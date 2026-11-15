import { randomUUID } from 'node:crypto';
import {
  Api,
  CurrentUser,
  EDITABLE_STATUSES,
  type Platform,
  type Post,
  type PostFields,
} from '@posthub/contract';
import { mediaAsset, post, postMedia, postTarget, socialAccount, type Db } from '@posthub/db';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { Clock, Effect } from 'effect';
import { HttpApiBuilder } from 'effect/http-api';
import { badRequest, conflict, handlerDatabase, notFound } from '../http-support';
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

interface Selection {
  accounts: Array<{
    id: string;
    platform: Platform;
    displayName: string;
    status: 'active' | 'expired' | 'revoked';
  }>;
  media: Map<string, { id: string; mimeType: string; sizeBytes: number }>;
}

/** Images referenced outside the attachments: featured image, thumbnail, images in the text. */
const imageIdsOf = (input: PostInput) =>
  [input.featuredMediaId, input.thumbnailMediaId, ...inlineMediaIds(input.body)].filter(
    (mediaId): mediaId is string => mediaId !== null,
  );

/** The owner's accounts and media that this post refers to. */
function readSelection(db: Db, userId: string, input: PostInput): Selection {
  const accounts = input.accountIds.length
    ? db
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
  const mediaIds = [...new Set([...input.mediaIds, ...imageIdsOf(input)])];
  const found = mediaIds.length
    ? db
        .select({
          id: mediaAsset.id,
          mimeType: mediaAsset.mimeType,
          sizeBytes: mediaAsset.sizeBytes,
        })
        .from(mediaAsset)
        .where(and(eq(mediaAsset.userId, userId), inArray(mediaAsset.id, mediaIds)))
        .all()
    : [];
  return { accounts, media: new Map(found.map((m) => [m.id, m])) };
}

/** Why this post can't be saved as asked, or null. Scheduling is checked against every platform. */
function problemWith(input: PostInput, { accounts, media }: Selection): string | null {
  if (accounts.length !== new Set(input.accountIds).size) {
    return 'One of the selected accounts no longer exists.';
  }
  const imageIds = imageIdsOf(input);
  if ([...input.mediaIds, ...imageIds].some((mediaId) => !media.has(mediaId))) {
    return 'One of the attached files no longer exists.';
  }
  if (imageIds.some((mediaId) => !media.get(mediaId)!.mimeType.startsWith('image/'))) {
    return 'Featured images, thumbnails and images in the text must be images.';
  }
  if (input.status !== 'scheduled') return null;
  if (!input.scheduledAt) return 'Pick a date and time to schedule the post.';
  if (!accounts.length) return 'Select at least one account to post to.';

  const attached = input.mediaIds.map((mediaId) => media.get(mediaId)!);
  const thumbnail = input.thumbnailMediaId ? media.get(input.thumbnailMediaId)! : null;
  const problems = accounts.flatMap((account) => {
    if (account.status !== 'active')
      return [`${account.displayName}: reconnect this account first.`];
    const problem = platformProblem(account.platform, { ...input, media: attached, thumbnail });
    return problem ? [`${account.displayName}: ${problem}`] : [];
  });
  return problems.length ? problems.join('\n') : null;
}

/** Writes the post, its targets (kept for accounts that stay selected) and its media order. */
function writePost(
  db: Db,
  userId: string,
  id: string,
  input: PostInput,
  isNew: boolean,
  accounts: Selection['accounts'],
) {
  const values = {
    title: input.title.trim(),
    body: input.body,
    link: input.link,
    featuredMediaId: input.featuredMediaId,
    thumbnailMediaId: input.thumbnailMediaId,
    wordpressOptions: input.wordpressOptions
      ? { ...input.wordpressOptions, tags: input.wordpressOptions.tags.map((tag) => tag.trim()) }
      : null,
    status: input.status,
    scheduledAt: input.scheduledAt,
  };
  if (isNew) {
    db.insert(post)
      .values({ id, userId, ...values })
      .run();
  } else {
    db.update(post).set(values).where(eq(post.id, id)).run();
  }

  // Keep target rows for accounts that stay selected; they have not started yet.
  const kept = new Set(
    db
      .select({ accountId: postTarget.socialAccountId })
      .from(postTarget)
      .where(eq(postTarget.postId, id))
      .all()
      .map((t) => t.accountId),
  );
  const removed = [...kept].filter((accountId) => !input.accountIds.includes(accountId));
  if (removed.length) {
    db.delete(postTarget)
      .where(and(eq(postTarget.postId, id), inArray(postTarget.socialAccountId, removed)))
      .run();
  }
  for (const account of accounts) {
    if (kept.has(account.id)) continue;
    db.insert(postTarget)
      .values({
        id: randomUUID(),
        postId: id,
        socialAccountId: account.id,
        status: isManualPlatform(account.platform) ? 'manual' : 'pending',
      })
      .run();
  }

  db.delete(postMedia).where(eq(postMedia.postId, id)).run();
  const uniqueMedia = [...new Set(input.mediaIds)];
  if (uniqueMedia.length) {
    db.insert(postMedia)
      .values(uniqueMedia.map((mediaId, position) => ({ postId: id, mediaId, position })))
      .run();
  }
}

/** A target of one of the caller's posts, or undefined. */
function findOwnTarget(db: Db, userId: string, targetId: string) {
  return db
    .select({ target: postTarget, postStatus: post.status })
    .from(postTarget)
    .innerJoin(post, eq(post.id, postTarget.postId))
    .where(and(eq(postTarget.id, targetId), eq(post.userId, userId)))
    .get();
}

const isEditable = (status: string) => (EDITABLE_STATUSES as readonly string[]).includes(status);

export const PostsHandlers = HttpApiBuilder.group(Api, 'posts', (handlers) =>
  Effect.gen(function* () {
    const { query, transaction } = handlerDatabase(yield* Database);

    const loadPost = (userId: string, id: string) =>
      Effect.flatMap(
        query((db) => loadPosts(db, userId, [id])[0]),
        (found) => (found ? Effect.succeed(found) : Effect.fail(notFound())),
      );

    /** Creates or updates a post with its targets and media, all or nothing. */
    const savePost = (userId: string, id: string, input: PostInput, isNew: boolean) =>
      transaction(
        Effect.gen(function* () {
          const selection = yield* query((db) => readSelection(db, userId, input));
          const problem = problemWith(input, selection);
          if (problem) return yield* badRequest(problem);
          yield* query((db) => writePost(db, userId, id, input, isNew, selection.accounts));
          return yield* loadPost(userId, id);
        }),
      );

    const ownTarget = (userId: string, targetId: string) =>
      Effect.flatMap(
        query((db) => findOwnTarget(db, userId, targetId)),
        (found) => (found ? Effect.succeed(found) : Effect.fail(notFound())),
      );

    return handlers.handleAll({
      list: () => Effect.flatMap(CurrentUser, (user) => query((db) => loadPosts(db, user.id))),

      // The client supplies the id so TanStack DB can insert optimistically.
      create: ({ payload: input }) =>
        Effect.flatMap(CurrentUser, (user) =>
          savePost(
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

      update: ({ payload: input }) =>
        transaction(
          Effect.gen(function* () {
            const user = yield* CurrentUser;
            const current = yield* loadPost(user.id, input.id);
            if (!isEditable(current.status)) {
              return yield* conflict(
                'This post has already started publishing and can no longer be edited.',
              );
            }
            return yield* savePost(
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
        Effect.gen(function* () {
          const user = yield* CurrentUser;
          return yield* transaction(
            Effect.gen(function* () {
              const publishing = yield* query((db) =>
                db
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
                  .get(),
              );
              if (publishing) {
                return yield* conflict('This post is publishing right now. Try again in a moment.');
              }
              yield* query((db) =>
                db
                  .delete(post)
                  .where(and(eq(post.id, input.id), eq(post.userId, user.id)))
                  .run(),
              );
              return { id: input.id };
            }),
          );
        }),

      retry: ({ payload: input }) =>
        transaction(
          Effect.gen(function* () {
            const user = yield* CurrentUser;
            const { target } = yield* ownTarget(user.id, input.targetId);
            if (target.status !== 'failed')
              return yield* conflict('Only failed posts can be retried.');
            yield* query((db) => {
              db.update(postTarget)
                .set({ status: 'pending', nextAttemptAt: null, lastError: null })
                .where(eq(postTarget.id, target.id))
                .run();
              refreshPostStatus(db, target.postId);
            });
            return yield* loadPost(user.id, target.postId);
          }),
        ),

      markPosted: ({ payload: input }) =>
        transaction(
          Effect.gen(function* () {
            const user = yield* CurrentUser;
            const publishedAt = new Date(yield* Clock.currentTimeMillis);
            const { target, postStatus } = yield* ownTarget(user.id, input.targetId);
            if (target.status !== 'manual') {
              return yield* conflict('This target is published automatically.');
            }
            yield* query((db) => {
              db.update(postTarget)
                .set({ status: 'published', externalUrl: input.url ?? null, publishedAt })
                .where(eq(postTarget.id, target.id))
                .run();
              if (postStatus !== 'draft' && postStatus !== 'scheduled') {
                refreshPostStatus(db, target.postId);
              }
            });
            return yield* loadPost(user.id, target.postId);
          }),
        ),
    });
  }),
);
