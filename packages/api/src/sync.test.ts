import {
  accountMetricSnapshot,
  post,
  postMetricSnapshot,
  postTarget,
  socialAccount,
  syncJob,
  type Db,
} from '@posthub/db';
import { createTestDb, seedUser } from '@posthub/db/testing';
import type { WordPressCredentials, YouTubeCredentials } from '@posthub/integrations';
import { createFakeFetch, type RecordedRequest } from '@posthub/integrations/testing';
import { describe, expect, it } from '@effect/vitest';
import { eq } from 'drizzle-orm';
import { Context as Services, Effect, Layer } from 'effect';
import { TestClock } from 'effect/testing';
import { saveAccounts } from './connections';
import { apiLayer } from './layer';
import { insertSyncJob, nextMetricsRun, Sync, SYNC_BACKOFF_MS, type SyncOptions } from './sync';
import { createVault } from '@posthub/integrations';
import { TEST_ENCRYPTION_KEY } from './testing';

const START = new Date('2030-01-01T09:00:00Z').getTime();
const HOUR = 3_600_000;
const WP_API = 'https://blog.test/wp-json';
const wordpress: WordPressCredentials = {
  siteUrl: 'https://blog.test',
  apiBase: WP_API,
  username: 'me',
  appPassword: 'pass',
};

type Responder = (req: RecordedRequest) => unknown;

const setup = Effect.fnUntraced(function* (
  routes: Array<[string, Responder]> = [],
  options: SyncOptions = {},
) {
  yield* TestClock.setTime(START);
  const db = createTestDb();
  const user = seedUser(db);
  const vault = createVault(TEST_ENCRYPTION_KEY);
  const fake = createFakeFetch([
    [`GET ${WP_API}/wp/v2/comments`, () => Response.json([], { headers: { 'x-wp-total': '4' } })],
    ...routes,
  ]);
  const layer = Sync.layer(options).pipe(
    Layer.provideMerge(
      apiLayer({
        db,
        encryptionKey: TEST_ENCRYPTION_KEY,
        mediaDir: '.',
        envConfig: { google: { clientId: 'g', clientSecret: 's' } },
        integrationDeps: { fetch: fake.fetch },
      }),
    ),
  );
  const services = yield* Layer.build(layer);
  const sync = Services.get(services, Sync);

  const addAccount = (platform: 'wordpress' | 'youtube', credentials: unknown, extra = {}) =>
    db
      .insert(socialAccount)
      .values({
        id: crypto.randomUUID(),
        userId: user.id,
        platform,
        externalId: crypto.randomUUID(),
        displayName: platform,
        credentials: vault.encrypt(credentials),
        ...extra,
      })
      .returning()
      .get();

  /** A target published at `publishedAt` with a metrics job due at `due`. */
  const published = (accountId: string, publishedAt = START, due = START) => {
    const postId = crypto.randomUUID();
    db.insert(post).values({ id: postId, userId: user.id, title: 'Hi', status: 'published' }).run();
    const target = db
      .insert(postTarget)
      .values({
        id: crypto.randomUUID(),
        postId,
        socialAccountId: accountId,
        status: 'published',
        externalPostId: '7',
        publishedAt: new Date(publishedAt),
      })
      .returning()
      .get();
    insertSyncJob(db, {
      kind: 'post_metrics',
      subjectId: target.id,
      socialAccountId: accountId,
      nextRunAt: new Date(due),
    });
    return target;
  };

  return { db, fake, sync, services, user, addAccount, published };
});

const job = (db: Db, subjectId: string) =>
  db.select().from(syncJob).where(eq(syncJob.subjectId, subjectId)).get()!;
const snapshots = (db: Db) => db.select().from(postMetricSnapshot).all();

describe('nextMetricsRun', () => {
  it('reads often while a post is new, then less, then stops', () => {
    expect(nextMetricsRun(0, 10 * HOUR)).toBe(11 * HOUR);
    expect(nextMetricsRun(0, 72 * HOUR)).toBe(78 * HOUR);
    expect(nextMetricsRun(0, 10 * 24 * HOUR)).toBe(11 * 24 * HOUR);
    expect(nextMetricsRun(0, 40 * 24 * HOUR)).toBe(47 * 24 * HOUR);
    expect(nextMetricsRun(0, 100 * 24 * HOUR)).toBeNull();
  });
});

describe('sync worker', () => {
  it.effect('stores a snapshot when a job is due and reschedules it by age', () =>
    Effect.gen(function* () {
      const { db, sync, addAccount, published } = yield* setup();
      const account = addAccount('wordpress', wordpress);
      const target = published(account.id, START, START + HOUR);

      yield* sync.tick;
      expect(snapshots(db)).toEqual([]);

      yield* TestClock.adjust(HOUR);
      yield* sync.tick;
      expect(snapshots(db)).toMatchObject([{ postTargetId: target.id, comments: 4, views: null }]);
      expect(job(db, target.id)).toMatchObject({
        status: 'pending',
        attempts: 0,
        nextRunAt: new Date(START + 2 * HOUR),
        lastRunAt: new Date(START + HOUR),
      });
    }),
  );

  it.effect('finishes jobs for old posts and platforms without insights', () =>
    Effect.gen(function* () {
      const { db, sync, addAccount, published } = yield* setup();
      const old = published(addAccount('wordpress', wordpress).id, START - 100 * 24 * HOUR);
      const linkedin = db
        .insert(socialAccount)
        .values({
          id: crypto.randomUUID(),
          userId: db.select().from(post).get()!.userId,
          platform: 'linkedin',
          externalId: 'li',
          displayName: 'Me',
          credentials: 'x',
        })
        .returning()
        .get();
      const unsupported = published(linkedin.id);

      yield* sync.tick;
      expect(job(db, old.id)).toMatchObject({ status: 'done', nextRunAt: null });
      expect(snapshots(db)).toHaveLength(1);
      expect(job(db, unsupported.id).status).toBe('done');
    }),
  );

  it.effect('backs off after failures, including network errors, and keeps going', () =>
    Effect.gen(function* () {
      let fail = true;
      const { db, sync, addAccount, published } = yield* setup([
        [
          'GET https://down.test/',
          () => {
            if (fail) throw new TypeError('fetch failed');
            return Response.json([], { headers: { 'x-wp-total': '1' } });
          },
        ],
      ]);
      const down = addAccount('wordpress', { ...wordpress, apiBase: 'https://down.test/wp-json' });
      const failing = published(down.id);
      const healthy = published(addAccount('wordpress', wordpress).id);

      yield* sync.tick;
      // The failure did not stop the other job.
      expect(job(db, healthy.id).lastError).toBeNull();
      expect(job(db, failing.id)).toMatchObject({
        status: 'pending',
        attempts: 1,
        nextRunAt: new Date(START + SYNC_BACKOFF_MS[0]!),
      });
      expect(job(db, failing.id).lastError).toBeTruthy();

      fail = false;
      yield* TestClock.adjust(SYNC_BACKOFF_MS[0]!);
      yield* sync.tick;
      expect(job(db, failing.id)).toMatchObject({ attempts: 0, lastError: null });
    }),
  );

  it.effect('pauses an account whose token was rejected, and resumes it on reconnect', () =>
    Effect.gen(function* () {
      const { db, sync, services, user, addAccount, published } = yield* setup([
        [
          'POST https://oauth2.googleapis.com/token',
          () => Response.json({ error: 'invalid_grant' }, { status: 400 }),
        ],
      ]);
      const credentials: YouTubeCredentials = { accessToken: 'a', refreshToken: 'r', expiresAt: 0 };
      const channel = addAccount('youtube', credentials, { tokenExpiresAt: new Date(START) });
      const target = published(channel.id);

      yield* sync.tick;
      expect(
        db.select().from(socialAccount).where(eq(socialAccount.id, channel.id)).get()!.status,
      ).toBe('expired');
      expect(job(db, target.id).status).toBe('paused');

      yield* Effect.provideContext(
        saveAccounts(user.id, [
          {
            platform: 'youtube',
            externalId: channel.externalId,
            displayName: 'Channel',
            credentials,
            tokenExpiresAt: null,
          },
        ]),
        services,
      );
      expect(job(db, target.id).status).toBe('pending');
      expect(job(db, channel.id)).toMatchObject({ kind: 'account_metrics', status: 'pending' });
    }),
  );

  it.effect('caps calls per platform in one pass', () =>
    Effect.gen(function* () {
      const { db, sync, fake, addAccount, published } = yield* setup([], {
        perPlatformPerPass: 1,
        concurrency: 5,
      });
      const account = addAccount('wordpress', wordpress);
      published(account.id);
      published(account.id);

      yield* sync.tick;
      expect(fake.calls).toHaveLength(1);
      yield* sync.tick;
      expect(fake.calls).toHaveLength(2);
      expect(snapshots(db)).toHaveLength(2);
    }),
  );

  it.effect('recovers interrupted jobs and adds account jobs at startup', () =>
    Effect.gen(function* () {
      const { db, sync, addAccount, published } = yield* setup([
        ['GET https://www.googleapis.com/youtube/v3/channels', () => ({ items: [] })],
      ]);
      const account = addAccount('wordpress', wordpress);
      const target = published(account.id);
      db.update(syncJob).set({ status: 'running' }).run();

      expect(yield* sync.recover).toBe(1);
      expect(job(db, target.id).status).toBe('pending');
      expect(job(db, account.id)).toMatchObject({ kind: 'account_metrics', status: 'pending' });

      yield* sync.tick;
      // WordPress has no account numbers in core: that job is done.
      expect(job(db, account.id).status).toBe('done');
      expect(db.select().from(accountMetricSnapshot).all()).toEqual([]);
      expect(snapshots(db)).toHaveLength(1);
    }),
  );
});
