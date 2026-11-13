import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { call, ORPCError } from '@orpc/server';
import { socialAccount } from '@posthub/db';
import { createTestDb, seedUser } from '@posthub/db/testing';
import { describe, expect, it } from 'vite-plus/test';
import { router } from '../index';
import { sessionFor, testContext } from '../testing';

const code = (c: string) => (e: unknown) => e instanceof ORPCError && e.code === c;

function setup() {
  const db = createTestDb();
  return { db, ctx: testContext(db, sessionFor(seedUser(db))) };
}

describe('media router', () => {
  it('stores uploads in the media folder and lists them without storage paths', async () => {
    const { ctx } = setup();
    const file = new File(['png-bytes'], 'Photo 1.PNG', { type: 'image/png' });

    const uploaded = await call(router.media.upload, { file }, { context: ctx });
    expect(uploaded).toMatchObject({
      fileName: 'Photo 1.PNG',
      mimeType: 'image/png',
      sizeBytes: 9,
    });
    expect(uploaded).not.toHaveProperty('storagePath');

    expect(readdirSync(ctx.mediaDir)).toEqual([`${uploaded.id}.png`]);
    expect(readFileSync(join(ctx.mediaDir, `${uploaded.id}.png`), 'utf8')).toBe('png-bytes');
    expect(await call(router.media.list, undefined, { context: ctx })).toEqual([uploaded]);
  });

  it('only accepts images and videos', async () => {
    const { ctx } = setup();
    const file = new File(['MZ'], 'setup.exe', { type: 'application/octet-stream' });
    await expect(call(router.media.upload, { file }, { context: ctx })).rejects.toSatisfy(
      code('BAD_REQUEST'),
    );
  });

  it('deletes files, but not while a scheduled post uses them', async () => {
    const { db, ctx } = setup();
    const file = new File(['v'], 'clip.mp4', { type: 'video/mp4' });
    const uploaded = await call(router.media.upload, { file }, { context: ctx });
    const account = db
      .insert(socialAccount)
      .values({
        id: crypto.randomUUID(),
        userId: ctx.session!.user.id,
        platform: 'youtube',
        externalId: 'UC1',
        displayName: 'Channel',
        credentials: ctx.vault.encrypt({}),
      })
      .returning()
      .get();
    const postId = crypto.randomUUID();
    await call(
      router.posts.create,
      {
        id: postId,
        title: 'Video',
        status: 'scheduled',
        scheduledAt: new Date('2030-01-01'),
        accountIds: [account.id],
        mediaIds: [uploaded.id],
      },
      { context: ctx },
    );

    await expect(
      call(router.media.delete, { id: uploaded.id }, { context: ctx }),
    ).rejects.toSatisfy(code('CONFLICT'));

    await call(router.posts.update, { id: postId, changes: { status: 'draft' } }, { context: ctx });
    await call(router.media.delete, { id: uploaded.id }, { context: ctx });
    expect(existsSync(join(ctx.mediaDir, `${uploaded.id}.mp4`))).toBe(false);
    expect(await call(router.media.list, undefined, { context: ctx })).toEqual([]);
  });

  it("can't touch other users' media", async () => {
    const { db, ctx } = setup();
    const file = new File(['x'], 'a.jpg', { type: 'image/jpeg' });
    const uploaded = await call(router.media.upload, { file }, { context: ctx });

    const other = testContext(db, sessionFor(seedUser(db)));
    expect(await call(router.media.list, undefined, { context: other })).toEqual([]);
    await expect(
      call(router.media.delete, { id: uploaded.id }, { context: other }),
    ).rejects.toSatisfy(code('NOT_FOUND'));
  });
});
