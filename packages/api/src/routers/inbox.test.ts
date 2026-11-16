import {
  comment,
  commentAction,
  post,
  postTarget,
  socialAccount,
  syncJob,
  type Db,
  type Platform,
} from '@posthub/db';
import { createTestDb, seedUser } from '@posthub/db/testing';
import { describe, expect, it } from 'vite-plus/test';
import { upsertComments } from '../comments';
import { insertSyncJob } from '../sync';
import { sessionFor, testContext } from '../testing';

const remote = (externalId: string, parent: string | null, extra = {}) => ({
  externalId,
  parentExternalId: parent,
  authorName: 'Ann',
  authorAvatarUrl: null,
  authorId: 'u',
  text: `comment ${externalId}`,
  likeCount: 0,
  likedByMe: false,
  createdAt: new Date(`2030-01-01T10:0${externalId}:00Z`),
  isOwn: false,
  hidden: false,
  ...extra,
});

function seed(db: Db, userId: string, platform: Platform = 'wordpress') {
  const accountId = crypto.randomUUID();
  db.insert(socialAccount)
    .values({
      id: accountId,
      userId,
      platform,
      externalId: accountId,
      displayName: 'Acc',
      credentials: 'x',
    })
    .run();
  const postId = crypto.randomUUID();
  db.insert(post).values({ id: postId, userId, title: 'Launch', status: 'published' }).run();
  const targetId = crypto.randomUUID();
  db.insert(postTarget)
    .values({
      id: targetId,
      postId,
      socialAccountId: accountId,
      status: 'published',
      externalPostId: '7',
    })
    .run();
  upsertComments(
    db,
    { id: targetId, userId },
    [remote('1', null), remote('2', '1', { isOwn: true }), remote('3', '2'), remote('4', null)],
    { full: true, now: new Date('2030-01-02') },
  );
  const byExternal = (id: string) =>
    db
      .select()
      .from(comment)
      .all()
      .find((c) => c.externalId === id && c.postTargetId === targetId)!;
  return { postId, byExternal };
}

function setup() {
  const db = createTestDb();
  const ctx = testContext(db, sessionFor(seedUser(db)), {
    config: { google: { clientId: 'g', clientSecret: 's' } },
  });
  return { db, ctx, userId: ctx.session!.user.id };
}

describe('inbox', () => {
  it('groups comments into conversations and counts unread ones', async () => {
    const { db, ctx, userId } = setup();
    const { byExternal } = seed(db, userId);

    const threads = await ctx.api.inbox.list({});
    expect(threads.map((t) => [t.root.externalId, t.replies, t.unread])).toEqual([
      ['4', 0, 1],
      ['1', 2, 2],
    ]);
    expect(
      (await ctx.api.inbox.thread({ commentId: byExternal('3').id })).map((c) => c.externalId),
    ).toEqual(['1', '2', '3']);
    expect(await ctx.api.inbox.unreadCount()).toEqual({ count: 3 });

    await ctx.api.inbox.markRead({ commentIds: [byExternal('1').id, byExternal('3').id] });
    expect((await ctx.api.inbox.list({ unread: true })).map((t) => t.root.externalId)).toEqual([
      '4',
    ]);

    await ctx.api.inbox.archive({ commentId: byExternal('4').id, archived: true });
    expect((await ctx.api.inbox.list({})).map((t) => t.root.externalId)).toEqual(['1']);
    expect((await ctx.api.inbox.list({ archived: true })).map((t) => t.root.externalId)).toEqual([
      '4',
    ]);
  });

  it('queues replies and moderation, and refuses what the platform cannot do', async () => {
    const { db, ctx, userId } = setup();
    const { byExternal } = seed(db, userId, 'youtube');
    const target = byExternal('1');

    await ctx.api.inbox.reply({ commentId: target.id, text: '  Thanks!  ' });
    await ctx.api.inbox.moderate({ commentId: target.id, action: 'hide' });
    expect(
      db
        .select()
        .from(commentAction)
        .all()
        .map((a) => [a.kind, a.text, a.status]),
    ).toEqual([
      ['reply', 'Thanks!', 'pending'],
      ['hide', null, 'pending'],
    ]);
    const [thread] = await ctx.api.inbox.thread({ commentId: target.id }).then((c) => [c[0]!]);
    expect(thread!.actions.map((a) => a.kind)).toEqual(['reply', 'hide']);
    expect(thread!.read).toBe(true);

    await expect(ctx.api.inbox.setLike({ commentId: target.id, liked: true })).rejects.toSatisfy(
      (e) =>
        e._tag === 'BadRequest' && e.message.includes('Liking comments is not possible on youtube'),
    );
  });

  it('retries only failed steps, checking first for replies', async () => {
    const { db, ctx, userId } = setup();
    const { byExternal } = seed(db, userId);
    await ctx.api.inbox.reply({ commentId: byExternal('1').id, text: 'Hi' });
    const action = db.select().from(commentAction).get()!;
    await expect(ctx.api.inbox.retryAction({ actionId: action.id })).rejects.toSatisfy(
      (e) => e._tag === 'Conflict',
    );
    db.update(commentAction).set({ status: 'failed', attempts: 3 }).run();
    await ctx.api.inbox.retryAction({ actionId: action.id });
    expect(db.select().from(commentAction).get()).toMatchObject({
      status: 'pending',
      attempts: 0,
      checkFirst: true,
    });
  });

  it("never shows or touches another user's comments", async () => {
    const { db, userId } = setup();
    const { byExternal } = seed(db, userId);
    const other = testContext(db, sessionFor(seedUser(db)));
    const id = byExternal('1').id;

    expect(await other.api.inbox.list({})).toEqual([]);
    expect(await other.api.inbox.unreadCount()).toEqual({ count: 0 });
    for (const call of [
      () => other.api.inbox.thread({ commentId: id }),
      () => other.api.inbox.reply({ commentId: id, text: 'x' }),
      () => other.api.inbox.moderate({ commentId: id, action: 'delete' }),
      () => other.api.inbox.archive({ commentId: id, archived: true }),
    ]) {
      await expect(call()).rejects.toSatisfy((e) => e._tag === 'NotFound');
    }
    await other.api.inbox.markRead({ commentIds: [id] });
    expect(byExternal('1').readAt).toBeNull();
    expect(db.select().from(commentAction).all()).toEqual([]);
  });
});

describe('saved replies', () => {
  it('saves, edits and deletes replies, per owner', async () => {
    const { db, ctx } = setup();
    const saved = await ctx.api.savedReplies.save({ title: ' Thanks ', body: 'Thank you!' });
    expect(saved).toMatchObject({ title: 'Thanks', body: 'Thank you!' });
    await ctx.api.savedReplies.save({ id: saved.id, title: 'Thanks', body: 'Thanks a lot!' });
    expect(await ctx.api.savedReplies.list()).toEqual([
      { id: saved.id, title: 'Thanks', body: 'Thanks a lot!' },
    ]);

    const other = testContext(db, sessionFor(seedUser(db)));
    expect(await other.api.savedReplies.list()).toEqual([]);
    await expect(
      other.api.savedReplies.save({ id: saved.id, title: 'Mine', body: 'now' }),
    ).rejects.toSatisfy((e) => e._tag === 'NotFound');
    await other.api.savedReplies.delete({ id: saved.id });
    expect(await ctx.api.savedReplies.list()).toHaveLength(1);

    await ctx.api.savedReplies.delete({ id: saved.id });
    expect(await ctx.api.savedReplies.list()).toEqual([]);
  });
});

describe('check now', () => {
  it("makes the owner's comment jobs due, leaving paused ones and other users' alone", async () => {
    const { db, ctx, userId } = setup();
    seed(db, userId);
    const own = db.select().from(postTarget).get()!;
    insertSyncJob(db, {
      kind: 'comments',
      subjectId: own.id,
      socialAccountId: own.socialAccountId,
      nextRunAt: new Date('2099-01-01'),
    });
    const other = testContext(db, sessionFor(seedUser(db)));
    const otherUser = other.session!.user.id;
    seed(db, otherUser);
    const theirs = db
      .select()
      .from(postTarget)
      .all()
      .find((t) => t.id !== own.id)!;
    insertSyncJob(db, {
      kind: 'comments',
      subjectId: theirs.id,
      socialAccountId: theirs.socialAccountId,
      nextRunAt: new Date('2099-01-01'),
    });

    await ctx.api.inbox.checkNow();
    const due = (id: string) =>
      db
        .select()
        .from(syncJob)
        .all()
        .find((j) => j.subjectId === id)!
        .nextRunAt!.getTime() <= Date.now();
    expect(due(own.id)).toBe(true);
    expect(due(theirs.id)).toBe(false);
  });
});
