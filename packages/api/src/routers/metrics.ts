import { randomUUID } from 'node:crypto';
import { Api, CurrentUser, type PostTotals, type TargetMetrics } from '@posthub/contract';
import { post, postMetricSnapshot, postTarget, socialAccount, syncJob, type Db } from '@posthub/db';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { Clock, Effect } from 'effect';
import { HttpApiBuilder } from 'effect/http-api';
import { conflict, handlerDatabase, notFound } from '../http-support';
import { ProviderApps } from '../provider-apps';
import { Database } from '../services';

type Snapshot = typeof postMetricSnapshot.$inferSelect;

const toSnapshot = ({ id: _id, postTargetId: _target, raw: _raw, ...rest }: Snapshot) => rest;

/** The caller's targets of a post, with their platform. */
const ownTargets = (db: Db, userId: string, postId: string) =>
  db
    .select({ id: postTarget.id, status: postTarget.status, platform: socialAccount.platform })
    .from(postTarget)
    .innerJoin(post, eq(post.id, postTarget.postId))
    .innerJoin(socialAccount, eq(socialAccount.id, postTarget.socialAccountId))
    .where(and(eq(post.id, postId), eq(post.userId, userId)))
    .orderBy(asc(postTarget.createdAt))
    .all();

function metricsFor(
  db: Db,
  targets: Array<{ id: string; platform: string }>,
  automatic: (platform: string) => boolean,
): TargetMetrics[] {
  const ids = targets.map((t) => t.id);
  if (!ids.length) return [];
  const snapshots = db
    .select()
    .from(postMetricSnapshot)
    .where(inArray(postMetricSnapshot.postTargetId, ids))
    .orderBy(asc(postMetricSnapshot.capturedAt))
    .all();
  const jobs = db
    .select()
    .from(syncJob)
    .where(and(eq(syncJob.kind, 'post_metrics'), inArray(syncJob.subjectId, ids)))
    .all();
  return targets.map((target) => {
    const series = snapshots.filter((s) => s.postTargetId === target.id).map(toSnapshot);
    const job = jobs.find((j) => j.subjectId === target.id);
    return {
      targetId: target.id,
      latest: series.at(-1) ?? null,
      series,
      automatic: automatic(target.platform),
      lastRunAt: job?.lastRunAt ?? null,
      nextRunAt: job?.status === 'pending' ? job.nextRunAt : null,
      lastError: job?.lastError ?? null,
    };
  });
}

/** Latest snapshot per target, summed per post. A metric no target has stays null. */
function totals(db: Db, userId: string): PostTotals[] {
  const rows = db
    .select({ postId: postTarget.postId, snapshot: postMetricSnapshot })
    .from(postMetricSnapshot)
    .innerJoin(postTarget, eq(postTarget.id, postMetricSnapshot.postTargetId))
    .innerJoin(post, eq(post.id, postTarget.postId))
    .where(eq(post.userId, userId))
    .orderBy(asc(postMetricSnapshot.capturedAt))
    .all();
  const latest = new Map<string, { postId: string; snapshot: Snapshot }>();
  for (const row of rows) latest.set(row.snapshot.postTargetId, row);
  const byPost = new Map<string, PostTotals>();
  const add = (a: number | null, b: number | null) => (b === null ? a : (a ?? 0) + b);
  for (const { postId, snapshot } of latest.values()) {
    const sum = byPost.get(postId) ?? { postId, views: null, likes: null, comments: null };
    byPost.set(postId, {
      postId,
      views: add(sum.views, snapshot.views),
      likes: add(sum.likes, snapshot.likes),
      comments: add(sum.comments, snapshot.comments),
    });
  }
  return [...byPost.values()];
}

export const MetricsHandlers = HttpApiBuilder.group(Api, 'metrics', (handlers) =>
  Effect.gen(function* () {
    const { query } = handlerDatabase(yield* Database);
    const providerApps = yield* ProviderApps;

    const automatic = Effect.map(
      providerApps.current,
      (integrations) => (platform: string) =>
        Boolean(integrations.insights(platform as Parameters<typeof integrations.insights>[0])),
    );

    const forPost = (userId: string, postId: string) =>
      Effect.gen(function* () {
        const isAutomatic = yield* automatic;
        const result = yield* query((db) => {
          const targets = ownTargets(db, userId, postId);
          return targets.length ? metricsFor(db, targets, isAutomatic) : null;
        });
        return result ?? (yield* notFound());
      });

    return handlers.handleAll({
      forPost: ({ payload }) =>
        Effect.flatMap(CurrentUser, (user) => forPost(user.id, payload.postId)),

      totals: () => Effect.flatMap(CurrentUser, (user) => query((db) => totals(db, user.id))),

      refresh: ({ payload }) =>
        Effect.gen(function* () {
          const user = yield* CurrentUser;
          const now = new Date(yield* Clock.currentTimeMillis);
          const targets = yield* query((db) => ownTargets(db, user.id, payload.postId));
          if (!targets.length) return yield* notFound();
          yield* query((db) =>
            db
              .update(syncJob)
              // Finished jobs (old posts) run once more; paused ones wait for a reconnect.
              .set({ status: 'pending', nextRunAt: now })
              .where(
                and(
                  eq(syncJob.kind, 'post_metrics'),
                  inArray(
                    syncJob.subjectId,
                    targets.map((t) => t.id),
                  ),
                  inArray(syncJob.status, ['pending', 'done']),
                ),
              )
              .run(),
          );
          return { ok: true };
        }),

      setManual: ({ payload }) =>
        Effect.gen(function* () {
          const user = yield* CurrentUser;
          const capturedAt = new Date(yield* Clock.currentTimeMillis);
          const target = yield* query((db) =>
            db
              .select({ id: postTarget.id, status: postTarget.status, postId: postTarget.postId })
              .from(postTarget)
              .innerJoin(post, eq(post.id, postTarget.postId))
              .where(and(eq(postTarget.id, payload.targetId), eq(post.userId, user.id)))
              .get(),
          );
          if (!target) return yield* notFound();
          if (target.status !== 'published') {
            return yield* conflict('Numbers can be entered once the post is published.');
          }
          yield* query((db) =>
            db
              .insert(postMetricSnapshot)
              .values({
                id: randomUUID(),
                postTargetId: target.id,
                capturedAt,
                source: 'manual',
                views: payload.views ?? null,
                likes: payload.likes ?? null,
                comments: payload.comments ?? null,
                shares: payload.shares ?? null,
                raw: {},
              })
              .run(),
          );
          const all = yield* forPost(user.id, target.postId);
          return all.find((m) => m.targetId === target.id)!;
        }),
    });
  }),
);
