import { post, postTarget, socialAccount, type Db, type Platform } from '@posthub/db';
import { createTestDb, seedUser } from '@posthub/db/testing';
import { eq } from 'drizzle-orm';
import { Context, Effect } from 'effect';
import { beforeEach, describe, expect, it } from 'vite-plus/test';
import { Database } from '../services';
import { contextFor, sessionFor, testContext, type TestContext } from '../testing';

const TAGS: Record<string, string> = {
  BAD_REQUEST: 'BadRequest',
  NOT_FOUND: 'NotFound',
  CONFLICT: 'Conflict',
  UNAUTHORIZED: 'Unauthorized',
  BAD_GATEWAY: 'BadGateway',
};
const code = (c: string) => (e: unknown) => (e as { _tag?: string } | null)?._tag === TAGS[c];

function seedAccount(ctx: TestContext, platform: Platform, displayName: string = platform) {
  return ctx.db
    .insert(socialAccount)
    .values({
      id: crypto.randomUUID(),
      userId: ctx.session!.user.id,
      platform,
      externalId: crypto.randomUUID(),
      displayName,
      credentials: ctx.vault.encrypt({ token: 't' }),
    })
    .returning()
    .get();
}

const video = new File(['v'], 'clip.mp4', { type: 'video/mp4' });

/** Let the publisher win just before the handler acquires its transaction. */
async function claimBeforeTransaction(ctx: TestContext, postId: string) {
  const services = await ctx.run(Effect.context());
  const database = Context.get(services, Database);
  let claimed = false;
  return contextFor(
    Context.add(services, Database, {
      ...database,
      transaction: (effect) =>
        Effect.suspend(() => {
          if (!claimed) {
            claimed = true;
            ctx.db.update(post).set({ status: 'publishing' }).where(eq(post.id, postId)).run();
            ctx.db.update(postTarget)
              .set({ status: 'publishing', attempts: 1 })
              .where(eq(postTarget.postId, postId)).run();
          }
          return database.transaction(effect);
        }),
    }),
    ctx.session,
    ctx.db,
  );
}

describe('posts router', () => {
  let db: Db;
  let ctx: TestContext;

  beforeEach(() => {
    db = createTestDb();
    ctx = testContext(db, sessionFor(seedUser(db)));
  });

  it('rejects anonymous callers', async () => {
    await expect(testContext(db, null).api.posts.list()).rejects.toSatisfy(code('UNAUTHORIZED'));
  });

  it('creates, lists, updates and deletes a draft', async () => {
    const id = crypto.randomUUID();
    const created = await ctx.api.posts.create({ id, title: '  Launch  ' });
    expect(created).toMatchObject({
      id,
      title: 'Launch',
      body: '',
      link: null,
      status: 'draft',
      accountIds: [],
      mediaIds: [],
      targets: [],
    });

    expect(await ctx.api.posts.list()).toHaveLength(1);

    const updated = await ctx.api.posts.update({
      id,
      changes: { body: 'Hello', link: 'https://example.com' },
    });
    expect(updated).toMatchObject({ title: 'Launch', body: 'Hello', link: 'https://example.com' });

    await ctx.api.posts.delete({ id });
    expect(await ctx.api.posts.list()).toHaveLength(0);
  });

  it('schedules a post with one target per account and keeps media order', async () => {
    const wordpress = seedAccount(ctx, 'wordpress', 'Blog');
    const tiktok = seedAccount(ctx, 'tiktok', 'Me on TikTok');
    const first = await ctx.api.media.upload({ file: video });
    const second = await ctx.api.media.upload({
      file: new File(['i'], 'a.png', { type: 'image/png' }),
    });

    const scheduled = await ctx.api.posts.create({
      id: crypto.randomUUID(),
      title: 'Launch',
      body: 'We are live',
      status: 'scheduled',
      scheduledAt: new Date('2030-01-01T09:00:00Z'),
      accountIds: [wordpress.id, tiktok.id],
      mediaIds: [second.id, first.id],
    });

    expect(scheduled.status).toBe('scheduled');
    expect(scheduled.mediaIds).toEqual([second.id, first.id]);
    expect(Object.fromEntries(scheduled.targets.map((t) => [t.socialAccountId, t.status]))).toEqual(
      { [wordpress.id]: 'pending', [tiktok.id]: 'manual' },
    );

    // Deselecting an account removes its target; keeping one keeps the same row.
    const kept = scheduled.targets.find((t) => t.socialAccountId === wordpress.id)!;
    const updated = await ctx.api.posts.update({
      id: scheduled.id,
      changes: { accountIds: [wordpress.id] },
    });
    expect(updated.targets.map((t) => t.id)).toEqual([kept.id]);
  });

  it('refuses to schedule what a platform cannot publish', async () => {
    const youtube = seedAccount(ctx, 'youtube', 'Channel');
    const base = { title: 'Hi', status: 'scheduled' as const, scheduledAt: new Date() };

    await expect(ctx.api.posts.create({ ...base, id: crypto.randomUUID() })).rejects.toSatisfy(
      (e) => code('BAD_REQUEST')(e) && (e as Error).message.includes('at least one account'),
    );
    await expect(
      ctx.api.posts.create({ ...base, id: crypto.randomUUID(), accountIds: [youtube.id] }),
    ).rejects.toSatisfy((e) => (e as Error).message === 'Channel: YouTube needs a video.');
    await expect(
      ctx.api.posts.create({
        ...base,
        id: crypto.randomUUID(),
        scheduledAt: null,
        accountIds: [youtube.id],
      }),
    ).rejects.toSatisfy((e) => (e as Error).message.includes('date and time'));

    // A draft can be saved with anything selected.
    const draft = await ctx.api.posts.create({
      id: crypto.randomUUID(),
      title: 'Later',
      accountIds: [youtube.id],
    });
    expect(draft.targets).toHaveLength(1);
  });

  it('locks a post once publishing has started', async () => {
    const wordpress = seedAccount(ctx, 'wordpress');
    const id = crypto.randomUUID();
    await ctx.api.posts.create({
      id,
      title: 'Go',
      status: 'scheduled',
      scheduledAt: new Date(),
      accountIds: [wordpress.id],
    });
    // Simulate the publisher having claimed the target.
    db.update(postTarget).set({ status: 'publishing' }).where(eq(postTarget.postId, id)).run();
    db.update(post).set({ status: 'publishing' }).where(eq(post.id, id)).run();

    await expect(ctx.api.posts.update({ id, changes: { title: 'Changed' } })).rejects.toSatisfy(
      code('CONFLICT'),
    );
    await expect(ctx.api.posts.delete({ id })).rejects.toSatisfy(code('CONFLICT'));
  });

  it('retries failed targets and marks manual ones as posted', async () => {
    const wordpress = seedAccount(ctx, 'wordpress');
    const tiktok = seedAccount(ctx, 'tiktok');
    const id = crypto.randomUUID();
    const created = await ctx.api.posts.create({
      id,
      title: 'Go',
      status: 'scheduled',
      scheduledAt: new Date(),
      accountIds: [wordpress.id, tiktok.id],
    });
    const wpTarget = created.targets.find((t) => t.socialAccountId === wordpress.id)!;
    const ttTarget = created.targets.find((t) => t.socialAccountId === tiktok.id)!;

    await expect(ctx.api.posts.retry({ targetId: wpTarget.id })).rejects.toSatisfy(
      code('CONFLICT'),
    );

    db.update(post).set({ status: 'failed' }).where(eq(post.id, id)).run();
    db.update(postTarget)
      .set({ status: 'failed', lastError: 'boom' })
      .where(eq(postTarget.id, wpTarget.id))
      .run();

    const retried = await ctx.api.posts.retry({ targetId: wpTarget.id });
    expect(retried.status).toBe('publishing');
    expect(retried.targets.find((t) => t.id === wpTarget.id)).toMatchObject({
      status: 'pending',
      lastError: null,
    });

    const posted = await ctx.api.posts.markPosted({
      targetId: ttTarget.id,
      url: 'https://tiktok.com/@me/video/1',
    });
    expect(posted.targets.find((t) => t.id === ttTarget.id)).toMatchObject({
      status: 'published',
      externalUrl: 'https://tiktok.com/@me/video/1',
    });
  });

  it('rejects an edit when the publisher claims the post before the save transaction', async () => {
    const account = seedAccount(ctx, 'wordpress');
    const created = await ctx.api.posts.create({
      id: crypto.randomUUID(), title: 'Original', status: 'scheduled',
      scheduledAt: new Date(), accountIds: [account.id],
    });
    const racing = await claimBeforeTransaction(ctx, created.id);
    await expect(racing.api.posts.update({ id: created.id, changes: { title: 'Changed' } }))
      .rejects.toSatisfy(code('CONFLICT'));
    expect(db.select().from(post).where(eq(post.id, created.id)).get())
      .toMatchObject({ title: 'Original', status: 'publishing' });
  });

  it('does not requeue a target claimed after another retry', async () => {
    const account = seedAccount(ctx, 'wordpress');
    const created = await ctx.api.posts.create({
      id: crypto.randomUUID(), title: 'Retry', accountIds: [account.id],
    });
    db.update(post).set({ status: 'failed' }).where(eq(post.id, created.id)).run();
    db.update(postTarget).set({ status: 'failed' }).where(eq(postTarget.postId, created.id)).run();
    const racing = await claimBeforeTransaction(ctx, created.id);
    await expect(racing.api.posts.retry({ targetId: created.targets[0]!.id }))
      .rejects.toSatisfy(code('CONFLICT'));
    expect(db.select().from(postTarget).where(eq(postTarget.postId, created.id)).get())
      .toMatchObject({ status: 'publishing', attempts: 1 });
  });

  it('validates WordPress options in both the client and raw HTTP requests', async () => {
    for (const wordpressOptions of [
      { tags: [' '], categories: {} },
      { tags: ['x'.repeat(101)], categories: {} },
      { tags: Array.from({ length: 51 }, () => 'tag'), categories: {} },
      { tags: [], categories: { site: [-1] } },
      { tags: [], categories: { site: [1.5] } },
      { tags: [], categories: { site: Array.from({ length: 101 }, () => 1) } },
    ]) {
      const input = { id: crypto.randomUUID(), title: 'Invalid options', wordpressOptions };
      await expect(ctx.api.posts.create(input)).rejects.toBeInstanceOf(Error);
      const response = await ctx.fetch('/rpc/posts', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input),
      });
      expect(response.status).toBe(400);
    }
    expect(await ctx.api.posts.list()).toEqual([]);
    const created = await ctx.api.posts.create({
      id: crypto.randomUUID(), title: 'Tags',
      wordpressOptions: { tags: ['  news  '], categories: { site: [1, 2] } },
    });
    expect(created.wordpressOptions).toEqual({ tags: ['news'], categories: { site: [1, 2] } });
  });

  it("hides other users' posts, accounts and media", async () => {
    const id = crypto.randomUUID();
    await ctx.api.posts.create({ id, title: 'Mine' });
    const mine = seedAccount(ctx, 'wordpress');
    const file = await ctx.api.media.upload({ file: video });

    const other = testContext(db, sessionFor(seedUser(db)));
    expect(await other.api.posts.list()).toHaveLength(0);
    await expect(other.api.posts.update({ id, changes: { title: 'Stolen' } })).rejects.toSatisfy(
      code('NOT_FOUND'),
    );
    await expect(
      other.api.posts.create({ id: crypto.randomUUID(), title: 'x', accountIds: [mine.id] }),
    ).rejects.toSatisfy(code('BAD_REQUEST'));
    await expect(
      other.api.posts.create({ id: crypto.randomUUID(), title: 'x', mediaIds: [file.id] }),
    ).rejects.toSatisfy(code('BAD_REQUEST'));
  });

  it('stores image choices per platform and checks them when scheduling', async () => {
    const youtube = seedAccount(ctx, 'youtube', 'Channel');
    const clip = await ctx.api.media.upload({ file: video });
    const gif = await ctx.api.media.upload({
      file: new File(['g'], 't.gif', { type: 'image/gif' }),
    });
    const png = await ctx.api.media.upload({
      file: new File(['p'], 't.png', { type: 'image/png' }),
    });
    const base = {
      title: 'Video',
      status: 'scheduled' as const,
      scheduledAt: new Date('2030-01-01'),
      accountIds: [youtube.id],
      mediaIds: [clip.id],
    };

    await expect(
      ctx.api.posts.create({ ...base, id: crypto.randomUUID(), thumbnailMediaId: clip.id }),
    ).rejects.toSatisfy((e) => (e as Error).message.includes('must be images'));
    await expect(
      ctx.api.posts.create({ ...base, id: crypto.randomUUID(), thumbnailMediaId: gif.id }),
    ).rejects.toSatisfy((e) => (e as Error).message.includes('JPEG or PNG'));

    const created = await ctx.api.posts.create({
      ...base,
      id: crypto.randomUUID(),
      thumbnailMediaId: png.id,
      featuredMediaId: gif.id,
    });
    expect(created).toMatchObject({ thumbnailMediaId: png.id, featuredMediaId: gif.id });

    // In use by a scheduled post: can't delete. Once it's a draft, deleting clears the choice.
    await expect(ctx.api.media.delete({ id: png.id })).rejects.toSatisfy(code('CONFLICT'));
    await ctx.api.posts.update({ id: created.id, changes: { status: 'draft' } });
    await ctx.api.media.delete({ id: png.id });
    const [after] = await ctx.api.posts.list();
    expect(after).toMatchObject({ thumbnailMediaId: null, featuredMediaId: gif.id });
  });

  it('checks images in the text and keeps WordPress options', async () => {
    const png = await ctx.api.media.upload({
      file: new File(['p'], 'p.png', { type: 'image/png' }),
    });
    const clip = await ctx.api.media.upload({ file: video });

    await expect(
      ctx.api.posts.create({
        id: crypto.randomUUID(),
        title: 'x',
        body: `<img src="/files/${clip.id}">`,
      }),
    ).rejects.toSatisfy((e) => (e as Error).message.includes('must be images'));
    await expect(
      ctx.api.posts.create({
        id: crypto.randomUUID(),
        title: 'x',
        body: `<img src="/files/${crypto.randomUUID()}">`,
      }),
    ).rejects.toSatisfy((e) => (e as Error).message.includes('no longer exists'));

    const created = await ctx.api.posts.create({
      id: crypto.randomUUID(),
      title: 'Story',
      body: `<p>Hi</p><img src="/files/${png.id}">`,
      wordpressOptions: { tags: ['news'], categories: { a: [1, 2] } },
    });
    expect(created.wordpressOptions).toEqual({ tags: ['news'], categories: { a: [1, 2] } });
    const updated = await ctx.api.posts.update({ id: created.id, changes: { title: 'Story 2' } });
    expect(updated.wordpressOptions).toEqual(created.wordpressOptions);
  });

  it('validates input on the server, and in the client before sending', async () => {
    const send = (body: object) =>
      ctx.fetch('/rpc/posts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    for (const body of [
      { id: crypto.randomUUID(), title: ' ' },
      { id: crypto.randomUUID(), title: 'x', link: 'javascript:alert(1)' },
      { id: 'not-a-uuid', title: 'x' },
    ]) {
      const res = await send(body);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ _tag: 'BadRequest' });
    }
    await expect(
      ctx.api.posts.create({ id: crypto.randomUUID(), title: 'x', link: 'javascript:alert(1)' }),
    ).rejects.toMatchObject({ message: expect.stringMatching(/valid http/) });
  });
});
