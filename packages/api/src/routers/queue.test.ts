import { post, socialAccount, type Db } from '@posthub/db';
import { createTestDb, seedUser } from '@posthub/db/testing';
import { describe, expect, it } from 'vite-plus/test';
import { sessionFor, testContext, type TestContext } from '../testing';

function addAccount(db: Db, userId: string) {
  return db
    .insert(socialAccount)
    .values({
      id: crypto.randomUUID(),
      userId,
      platform: 'wordpress',
      externalId: crypto.randomUUID(),
      displayName: 'Blog',
      credentials: 'x',
    })
    .returning()
    .get();
}

function setup() {
  const db = createTestDb();
  const ctx = testContext(db, sessionFor(seedUser(db)));
  const account = addAccount(db, ctx.session!.user.id);
  const draft = (title = 'Draft') =>
    ctx.api.posts.create({ id: crypto.randomUUID(), title, body: 'Hi', accountIds: [account.id] });
  return { db, ctx, account, draft };
}

/** Every day at 09:00 and 17:00 UTC. */
const everyDay = (ctx: TestContext) =>
  ctx.api.queue.saveSlots({
    timezone: 'UTC',
    slots: [0, 1, 2, 3, 4, 5, 6].flatMap((weekday) => [
      { weekday, minuteOfDay: 9 * 60, socialAccountId: null },
      { weekday, minuteOfDay: 17 * 60, socialAccountId: null },
    ]),
  });

describe('queue', () => {
  it('saves slots and the time zone, scoped to the owner', async () => {
    const { db, ctx, account } = setup();
    const saved = await ctx.api.queue.saveSlots({
      timezone: 'Europe/Berlin',
      slots: [
        { weekday: 3, minuteOfDay: 600, socialAccountId: account.id },
        { weekday: 1, minuteOfDay: 540, socialAccountId: null },
        { weekday: 1, minuteOfDay: 540, socialAccountId: null },
      ],
    });
    expect(saved).toEqual({
      timezone: 'Europe/Berlin',
      slots: [
        { weekday: 1, minuteOfDay: 540, socialAccountId: null },
        { weekday: 3, minuteOfDay: 600, socialAccountId: account.id },
      ],
    });

    const other = testContext(db, sessionFor(seedUser(db)));
    expect((await other.api.queue.slots()).slots).toEqual([]);
    // Someone else's account can't be used.
    await expect(
      other.api.queue.saveSlots({
        timezone: 'UTC',
        slots: [{ weekday: 1, minuteOfDay: 60, socialAccountId: account.id }],
      }),
    ).rejects.toSatisfy((e) => e._tag === 'BadRequest');
    expect((await ctx.api.queue.slots()).slots).toHaveLength(2);
  });

  it('rejects unknown time zones and impossible times', async () => {
    const { ctx } = setup();
    const response = await ctx.fetch('/rpc/queue/slots', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        timezone: 'Mars/Olympus',
        slots: [{ weekday: 7, minuteOfDay: 2000, socialAccountId: null }],
      }),
    });
    expect(response.status).toBe(400);
  });

  it('enqueues posts into free slots in order, skipping taken ones', async () => {
    const { db, ctx, draft } = setup();
    await everyDay(ctx);
    const first = await draft('First');
    const second = await draft('Second');

    const a = await ctx.api.posts.enqueue({ postId: first.id });
    const b = await ctx.api.posts.enqueue({ postId: second.id });
    expect(a.status).toBe('scheduled');
    expect(b.scheduledAt!.getTime()).toBeGreaterThan(a.scheduledAt!.getTime());
    // Consecutive slots, each at 09:00 or 17:00.
    for (const p of [a, b]) expect([9, 17]).toContain(p.scheduledAt!.getUTCHours());
    expect(b.scheduledAt!.getTime() - a.scheduledAt!.getTime()).toBeLessThanOrEqual(16 * 3600_000);
    const next = (await ctx.api.queue.nextSlot()).at!;
    expect(next.getTime()).toBeGreaterThan(b.scheduledAt!.getTime());
    expect(
      db
        .select()
        .from(post)
        .all()
        .every((p) => p.status === 'scheduled'),
    ).toBe(true);
  });

  it('gives concurrent enqueues different slots', async () => {
    const { ctx, draft } = setup();
    await everyDay(ctx);
    const posts = await Promise.all([draft('A'), draft('B'), draft('C')]);
    const queued = await Promise.all(posts.map((p) => ctx.api.posts.enqueue({ postId: p.id })));
    const times = new Set(queued.map((p) => p.scheduledAt!.getTime()));
    expect(times.size).toBe(3);
  });

  it('fails with Conflict when there are no slots, and for posts that already started', async () => {
    const { db, ctx, draft } = setup();
    const created = await draft();
    await expect(ctx.api.posts.enqueue({ postId: created.id })).rejects.toSatisfy(
      (e) => e._tag === 'Conflict',
    );
    await everyDay(ctx);
    db.update(post).set({ status: 'published' }).run();
    await expect(ctx.api.posts.enqueue({ postId: created.id })).rejects.toSatisfy(
      (e) => e._tag === 'Conflict',
    );
  });

  it("can't enqueue someone else's post", async () => {
    const { db, ctx, draft } = setup();
    await everyDay(ctx);
    const created = await draft();
    const other = testContext(db, sessionFor(seedUser(db)));
    await everyDay(other);
    await expect(other.api.posts.enqueue({ postId: created.id })).rejects.toSatisfy(
      (e) => e._tag === 'NotFound',
    );
  });
});

describe('rescheduling', () => {
  it('refuses to move a post that is no longer editable', async () => {
    const { db, ctx, draft } = setup();
    const created = await draft();
    db.update(post).set({ status: 'publishing' }).run();
    await expect(
      ctx.api.posts.update({ id: created.id, changes: { scheduledAt: new Date('2031-01-01') } }),
    ).rejects.toSatisfy((e) => e._tag === 'Conflict');
  });
});
