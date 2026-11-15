import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { socialAccount } from '@posthub/db';
import { createTestDb, seedUser } from '@posthub/db/testing';
import { describe, expect, it } from 'vite-plus/test';
import { sessionFor, testContext } from '../testing';

const TAGS: Record<string, string> = {
  BAD_REQUEST: 'BadRequest',
  NOT_FOUND: 'NotFound',
  CONFLICT: 'Conflict',
  UNAUTHORIZED: 'Unauthorized',
  BAD_GATEWAY: 'BadGateway',
};
const code = (c: string) => (e: unknown) => (e as { _tag?: string } | null)?._tag === TAGS[c];

function setup() {
  const db = createTestDb();
  return { db, ctx: testContext(db, sessionFor(seedUser(db))) };
}

describe('media router', () => {
  it('stores uploads in the media folder and lists them without storage paths', async () => {
    const { ctx } = setup();
    const file = new File(['png-bytes'], 'Photo 1.PNG', { type: 'image/png' });

    const uploaded = await ctx.api.media.upload({ file });
    expect(uploaded).toMatchObject({
      fileName: 'Photo 1.PNG',
      mimeType: 'image/png',
      sizeBytes: 9,
    });
    expect(uploaded).not.toHaveProperty('storagePath');

    expect(readdirSync(ctx.mediaDir)).toEqual([`${uploaded.id}.png`]);
    expect(readFileSync(join(ctx.mediaDir, `${uploaded.id}.png`), 'utf8')).toBe('png-bytes');
    expect(await ctx.api.media.list()).toEqual([uploaded]);
  });

  it('only accepts images and videos', async () => {
    const { ctx } = setup();
    const file = new File(['MZ'], 'setup.exe', { type: 'application/octet-stream' });
    await expect(ctx.api.media.upload({ file })).rejects.toSatisfy(code('BAD_REQUEST'));
  });

  it('deletes files, but not while a scheduled post uses them', async () => {
    const { db, ctx } = setup();
    const file = new File(['v'], 'clip.mp4', { type: 'video/mp4' });
    const uploaded = await ctx.api.media.upload({ file });
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
    await ctx.api.posts.create({
      id: postId,
      title: 'Video',
      status: 'scheduled',
      scheduledAt: new Date('2030-01-01'),
      accountIds: [account.id],
      mediaIds: [uploaded.id],
    });

    await expect(ctx.api.media.delete({ id: uploaded.id })).rejects.toSatisfy(code('CONFLICT'));

    await ctx.api.posts.update({ id: postId, changes: { status: 'draft' } });
    await ctx.api.media.delete({ id: uploaded.id });
    expect(existsSync(join(ctx.mediaDir, `${uploaded.id}.mp4`))).toBe(false);
    expect(await ctx.api.media.list()).toEqual([]);
  });

  it("can't touch other users' media", async () => {
    const { db, ctx } = setup();
    const file = new File(['x'], 'a.jpg', { type: 'image/jpeg' });
    const uploaded = await ctx.api.media.upload({ file });

    const other = testContext(db, sessionFor(seedUser(db)));
    expect(await other.api.media.list()).toEqual([]);
    await expect(other.api.media.delete({ id: uploaded.id })).rejects.toSatisfy(code('NOT_FOUND'));
  });
});
