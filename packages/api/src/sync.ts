// The sync worker: pulls numbers (and later comments) from platforms in the background.
// Built like the publisher: jobs live in SQLite (`sync_job`), are claimed in a transaction, run in
// a FiberSet, and survive restarts. Unlike publishing, reading is safe to repeat, so a job found
// `running` at startup simply runs again, and every failure is retried later.
import { randomUUID } from 'node:crypto';
import {
  accountMetricSnapshot,
  postMetricSnapshot,
  postTarget,
  socialAccount,
  syncJob,
  type Db,
  type Platform,
  type SyncJobKind,
} from '@posthub/db';
import { PlatformError } from '@posthub/integrations';
import { and, asc, eq, isNotNull, lte, notInArray } from 'drizzle-orm';
import {
  Cause,
  Clock,
  Context,
  Duration,
  Effect,
  Fiber,
  FiberSet,
  Layer,
  Option,
  Schedule,
  type Scope,
} from 'effect';
import { makeCredentialAccess } from './accounts';
import { makeCommentWork } from './comments';
import { nextMetricsRun } from './sync-schedule';
import { ProviderApps } from './provider-apps';
import { Database, type DatabaseError } from './services';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Waits after failed run 1, 2, 3 and later (reads are retried indefinitely, slowly). */
export const SYNC_BACKOFF_MS = [5 * 60_000, 30 * 60_000, 2 * HOUR, 6 * HOUR];

export { nextMetricsRun } from './sync-schedule';

export const ACCOUNT_METRICS_INTERVAL_MS = DAY;

/** Adds a job unless one exists for the subject. Synchronous: call it inside a transaction. */
export function insertSyncJob(
  db: Db,
  job: { kind: SyncJobKind; subjectId: string; socialAccountId: string; nextRunAt: Date },
) {
  db.insert(syncJob)
    .values({ id: randomUUID(), status: 'pending', ...job })
    .onConflictDoNothing()
    .run();
}

/** Restarts an account's paused jobs (after a reconnect) and makes sure it has an account job. */
export function resumeAccountJobs(db: Db, socialAccountId: string, at: Date) {
  db.update(syncJob)
    .set({ status: 'pending', nextRunAt: at, attempts: 0 })
    .where(and(eq(syncJob.socialAccountId, socialAccountId), eq(syncJob.status, 'paused')))
    .run();
  insertSyncJob(db, {
    kind: 'account_metrics',
    subjectId: socialAccountId,
    socialAccountId,
    nextRunAt: at,
  });
}

export interface SyncOptions {
  /** Jobs running at the same time. */
  concurrency?: number;
  /**
   * Calls per platform per pass, so metrics never use up a platform's quota (YouTube uploads
   * share it). The rest wait for the next pass.
   */
  perPlatformPerPass?: number;
}

export interface SyncService {
  /** Puts jobs left `running` back to `pending` and adds missing account jobs. Succeeds with how many were reset. */
  readonly recover: Effect.Effect<number, DatabaseError>;
  /** Claims due jobs up to the concurrency limit, without waiting for them. */
  readonly startJobs: Effect.Effect<void, DatabaseError>;
  /** Like `startJobs`, but waits until the jobs it started have finished. */
  readonly tick: Effect.Effect<void, DatabaseError>;
}

type Job = typeof syncJob.$inferSelect;
/** A job that ran (with its next run, or null when finished) or one that can't run now. */
type Outcome = { _tag: 'ran'; next: number | null } | { _tag: 'stop'; status: 'done' | 'paused' };
const stop = (status: 'done' | 'paused') => ({ _tag: 'stop' as const, status });

export const makeSync = Effect.fnUntraced(function* ({
  concurrency = 2,
  perPlatformPerPass = 20,
}: SyncOptions) {
  const database = yield* Database;
  const providerApps = yield* ProviderApps;
  const credentialAccess = yield* makeCredentialAccess;
  const jobs = yield* FiberSet.make<void>();
  // Comment sync and the outbox (replies, likes, moderation) run in the same job set.
  const commentWork = makeCommentWork({ database, providerApps, credentialAccess });

  const recoverJobs = Effect.flatMap(Clock.currentTimeMillis, (now) =>
    database.transaction(
      database.use((db) => {
        const reset = db
          .update(syncJob)
          .set({ status: 'pending' })
          .where(eq(syncJob.status, 'running'))
          .run().changes;
        const active = db
          .select({ id: socialAccount.id })
          .from(socialAccount)
          .where(eq(socialAccount.status, 'active'))
          .all();
        for (const { id } of active) {
          insertSyncJob(db, {
            kind: 'account_metrics',
            subjectId: id,
            socialAccountId: id,
            nextRunAt: new Date(now),
          });
        }
        return reset;
      }),
    ),
  );

  const recover = Effect.map(
    Effect.all([recoverJobs, commentWork.recoverActions, commentWork.recoverFirstComments]),
    (counts) => counts.reduce((sum, n) => sum + n, 0),
  );

  function claimNext(db: Db, at: Date, exclude: Platform[]): (Job & { platform: Platform }) | null {
    const next = db
      .select({ job: syncJob, platform: socialAccount.platform })
      .from(syncJob)
      .innerJoin(socialAccount, eq(socialAccount.id, syncJob.socialAccountId))
      .where(
        and(
          eq(syncJob.status, 'pending'),
          isNotNull(syncJob.nextRunAt),
          lte(syncJob.nextRunAt, at),
          exclude.length ? notInArray(socialAccount.platform, exclude) : undefined,
        ),
      )
      .orderBy(asc(syncJob.nextRunAt))
      .limit(1)
      .get();
    if (!next) return null;
    db.update(syncJob).set({ status: 'running' }).where(eq(syncJob.id, next.job.id)).run();
    return { ...next.job, status: 'running', platform: next.platform };
  }

  const loadAccount = (id: string) =>
    database.use((db) => db.select().from(socialAccount).where(eq(socialAccount.id, id)).get());

  /** The account's insights adapter and fresh credentials, or why the job can't run. */
  const prepare = Effect.fnUntraced(function* (accountId: string) {
    // Outcome or a ready-to-call adapter.
    const account = yield* loadAccount(accountId);
    if (!account) return stop('done');
    if (account.status !== 'active' || !account.credentials) return stop('paused');
    const insights = (yield* providerApps.current).insights(account.platform);
    // No support for this platform (or its app credentials were removed): nothing to read.
    if (!insights) return stop('done');
    const credentials = yield* credentialAccess.fresh(
      { ...account, credentials: account.credentials },
      insights,
    );
    return { _tag: 'ready' as const, account, insights, credentials };
  });

  const runPostMetrics = Effect.fnUntraced(function* (job: Job, now: number) {
    const target = yield* database.use((db) =>
      db.select().from(postTarget).where(eq(postTarget.id, job.subjectId)).get(),
    );
    if (!target?.externalPostId || target.status !== 'published') {
      return stop('done');
    }
    const ready = yield* prepare(job.socialAccountId);
    if (ready._tag === 'stop') return ready;
    const metrics = yield* ready.insights.postMetrics(ready.credentials, target.externalPostId);
    yield* database.use((db) =>
      db
        .insert(postMetricSnapshot)
        .values({
          id: randomUUID(),
          postTargetId: target.id,
          capturedAt: new Date(now),
          views: metrics.views ?? null,
          reach: metrics.reach ?? null,
          likes: metrics.likes ?? null,
          comments: metrics.comments ?? null,
          shares: metrics.shares ?? null,
          saves: metrics.saves ?? null,
          clicks: metrics.clicks ?? null,
          watchTimeSec: metrics.watchTimeSec ?? null,
          raw: metrics.raw,
        })
        .run(),
    );
    const publishedAt = target.publishedAt?.getTime() ?? now;
    return { _tag: 'ran', next: nextMetricsRun(publishedAt, now) } satisfies Outcome;
  });

  const runAccountMetrics = Effect.fnUntraced(function* (job: Job, now: number) {
    const ready = yield* prepare(job.socialAccountId);
    if (ready._tag === 'stop') return ready;
    if (!ready.insights.accountMetrics) return stop('done');
    const metrics = yield* ready.insights.accountMetrics(ready.credentials);
    yield* database.use((db) =>
      db
        .insert(accountMetricSnapshot)
        .values({
          id: randomUUID(),
          socialAccountId: job.socialAccountId,
          capturedAt: new Date(now),
          followers: metrics.followers ?? null,
          reach: metrics.reach ?? null,
          raw: metrics.raw,
        })
        .run(),
    );
    return { _tag: 'ran', next: now + ACCOUNT_METRICS_INTERVAL_MS } satisfies Outcome;
  });

  const runComments = Effect.fnUntraced(function* (job: Job, now: number) {
    const result = yield* commentWork.syncTarget(job.subjectId, now);
    if (result._tag === 'ran') return { _tag: 'ran', next: result.next } satisfies Outcome;
    return stop(result._tag);
  });

  const update = (job: Job, changes: Partial<typeof syncJob.$inferInsert>) =>
    database.use((db) => db.update(syncJob).set(changes).where(eq(syncJob.id, job.id)).run());

  const runJob = (job: Job) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const result =
        job.kind === 'post_metrics'
          ? yield* runPostMetrics(job, now)
          : job.kind === 'comments'
            ? yield* runComments(job, now)
            : yield* runAccountMetrics(job, now);
      const lastRunAt = new Date(now);
      if (result._tag === 'stop') {
        return yield* update(job, { status: result.status, lastRunAt });
      }
      yield* update(job, {
        status: result.next === null ? 'done' : 'pending',
        nextRunAt: result.next === null ? null : new Date(result.next),
        attempts: 0,
        lastRunAt,
        lastError: null,
      });
    }).pipe(
      Effect.catchCause((cause) => recordFailure(job, cause)),
      // Never cut short: the snapshot and the job's next run are always written together.
      Effect.uninterruptible,
    );

  const recordFailure = Effect.fnUntraced(function* (job: Job, cause: Cause.Cause<unknown>) {
    const now = yield* Clock.currentTimeMillis;
    const error = Cause.squash(cause);
    const message = error instanceof Error ? error.message : String(error);
    const attempts = job.attempts + 1;
    const account = yield* loadAccount(job.socialAccountId);

    if (account && account.status !== 'active') {
      // The refresh was rejected (the credential helper marked the account expired): wait for a reconnect.
      return yield* database.use((db) =>
        db
          .update(syncJob)
          .set({ status: 'paused', lastError: message })
          .where(eq(syncJob.socialAccountId, job.socialAccountId))
          .run(),
      );
    }
    if (!(error instanceof PlatformError)) {
      yield* Effect.logError(`[sync] ${job.kind} ${job.subjectId}`, cause);
    }
    const delay = SYNC_BACKOFF_MS[Math.min(attempts - 1, SYNC_BACKOFF_MS.length - 1)]!;
    yield* update(job, {
      status: 'pending',
      attempts,
      lastError: message,
      lastRunAt: new Date(now),
      nextRunAt: new Date(now + delay),
    });
  });

  const claimJobs = Effect.gen(function* () {
    const at = new Date(yield* Clock.currentTimeMillis);
    // Calls per platform in this pass (the quota guard).
    const used = new Map<Platform, number>();
    const started: Array<Fiber.Fiber<void>> = [];
    while ((yield* FiberSet.size(jobs)) < concurrency) {
      const exclude = [...used].filter(([, n]) => n >= perPlatformPerPass).map(([p]) => p);
      const fiber = yield* Effect.uninterruptible(
        Effect.flatMap(
          database.transaction(database.use((db) => claimNext(db, at, exclude))),
          (job) => {
            if (!job) return Effect.succeedNone;
            used.set(job.platform, (used.get(job.platform) ?? 0) + 1);
            return Effect.asSome(
              FiberSet.run(
                jobs,
                runJob(job).pipe(
                  // If even recording fails, the job stays `running` and recover resets it.
                  Effect.catchCause((cause) => Effect.logError(`[sync] ${job.id}`, cause)),
                ),
              ),
            );
          },
        ),
      );
      if (Option.isNone(fiber)) break;
      started.push(fiber.value);
    }
    // Then the outbox and first comments, with whatever room is left.
    const queues = [
      {
        label: '[inbox]',
        claim: (db: Db) => commentWork.claimAction(db, at),
        run: commentWork.runAction,
      },
      {
        label: '[first comment]',
        claim: (db: Db) => commentWork.claimFirstComment(db, at),
        run: commentWork.runFirstComment,
      },
    ] as const;
    for (const queue of queues) {
      while ((yield* FiberSet.size(jobs)) < concurrency) {
        const fiber = yield* Effect.uninterruptible(
          Effect.flatMap(
            database.transaction(database.use((db) => queue.claim(db))),
            (item: { id: string } | null) =>
              item
                ? Effect.asSome(
                    FiberSet.run(
                      jobs,
                      (queue.run as (item: unknown) => Effect.Effect<void, unknown>)(item).pipe(
                        Effect.catchCause((cause) =>
                          Effect.logError(`${queue.label} ${item.id}`, cause),
                        ),
                      ),
                    ),
                  )
                : Effect.succeedNone,
          ),
        );
        if (Option.isNone(fiber)) break;
        started.push(fiber.value);
      }
    }
    return started;
  });

  return Sync.of({
    recover,
    startJobs: Effect.asVoid(claimJobs),
    tick: Effect.flatMap(claimJobs, (started) => Fiber.awaitAll(started)).pipe(Effect.asVoid),
  });
});

export class Sync extends Context.Service<Sync, SyncService>()('@posthub/api/Sync') {
  static readonly layer = (options: SyncOptions = {}) => Layer.effect(Sync, makeSync(options));
}

/**
 * Runs the sync worker in the background: recovers, then looks for due jobs every `interval`.
 * Closing the layer's scope stops polling and waits for jobs in progress.
 */
export const syncWorker = (interval: Duration.Input = '30 seconds') =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const sync = yield* Sync;
      const reset = yield* sync.recover;
      if (reset) yield* Effect.logInfo(`[sync] resumed ${reset} interrupted job(s)`);
      yield* sync.startJobs.pipe(
        Effect.catchCause((cause) => Effect.logError('[sync]', cause)),
        Effect.repeat(Schedule.spaced(interval)),
        Effect.forkScoped,
      );
    }) satisfies Effect.Effect<void, DatabaseError, Sync | Scope.Scope>,
  );
