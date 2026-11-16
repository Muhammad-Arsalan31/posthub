import { randomUUID } from 'node:crypto';
import { Api, CurrentUser, type InboxComment, type InboxThread } from '@posthub/contract';
import {
  comment,
  commentAction,
  post,
  postTarget,
  savedReply,
  socialAccount,
  type CommentActionKind,
  type Db,
} from '@posthub/db';
import type { EngagementCapabilities } from '@posthub/integrations';
import { and, asc, eq, inArray, isNull, type SQL } from 'drizzle-orm';
import { Clock, Effect } from 'effect';
import { HttpApiBuilder } from 'effect/http-api';
import { openActions, ownComment } from '../comments';
import { badRequest, conflict, handlerDatabase, notFound } from '../http-support';
import { ProviderApps } from '../provider-apps';
import { Database } from '../services';

/** The owner's comments with their post and account, matching `where`. */
function loadComments(db: Db, userId: string, where?: SQL): InboxComment[] {
  const rows = db
    .select({
      comment,
      postId: post.id,
      postTitle: post.title,
      accountId: socialAccount.id,
      platform: socialAccount.platform,
    })
    .from(comment)
    .innerJoin(postTarget, eq(postTarget.id, comment.postTargetId))
    .innerJoin(post, eq(post.id, postTarget.postId))
    .innerJoin(socialAccount, eq(socialAccount.id, postTarget.socialAccountId))
    .where(and(eq(comment.userId, userId), where))
    .orderBy(asc(comment.externalCreatedAt))
    .all();
  const actions = openActions(
    db,
    rows.map((r) => r.comment.id),
  );
  return rows.map(({ comment: c, ...rest }) => ({
    ...rest,
    id: c.id,
    externalId: c.externalId,
    parentExternalId: c.parentExternalId,
    authorName: c.authorName,
    authorAvatarUrl: c.authorAvatarUrl,
    text: c.text,
    likeCount: c.likeCount,
    likedByMe: c.likedByMe,
    hidden: c.hidden,
    isOwn: c.isOwn,
    createdAt: c.externalCreatedAt,
    read: c.readAt !== null,
    archived: c.archivedAt !== null,
    deleted: c.deletedAt !== null,
    actions: actions
      .filter((a) => a.commentId === c.id)
      .map((a) => ({
        id: a.id,
        kind: a.kind,
        status: a.status as 'pending' | 'sending' | 'failed',
        text: a.text,
        lastError: a.lastError,
      })),
  }));
}

/** Groups comments into conversations by their top-level comment (per target). */
function threadsOf(comments: InboxComment[], targetOf: Map<string, string>) {
  const byExternal = new Map(comments.map((c) => [`${targetOf.get(c.id)}:${c.externalId}`, c]));
  const rootOf = (c: InboxComment) => {
    let current = c;
    for (let depth = 0; current.parentExternalId && depth < 20; depth++) {
      const parent = byExternal.get(`${targetOf.get(c.id)}:${current.parentExternalId}`);
      if (!parent) break;
      current = parent;
    }
    return current;
  };
  const threads = new Map<string, { root: InboxComment; members: InboxComment[] }>();
  for (const c of comments) {
    const root = rootOf(c);
    const thread = threads.get(root.id) ?? { root, members: [] };
    thread.members.push(c);
    threads.set(root.id, thread);
  }
  return threads;
}

function targetIds(db: Db, commentIds: string[]) {
  return new Map(
    commentIds.length
      ? db
          .select({ id: comment.id, targetId: comment.postTargetId })
          .from(comment)
          .where(inArray(comment.id, commentIds))
          .all()
          .map((r) => [r.id, r.targetId])
      : [],
  );
}

const CAPABILITY: Record<CommentActionKind, keyof EngagementCapabilities> = {
  reply: 'reply',
  like: 'like',
  unlike: 'like',
  hide: 'hide',
  unhide: 'hide',
  delete: 'delete',
};

const ACTION_WORDS: Record<keyof EngagementCapabilities, string> = {
  reply: 'Replying to comments',
  like: 'Liking comments',
  hide: 'Hiding comments',
  delete: 'Deleting comments',
};

export const InboxHandlers = HttpApiBuilder.group(Api, 'inbox', (handlers) =>
  Effect.gen(function* () {
    const { query, transaction } = handlerDatabase(yield* Database);
    const providerApps = yield* ProviderApps;

    /** Records an action for the sync worker, after checking the platform can do it. */
    const enqueue = (commentId: string, kind: CommentActionKind, text?: string) =>
      Effect.gen(function* () {
        const user = yield* CurrentUser;
        const found = yield* query((db) => {
          const own = ownComment(db, user.id, commentId);
          if (!own) return undefined;
          const platform = db
            .select({ platform: socialAccount.platform })
            .from(postTarget)
            .innerJoin(socialAccount, eq(socialAccount.id, postTarget.socialAccountId))
            .where(eq(postTarget.id, own.postTargetId))
            .get()?.platform;
          return platform ? { own, platform } : undefined;
        });
        if (!found) return yield* notFound();
        if (found.own.deletedAt) return yield* conflict('This comment has been deleted.');
        const engagement = (yield* providerApps.current).engagement(found.platform);
        const capability = CAPABILITY[kind];
        if (!engagement?.capabilities[capability]) {
          return yield* badRequest(
            `${ACTION_WORDS[capability]} is not possible on ${found.platform} through its API.`,
          );
        }
        const now = new Date(yield* Clock.currentTimeMillis);
        yield* query((db) => {
          db.insert(commentAction)
            .values({ id: randomUUID(), commentId, kind, text: text?.trim(), createdAt: now })
            .run();
          // Answering a comment means it has been read.
          db.update(comment)
            .set({ readAt: now })
            .where(and(eq(comment.id, commentId), isNull(comment.readAt)))
            .run();
        });
        return { ok: true };
      });

    return handlers.handleAll({
      list: ({ payload }) =>
        Effect.flatMap(CurrentUser, (user) =>
          query((db): InboxThread[] => {
            const filters = and(
              isNull(comment.deletedAt),
              payload.postId ? eq(post.id, payload.postId) : undefined,
              payload.accountIds?.length
                ? inArray(socialAccount.id, payload.accountIds)
                : undefined,
            );
            const comments = loadComments(db, user.id, filters);
            const threads = threadsOf(
              comments,
              targetIds(
                db,
                comments.map((c) => c.id),
              ),
            );
            return [...threads.values()]
              .map(({ root, members }) => ({
                root,
                replies: members.length - 1,
                unread: members.filter((m) => !m.read && !m.isOwn).length,
                lastActivityAt: members.reduce(
                  (latest, m) => (m.createdAt > latest ? m.createdAt : latest),
                  root.createdAt,
                ),
              }))
              .filter((t) => (payload.archived ? t.root.archived : !t.root.archived))
              .filter((t) => !payload.unread || t.unread > 0)
              .sort((a, b) => b.lastActivityAt.getTime() - a.lastActivityAt.getTime())
              .slice(0, 300);
          }),
        ),

      thread: ({ payload }) =>
        Effect.gen(function* () {
          const user = yield* CurrentUser;
          const result = yield* query((db) => {
            const own = ownComment(db, user.id, payload.commentId);
            if (!own) return undefined;
            const comments = loadComments(db, user.id, eq(comment.postTargetId, own.postTargetId));
            const threads = threadsOf(
              comments,
              new Map(comments.map((c) => [c.id, own.postTargetId])),
            );
            return [...threads.values()].find((t) => t.members.some((m) => m.id === own.id))
              ?.members;
          });
          return result ?? (yield* notFound());
        }),

      unreadCount: () =>
        Effect.flatMap(CurrentUser, (user) =>
          query((db) => ({
            count: db
              .select({ id: comment.id })
              .from(comment)
              .where(
                and(
                  eq(comment.userId, user.id),
                  isNull(comment.readAt),
                  isNull(comment.deletedAt),
                  isNull(comment.archivedAt),
                  eq(comment.isOwn, false),
                ),
              )
              .all().length,
          })),
        ),

      reply: ({ payload }) => enqueue(payload.commentId, 'reply', payload.text),
      setLike: ({ payload }) => enqueue(payload.commentId, payload.liked ? 'like' : 'unlike'),
      moderate: ({ payload }) => enqueue(payload.commentId, payload.action),

      markRead: ({ payload }) =>
        Effect.gen(function* () {
          const user = yield* CurrentUser;
          const now = new Date(yield* Clock.currentTimeMillis);
          if (!payload.commentIds.length) return { ok: true };
          yield* query((db) =>
            db
              .update(comment)
              .set({ readAt: now })
              .where(
                and(
                  eq(comment.userId, user.id),
                  inArray(comment.id, payload.commentIds),
                  isNull(comment.readAt),
                ),
              )
              .run(),
          );
          return { ok: true };
        }),

      archive: ({ payload }) =>
        Effect.gen(function* () {
          const user = yield* CurrentUser;
          const now = new Date(yield* Clock.currentTimeMillis);
          const changed = yield* query(
            (db) =>
              db
                .update(comment)
                .set({ archivedAt: payload.archived ? now : null, readAt: now })
                .where(and(eq(comment.id, payload.commentId), eq(comment.userId, user.id)))
                .run().changes,
          );
          return changed ? { ok: true } : yield* notFound();
        }),

      retryAction: ({ payload }) =>
        transaction(
          Effect.gen(function* () {
            const user = yield* CurrentUser;
            const action = yield* query((db) =>
              db
                .select({ action: commentAction })
                .from(commentAction)
                .innerJoin(comment, eq(comment.id, commentAction.commentId))
                .where(and(eq(commentAction.id, payload.actionId), eq(comment.userId, user.id)))
                .get(),
            );
            if (!action) return yield* notFound();
            if (action.action.status !== 'failed') {
              return yield* conflict('Only failed steps can be retried.');
            }
            yield* query((db) =>
              db
                .update(commentAction)
                // A failed reply may have gone out: look before sending again.
                .set({
                  status: 'pending',
                  attempts: 0,
                  nextAttemptAt: null,
                  checkFirst: action.action.kind === 'reply',
                })
                .where(eq(commentAction.id, payload.actionId))
                .run(),
            );
            return { ok: true };
          }),
        ),
    });
  }),
);

export const SavedRepliesHandlers = HttpApiBuilder.group(Api, 'savedReplies', (handlers) =>
  Effect.gen(function* () {
    const { query } = handlerDatabase(yield* Database);
    const columns = { id: savedReply.id, title: savedReply.title, body: savedReply.body };

    return handlers.handleAll({
      list: () =>
        Effect.flatMap(CurrentUser, (user) =>
          query((db) =>
            db
              .select(columns)
              .from(savedReply)
              .where(eq(savedReply.userId, user.id))
              .orderBy(asc(savedReply.title))
              .all(),
          ),
        ),

      save: ({ payload }) =>
        Effect.gen(function* () {
          const user = yield* CurrentUser;
          const values = { title: payload.title.trim(), body: payload.body.trim() };
          if (payload.id) {
            const changed = yield* query(
              (db) =>
                db
                  .update(savedReply)
                  .set(values)
                  .where(and(eq(savedReply.id, payload.id!), eq(savedReply.userId, user.id)))
                  .run().changes,
            );
            if (!changed) return yield* notFound();
            return { id: payload.id, ...values };
          }
          const id = randomUUID();
          yield* query((db) =>
            db
              .insert(savedReply)
              .values({ id, userId: user.id, ...values })
              .run(),
          );
          return { id, ...values };
        }),

      delete: ({ payload }) =>
        Effect.flatMap(CurrentUser, (user) =>
          query((db) => {
            db.delete(savedReply)
              .where(and(eq(savedReply.id, payload.id), eq(savedReply.userId, user.id)))
              .run();
            return { id: payload.id };
          }),
        ),
    });
  }),
);
