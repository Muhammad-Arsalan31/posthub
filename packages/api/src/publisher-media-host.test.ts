// Instagram publishing through the media host: files are uploaded just before publishing and
// removed afterwards, whatever the outcome.
import { hostedMedia, postTarget, socialAccount, type Db } from '@posthub/db';
import { createTestDb, seedUser } from '@posthub/db/testing';
import type { InstagramCredentials } from '@posthub/integrations';
import { createFakeFetch, type RecordedRequest } from '@posthub/integrations/testing';
import { describe, expect, it } from '@effect/vitest';
import { eq } from 'drizzle-orm';
import { Context as Services, Effect, Layer } from 'effect';
import { TestClock } from 'effect/testing';
import { apiLayer } from './layer';
import { Publisher, RETRY_DELAYS_MS } from './publisher';
import { sessionFor, TEST_ENCRYPTION_KEY, testContext } from './testing';

const GRAPH = 'https://graph.facebook.com/v26.0';
const BUCKET = 'https://acct.r2.test/media';
const credentials: InstagramCredentials = { igUserId: 'ig1', accessToken: 'page-token' };

type Responder = (req: RecordedRequest) => unknown;

const setup = Effect.fnUntraced(function* (
  overrides: {
    put?: Responder;
    remove?: Responder;
    container?: Responder;
    withHost?: boolean;
  } = {},
) {
  yield* TestClock.setTime(new Date('2030-01-01T09:00:00Z').getTime());
  const db = createTestDb();
  const fake = createFakeFetch([
    ['PUT https://acct.r2.test/', overrides.put ?? (() => new Response(''))],
    ['DELETE https://acct.r2.test/', overrides.remove ?? (() => new Response(null))],
    [`POST ${GRAPH}/ig1/media_publish`, () => ({ id: 'm1' })],
    [`POST ${GRAPH}/ig1/media`, overrides.container ?? (() => ({ id: 'c1' }))],
    [`GET ${GRAPH}/c1`, () => ({ status_code: 'FINISHED' })],
    [`GET ${GRAPH}/m1`, () => ({ permalink: 'https://instagram.com/p/m1' })],
  ]);
  const options = {
    config: { meta: { appId: 'app', appSecret: 'secret' } },
    deps: { fetch: fake.fetch, pollIntervalMs: 0 },
  };
  const ctx = testContext(db, sessionFor(seedUser(db)), options);
  if (overrides.withHost !== false) {
    yield* Effect.promise(() =>
      ctx.api.settings.saveMediaHost({
        endpoint: 'https://acct.r2.test',
        region: 'auto',
        bucket: 'media',
        accessKeyId: 'key',
        secretAccessKey: 'secret',
      }),
    );
  }
  const account = db
    .insert(socialAccount)
    .values({
      id: crypto.randomUUID(),
      userId: ctx.session!.user.id,
      platform: 'instagram',
      externalId: 'ig1',
      displayName: '@me',
      credentials: ctx.vault.encrypt(credentials),
    })
    .returning()
    .get();

  const layer = Publisher.layer().pipe(
    Layer.provideMerge(
      apiLayer({
        db,
        encryptionKey: TEST_ENCRYPTION_KEY,
        mediaDir: ctx.mediaDir,
        envConfig: options.config,
        integrationDeps: options.deps,
      }),
    ),
  );
  const publisher = Services.get(yield* Layer.build(layer), Publisher);

  const image = yield* Effect.promise(() =>
    ctx.api.media.upload({ file: new File(['img'], 'photo.JPG', { type: 'image/jpeg' }) }),
  );
  const created = yield* Effect.promise(() =>
    ctx.api.posts.create({
      id: crypto.randomUUID(),
      title: 'Hello',
      body: 'Caption',
      status: overrides.withHost === false ? 'draft' : 'scheduled',
      scheduledAt: new Date('2030-01-01T08:00:00Z'),
      accountIds: [account.id],
      mediaIds: [image.id],
    }),
  );
  return { db, ctx, fake, publisher, post: created, image };
});

const target = (db: Db, postId: string) =>
  db.select().from(postTarget).where(eq(postTarget.postId, postId)).get()!;
const calls = (fake: { calls: RecordedRequest[] }) =>
  fake.calls.map((c) => `${c.method} ${c.url.split('?')[0]}`);

describe('publisher with a media host', () => {
  it.effect('uploads the file, gives Instagram its URL, then deletes it', () =>
    Effect.gen(function* () {
      const { db, fake, publisher, post: created, image } = yield* setup();
      const targetId = created.targets[0]!.id;

      yield* publisher.tick;

      expect(target(db, created.id)).toMatchObject({
        status: 'published',
        externalUrl: 'https://instagram.com/p/m1',
      });
      const key = `${targetId}/${image.id}.jpg`;
      expect(calls(fake)).toEqual([
        `PUT ${BUCKET}/${key}`,
        `POST ${GRAPH}/ig1/media`,
        `GET ${GRAPH}/c1`,
        `POST ${GRAPH}/ig1/media_publish`,
        `GET ${GRAPH}/m1`,
        `DELETE ${BUCKET}/${key}`,
      ]);
      const container = new URLSearchParams(fake.calls[1]!.body as string);
      expect(container.get('image_url')).toMatch(
        new RegExp(`^${BUCKET}/${key}\\?X-Amz-Algorithm=`),
      );
      expect(db.select().from(hostedMedia).all()).toEqual([]);
    }),
  );

  it.effect('backs off when the upload fails, without saying it may have been posted', () =>
    Effect.gen(function* () {
      const {
        db,
        fake,
        publisher,
        post: created,
      } = yield* setup({
        put: () => {
          throw new TypeError('fetch failed');
        },
      });

      yield* publisher.tick;

      const row = target(db, created.id);
      expect(row.status).toBe('pending');
      expect(row.lastError).toContain('Could not reach the media host');
      expect(row.lastError).not.toContain('could not confirm');
      expect(row.nextAttemptAt!.getTime()).toBe(
        new Date('2030-01-01T09:00:00Z').getTime() + RETRY_DELAYS_MS[0]!,
      );
      // Nothing reached Instagram, and the (maybe partial) object was cleaned up.
      expect(calls(fake).some((c) => c.includes('graph.facebook.com'))).toBe(false);
      expect(calls(fake).at(-1)).toMatch(/^DELETE /);
      expect(db.select().from(hostedMedia).all()).toEqual([]);
    }),
  );

  it.effect('removes the file when Instagram rejects the post', () =>
    Effect.gen(function* () {
      const {
        db,
        fake,
        publisher,
        post: created,
      } = yield* setup({
        container: () =>
          Response.json({ error: { message: 'Unsupported format' } }, { status: 400 }),
      });
      yield* publisher.tick;
      expect(target(db, created.id)).toMatchObject({
        status: 'failed',
        lastError: 'instagram: Unsupported format',
      });
      expect(calls(fake).at(-1)).toMatch(/^DELETE /);
      expect(db.select().from(hostedMedia).all()).toEqual([]);
    }),
  );

  it.effect('keeps the target result when deleting the file fails, and sweeps it later', () =>
    Effect.gen(function* () {
      let failDelete = true;
      const {
        db,
        fake,
        publisher,
        post: created,
      } = yield* setup({
        remove: () => (failDelete ? new Response('boom', { status: 500 }) : new Response(null)),
      });

      yield* publisher.tick;
      expect(target(db, created.id).status).toBe('published');
      expect(db.select().from(hostedMedia).all()).toHaveLength(1);

      failDelete = false;
      expect(yield* publisher.sweepHostedMedia).toBe(1);
      expect(db.select().from(hostedMedia).all()).toEqual([]);
      expect(calls(fake).filter((c) => c.startsWith('DELETE'))).toHaveLength(2);
    }),
  );

  it.effect('the sweep leaves files of targets that are publishing alone', () =>
    Effect.gen(function* () {
      const { db, ctx, publisher, post: created } = yield* setup();
      const targetId = created.targets[0]!.id;
      db.update(postTarget).set({ status: 'publishing' }).where(eq(postTarget.id, targetId)).run();
      db.insert(hostedMedia)
        .values([
          { key: `${targetId}/a.jpg`, userId: ctx.session!.user.id, targetId },
          { key: 'gone/b.jpg', userId: ctx.session!.user.id, targetId: 'gone' },
        ])
        .run();

      expect(yield* publisher.sweepHostedMedia).toBe(1);
      expect(db.select({ key: hostedMedia.key }).from(hostedMedia).all()).toEqual([
        { key: `${targetId}/a.jpg` },
      ]);
    }),
  );

  it.effect('Instagram cannot be scheduled without a media host', () =>
    Effect.gen(function* () {
      const { ctx, post: draft } = yield* setup({ withHost: false });
      const error = yield* Effect.promise(() =>
        ctx.api.posts
          .update({ id: draft.id, changes: { status: 'scheduled' } })
          .catch((e: unknown) => e),
      );
      expect(error).toMatchObject({ _tag: 'BadRequest' });
      expect((error as Error).message).toContain('Set up a media host in Settings');
    }),
  );
});
