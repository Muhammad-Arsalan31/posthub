import { call, ORPCError } from '@orpc/server';
import { post, postTarget, socialAccount, type Db, type Platform } from '@posthub/db';
import { createTestDb, seedUser } from '@posthub/db/testing';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vite-plus/test';
import { router } from '../index';
import type { Context } from '../procedures';
import { sessionFor, testContext } from '../testing';

const code = (c: string) => (e: unknown) => e instanceof ORPCError && e.code === c;

function seedAccount(ctx: Context, platform: Platform, displayName: string = platform) {
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

describe('posts router', () => {
  let db: Db;
  let ctx: Context;

  beforeEach(() => {
    db = createTestDb();
    ctx = testContext(db, sessionFor(seedUser(db)));
  });

  it('rejects anonymous callers', async () => {
    await expect(
      call(router.posts.list, undefined, { context: testContext(db, null) }),
    ).rejects.toSatisfy(code('UNAUTHORIZED'));
  });

  it('creates, lists, updates and deletes a draft', async () => {
    const id = crypto.randomUUID();
    const created = await call(router.posts.create, { id, title: '  Launch  ' }, { context: ctx });
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

    expect(await call(router.posts.list, undefined, { context: ctx })).toHaveLength(1);

    const updated = await call(
      router.posts.update,
      { id, changes: { body: 'Hello', link: 'https://example.com' } },
      { context: ctx },
    );
    expect(updated).toMatchObject({ title: 'Launch', body: 'Hello', link: 'https://example.com' });

    await call(router.posts.delete, { id }, { context: ctx });
    expect(await call(router.posts.list, undefined, { context: ctx })).toHaveLength(0);
  });

  it('schedules a post with one target per account and keeps media order', async () => {
    const wordpress = seedAccount(ctx, 'wordpress', 'Blog');
    const tiktok = seedAccount(ctx, 'tiktok', 'Me on TikTok');
    const first = await call(router.media.upload, { file: video }, { context: ctx });
    const second = await call(
      router.media.upload,
      { file: new File(['i'], 'a.png', { type: 'image/png' }) },
      { context: ctx },
    );

    const scheduled = await call(
      router.posts.create,
      {
        id: crypto.randomUUID(),
        title: 'Launch',
        body: 'We are live',
        status: 'scheduled',
        scheduledAt: new Date('2030-01-01T09:00:00Z'),
        accountIds: [wordpress.id, tiktok.id],
        mediaIds: [second.id, first.id],
      },
      { context: ctx },
    );

    expect(scheduled.status).toBe('scheduled');
    expect(scheduled.mediaIds).toEqual([second.id, first.id]);
    expect(Object.fromEntries(scheduled.targets.map((t) => [t.socialAccountId, t.status]))).toEqual(
      { [wordpress.id]: 'pending', [tiktok.id]: 'manual' },
    );

    // Deselecting an account removes its target; keeping one keeps the same row.
    const kept = scheduled.targets.find((t) => t.socialAccountId === wordpress.id)!;
    const updated = await call(
      router.posts.update,
      { id: scheduled.id, changes: { accountIds: [wordpress.id] } },
      { context: ctx },
    );
    expect(updated.targets.map((t) => t.id)).toEqual([kept.id]);
  });

  it('refuses to schedule what a platform cannot publish', async () => {
    const youtube = seedAccount(ctx, 'youtube', 'Channel');
    const base = { title: 'Hi', status: 'scheduled' as const, scheduledAt: new Date() };

    await expect(
      call(router.posts.create, { ...base, id: crypto.randomUUID() }, { context: ctx }),
    ).rejects.toSatisfy(
      (e) => code('BAD_REQUEST')(e) && (e as Error).message.includes('at least one account'),
    );
    await expect(
      call(
        router.posts.create,
        { ...base, id: crypto.randomUUID(), accountIds: [youtube.id] },
        { context: ctx },
      ),
    ).rejects.toSatisfy((e) => (e as Error).message === 'Channel: YouTube needs a video.');
    await expect(
      call(
        router.posts.create,
        { ...base, id: crypto.randomUUID(), scheduledAt: null, accountIds: [youtube.id] },
        { context: ctx },
      ),
    ).rejects.toSatisfy((e) => (e as Error).message.includes('date and time'));

    // A draft can be saved with anything selected.
    const draft = await call(
      router.posts.create,
      { id: crypto.randomUUID(), title: 'Later', accountIds: [youtube.id] },
      { context: ctx },
    );
    expect(draft.targets).toHaveLength(1);
  });

  it('locks a post once publishing has started', async () => {
    const wordpress = seedAccount(ctx, 'wordpress');
    const id = crypto.randomUUID();
    await call(
      router.posts.create,
      { id, title: 'Go', status: 'scheduled', scheduledAt: new Date(), accountIds: [wordpress.id] },
      { context: ctx },
    );
    // Simulate the publisher having claimed the target.
    db.update(postTarget).set({ status: 'publishing' }).where(eq(postTarget.postId, id)).run();
    db.update(post).set({ status: 'publishing' }).where(eq(post.id, id)).run();

    await expect(
      call(router.posts.update, { id, changes: { title: 'Changed' } }, { context: ctx }),
    ).rejects.toSatisfy(code('CONFLICT'));
    await expect(call(router.posts.delete, { id }, { context: ctx })).rejects.toSatisfy(
      code('CONFLICT'),
    );
  });

  it('retries failed targets and marks manual ones as posted', async () => {
    const wordpress = seedAccount(ctx, 'wordpress');
    const tiktok = seedAccount(ctx, 'tiktok');
    const id = crypto.randomUUID();
    const created = await call(
      router.posts.create,
      {
        id,
        title: 'Go',
        status: 'scheduled',
        scheduledAt: new Date(),
        accountIds: [wordpress.id, tiktok.id],
      },
      { context: ctx },
    );
    const wpTarget = created.targets.find((t) => t.socialAccountId === wordpress.id)!;
    const ttTarget = created.targets.find((t) => t.socialAccountId === tiktok.id)!;

    await expect(
      call(router.posts.retry, { targetId: wpTarget.id }, { context: ctx }),
    ).rejects.toSatisfy(code('CONFLICT'));

    db.update(post).set({ status: 'failed' }).where(eq(post.id, id)).run();
    db.update(postTarget)
      .set({ status: 'failed', lastError: 'boom' })
      .where(eq(postTarget.id, wpTarget.id))
      .run();

    const retried = await call(router.posts.retry, { targetId: wpTarget.id }, { context: ctx });
    expect(retried.status).toBe('publishing');
    expect(retried.targets.find((t) => t.id === wpTarget.id)).toMatchObject({
      status: 'pending',
      lastError: null,
    });

    const posted = await call(
      router.posts.markPosted,
      { targetId: ttTarget.id, url: 'https://tiktok.com/@me/video/1' },
      { context: ctx },
    );
    expect(posted.targets.find((t) => t.id === ttTarget.id)).toMatchObject({
      status: 'published',
      externalUrl: 'https://tiktok.com/@me/video/1',
    });
  });

  it("hides other users' posts, accounts and media", async () => {
    const id = crypto.randomUUID();
    await call(router.posts.create, { id, title: 'Mine' }, { context: ctx });
    const mine = seedAccount(ctx, 'wordpress');
    const file = await call(router.media.upload, { file: video }, { context: ctx });

    const other = testContext(db, sessionFor(seedUser(db)));
    expect(await call(router.posts.list, undefined, { context: other })).toHaveLength(0);
    await expect(
      call(router.posts.update, { id, changes: { title: 'Stolen' } }, { context: other }),
    ).rejects.toSatisfy(code('NOT_FOUND'));
    await expect(
      call(
        router.posts.create,
        { id: crypto.randomUUID(), title: 'x', accountIds: [mine.id] },
        { context: other },
      ),
    ).rejects.toSatisfy(code('BAD_REQUEST'));
    await expect(
      call(
        router.posts.create,
        { id: crypto.randomUUID(), title: 'x', mediaIds: [file.id] },
        { context: other },
      ),
    ).rejects.toSatisfy(code('BAD_REQUEST'));
  });

  it('stores image choices per platform and checks them when scheduling', async () => {
    const youtube = seedAccount(ctx, 'youtube', 'Channel');
    const clip = await call(router.media.upload, { file: video }, { context: ctx });
    const gif = await call(
      router.media.upload,
      { file: new File(['g'], 't.gif', { type: 'image/gif' }) },
      { context: ctx },
    );
    const png = await call(
      router.media.upload,
      { file: new File(['p'], 't.png', { type: 'image/png' }) },
      { context: ctx },
    );
    const base = {
      title: 'Video',
      status: 'scheduled' as const,
      scheduledAt: new Date('2030-01-01'),
      accountIds: [youtube.id],
      mediaIds: [clip.id],
    };

    await expect(
      call(
        router.posts.create,
        { ...base, id: crypto.randomUUID(), thumbnailMediaId: clip.id },
        { context: ctx },
      ),
    ).rejects.toSatisfy((e) => (e as Error).message.includes('must be images'));
    await expect(
      call(
        router.posts.create,
        { ...base, id: crypto.randomUUID(), thumbnailMediaId: gif.id },
        { context: ctx },
      ),
    ).rejects.toSatisfy((e) => (e as Error).message.includes('JPEG or PNG'));

    const created = await call(
      router.posts.create,
      { ...base, id: crypto.randomUUID(), thumbnailMediaId: png.id, featuredMediaId: gif.id },
      { context: ctx },
    );
    expect(created).toMatchObject({ thumbnailMediaId: png.id, featuredMediaId: gif.id });

    // In use by a scheduled post: can't delete. Once it's a draft, deleting clears the choice.
    await expect(call(router.media.delete, { id: png.id }, { context: ctx })).rejects.toSatisfy(
      code('CONFLICT'),
    );
    await call(
      router.posts.update,
      { id: created.id, changes: { status: 'draft' } },
      { context: ctx },
    );
    await call(router.media.delete, { id: png.id }, { context: ctx });
    const [after] = await call(router.posts.list, undefined, { context: ctx });
    expect(after).toMatchObject({ thumbnailMediaId: null, featuredMediaId: gif.id });
  });

  it('checks images in the text and keeps WordPress options', async () => {
    const png = await call(
      router.media.upload,
      { file: new File(['p'], 'p.png', { type: 'image/png' }) },
      { context: ctx },
    );
    const clip = await call(router.media.upload, { file: video }, { context: ctx });

    await expect(
      call(
        router.posts.create,
        { id: crypto.randomUUID(), title: 'x', body: `<img src="/files/${clip.id}">` },
        { context: ctx },
      ),
    ).rejects.toSatisfy((e) => (e as Error).message.includes('must be images'));
    await expect(
      call(
        router.posts.create,
        { id: crypto.randomUUID(), title: 'x', body: `<img src="/files/${crypto.randomUUID()}">` },
        { context: ctx },
      ),
    ).rejects.toSatisfy((e) => (e as Error).message.includes('no longer exists'));

    const created = await call(
      router.posts.create,
      {
        id: crypto.randomUUID(),
        title: 'Story',
        body: `<p>Hi</p><img src="/files/${png.id}">`,
        wordpressOptions: { tags: ['news'], categories: { a: [1, 2] } },
      },
      { context: ctx },
    );
    expect(created.wordpressOptions).toEqual({ tags: ['news'], categories: { a: [1, 2] } });
    const updated = await call(
      router.posts.update,
      { id: created.id, changes: { title: 'Story 2' } },
      { context: ctx },
    );
    expect(updated.wordpressOptions).toEqual(created.wordpressOptions);
  });

  it('validates input', async () => {
    await expect(
      call(router.posts.create, { id: crypto.randomUUID(), title: '' }, { context: ctx }),
    ).rejects.toSatisfy(code('BAD_REQUEST'));
    await expect(
      call(
        router.posts.create,
        { id: crypto.randomUUID(), title: 'x', link: 'javascript:alert(1)' },
        { context: ctx },
      ),
    ).rejects.toSatisfy(code('BAD_REQUEST'));
  });
});
