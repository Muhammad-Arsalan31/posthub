import { call } from '@orpc/server';
import { post, postTarget, socialAccount, type Db } from '@posthub/db';
import { createTestDb, seedUser } from '@posthub/db/testing';
import type { WordPressCredentials } from '@posthub/integrations';
import { createFakeFetch } from '@posthub/integrations/testing';
import { describe, expect, it } from '@effect/vitest';
import { eq } from 'drizzle-orm';
import { Context as Services, Effect, Layer } from 'effect';
import { TestClock } from 'effect/testing';
import { router } from './index';
import { apiLayer } from './layer';
import type { Context } from './procedures';
import { INTERRUPTED_MESSAGE, Publisher, RETRY_DELAYS_MS } from './publisher';
import { sessionFor, TEST_ENCRYPTION_KEY, testContext } from './testing';

const API = 'https://blog.test/wp-json';
const credentials: WordPressCredentials = {
  siteUrl: 'https://blog.test',
  apiBase: API,
  username: 'me',
  appPassword: 'app pass',
};

const setup = Effect.fnUntraced(function* (
  respond: () => unknown = () => ({ id: 7, link: 'https://blog.test/?p=7' }),
) {
  yield* TestClock.setTime(new Date('2030-01-01T09:00:00Z').getTime());
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

  const services = yield* Layer.build(
    Publisher.layer().pipe(
      Layer.provideMerge(
        apiLayer({
          db,
          encryptionKey: TEST_ENCRYPTION_KEY,
          mediaDir: ctx.mediaDir,
          integrationDeps: { fetch: fake.fetch },
        }),
      ),
    ),
  );
  const publisher = Services.get(services, Publisher);

  return {
    db,
    ctx,
    fake,
    account,
    publisher,
    schedule: (
      scheduledAt: Date,
      extra: {
        mediaIds?: string[];
        body?: string;
        featuredMediaId?: string;
        wordpressOptions?: { tags: string[]; categories: Record<string, number[]> };
      } = {},
    ) =>
      Effect.promise(() =>
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
      ),
  };
});

const state = (db: Db, postId: string) => ({
  post: db.select().from(post).where(eq(post.id, postId)).get()!,
  target: db.select().from(postTarget).where(eq(postTarget.postId, postId)).get()!,
});

const uploadImage = (ctx: Context) =>
  Effect.promise(() =>
    call(
      router.media.upload,
      { file: new File(['img'], 'cover.png', { type: 'image/png' }) },
      { context: ctx },
    ),
  );

describe('publisher', () => {
  it.effect('publishes due posts with their media and records the result', () =>
    Effect.gen(function* () {
      const { db, ctx, fake, publisher, schedule } = yield* setup();
      const image = yield* uploadImage(ctx);
      const due = yield* schedule(new Date('2030-01-01T08:59:00Z'), { mediaIds: [image.id] });
      const later = yield* schedule(new Date('2030-01-01T10:00:00Z'));

      yield* publisher.tick;

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
      yield* publisher.tick;
      expect(fake.calls).toHaveLength(2);
    }),
  );

  it.effect('sends the editor HTML and the chosen featured image to WordPress', () =>
    Effect.gen(function* () {
      const { db, ctx, fake, publisher, schedule } = yield* setup();
      const cover = yield* uploadImage(ctx);
      const { id } = yield* schedule(new Date('2030-01-01T08:00:00Z'), {
        body: '<h2>News</h2><p><strong>Big</strong> day</p>',
        featuredMediaId: cover.id,
      });

      yield* publisher.tick;

      expect(state(db, id).target.status).toBe('published');
      // Not attached, so it is uploaded only as the featured image.
      expect(fake.calls.map((c) => c.url)).toEqual([`${API}/wp/v2/media`, `${API}/wp/v2/posts`]);
      const sent = JSON.parse(fake.calls[1]!.body as string);
      expect(sent).toMatchObject({
        content: '<h2>News</h2><p><strong>Big</strong> day</p>',
        featured_media: 3,
      });
    }),
  );

  it.effect("places inline images and applies this site's categories", () =>
    Effect.gen(function* () {
      const { db, ctx, fake, account, publisher, schedule } = yield* setup();
      const photo = yield* uploadImage(ctx);
      const { id } = yield* schedule(new Date('2030-01-01T08:00:00Z'), {
        body: `<p>Before</p><img src="/files/${photo.id}" alt="Photo"><p>After</p>`,
        wordpressOptions: { tags: [], categories: { [account.id]: [12], other: [99] } },
      });

      yield* publisher.tick;

      expect(state(db, id).target.status).toBe('published');
      const sent = JSON.parse(fake.calls.at(-1)!.body as string);
      expect(sent.content).toMatch(
        /^<p>Before<\/p>\n<!-- wp:image \{"id":3,[\s\S]*src="https:\/\/blog\.test\/cover\.png" alt="Photo"[\s\S]*<p>After<\/p>$/,
      );
      expect(sent).toMatchObject({ categories: [12], featured_media: 3 });
    }),
  );

  it.effect('retries retryable failures with backoff, then gives up', () =>
    Effect.gen(function* () {
      const { db, fake, publisher, schedule } = yield* setup(
        () => new Response('{"message":"busy"}', { status: 503 }),
      );
      const { id } = yield* schedule(new Date('2030-01-01T08:00:00Z'));

      yield* publisher.tick;
      expect(state(db, id).target).toMatchObject({ status: 'pending', attempts: 1 });
      expect(state(db, id).post.status).toBe('publishing');

      // Not due again yet.
      yield* publisher.tick;
      expect(fake.calls).toHaveLength(1);

      for (const delay of RETRY_DELAYS_MS) {
        yield* TestClock.adjust(delay);
        yield* publisher.tick;
      }
      expect(fake.calls).toHaveLength(RETRY_DELAYS_MS.length + 1);
      expect(state(db, id).target).toMatchObject({
        status: 'failed',
        lastError: 'wordpress: busy',
      });
      expect(state(db, id).post.status).toBe('failed');
    }),
  );

  it.effect('fails permanent errors immediately', () =>
    Effect.gen(function* () {
      const { db, publisher, schedule } = yield* setup(
        () => new Response('{"message":"Sorry, you are not allowed"}', { status: 403 }),
      );
      const { id } = yield* schedule(new Date('2030-01-01T08:00:00Z'));
      yield* publisher.tick;
      expect(state(db, id).target).toMatchObject({ status: 'failed', attempts: 1 });
    }),
  );

  it.effect('does not guess after a network failure mid-publish', () =>
    Effect.gen(function* () {
      const { db, publisher, schedule } = yield* setup(() => {
        throw new TypeError('fetch failed');
      });
      const { id } = yield* schedule(new Date('2030-01-01T08:00:00Z'));
      yield* publisher.tick;
      expect(state(db, id).target.status).toBe('failed');
      expect(state(db, id).target.lastError).toContain('could not confirm whether this was posted');
    }),
  );

  it.effect('marks interrupted attempts failed on startup instead of retrying them', () =>
    Effect.gen(function* () {
      const { db, fake, publisher, schedule } = yield* setup();
      const { id } = yield* schedule(new Date('2030-01-01T08:00:00Z'));
      db.update(post).set({ status: 'publishing' }).where(eq(post.id, id)).run();
      db.update(postTarget)
        .set({ status: 'publishing', attempts: 1, lockedAt: new Date() })
        .where(eq(postTarget.postId, id))
        .run();

      expect(yield* publisher.recover).toBe(1);
      yield* publisher.tick;

      expect(fake.calls).toHaveLength(0);
      expect(state(db, id).target).toMatchObject({
        status: 'failed',
        lastError: INTERRUPTED_MESSAGE,
      });
      expect(state(db, id).post.status).toBe('failed');
    }),
  );

  it.effect('fails targets whose account needs reconnecting', () =>
    Effect.gen(function* () {
      const { db, account, fake, publisher, schedule } = yield* setup();
      const { id } = yield* schedule(new Date('2030-01-01T08:00:00Z'));
      db.update(socialAccount)
        .set({ status: 'expired' })
        .where(eq(socialAccount.id, account.id))
        .run();

      yield* publisher.tick;
      expect(fake.calls).toHaveLength(0);
      expect(state(db, id).target.lastError).toContain('Reconnect');
    }),
  );
});
