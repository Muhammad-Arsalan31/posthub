import { call } from '@orpc/server';
import { post, postTarget, socialAccount, type Db } from '@posthub/db';
import { createTestDb, seedUser } from '@posthub/db/testing';
import { createIntegrations, type WordPressCredentials } from '@posthub/integrations';
import { createFakeFetch } from '@posthub/integrations/testing';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vite-plus/test';
import { router } from './index';
import type { Context } from './procedures';
import { createPublisher, INTERRUPTED_MESSAGE, RETRY_DELAYS_MS } from './publisher';
import { sessionFor, testContext } from './testing';

const API = 'https://blog.test/wp-json';
const credentials: WordPressCredentials = {
  siteUrl: 'https://blog.test',
  apiBase: API,
  username: 'me',
  appPassword: 'app pass',
};

const silent = { info: () => {}, error: () => {} };

function setup(respond: () => unknown = () => ({ id: 7, link: 'https://blog.test/?p=7' })) {
  const db = createTestDb();
  const ctx = testContext(db, sessionFor(seedUser(db)));
  const fake = createFakeFetch([
    [
      'POST https://blog.test/wp-json/wp/v2/media',
      () => ({ id: 3, source_url: 'https://blog.test/cover.png' }),
    ],
    ['POST https://blog.test/wp-json/wp/v2/posts', respond],
  ]);
  const account = db
    .insert(socialAccount)
    .values({
      id: crypto.randomUUID(),
      userId: ctx.session!.user.id,
      platform: 'wordpress',
      externalId: 'https://blog.test#1',
      displayName: 'Blog',
      credentials: ctx.vault.encrypt(credentials),
    })
    .returning()
    .get();

  let clock = new Date('2030-01-01T09:00:00Z');
  const publisher = createPublisher({
    db,
    vault: ctx.vault,
    integrations: () => createIntegrations({}, { fetch: fake.fetch }),
    mediaDir: ctx.mediaDir,
    now: () => clock,
    log: silent,
  });

  return {
    db,
    ctx,
    fake,
    account,
    publisher,
    advance: (ms: number) => {
      clock = new Date(clock.getTime() + ms);
    },
    schedule: (
      scheduledAt: Date,
      extra: {
        mediaIds?: string[];
        body?: string;
        featuredMediaId?: string;
        wordpressOptions?: { tags: string[]; categories: Record<string, number[]> };
      } = {},
    ) =>
      call(
        router.posts.create,
        {
          id: crypto.randomUUID(),
          title: 'Hello',
          body: 'First post',
          status: 'scheduled',
          scheduledAt,
          accountIds: [account.id],
          ...extra,
        },
        { context: ctx },
      ),
  };
}

const state = (db: Db, postId: string) => ({
  post: db.select().from(post).where(eq(post.id, postId)).get()!,
  target: db.select().from(postTarget).where(eq(postTarget.postId, postId)).get()!,
});

async function uploadImage(ctx: Context) {
  const file = new File(['img'], 'cover.png', { type: 'image/png' });
  return call(router.media.upload, { file }, { context: ctx });
}

describe('publisher', () => {
  it('publishes due posts with their media and records the result', async () => {
    const { db, ctx, fake, publisher, schedule } = setup();
    const image = await uploadImage(ctx);
    const due = await schedule(new Date('2030-01-01T08:59:00Z'), { mediaIds: [image.id] });
    const later = await schedule(new Date('2030-01-01T10:00:00Z'));

    await publisher.tick();

    expect(state(db, due.id).post.status).toBe('published');
    expect(state(db, due.id).target).toMatchObject({
      status: 'published',
      attempts: 1,
      externalPostId: '7',
      externalUrl: 'https://blog.test/?p=7',
      lockedAt: null,
    });
    expect(state(db, later.id).post.status).toBe('scheduled');
    expect(fake.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `POST ${API}/wp/v2/media`,
      `POST ${API}/wp/v2/posts`,
    ]);
    expect(JSON.parse(fake.calls[1]!.body as string)).toMatchObject({
      title: 'Hello',
      featured_media: 3,
    });
    expect(JSON.parse(fake.calls[1]!.body as string).content).toContain(
      '<img src="https://blog.test/cover.png"',
    );

    // Already published: nothing goes out twice.
    await publisher.tick();
    expect(fake.calls).toHaveLength(2);
  });

  it('sends the editor HTML and the chosen featured image to WordPress', async () => {
    const { db, ctx, fake, publisher, schedule } = setup();
    const cover = await uploadImage(ctx);
    const { id } = await schedule(new Date('2030-01-01T08:00:00Z'), {
      body: '<h2>News</h2><p><strong>Big</strong> day</p>',
      featuredMediaId: cover.id,
    });

    await publisher.tick();

    expect(state(db, id).target.status).toBe('published');
    // Not attached, so it is uploaded only as the featured image.
    expect(fake.calls.map((c) => c.url)).toEqual([`${API}/wp/v2/media`, `${API}/wp/v2/posts`]);
    const sent = JSON.parse(fake.calls[1]!.body as string);
    expect(sent).toMatchObject({
      content: '<h2>News</h2><p><strong>Big</strong> day</p>',
      featured_media: 3,
    });
  });

  it("places inline images and applies this site's categories", async () => {
    const { db, ctx, fake, account, publisher, schedule } = setup();
    const photo = await uploadImage(ctx);
    const { id } = await schedule(new Date('2030-01-01T08:00:00Z'), {
      body: `<p>Before</p><img src="/files/${photo.id}" alt="Photo"><p>After</p>`,
      wordpressOptions: { tags: [], categories: { [account.id]: [12], other: [99] } },
    });

    await publisher.tick();

    expect(state(db, id).target.status).toBe('published');
    const sent = JSON.parse(fake.calls.at(-1)!.body as string);
    expect(sent.content).toMatch(
      /^<p>Before<\/p>\n<!-- wp:image \{"id":3,[\s\S]*src="https:\/\/blog\.test\/cover\.png" alt="Photo"[\s\S]*<p>After<\/p>$/,
    );
    expect(sent).toMatchObject({ categories: [12], featured_media: 3 });
  });

  it('retries retryable failures with backoff, then gives up', async () => {
    const { db, fake, publisher, schedule, advance } = setup(
      () => new Response('{"message":"busy"}', { status: 503 }),
    );
    const { id } = await schedule(new Date('2030-01-01T08:00:00Z'));

    await publisher.tick();
    expect(state(db, id).target).toMatchObject({ status: 'pending', attempts: 1 });
    expect(state(db, id).post.status).toBe('publishing');

    // Not due again yet.
    await publisher.tick();
    expect(fake.calls).toHaveLength(1);

    for (const delay of RETRY_DELAYS_MS) {
      advance(delay);
      await publisher.tick();
    }
    expect(fake.calls).toHaveLength(RETRY_DELAYS_MS.length + 1);
    expect(state(db, id).target).toMatchObject({ status: 'failed', lastError: 'wordpress: busy' });
    expect(state(db, id).post.status).toBe('failed');
  });

  it('fails permanent errors immediately', async () => {
    const { db, publisher, schedule } = setup(
      () => new Response('{"message":"Sorry, you are not allowed"}', { status: 403 }),
    );
    const { id } = await schedule(new Date('2030-01-01T08:00:00Z'));
    await publisher.tick();
    expect(state(db, id).target).toMatchObject({ status: 'failed', attempts: 1 });
  });

  it('does not guess after a network failure mid-publish', async () => {
    const { db, publisher, schedule } = setup(() => {
      throw new TypeError('fetch failed');
    });
    const { id } = await schedule(new Date('2030-01-01T08:00:00Z'));
    await publisher.tick();
    expect(state(db, id).target.status).toBe('failed');
    expect(state(db, id).target.lastError).toContain('could not confirm whether this was posted');
  });

  it('marks interrupted attempts failed on startup instead of retrying them', async () => {
    const { db, fake, publisher, schedule } = setup();
    const { id } = await schedule(new Date('2030-01-01T08:00:00Z'));
    db.update(post).set({ status: 'publishing' }).where(eq(post.id, id)).run();
    db.update(postTarget)
      .set({ status: 'publishing', attempts: 1, lockedAt: new Date() })
      .where(eq(postTarget.postId, id))
      .run();

    expect(publisher.recover()).toBe(1);
    await publisher.tick();

    expect(fake.calls).toHaveLength(0);
    expect(state(db, id).target).toMatchObject({
      status: 'failed',
      lastError: INTERRUPTED_MESSAGE,
    });
    expect(state(db, id).post.status).toBe('failed');
  });

  it('fails targets whose account needs reconnecting', async () => {
    const { db, account, fake, publisher, schedule } = setup();
    const { id } = await schedule(new Date('2030-01-01T08:00:00Z'));
    db.update(socialAccount)
      .set({ status: 'expired' })
      .where(eq(socialAccount.id, account.id))
      .run();

    await publisher.tick();
    expect(fake.calls).toHaveLength(0);
    expect(state(db, id).target.lastError).toContain('Reconnect');
  });
});
