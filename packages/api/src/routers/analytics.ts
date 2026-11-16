import { Api, CurrentUser, type AnalyticsOverview } from '@posthub/contract';
import { accountMetricSnapshot, socialAccount, type Db, type Platform } from '@posthub/db';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { Effect } from 'effect';
import { HttpApiBuilder } from 'effect/http-api';
import {
  bestTimes,
  byContentType,
  loadAnalytics,
  timeseries,
  topPosts,
  totals,
  type TargetRow,
} from '../analytics';
import { handlerDatabase } from '../http-support';
import { readTimeZone } from '../queue';
import { Database } from '../services';

interface Range {
  from: Date;
  to: Date;
  accountIds?: readonly string[];
}

/** Followers now (latest count up to `to`) and their change since the last count before `from`. */
function followers(db: Db, userId: string, { from, to, accountIds }: Range) {
  const accounts = db
    .select({
      id: socialAccount.id,
      displayName: socialAccount.displayName,
      platform: socialAccount.platform,
    })
    .from(socialAccount)
    .where(
      and(
        eq(socialAccount.userId, userId),
        accountIds?.length ? inArray(socialAccount.id, [...accountIds]) : undefined,
      ),
    )
    .all();
  if (!accounts.length) return [];
  const snapshots = db
    .select()
    .from(accountMetricSnapshot)
    .where(
      inArray(
        accountMetricSnapshot.socialAccountId,
        accounts.map((a) => a.id),
      ),
    )
    .orderBy(asc(accountMetricSnapshot.capturedAt))
    .all()
    .filter((s) => s.followers !== null);
  return accounts.flatMap((account) => {
    const own = snapshots.filter((s) => s.socialAccountId === account.id);
    const now = own.findLast((s) => s.capturedAt <= to);
    if (!now) return [];
    const before = own.findLast((s) => s.capturedAt < from);
    return [
      {
        accountId: account.id,
        displayName: account.displayName,
        platform: account.platform,
        followers: now.followers,
        change: before ? now.followers! - before.followers! : null,
      },
    ];
  });
}

function overview(db: Db, userId: string, range: Range): AnalyticsOverview {
  const targets = loadAnalytics(db, userId, range.accountIds);
  const from = range.from.getTime();
  const to = range.to.getTime();
  const length = to - from;
  const platforms = [...new Set(targets.map((t) => t.platform))].sort();
  const forPlatform = (platform: Platform) => targets.filter((t) => t.platform === platform);
  return {
    totals: totals(targets, from, to),
    previous: totals(targets, from - length - 1, from - 1),
    byPlatform: platforms.map((platform) => ({
      platform,
      totals: totals(forPlatform(platform), from, to),
    })),
    followers: followers(db, userId, range),
  };
}

export const AnalyticsHandlers = HttpApiBuilder.group(Api, 'analytics', (handlers) =>
  Effect.gen(function* () {
    const { query } = handlerDatabase(yield* Database);

    /** Runs `compute` over the caller's targets (and time zone). */
    const withTargets = <A>(
      accountIds: readonly string[] | undefined,
      compute: (targets: TargetRow[], timeZone: string) => A,
    ) =>
      Effect.flatMap(CurrentUser, (user) =>
        query((db) => compute(loadAnalytics(db, user.id, accountIds), readTimeZone(db, user.id))),
      );

    return handlers.handleAll({
      overview: ({ payload }) =>
        Effect.flatMap(CurrentUser, (user) => query((db) => overview(db, user.id, payload))),

      timeseries: ({ payload }) =>
        withTargets(payload.accountIds, (targets, timeZone) =>
          timeseries(
            targets,
            payload.metric,
            payload.from.getTime(),
            payload.to.getTime(),
            timeZone,
            payload.groupBy,
          ),
        ),

      topPosts: ({ payload }) =>
        withTargets(payload.accountIds, (targets) =>
          topPosts(
            targets,
            payload.metric,
            payload.from.getTime(),
            payload.to.getTime(),
            payload.limit,
          ),
        ),

      bestTimes: ({ payload }) =>
        withTargets(payload.accountIds, (targets, timezone) => ({
          timezone,
          cells: bestTimes(targets, timezone),
        })),

      byContentType: ({ payload }) =>
        withTargets(payload.accountIds, (targets) => {
          const from = payload.from.getTime();
          const to = payload.to.getTime();
          return byContentType(
            targets.filter((t) => t.publishedAt.getTime() >= from && t.publishedAt.getTime() <= to),
            to,
          );
        }),
    });
  }),
);
