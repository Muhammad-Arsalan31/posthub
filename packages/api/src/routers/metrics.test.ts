import { post, postMetricSnapshot, postTarget, socialAccount, syncJob, type Db } from '@posthub/db';
import { createTestDb, seedUser } from '@posthub/db/testing';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vite-plus/test';
import { insertSyncJob } from '../sync';
import { sessionFor, testContext } from '../testing';

function publishedTarget(db: Db, userId: string, platform: 'wordpress' | 'tiktok') {
  const account = db
    .insert(socialAccount)
    .values({
      id: crypto.randomUUID(),
      userId,
      platform,
      externalId: crypto.randomUUID(),
      displayName: platform,
      credentials: 'x',
    })
    .returning()
    .get();
  const postId = crypto.randomUUID();
  db.insert(post).values({ id: postId, userId, title: 'Hi', status: 'published' }).run();
  const target = db
    .insert(postTarget)
    .values({
      id: crypto.randomUUID(),
      postId,
      socialAccountId: account.id,
      status: 'published',
      externalPostId: '1',
    })
    .returning()
    .get();
  return { postId, target, account };
}

const snapshot = (
  db: Db,
  targetId: string,
  at: string,
  values: { views?: number; likes?: number },
) =>
  db
    .insert(postMetricSnapshot)
    .values({
      id: crypto.randomUUID(),
      postTargetId: targetId,
      capturedAt: new Date(at),
      ...values,
    })
    .run();

function setup() {
  const db = createTestDb();
  const ctx = testContext(db, sessionFor(seedUser(db)));
  return { db, ctx, userId: ctx.session!.user.id };
}

describe('metrics', () => {
  it('returns the latest numbers and the history per target', async () => {
    const { db, ctx, userId } = setup();
    const { postId, target, account } = publishedTarget(db, userId, 'wordpress');
    snapshot(db, target.id, '2030-01-01T10:00:00Z', { views: 1 });
    snapshot(db, target.id, '2030-01-01T11:00:00Z', { views: 5, likes: 2 });
    insertSyncJob(db, {
      kind: 'post_metrics',
      subjectId: target.id,
      socialAccountId: account.id,
      nextRunAt: new Date('2030-01-01T12:00:00Z'),
    });

    const [metrics] = await ctx.api.metrics.forPost({ postId });
    expect(metrics).toMatchObject({
      targetId: target.id,
      automatic: true,
      latest: { views: 5, likes: 2, comments: null, source: 'platform' },
      nextRunAt: new Date('2030-01-01T12:00:00Z'),
    });
    expect(metrics!.series).toHaveLength(2);
    expect(await ctx.api.metrics.totals()).toEqual([
      { postId, views: 5, likes: 2, comments: null },
    ]);
  });

  it('is scoped to the owner', async () => {
    const { db, userId } = setup();
    const { postId, target } = publishedTarget(db, userId, 'tiktok');
    snapshot(db, target.id, '2030-01-01T10:00:00Z', { views: 1 });
    const other = testContext(db, sessionFor(seedUser(db)));

    await expect(other.api.metrics.forPost({ postId })).rejects.toSatisfy(
      (e) => e._tag === 'NotFound',
    );
    await expect(other.api.metrics.refresh({ postId })).rejects.toSatisfy(
      (e) => e._tag === 'NotFound',
    );
    await expect(other.api.metrics.setManual({ targetId: target.id, views: 3 })).rejects.toSatisfy(
      (e) => e._tag === 'NotFound',
    );
    expect(await other.api.metrics.totals()).toEqual([]);
  });

  it('takes numbers typed in by hand for platforms PostHub cannot read', async () => {
    const { db, ctx, userId } = setup();
    const { postId, target } = publishedTarget(db, userId, 'tiktok');
    const saved = await ctx.api.metrics.setManual({ targetId: target.id, views: 1200, likes: 80 });
    expect(saved).toMatchObject({
      automatic: false,
      latest: { source: 'manual', views: 1200, likes: 80, comments: null },
    });
    expect((await ctx.api.metrics.totals())[0]).toMatchObject({ postId, views: 1200 });

    db.update(postTarget).set({ status: 'manual' }).where(eq(postTarget.id, target.id)).run();
    await expect(ctx.api.metrics.setManual({ targetId: target.id, views: 1 })).rejects.toSatisfy(
      (e) => e._tag === 'Conflict',
    );
  });

  it('refresh makes the jobs due now, including finished ones', async () => {
    const { db, ctx, userId } = setup();
    const { postId, target, account } = publishedTarget(db, userId, 'wordpress');
    insertSyncJob(db, {
      kind: 'post_metrics',
      subjectId: target.id,
      socialAccountId: account.id,
      nextRunAt: new Date('2099-01-01'),
    });
    db.update(syncJob).set({ status: 'done', nextRunAt: null }).run();

    await ctx.api.metrics.refresh({ postId });
    const job = db.select().from(syncJob).get()!;
    expect(job.status).toBe('pending');
    expect(job.nextRunAt!.getTime()).toBeLessThanOrEqual(Date.now());
  });
});

describe('accounts: reconnect hints', () => {
  it('asks to reconnect accounts that lack the scopes for metrics', async () => {
    const db = createTestDb();
    const ctx = testContext(db, sessionFor(seedUser(db)), {
      config: { meta: { appId: 'a', appSecret: 's' } },
    });
    const userId = ctx.session!.user.id;
    const add = (externalId: string, grantedScopes: string[] | null) =>
      db
        .insert(socialAccount)
        .values({
          id: crypto.randomUUID(),
          userId,
          platform: 'facebook',
          externalId,
          displayName: externalId,
          credentials: 'x',
          grantedScopes,
        })
        .run();
    add('old', null);
    add('new', ['pages_manage_posts', 'read_insights']);
    publishedTarget(db, userId, 'wordpress');

    const accounts = Object.fromEntries(
      (await ctx.api.accounts.list()).map((a) => [a.displayName, a.reconnectFor]),
    );
    expect(accounts).toEqual({ old: ['metrics', 'comments'], new: ['comments'], wordpress: [] });
  });
});
