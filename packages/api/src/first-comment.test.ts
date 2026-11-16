import { comment, post, postTarget, socialAccount, type Db } from '@posthub/db';
import { createTestDb, seedUser } from '@posthub/db/testing';
import { createVault, type WordPressCredentials } from '@posthub/integrations';
import { createFakeFetch, type RecordedRequest } from '@posthub/integrations/testing';
import { describe, expect, it } from '@effect/vitest';
import { eq } from 'drizzle-orm';
import { Context as Services, Effect, Layer } from 'effect';
import { TestClock } from 'effect/testing';
import { apiLayer } from './layer';
import { RETRY_DELAYS_MS } from './retry';
import { Sync } from './sync';
import { TEST_ENCRYPTION_KEY } from './testing';

const START = new Date('2030-01-01T09:00:00Z').getTime();
const WP = 'https://blog.test/wp-json';
const TEXT = 'Read more at https://example.com #news';
const credentials: WordPressCredentials = {
  siteUrl: 'https://blog.test',
  apiBase: WP,
  username: 'me',
  appPassword: 'pass',
};

type Responder = (req: RecordedRequest) => unknown;

const setup = Effect.fnUntraced(function* (send?: Responder) {
  yield* TestClock.setTime(START);
  const db = createTestDb();
  const user = seedUser(db);
  const site: Array<Record<string, unknown>> = [];
  const created = (content: string) => {
    const c = {
      id: 50 + site.length,
      parent: 0,
      author: 5,
      author_name: 'Me',
      content: { rendered: `<p>${content}</p>` },
      date_gmt: '2030-01-01T09:00:30',
      status: 'approved',
    };
    site.push(c);
    return c;
  };
  const fake = createFakeFetch([
    [`GET ${WP}/wp/v2/users/me`, () => ({ id: 5 })],
    [
      `GET ${WP}/wp/v2/comments`,
      () => Response.json(site, { headers: { 'x-wp-totalpages': '1' } }),
    ],
    [
      `POST ${WP}/wp/v2/comments`,
      send ?? ((req) => created((JSON.parse(req.body as string) as { content: string }).content)),
    ],
  ]);
  const layer = Sync.layer().pipe(
    Layer.provideMerge(
      apiLayer({
        db,
        encryptionKey: TEST_ENCRYPTION_KEY,
        mediaDir: '.',
        integrationDeps: { fetch: fake.fetch },
      }),
    ),
  );
  const sync = Services.get(yield* Layer.build(layer), Sync);
  const accountId = crypto.randomUUID();
  db.insert(socialAccount)
    .values({
      id: accountId,
      userId: user.id,
      platform: 'wordpress',
      externalId: 'blog',
      displayName: 'Blog',
      credentials: createVault(TEST_ENCRYPTION_KEY).encrypt(credentials),
    })
    .run();
  const postId = crypto.randomUUID();
  db.insert(post)
    .values({ id: postId, userId: user.id, title: 'Hi', status: 'published', firstComment: TEXT })
    .run();
  const targetId = crypto.randomUUID();
  db.insert(postTarget)
    .values({
      id: targetId,
      postId,
      socialAccountId: accountId,
      status: 'published',
      externalPostId: '7',
      publishedAt: new Date(START),
      firstCommentStatus: 'pending',
    })
    .run();
  const sends = () =>
    fake.calls.filter((c) => c.method === 'POST' && c.url === `${WP}/wp/v2/comments`);
  return { db, sync, site, created, targetId, sends };
});

const target = (db: Db, id: string) =>
  db.select().from(postTarget).where(eq(postTarget.id, id)).get()!;

describe('first comment', () => {
  it.effect('is posted once, after the post, and shows in the inbox', () =>
    Effect.gen(function* () {
      const { db, sync, targetId, sends } = yield* setup();
      yield* sync.tick;
      expect(target(db, targetId)).toMatchObject({
        status: 'published',
        firstCommentStatus: 'posted',
        firstCommentExternalId: '50',
      });
      expect(JSON.parse(sends()[0]!.body as string)).toEqual({ post: 7, content: TEXT });
      expect(db.select().from(comment).all()).toMatchObject([{ externalId: '50', isOwn: true }]);

      yield* sync.tick;
      expect(sends()).toHaveLength(1);
    }),
  );

  it.effect('a refused comment fails on its own; the post stays published', () =>
    Effect.gen(function* () {
      const { db, sync, targetId } = yield* setup(() =>
        Response.json({ message: 'Comments are closed.' }, { status: 403 }),
      );
      yield* sync.tick;
      expect(target(db, targetId)).toMatchObject({
        status: 'published',
        firstCommentStatus: 'failed',
        firstCommentError: 'wordpress: Comments are closed.',
      });
      expect(db.select().from(post).get()!.status).toBe('published');
    }),
  );

  it.effect('after a network failure, finds the comment on the platform instead of resending', () =>
    Effect.gen(function* () {
      let created: ((content: string) => unknown) | undefined;
      const env = yield* setup((req) => {
        created!((JSON.parse(req.body as string) as { content: string }).content);
        throw new TypeError('socket hang up');
      });
      created = env.created;
      yield* env.sync.tick;
      expect(target(env.db, env.targetId)).toMatchObject({
        firstCommentStatus: 'pending',
        firstCommentCheck: true,
      });

      yield* TestClock.adjust(RETRY_DELAYS_MS[0]!);
      yield* env.sync.tick;
      expect(target(env.db, env.targetId)).toMatchObject({
        firstCommentStatus: 'posted',
        firstCommentExternalId: '50',
      });
      expect(env.sends()).toHaveLength(1);
    }),
  );

  it.effect('one found posting at startup is checked, then posted when missing', () =>
    Effect.gen(function* () {
      const { db, sync, targetId, sends } = yield* setup();
      db.update(postTarget).set({ firstCommentStatus: 'posting', firstCommentAttempts: 1 }).run();
      yield* sync.recover;
      expect(target(db, targetId)).toMatchObject({
        firstCommentStatus: 'pending',
        firstCommentCheck: true,
      });
      yield* sync.tick;
      expect(target(db, targetId).firstCommentStatus).toBe('posted');
      expect(sends()).toHaveLength(1);
    }),
  );
});
