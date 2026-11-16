import { postTarget, socialAccount, type Db } from '@posthub/db';
import { createTestDb, seedUser } from '@posthub/db/testing';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vite-plus/test';
import { sessionFor, testContext } from '../testing';

function setup() {
  const db = createTestDb();
  const ctx = testContext(db, sessionFor(seedUser(db)));
  const add = (platform: 'wordpress' | 'instagram') =>
    db
      .insert(socialAccount)
      .values({
        id: crypto.randomUUID(),
        userId: ctx.session!.user.id,
        platform,
        externalId: crypto.randomUUID(),
        displayName: platform,
        credentials: 'x',
      })
      .returning()
      .get();
  return { db, ctx, add };
}

const setTarget = (db: Db, id: string, changes: Partial<typeof postTarget.$inferInsert>) =>
  db.update(postTarget).set(changes).where(eq(postTarget.id, id)).run();

describe('first comment endpoints', () => {
  it('saves the first comment and the pin wish, trimmed', async () => {
    const { ctx, add } = setup();
    const account = add('wordpress');
    const created = await ctx.api.posts.create({
      id: crypto.randomUUID(),
      title: 'Hi',
      accountIds: [account.id],
      firstComment: '  Link in here  ',
      pinFirstComment: true,
    });
    expect(created).toMatchObject({ firstComment: 'Link in here', pinFirstComment: true });
    expect(created.targets[0]).toMatchObject({ firstCommentStatus: 'none', pinnedAt: null });
  });

  it('checks the comment against the platform when scheduling', async () => {
    const { ctx, add } = setup();
    const account = add('wordpress');
    const instagram = add('instagram');
    const tags = Array.from({ length: 31 }, (_, i) => `#tag${i}`).join(' ');
    const schedule = (accountIds: string[]) =>
      ctx.api.posts.create({
        id: crypto.randomUUID(),
        title: 'Hi',
        body: 'Text',
        status: 'scheduled',
        scheduledAt: new Date(Date.now() + 3600_000),
        accountIds,
        firstComment: tags,
      });
    await expect(schedule([instagram.id])).rejects.toSatisfy(
      (e) => e._tag === 'BadRequest' && e.message.includes('at most 30 hashtags'),
    );
    // WordPress has no such limit.
    await expect(schedule([account.id])).resolves.toMatchObject({ status: 'scheduled' });
  });

  it('retries only failed comments, and marks pins only on posted ones', async () => {
    const { db, ctx, add } = setup();
    const account = add('wordpress');
    const created = await ctx.api.posts.create({
      id: crypto.randomUUID(),
      title: 'Hi',
      accountIds: [account.id],
      firstComment: 'Hello',
      pinFirstComment: true,
    });
    const targetId = created.targets[0]!.id;
    const conflict = (e: { _tag: string }) => e._tag === 'Conflict';

    await expect(ctx.api.posts.retryFirstComment({ targetId })).rejects.toSatisfy(conflict);
    await expect(ctx.api.posts.markPinned({ targetId, pinned: true })).rejects.toSatisfy(conflict);

    setTarget(db, targetId, {
      status: 'published',
      firstCommentStatus: 'failed',
      firstCommentAttempts: 3,
    });
    const retried = await ctx.api.posts.retryFirstComment({ targetId });
    expect(retried.targets[0]!.firstCommentStatus).toBe('pending');
    expect(db.select().from(postTarget).get()).toMatchObject({
      firstCommentCheck: true,
      firstCommentAttempts: 0,
    });

    setTarget(db, targetId, { firstCommentStatus: 'posted' });
    const pinned = await ctx.api.posts.markPinned({ targetId, pinned: true });
    expect(pinned.targets[0]!.pinnedAt).toBeInstanceOf(Date);

    const other = testContext(db, sessionFor(seedUser(db)));
    await expect(other.api.posts.markPinned({ targetId, pinned: false })).rejects.toSatisfy(
      (e) => e._tag === 'NotFound',
    );
  });
});
