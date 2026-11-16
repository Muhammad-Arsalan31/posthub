// Comments: syncing them from platforms, and the outbox that sends replies and moderation.
// Run by the sync worker (sync.ts). The rule that nothing posts twice applies to replies: a reply
// whose send may have reached the platform (network failure, or found `sending` at startup) is
// only sent again after a fresh read of the post's comments shows it is not there.
import { randomUUID } from 'node:crypto';
import { comment, commentAction, post, postTarget, socialAccount, type Db } from '@posthub/db';
import {
  PlatformError,
  type CommentRef,
  type EngagementAdapter,
  type RemoteComment,
} from '@posthub/integrations';
import { and, asc, eq, inArray, isNull, lte, notInArray, or } from 'drizzle-orm';
import { Cause, Clock, Effect } from 'effect';
import type { CredentialAccess } from './accounts';
import type { ProviderAppsService } from './provider-apps';
import type { DatabaseService } from './services';
import { nextMetricsRun } from './sync-schedule';

const MINUTE = 60_000;
/** Pages read per sync (100 comments each on most platforms). */
const MAX_PAGES = 10;
/** Waits before retries of an outbox action. */
export const ACTION_RETRY_MS = [MINUTE, 5 * MINUTE, 30 * MINUTE];

/** Every 10 minutes while a post is a day old, then like metrics. */
export const nextCommentsRun = (publishedAt: number, now: number) =>
  now - publishedAt < 24 * 60 * MINUTE ? now + 10 * MINUTE : nextMetricsRun(publishedAt, now);

/**
 * Stores a page of comments (an upsert on the external id). After a full read, comments missing
 * from it are marked deleted. Synchronous: call it inside a transaction.
 */
export function upsertComments(
  db: Db,
  target: { id: string; userId: string },
  remote: RemoteComment[],
  options: { full: boolean; now: Date },
) {
  for (const c of remote) {
    const values = {
      parentExternalId: c.parentExternalId,
      authorName: c.authorName,
      authorAvatarUrl: c.authorAvatarUrl,
      authorId: c.authorId,
      text: c.text,
      likeCount: c.likeCount,
      likedByMe: c.likedByMe,
      hidden: c.hidden,
      isOwn: c.isOwn,
      externalCreatedAt: c.createdAt,
      deletedAt: null,
    };
    db.insert(comment)
      .values({
        id: randomUUID(),
        userId: target.userId,
        postTargetId: target.id,
        externalId: c.externalId,
        // Own comments are never unread.
        readAt: c.isOwn ? options.now : null,
        ...values,
      })
      .onConflictDoUpdate({ target: [comment.postTargetId, comment.externalId], set: values })
      .run();
  }
  if (options.full) {
    const seen = remote.map((c) => c.externalId);
    db.update(comment)
      .set({ deletedAt: options.now })
      .where(
        and(
          eq(comment.postTargetId, target.id),
          isNull(comment.deletedAt),
          seen.length ? notInArray(comment.externalId, seen) : undefined,
        ),
      )
      .run();
  }
}

type AnyEngagement = EngagementAdapter<unknown>;

interface Deps {
  database: DatabaseService;
  providerApps: ProviderAppsService;
  credentialAccess: CredentialAccess;
}

/** A target with what comment calls need, or undefined. */
function loadTarget(db: Db, targetId: string) {
  return db
    .select({
      id: postTarget.id,
      status: postTarget.status,
      externalPostId: postTarget.externalPostId,
      publishedAt: postTarget.publishedAt,
      userId: post.userId,
      account: socialAccount,
    })
    .from(postTarget)
    .innerJoin(post, eq(post.id, postTarget.postId))
    .innerJoin(socialAccount, eq(socialAccount.id, postTarget.socialAccountId))
    .where(eq(postTarget.id, targetId))
    .get();
}

type LoadedTarget = NonNullable<ReturnType<typeof loadTarget>>;

export function makeCommentWork({ database, providerApps, credentialAccess }: Deps) {
  /** The engagement adapter and fresh credentials for a target's account, or why not. */
  const prepare = Effect.fnUntraced(function* (target: LoadedTarget) {
    const { account } = target;
    if (account.status !== 'active' || !account.credentials) return { _tag: 'paused' as const };
    const adapter = (yield* providerApps.current).engagement(account.platform);
    if (!adapter) return { _tag: 'unsupported' as const };
    const credentials = yield* credentialAccess.fresh(
      { ...account, credentials: account.credentials },
      adapter,
    );
    return { _tag: 'ready' as const, adapter, credentials };
  });

  /** Every page of a target's comments (up to MAX_PAGES); `full` when none were left out. */
  const readAll = (adapter: AnyEngagement, credentials: unknown, target: LoadedTarget) =>
    Effect.gen(function* () {
      const comments: RemoteComment[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_PAGES; page++) {
        const result = yield* adapter.listComments(
          credentials,
          { externalPostId: target.externalPostId!, accountExternalId: target.account.externalId },
          cursor,
        );
        comments.push(...result.comments);
        cursor = result.next;
        if (!cursor) return { comments, full: true };
      }
      return { comments, full: false };
    });

  const store = (target: LoadedTarget, remote: RemoteComment[], full: boolean) =>
    Effect.flatMap(Clock.currentTimeMillis, (now) =>
      database.transaction(
        database.use((db) =>
          upsertComments(db, { id: target.id, userId: target.userId }, remote, {
            full,
            now: new Date(now),
          }),
        ),
      ),
    );

  /** Syncs one target's comments. Succeeds with the next run (null: stop) or a stop reason. */
  const syncTarget = Effect.fnUntraced(function* (targetId: string, now: number) {
    const target = yield* database.use((db) => loadTarget(db, targetId));
    if (!target?.externalPostId || target.status !== 'published') return { _tag: 'done' as const };
    const ready = yield* prepare(target);
    if (ready._tag === 'paused') return { _tag: 'paused' as const };
    if (ready._tag === 'unsupported') return { _tag: 'done' as const };
    // Read first, then write everything in one synchronous transaction.
    const { comments, full } = yield* readAll(ready.adapter, ready.credentials, target);
    yield* store(target, comments, full);
    const publishedAt = target.publishedAt?.getTime() ?? now;
    return { _tag: 'ran' as const, next: nextCommentsRun(publishedAt, now) };
  });

  /** Atomically takes the next due outbox action, or null. */
  function claimAction(db: Db, at: Date) {
    const next = db
      .select()
      .from(commentAction)
      .where(
        and(
          eq(commentAction.status, 'pending'),
          or(isNull(commentAction.nextAttemptAt), lte(commentAction.nextAttemptAt, at)),
        ),
      )
      .orderBy(asc(commentAction.createdAt))
      .limit(1)
      .get();
    if (!next) return null;
    db.update(commentAction)
      .set({ status: 'sending', attempts: next.attempts + 1 })
      .where(eq(commentAction.id, next.id))
      .run();
    return { ...next, status: 'sending' as const, attempts: next.attempts + 1 };
  }

  type Action = NonNullable<ReturnType<typeof claimAction>>;

  /** Actions left `sending` by a crash go back to pending; replies must check before resending. */
  const recoverActions = database.use(
    (db) =>
      db
        .update(commentAction)
        .set({ status: 'pending', checkFirst: true })
        .where(eq(commentAction.status, 'sending'))
        .run().changes,
  );

  /** Where a comment is, walking up to the top of its thread. */
  function refOf(db: Db, row: typeof comment.$inferSelect, postExternalId: string): CommentRef {
    let top = row;
    for (let depth = 0; top.parentExternalId && depth < 20; depth++) {
      const parent = db
        .select()
        .from(comment)
        .where(
          and(
            eq(comment.postTargetId, row.postTargetId),
            eq(comment.externalId, top.parentExternalId),
          ),
        )
        .get();
      if (!parent) break;
      top = parent;
    }
    return { externalId: row.externalId, threadExternalId: top.externalId, postExternalId };
  }

  const finishAction = (action: Action, changes: Partial<typeof commentAction.$inferInsert>) =>
    database.use((db) =>
      db.update(commentAction).set(changes).where(eq(commentAction.id, action.id)).run(),
    );

  const runAction = (action: Action) =>
    Effect.gen(function* () {
      const loaded = yield* database.use((db) => {
        const row = db.select().from(comment).where(eq(comment.id, action.commentId)).get();
        const target = row && loadTarget(db, row.postTargetId);
        return row && target?.externalPostId
          ? { row, target, ref: refOf(db, row, target.externalPostId) }
          : undefined;
      });
      if (!loaded) {
        return yield* finishAction(action, { status: 'failed', lastError: 'The comment is gone.' });
      }
      const { row, target, ref } = loaded;
      const ready = yield* prepare(target);
      if (ready._tag !== 'ready') {
        return yield* finishAction(action, {
          status: 'failed',
          lastError:
            ready._tag === 'paused'
              ? 'Reconnect this account on the Accounts page, then retry.'
              : 'This platform does not support comments.',
        });
      }
      const { adapter, credentials } = ready;

      if (action.kind === 'reply') {
        if (action.checkFirst) {
          // A previous send may have gone through: look before sending again.
          const { comments, full } = yield* readAll(adapter, credentials, target);
          yield* store(target, comments, full);
          const since = action.createdAt.getTime() - MINUTE;
          const already = comments.some(
            (c) =>
              c.isOwn && c.text.trim() === action.text!.trim() && c.createdAt.getTime() >= since,
          );
          if (already) return yield* finishAction(action, { status: 'done', lastError: null });
        }
        const sent = yield* adapter.reply(credentials, ref, action.text!);
        // Posted: record it, and never fail from here on.
        yield* store(
          target,
          [{ ...sent, parentExternalId: sent.parentExternalId ?? row.externalId }],
          false,
        ).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning('[inbox] could not store a sent reply', cause),
          ),
        );
        return yield* finishAction(action, { status: 'done', lastError: null }).pipe(
          Effect.catchCause((cause) =>
            Effect.logError('[inbox] reply sent but not recorded', cause),
          ),
        );
      }

      const now = new Date(yield* Clock.currentTimeMillis);
      if (action.kind === 'like' || action.kind === 'unlike') {
        const liked = action.kind === 'like';
        yield* adapter.setLike(credentials, ref, liked);
        yield* database.use((db) =>
          db.update(comment).set({ likedByMe: liked }).where(eq(comment.id, row.id)).run(),
        );
      } else {
        yield* adapter.moderate(credentials, ref, action.kind);
        yield* database.use((db) =>
          db
            .update(comment)
            .set(action.kind === 'delete' ? { deletedAt: now } : { hidden: action.kind === 'hide' })
            .where(eq(comment.id, row.id))
            .run(),
        );
      }
      yield* finishAction(action, { status: 'done', lastError: null });
    }).pipe(
      Effect.catchCause((cause) => actionFailed(action, cause)),
      Effect.uninterruptible,
    );

  const actionFailed = Effect.fnUntraced(function* (action: Action, cause: Cause.Cause<unknown>) {
    const now = yield* Clock.currentTimeMillis;
    const error = Cause.squash(cause);
    const message = error instanceof Error ? error.message : String(error);
    const delay = ACTION_RETRY_MS[action.attempts - 1];
    if (error instanceof PlatformError) {
      // A definite answer: follow its retryable flag.
      return yield* finishAction(action, {
        status: error.retryable && delay !== undefined ? 'pending' : 'failed',
        nextAttemptAt: delay === undefined ? null : new Date(now + delay),
        lastError: error.message,
      });
    }
    yield* Effect.logError(`[inbox] ${action.kind} ${action.id}`, cause);
    // Unknown outcome. Moderation is idempotent; a reply is checked for before it is sent again.
    yield* finishAction(action, {
      status: delay === undefined ? 'failed' : 'pending',
      checkFirst: action.kind === 'reply' ? true : action.checkFirst,
      nextAttemptAt: delay === undefined ? null : new Date(now + delay),
      lastError:
        action.kind === 'reply' && delay === undefined
          ? `${message}. PostHub could not confirm whether the reply was posted; check before retrying.`
          : message,
    });
  });

  return { syncTarget, claimAction, runAction, recoverActions };
}

/** Comments of the owner's targets, for scoping checks. */
export const ownComment = (db: Db, userId: string, commentId: string) =>
  db
    .select()
    .from(comment)
    .where(and(eq(comment.id, commentId), eq(comment.userId, userId)))
    .get();

/** Pending and failed actions of some comments (shown next to them). */
export const openActions = (db: Db, commentIds: string[]) =>
  commentIds.length
    ? db
        .select()
        .from(commentAction)
        .where(
          and(
            inArray(commentAction.commentId, commentIds),
            inArray(commentAction.status, ['pending', 'sending', 'failed']),
          ),
        )
        .orderBy(asc(commentAction.createdAt))
        .all()
    : [];
