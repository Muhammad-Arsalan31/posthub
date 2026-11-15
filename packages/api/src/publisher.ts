// The publishing worker. Jobs live in SQLite (`post_target` rows), so nothing is lost on restart:
//   1. A scheduled post that is due moves to `publishing`.
//   2. Each of its `pending` targets is claimed (status `publishing`, attempts + 1), published through
//      its platform adapter, and recorded as `published`, `pending` (retry later) or `failed`.
//   3. The post's status is recomputed from its targets.
// A target found in `publishing` at startup was interrupted mid-call: it may or may not have gone out,
// so it is marked failed for the owner to check instead of being retried (posts never duplicate).
import { join } from 'node:path';
import {
  mediaAsset,
  post,
  postMedia,
  postTarget,
  socialAccount,
  type Db,
  type PostStatus,
  type TargetStatus,
} from '@posthub/db';
import {
  bodyFormats,
  PlatformError,
  platformError,
  PROVIDERS,
  refreshIfExpiring,
  Vault,
  type MediaFile,
} from '@posthub/integrations';
import { and, asc, eq, isNull, lte, or } from 'drizzle-orm';
import {
  Cause,
  Clock,
  Context,
  Duration,
  Effect,
  Fiber,
  FiberSet,
  Layer,
  Schedule,
  type Scope,
} from 'effect';
import { inlineMediaIds, inlineRef } from './inline-media';
import { ProviderApps } from './provider-apps';
import { Database, type DatabaseError, MediaDir } from './services';

/** Waits before retry 1, 2 and 3 of a retryable failure (429, 5xx, still processing). */
export const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000];

export const INTERRUPTED_MESSAGE =
  'PostHub stopped while this was publishing. Check the platform to see whether it went out, then retry if it did not.';

/** A started post's status, from its targets. Manual handoffs (TikTok) don't hold a post open. */
export function summarizeTargets(statuses: TargetStatus[]): PostStatus {
  if (statuses.some((s) => s === 'pending' || s === 'publishing')) return 'publishing';
  if (statuses.some((s) => s === 'failed')) return 'failed';
  return 'published';
}

/** Recomputes a post's status from its targets. Synchronous: call it inside `database.use`. */
export function refreshPostStatus(db: Db, postId: string) {
  const statuses = db
    .select({ status: postTarget.status })
    .from(postTarget)
    .where(eq(postTarget.postId, postId))
    .all()
    .map((t) => t.status);
  db.update(post)
    .set({ status: summarizeTargets(statuses) })
    .where(eq(post.id, postId))
    .run();
}

export interface PublisherOptions {
  /** Targets published at the same time. */
  concurrency?: number;
}

export interface PublisherService {
  /** Marks targets left `publishing` by a crash or shutdown as failed. Succeeds with how many. */
  readonly recover: Effect.Effect<number, DatabaseError>;
  /** Starts due posts and claims targets up to the concurrency limit, without waiting for them. */
  readonly startJobs: Effect.Effect<void, DatabaseError>;
  /** Like `startJobs`, but waits until the jobs it started have finished. */
  readonly tick: Effect.Effect<void, DatabaseError>;
}

type ClaimedTarget = typeof postTarget.$inferSelect;
type Phase = 'prepare' | 'refresh' | 'publish';

const now = Effect.map(Clock.currentTimeMillis, (ms) => new Date(ms));

export const makePublisher = Effect.fnUntraced(function* ({ concurrency = 2 }: PublisherOptions) {
  const database = yield* Database;
  const vault = yield* Vault;
  const providerApps = yield* ProviderApps;
  const mediaDir = yield* MediaDir;
  // Jobs run in this set; closing the publisher's scope waits for them (they are uninterruptible).
  const jobs = yield* FiberSet.make<void>();

  const recover = database.transaction(
    database.use((db) => {
      const stuck = db
        .select({ id: postTarget.id, postId: postTarget.postId })
        .from(postTarget)
        .where(eq(postTarget.status, 'publishing'))
        .all();
      for (const target of stuck) {
        db.update(postTarget)
          .set({ status: 'failed', lockedAt: null, lastError: INTERRUPTED_MESSAGE })
          .where(eq(postTarget.id, target.id))
          .run();
      }
      for (const postId of new Set(stuck.map((t) => t.postId))) refreshPostStatus(db, postId);
      return stuck.length;
    }),
  );

  function startDuePosts(db: Db, at: Date) {
    const due = db
      .select({ id: post.id })
      .from(post)
      .where(and(eq(post.status, 'scheduled'), lte(post.scheduledAt, at)))
      .all();
    for (const { id } of due) refreshPostStatus(db, id);
  }

  /** Atomically takes the next due target, or returns null when there is none. */
  function claimNext(db: Db, at: Date): ClaimedTarget | null {
    {
      const next = db
        .select({ id: postTarget.id })
        .from(postTarget)
        .innerJoin(post, eq(post.id, postTarget.postId))
        .where(
          and(
            eq(post.status, 'publishing'),
            eq(postTarget.status, 'pending'),
            or(isNull(postTarget.nextAttemptAt), lte(postTarget.nextAttemptAt, at)),
          ),
        )
        .orderBy(asc(post.scheduledAt), asc(postTarget.createdAt))
        .limit(1)
        .get();
      if (!next) return null;
      const claimed = db.select().from(postTarget).where(eq(postTarget.id, next.id)).get()!;
      db.update(postTarget)
        .set({ status: 'publishing', lockedAt: at, attempts: claimed.attempts + 1 })
        .where(eq(postTarget.id, next.id))
        .run();
      return { ...claimed, status: 'publishing' as const, attempts: claimed.attempts + 1 };
    }
  }

  /** One of the post owner's media files, or undefined. */
  function mediaFile(db: Db, mediaId: string | null, userId: string): MediaFile | undefined {
    if (!mediaId) return undefined;
    const row = db
      .select()
      .from(mediaAsset)
      .where(and(eq(mediaAsset.id, mediaId), eq(mediaAsset.userId, userId)))
      .get();
    if (!row) return undefined;
    return {
      path: join(mediaDir, row.storagePath),
      fileName: row.fileName,
      mimeType: row.mimeType,
      sizeBytes: row.sizeBytes,
    };
  }

  function loadMedia(db: Db, postId: string): MediaFile[] {
    return db
      .select({
        storagePath: mediaAsset.storagePath,
        fileName: mediaAsset.fileName,
        mimeType: mediaAsset.mimeType,
        sizeBytes: mediaAsset.sizeBytes,
      })
      .from(postMedia)
      .innerJoin(mediaAsset, eq(mediaAsset.id, postMedia.mediaId))
      .where(eq(postMedia.postId, postId))
      .orderBy(asc(postMedia.position))
      .all()
      .map(({ storagePath, ...file }) => ({ ...file, path: join(mediaDir, storagePath) }));
  }

  const finish = (target: ClaimedTarget, changes: Partial<typeof postTarget.$inferInsert>) =>
    database.transaction(
      database.use((db) => {
        db.update(postTarget)
          .set({ lockedAt: null, ...changes })
          .where(eq(postTarget.id, target.id))
          .run();
        refreshPostStatus(db, target.postId);
      }),
    );

  const publishTarget = (target: ClaimedTarget) => {
    let phase: Phase = 'prepare';
    let platform = 'platform';

    const attempt = Effect.gen(function* () {
      const { account, content } = yield* database.use((db) => ({
        account: db
          .select()
          .from(socialAccount)
          .where(eq(socialAccount.id, target.socialAccountId))
          .get(),
        content: db.select().from(post).where(eq(post.id, target.postId)).get(),
      }));
      if (!account || !content) {
        return yield* finish(target, {
          status: 'failed',
          lastError: 'The post or account no longer exists.',
        });
      }
      platform = account.platform;

      if (account.status !== 'active' || !account.credentials) {
        return yield* platformError(
          platform,
          'Reconnect this account on the Accounts page, then retry.',
          { retryable: false },
        );
      }
      const adapter = (yield* providerApps.current).adapter(account.platform);
      if (!adapter) {
        const label =
          PROVIDERS.find((p) => p.platforms.includes(account.platform))?.label ?? platform;
        return yield* platformError(
          platform,
          `${label} is not set up. Add its app credentials on the Accounts page, then retry.`,
          { retryable: false },
        );
      }

      phase = 'refresh';
      let credentials = yield* vault.decrypt(account.credentials);
      const refreshed = yield* refreshIfExpiring(adapter, credentials, account.tokenExpiresAt);
      if (refreshed) {
        credentials = refreshed.credentials;
        const stored = vault.encrypt(refreshed.credentials);
        const tokenExpiresAt = refreshed.tokenExpiresAt;
        yield* database.use((db) =>
          db
            .update(socialAccount)
            .set({ credentials: stored, tokenExpiresAt })
            .where(eq(socialAccount.id, account.id))
            .run(),
        );
      }

      phase = 'publish';
      const body = bodyFormats(content.body);
      const files = yield* database.use((db) => ({
        media: loadMedia(db, content.id),
        featuredImage: mediaFile(db, content.featuredMediaId, content.userId),
        thumbnail: mediaFile(db, content.thumbnailMediaId, content.userId),
        inlineImages: inlineMediaIds(content.body).flatMap((mediaId) => {
          const file = mediaFile(db, mediaId, content.userId);
          return file ? [{ ref: inlineRef(mediaId), file }] : [];
        }),
      }));
      const result = yield* adapter.publish(credentials, {
        title: content.title,
        text: target.captionOverride ?? body.text,
        html: body.html,
        link: content.link ?? undefined,
        ...files,
        wordpress: content.wordpressOptions
          ? {
              tags: content.wordpressOptions.tags,
              categoryIds: content.wordpressOptions.categories[account.id] ?? [],
            }
          : undefined,
      });
      yield* finish(target, {
        status: 'published',
        externalPostId: result.externalId,
        externalUrl: result.url ?? null,
        publishedAt: yield* now,
        // Kept on published targets so the owner sees partial problems (e.g. no thumbnail).
        lastError: result.warning ?? null,
        nextAttemptAt: null,
      });
      yield* Effect.logInfo(`[publisher] published ${target.id} to ${platform}`);
    });

    return attempt.pipe(
      Effect.catchCause((cause) => recordFailure(target, cause, phase, platform)),
      // Never cut short: a half-finished upload must be recorded, not abandoned.
      Effect.uninterruptible,
    );
  };

  const recordFailure = Effect.fnUntraced(function* (
    target: ClaimedTarget,
    cause: Cause.Cause<unknown>,
    phase: Phase,
    platform: string,
  ) {
    const error = Cause.squash(cause);
    if (error instanceof PlatformError) {
      const delay = RETRY_DELAYS_MS[target.attempts - 1];
      if (error.retryable && delay !== undefined) {
        return yield* finish(target, {
          status: 'pending',
          lastError: error.message,
          nextAttemptAt: new Date((yield* Clock.currentTimeMillis) + delay),
        });
      }
      if (phase === 'refresh' && !error.retryable) {
        // The platform rejected the refresh token: the owner has to reconnect.
        yield* database.use((db) =>
          db
            .update(socialAccount)
            .set({ status: 'expired' })
            .where(eq(socialAccount.id, target.socialAccountId))
            .run(),
        );
      }
      return yield* finish(target, { status: 'failed', lastError: error.message });
    }

    // Anything else (a network failure, a bug): the outcome is unknown, so never retry it.
    yield* Effect.logError(`[publisher] ${target.id} (${platform})`, cause);
    const message = error instanceof Error ? error.message : String(error);
    yield* finish(target, {
      status: 'failed',
      // A network failure mid-publish is ambiguous: the platform may have received the post.
      lastError:
        phase === 'publish'
          ? `${message}. PostHub could not confirm whether this was posted; check ${platform} before retrying.`
          : message,
    });
  });

  /** Claims due targets into the job set and returns their fibers. */
  const claimJobs = Effect.gen(function* () {
    const at = yield* now;
    yield* database.use((db) => startDuePosts(db, at));
    const started: Array<Fiber.Fiber<void>> = [];
    while ((yield* FiberSet.size(jobs)) < concurrency) {
      const target = yield* database.transaction(database.use((db) => claimNext(db, at)));
      if (!target) break;
      // If even recording the outcome fails (the database itself), the target stays
      // `publishing`, so the next start marks it failed for the owner to check.
      const job = publishTarget(target).pipe(
        Effect.catchCause((cause) => Effect.logError(`[publisher] ${target.id}`, cause)),
      );
      started.push(yield* FiberSet.run(jobs, job));
    }
    return started;
  });

  return Publisher.of({
    recover,
    startJobs: Effect.asVoid(claimJobs),
    tick: Effect.flatMap(claimJobs, (started) => Fiber.awaitAll(started)).pipe(Effect.asVoid),
  });
});

export class Publisher extends Context.Service<Publisher, PublisherService>()(
  '@posthub/api/Publisher',
) {
  static readonly layer = (options: PublisherOptions = {}) =>
    Layer.effect(Publisher, makePublisher(options));
}

/**
 * Runs the publisher in the background: recovers interrupted work, then checks for due posts
 * every `interval`. Closing the layer's scope stops polling and waits for jobs in progress.
 */
export const publisherWorker = (interval: Duration.Input = '5 seconds') =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const publisher = yield* Publisher;
      const interrupted = yield* publisher.recover;
      if (interrupted) {
        yield* Effect.logInfo(`[publisher] marked ${interrupted} interrupted target(s) failed`);
      }
      yield* publisher.startJobs.pipe(
        Effect.catchCause((cause) => Effect.logError('[publisher]', cause)),
        Effect.repeat(Schedule.spaced(interval)),
        Effect.forkScoped,
      );
    }) satisfies Effect.Effect<void, DatabaseError, Publisher | Scope.Scope>,
  );
