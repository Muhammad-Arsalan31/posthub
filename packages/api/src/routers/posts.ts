import { randomUUID } from 'node:crypto';
import { Api, CurrentUser, EDITABLE_STATUSES, type Post, type PostFields } from '@posthub/contract';
import { mediaAsset, post, postMedia, postTarget, socialAccount, type Db } from '@posthub/db';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { Clock, Effect } from 'effect';
import { HttpApiBuilder } from 'effect/http-api';
import { badRequest, conflict, notFound, trySync } from '../http-support';
import { inlineMediaIds } from '../inline-media';
import { isManualPlatform, platformProblem } from '../post-rules';
import { refreshPostStatus } from '../publisher';
import { Database } from '../services';

type PostInput = PostFields;

const targetColumns = {
  id: postTarget.id,
  postId: postTarget.postId,
  socialAccountId: postTarget.socialAccountId,
  status: postTarget.status,
  attempts: postTarget.attempts,
  lastError: postTarget.lastError,
  externalUrl: postTarget.externalUrl,
  publishedAt: postTarget.publishedAt,
  nextAttemptAt: postTarget.nextAttemptAt,
};

/** Posts with their selected accounts, media (in order) and per-platform publish state. */
function loadPosts(db: Db, userId: string, ids?: string[]): Post[] {
  const where = ids ? and(eq(post.userId, userId), inArray(post.id, ids)) : eq(post.userId, userId);
  const posts = db.select().from(post).where(where).orderBy(desc(post.createdAt)).all();
  const postIds = posts.map((p) => p.id);
  if (!postIds.length) return [];

  const targets = db
    .select(targetColumns)
    .from(postTarget)
    .where(inArray(postTarget.postId, postIds))
    .orderBy(asc(postTarget.createdAt))
    .all();
  const media = db
    .select({ postId: postMedia.postId, mediaId: postMedia.mediaId })
    .from(postMedia)
    .where(inArray(postMedia.postId, postIds))
    .orderBy(asc(postMedia.position))
    .all();

  return posts.map((p) => {
    const own = targets.filter((t) => t.postId === p.id);
    return {
      ...p,
      accountIds: own.map((t) => t.socialAccountId),
      mediaIds: media.filter((m) => m.postId === p.id).map((m) => m.mediaId),
      targets: own,
    };
  });
}

/**
 * Creates or updates a post with its targets and media in one transaction.
 * Scheduling is validated against every selected platform first.
 */
function savePost(db: Db, userId: string, id: string, input: PostInput, isNew: boolean) {
  db.transaction((tx) => {
    const accounts = input.accountIds.length
      ? tx
          .select({
            id: socialAccount.id,
            platform: socialAccount.platform,
            displayName: socialAccount.displayName,
            status: socialAccount.status,
          })
          .from(socialAccount)
          .where(and(eq(socialAccount.userId, userId), inArray(socialAccount.id, input.accountIds)))
          .all()
      : [];
    if (accounts.length !== new Set(input.accountIds).size) {
      throw badRequest('One of the selected accounts no longer exists.');
    }

    const imageIds = [
      input.featuredMediaId,
      input.thumbnailMediaId,
      ...inlineMediaIds(input.body),
    ].filter((mediaId): mediaId is string => mediaId !== null);
    const allMediaIds = [...new Set([...input.mediaIds, ...imageIds])];
    const found = allMediaIds.length
      ? tx
          .select({
            id: mediaAsset.id,
            mimeType: mediaAsset.mimeType,
            sizeBytes: mediaAsset.sizeBytes,
          })
          .from(mediaAsset)
          .where(and(eq(mediaAsset.userId, userId), inArray(mediaAsset.id, allMediaIds)))
          .all()
      : [];
    if (found.length !== allMediaIds.length) {
      throw badRequest('One of the attached files no longer exists.');
    }
    const byId = new Map(found.map((m) => [m.id, m]));
    const media = input.mediaIds.map((mediaId) => byId.get(mediaId)!);
    const thumbnail = input.thumbnailMediaId ? byId.get(input.thumbnailMediaId)! : null;
    for (const mediaId of imageIds) {
      if (!byId.get(mediaId)!.mimeType.startsWith('image/')) {
        throw badRequest('Featured images, thumbnails and images in the text must be images.');
      }
    }

    if (input.status === 'scheduled') {
      if (!input.scheduledAt) throw badRequest('Pick a date and time to schedule the post.');
      if (!accounts.length) throw badRequest('Select at least one account to post to.');
      const problems = accounts.flatMap((account) => {
        if (account.status !== 'active') {
          return [`${account.displayName}: reconnect this account first.`];
        }
        const problem = platformProblem(account.platform, { ...input, media, thumbnail });
        return problem ? [`${account.displayName}: ${problem}`] : [];
      });
      if (problems.length) throw badRequest(problems.join('\n'));
    }

    const values = {
      title: input.title.trim(),
      body: input.body,
      link: input.link,
      featuredMediaId: input.featuredMediaId,
      thumbnailMediaId: input.thumbnailMediaId,
      wordpressOptions: input.wordpressOptions,
      status: input.status,
      scheduledAt: input.scheduledAt,
    };
    if (isNew) {
      tx.insert(post)
        .values({ id, userId, ...values })
        .run();
    } else {
      tx.update(post).set(values).where(eq(post.id, id)).run();
    }

    // Keep target rows for accounts that stay selected; they have not started yet.
    const kept = new Set(
      tx
        .select({ accountId: postTarget.socialAccountId })
        .from(postTarget)
        .where(eq(postTarget.postId, id))
        .all()
        .map((t) => t.accountId),
    );
    const removed = [...kept].filter((accountId) => !input.accountIds.includes(accountId));
    if (removed.length) {
      tx.delete(postTarget)
        .where(and(eq(postTarget.postId, id), inArray(postTarget.socialAccountId, removed)))
        .run();
    }
    for (const account of accounts) {
      if (kept.has(account.id)) continue;
      tx.insert(postTarget)
        .values({
          id: randomUUID(),
          postId: id,
          socialAccountId: account.id,
          status: isManualPlatform(account.platform) ? 'manual' : 'pending',
        })
        .run();
    }

    tx.delete(postMedia).where(eq(postMedia.postId, id)).run();
    const uniqueMedia = [...new Set(input.mediaIds)];
    if (uniqueMedia.length) {
      tx.insert(postMedia)
        .values(uniqueMedia.map((mediaId, position) => ({ postId: id, mediaId, position })))
        .run();
    }
  });
  return loadPosts(db, userId, [id])[0]!;
}

/** A target of one of the caller's posts, or NOT_FOUND. */
function ownTarget(db: Db, userId: string, targetId: string) {
  const row = db
    .select({ target: postTarget, postStatus: post.status })
    .from(postTarget)
    .innerJoin(post, eq(post.id, postTarget.postId))
    .where(and(eq(postTarget.id, targetId), eq(post.userId, userId)))
    .get();
  if (!row) throw notFound();
  return row;
}

const isEditable = (status: string) => (EDITABLE_STATUSES as readonly string[]).includes(status);

export const PostsHandlers = HttpApiBuilder.group(Api, 'posts', (handlers) =>
  Effect.gen(function* () {
    const db = yield* Database;

    return handlers.handleAll({
      list: () => Effect.flatMap(CurrentUser, (user) => trySync(() => loadPosts(db, user.id))),

      // The client supplies the id so TanStack DB can insert optimistically.
      create: ({ payload: input }) =>
        Effect.flatMap(CurrentUser, (user) =>
          trySync(() =>
            savePost(
              db,
              user.id,
              input.id,
              {
                title: input.title,
                body: input.body ?? '',
                link: input.link ?? null,
                status: input.status ?? 'draft',
                scheduledAt: input.scheduledAt ?? null,
                accountIds: input.accountIds ?? [],
                mediaIds: input.mediaIds ?? [],
                featuredMediaId: input.featuredMediaId ?? null,
                thumbnailMediaId: input.thumbnailMediaId ?? null,
                wordpressOptions: input.wordpressOptions ?? null,
              },
              true,
            ),
          ),
        ),

      update: ({ payload: input }) =>
        Effect.flatMap(CurrentUser, (user) =>
          trySync(() => {
            const [current] = loadPosts(db, user.id, [input.id]);
            if (!current) throw notFound();
            if (!isEditable(current.status)) {
              throw conflict(
                'This post has already started publishing and can no longer be edited.',
              );
            }
            return savePost(
              db,
              user.id,
              input.id,
              {
                title: current.title,
                body: current.body,
                link: current.link,
                status: current.status as PostInput['status'],
                scheduledAt: current.scheduledAt,
                accountIds: current.accountIds,
                mediaIds: current.mediaIds,
                featuredMediaId: current.featuredMediaId,
                thumbnailMediaId: current.thumbnailMediaId,
                wordpressOptions: current.wordpressOptions,
                ...input.changes,
              },
              false,
            );
          }),
        ),

      delete: ({ payload: input }) =>
        Effect.flatMap(CurrentUser, (user) =>
          trySync(() => {
            const publishing = db
              .select({ id: postTarget.id })
              .from(postTarget)
              .innerJoin(post, eq(post.id, postTarget.postId))
              .where(
                and(
                  eq(post.id, input.id),
                  eq(post.userId, user.id),
                  eq(postTarget.status, 'publishing'),
                ),
              )
              .get();
            if (publishing) {
              throw conflict('This post is publishing right now. Try again in a moment.');
            }
            db.delete(post)
              .where(and(eq(post.id, input.id), eq(post.userId, user.id)))
              .run();
            return { id: input.id };
          }),
        ),

      retry: ({ payload: input }) =>
        Effect.flatMap(CurrentUser, (user) =>
          trySync(() => {
            const { target } = ownTarget(db, user.id, input.targetId);
            if (target.status !== 'failed') throw conflict('Only failed posts can be retried.');
            db.transaction((tx) => {
              tx.update(postTarget)
                .set({ status: 'pending', nextAttemptAt: null, lastError: null })
                .where(eq(postTarget.id, target.id))
                .run();
              refreshPostStatus(tx, target.postId);
            });
            return loadPosts(db, user.id, [target.postId])[0]!;
          }),
        ),

      markPosted: ({ payload: input }) =>
        Effect.gen(function* () {
          const user = yield* CurrentUser;
          const publishedAt = new Date(yield* Clock.currentTimeMillis);
          return yield* trySync(() => {
            const { target, postStatus } = ownTarget(db, user.id, input.targetId);
            if (target.status !== 'manual') {
              throw conflict('This target is published automatically.');
            }
            db.transaction((tx) => {
              tx.update(postTarget)
                .set({ status: 'published', externalUrl: input.url ?? null, publishedAt })
                .where(eq(postTarget.id, target.id))
                .run();
              if (postStatus !== 'draft' && postStatus !== 'scheduled') {
                refreshPostStatus(tx, target.postId);
              }
            });
            return loadPosts(db, user.id, [target.postId])[0]!;
          });
        }),
    });
  }),
);
