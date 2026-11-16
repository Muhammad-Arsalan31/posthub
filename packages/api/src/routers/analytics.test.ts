import {
  accountMetricSnapshot,
  post,
  postMetricSnapshot,
  postTarget,
  socialAccount,
  type Db,
} from '@posthub/db';
import { createTestDb, seedUser } from '@posthub/db/testing';
import { describe, expect, it } from 'vite-plus/test';
import { sessionFor, testContext } from '../testing';

const range = { from: new Date('2030-01-08T00:00:00Z'), to: new Date('2030-01-14T23:59:59Z') };

function seed(db: Db, userId: string) {
  const accountId = crypto.randomUUID();
  db.insert(socialAccount)
    .values({
      id: accountId,
      userId,
      platform: 'youtube',
      externalId: accountId,
      displayName: 'Channel',
    })
    .run();
  const postId = crypto.randomUUID();
  db.insert(post).values({ id: postId, userId, title: 'Video', status: 'published' }).run();
  const targetId = crypto.randomUUID();
  db.insert(postTarget)
    .values({
      id: targetId,
      postId,
      socialAccountId: accountId,
      status: 'published',
      publishedAt: new Date('2030-01-06T09:00:00Z'),
    })
    .run();
  const snapshot = (iso: string, views: number, likes: number) =>
    db
      .insert(postMetricSnapshot)
      .values({
        id: crypto.randomUUID(),
        postTargetId: targetId,
        capturedAt: new Date(iso),
        views,
        likes,
      })
      .run();
  snapshot('2030-01-06T10:00:00Z', 100, 2);
  snapshot('2030-01-10T10:00:00Z', 400, 6);
  for (const [iso, followers] of [
    ['2030-01-05T00:00:00Z', 50],
    ['2030-01-12T00:00:00Z', 65],
  ] as const) {
    db.insert(accountMetricSnapshot)
      .values({
        id: crypto.randomUUID(),
        socialAccountId: accountId,
        capturedAt: new Date(iso),
        followers,
      })
      .run();
  }
  return { accountId, postId };
}

describe('analytics', () => {
  it('uses only snapshots up to the end of a historical content breakdown', async () => {
    const db = createTestDb();
    const user = seedUser(db);
    const { postId } = seed(db, user.id);
    const target = db
      .select()
      .from(postTarget)
      .all()
      .find((t) => t.postId === postId)!;
    db.insert(postMetricSnapshot)
      .values({
        id: crypto.randomUUID(),
        postTargetId: target.id,
        capturedAt: new Date('2030-02-01T00:00:00Z'),
        likes: 100,
        views: 1000,
      })
      .run();
    const ctx = testContext(db, sessionFor(user));
    expect(
      await ctx.api.analytics.byContentType({
        from: new Date('2030-01-01T00:00:00Z'),
        to: range.to,
      }),
    ).toEqual([{ contentType: 'text', posts: 1, averageEngagement: 6, averageRate: 6 / 400 }]);
  });

  it('summarises the period against the previous one, with follower growth', async () => {
    const db = createTestDb();
    const ctx = testContext(db, sessionFor(seedUser(db)));
    const { accountId, postId } = seed(db, ctx.session!.user.id);
    // Days are counted in the owner's time zone.
    await ctx.api.queue.saveSlots({ timezone: 'UTC', slots: [] });

    const overview = await ctx.api.analytics.overview(range);
    const value = (list: typeof overview.totals, metric: string) =>
      list.find((t) => t.metric === metric)!.value;
    expect(value(overview.totals, 'views')).toBe(300);
    expect(value(overview.previous, 'views')).toBe(100);
    expect(value(overview.totals, 'engagement')).toBe(4);
    expect(overview.byPlatform.map((p) => p.platform)).toEqual(['youtube']);
    expect(overview.followers).toEqual([
      { accountId, displayName: 'Channel', platform: 'youtube', followers: 65, change: 15 },
    ]);

    const top = await ctx.api.analytics.topPosts({
      from: new Date('2030-01-01'),
      to: range.to,
      metric: 'views',
      limit: 5,
    });
    expect(top).toMatchObject([{ postId, value: 400, platforms: ['youtube'] }]);

    const series = await ctx.api.analytics.timeseries({
      ...range,
      metric: 'views',
      groupBy: 'day',
    });
    expect(series.points).toHaveLength(7);
    expect(series.points.find((p) => p.bucket === '2030-01-10')!.values).toEqual({ youtube: 300 });
  });

  it("never shows another user's numbers", async () => {
    const db = createTestDb();
    const owner = testContext(db, sessionFor(seedUser(db)));
    const { accountId } = seed(db, owner.session!.user.id);
    const other = testContext(db, sessionFor(seedUser(db)));

    const overview = await other.api.analytics.overview({ ...range, accountIds: [accountId] });
    expect(overview.totals.every((t) => t.value === null)).toBe(true);
    expect(overview.followers).toEqual([]);
    expect(await other.api.analytics.topPosts({ ...range, metric: 'views', limit: 5 })).toEqual([]);
    expect((await other.api.analytics.bestTimes({})).cells).toEqual([]);
    expect(await other.api.analytics.byContentType(range)).toEqual([]);
  });
});
