import {
  comment,
  commentAction,
  post,
  postMetricSnapshot,
  postTarget,
  socialAccount,
  syncJob,
  type CommentActionKind,
  type Db,
} from '@posthub/db';
import { createTestDb, seedUser } from '@posthub/db/testing';
import { createVault, type WordPressCredentials } from '@posthub/integrations';
import { createFakeFetch, type RecordedRequest } from '@posthub/integrations/testing';
import { describe, expect, it } from '@effect/vitest';
import { asc, eq } from 'drizzle-orm';
import { Context as Services, Effect, Layer } from 'effect';
import { TestClock } from 'effect/testing';
import { apiLayer } from './layer';
import { insertSyncJob, Sync } from './sync';
import { TEST_ENCRYPTION_KEY } from './testing';

const START = new Date('2030-01-01T09:00:00Z').getTime();
const WP = 'https://blog.test/wp-json';
const credentials: WordPressCredentials = {
  siteUrl: 'https://blog.test',
  apiBase: WP,
  username: 'me',
  appPassword: 'pass',
};

interface WpComment {
  id: number;
  parent: number;
  author: number;
  author_name: string;
  content: { rendered: string };
  date_gmt: string;
  status: string;
}
const wp = (id: number, text: string, extra: Partial<WpComment> = {}): WpComment => ({
  id,
  parent: 0,
  author: 0,
  author_name: 'Ann',
  content: { rendered: `<p>${text}</p>` },
  date_gmt: '2030-01-01T09:30:00',
  status: 'approved',
  ...extra,
});

type Responder = (req: RecordedRequest) => unknown;

const setup = Effect.fnUntraced(function* (
  options: { reply?: Responder; pages?: number; me?: Responder } = {},
) {
  yield* TestClock.setTime(START);
  const db = createTestDb();
  const user = seedUser(db);
  // What the "site" currently has; tests change it.
  const site: { comments: WpComment[] } = {
    comments: [wp(1, 'Great post'), wp(2, 'Thanks!', { parent: 1, author: 5 })],
  };
  const fake = createFakeFetch([
    [`GET ${WP}/wp/v2/users/me`, options.me ?? (() => ({ id: 5 }))],
    [
      `GET ${WP}/wp/v2/comments`,
      (req) => {
        const page = Number(new URL(req.url).searchParams.get('page') ?? 1);
        return Response.json(
          options.pages ? site.comments.slice((page - 1) * 100, page * 100) : site.comments,
          {
            headers: { 'x-wp-totalpages': String(options.pages ?? 1) },
          },
        );
      },
    ],
    [`POST ${WP}/wp/v2/comments/`, () => ({ id: 1 })],
    [
      `POST ${WP}/wp/v2/comments`,
      options.reply ??
        ((req) => {
          const body = JSON.parse(req.body as string) as { parent: number; content: string };
          const created = wp(100 + site.comments.length, body.content, {
            parent: body.parent,
            author: 5,
          });
          site.comments.push(created);
          return created;
        }),
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

  const account = db
    .insert(socialAccount)
    .values({
      id: crypto.randomUUID(),
      userId: user.id,
      platform: 'wordpress',
      externalId: 'blog',
      displayName: 'Blog',
      credentials: createVault(TEST_ENCRYPTION_KEY).encrypt(credentials),
    })
    .returning()
    .get();
  const postId = crypto.randomUUID();
  db.insert(post).values({ id: postId, userId: user.id, title: 'Hi', status: 'published' }).run();
  const target = db
    .insert(postTarget)
    .values({
      id: crypto.randomUUID(),
      postId,
      socialAccountId: account.id,
      status: 'published',
      externalPostId: '7',
      publishedAt: new Date(START),
    })
    .returning()
    .get();
  insertSyncJob(db, {
    kind: 'comments',
    subjectId: target.id,
    socialAccountId: account.id,
    nextRunAt: new Date(START),
  });

  const comments = () => db.select().from(comment).all();
  const act = (externalId: string, kind: CommentActionKind, text?: string) => {
    const row = comments().find((c) => c.externalId === externalId)!;
    return db
      .insert(commentAction)
      .values({
        id: crypto.randomUUID(),
        commentId: row.id,
        kind,
        text,
        createdAt: new Date(START),
      })
      .returning()
      .get();
  };
  const action = (id: string) =>
    db.select().from(commentAction).where(eq(commentAction.id, id)).get()!;
  const replies = () =>
    fake.calls.filter((c) => c.method === 'POST' && c.url === `${WP}/wp/v2/comments`);
  return { db, sync, site, fake, target, comments, act, action, replies };
});

const job = (db: Db) => db.select().from(syncJob).get()!;

describe('comment sync', () => {
  it.effect('stores comments, marks own ones read, and notices deletions', () =>
    Effect.gen(function* () {
      const { db, sync, site, comments } = yield* setup();
      yield* sync.tick;

      expect(
        comments().map((c) => [c.externalId, c.parentExternalId, c.isOwn, !!c.readAt]),
      ).toEqual([
        ['1', null, false, false],
        ['2', '1', true, true],
      ]);
      // Every 10 minutes while the post is new.
      expect(job(db).nextRunAt).toEqual(new Date(START + 10 * 60_000));

      site.comments = [site.comments[0]!];
      yield* TestClock.adjust(10 * 60_000);
      yield* sync.tick;
      const own = comments().find((c) => c.externalId === '2')!;
      expect(own.deletedAt).toEqual(new Date(START + 10 * 60_000));
      expect(comments()).toHaveLength(2);
    }),
  );
});

describe('comment counts', () => {
  it.effect("keeps the post's comment count current, carrying its other numbers forward", () =>
    Effect.gen(function* () {
      const { db, sync, site, target } = yield* setup();
      db.insert(postMetricSnapshot)
        .values({
          id: crypto.randomUUID(),
          postTargetId: target.id,
          capturedAt: new Date(START - 60_000),
          views: 40,
          comments: 0,
        })
        .run();

      yield* sync.tick;
      const snapshots = () =>
        db
          .select({ views: postMetricSnapshot.views, comments: postMetricSnapshot.comments })
          .from(postMetricSnapshot)
          .orderBy(asc(postMetricSnapshot.capturedAt))
          .all();
      expect(snapshots()).toEqual([
        { views: 40, comments: 0 },
        { views: 40, comments: 2 },
      ]);

      // Unchanged: no new snapshot. A held comment doesn't count.
      site.comments.push(wp(3, 'Spam?', { status: 'hold' }));
      yield* TestClock.adjust(10 * 60_000);
      yield* sync.tick;
      expect(snapshots()).toHaveLength(2);
    }),
  );
});

describe('outbox', () => {
  it.effect('waits for WordPress identity before retrying an uncertain reply', () =>
    Effect.gen(function* () {
      let unavailable = false;
      const env = yield* setup({
        me: () =>
          unavailable ? Response.json({ message: 'Try later' }, { status: 503 }) : { id: 5 },
      });
      yield* env.sync.tick;
      const reply = env.act('1', 'reply', 'Thanks!');
      env.db
        .update(commentAction)
        .set({ checkFirst: true })
        .where(eq(commentAction.id, reply.id))
        .run();
      unavailable = true;
      yield* env.sync.tick;
      expect(env.replies()).toHaveLength(0);
      expect(env.action(reply.id)).toMatchObject({ status: 'pending', checkFirst: true });
      unavailable = false;
      yield* TestClock.adjust(60_000);
      yield* env.sync.tick;
      expect(env.action(reply.id).status).toBe('done');
      expect(env.replies()).toHaveLength(0);
    }),
  );

  it.effect('does not mistake an identical reply in another conversation for this reply', () =>
    Effect.gen(function* () {
      const env = yield* setup();
      env.site.comments.push(
        wp(3, 'Another question'),
        wp(4, 'Repeated reply', { parent: 3, author: 5 }),
      );
      yield* env.sync.tick;
      const reply = env.act('1', 'reply', 'Repeated reply');
      env.db
        .update(commentAction)
        .set({ checkFirst: true })
        .where(eq(commentAction.id, reply.id))
        .run();
      yield* env.sync.tick;
      expect(env.action(reply.id).status).toBe('done');
      expect(env.replies()).toHaveLength(1);
      expect(JSON.parse(env.replies()[0]!.body as string)).toMatchObject({ parent: 1 });
    }),
  );

  it.effect('does not resend an uncertain reply when the recovery read is incomplete', () =>
    Effect.gen(function* () {
      const env = yield* setup({ pages: 11 });
      env.site.comments = Array.from({ length: 1000 }, (_, i) => wp(i + 1, `Comment ${i}`));
      env.site.comments.push(wp(1001, 'Already sent', { parent: 1, author: 5 }));
      yield* env.sync.tick;
      const reply = env.act('1', 'reply', 'Already sent');
      env.db
        .update(commentAction)
        .set({ checkFirst: true })
        .where(eq(commentAction.id, reply.id))
        .run();
      yield* env.sync.tick;
      expect(env.replies()).toHaveLength(0);
      expect(env.action(reply.id)).toMatchObject({ status: 'failed', checkFirst: true });
      expect(env.action(reply.id).lastError).toContain('could not check all comments');
    }),
  );

  it.effect('sends a reply once and records it', () =>
    Effect.gen(function* () {
      const { sync, comments, act, action, replies } = yield* setup();
      yield* sync.tick;
      const reply = act('1', 'reply', 'Glad you liked it');

      yield* sync.tick;
      expect(action(reply.id)).toMatchObject({ status: 'done', attempts: 1 });
      expect(replies()).toHaveLength(1);
      expect(JSON.parse(replies()[0]!.body as string)).toMatchObject({ post: 7, parent: 1 });
      expect(comments().find((c) => c.text === 'Glad you liked it')).toMatchObject({ isOwn: true });

      yield* sync.tick;
      expect(replies()).toHaveLength(1);
    }),
  );

  it.effect('after a network failure, does not resend a reply the platform already has', () =>
    Effect.gen(function* () {
      let reached = false;
      const env = yield* setup({
        reply: (req) => {
          // The reply reaches the site, but the response is lost.
          const body = JSON.parse(req.body as string) as { parent: number; content: string };
          env.site.comments.push(wp(200, body.content, { parent: body.parent, author: 5 }));
          reached = true;
          throw new TypeError('socket hang up');
        },
      });
      yield* env.sync.tick;
      const reply = env.act('1', 'reply', 'Thanks!!');

      yield* env.sync.tick;
      expect(reached).toBe(true);
      expect(env.action(reply.id)).toMatchObject({ status: 'pending', checkFirst: true });

      yield* TestClock.adjust(60_000);
      yield* env.sync.tick;
      expect(env.action(reply.id).status).toBe('done');
      expect(env.replies()).toHaveLength(1);
    }),
  );

  it.effect('a reply found sending at startup is checked, then sent when it is missing', () =>
    Effect.gen(function* () {
      const { db, sync, act, action, replies } = yield* setup();
      yield* sync.tick;
      const reply = act('1', 'reply', 'Hello');
      db.update(commentAction).set({ status: 'sending', attempts: 1 }).run();

      yield* sync.recover;
      expect(action(reply.id)).toMatchObject({ status: 'pending', checkFirst: true });
      yield* sync.tick;
      expect(action(reply.id).status).toBe('done');
      expect(replies()).toHaveLength(1);
    }),
  );

  it.effect('a definite refusal fails the action for the owner to see', () =>
    Effect.gen(function* () {
      const { sync, act, action } = yield* setup({
        reply: () => Response.json({ message: 'Comments are closed.' }, { status: 403 }),
      });
      yield* sync.tick;
      const reply = act('1', 'reply', 'Hi');
      yield* sync.tick;
      expect(action(reply.id)).toMatchObject({
        status: 'failed',
        lastError: 'wordpress: Comments are closed.',
      });
    }),
  );

  it.effect('hides a comment', () =>
    Effect.gen(function* () {
      const { sync, fake, comments, act, action } = yield* setup();
      yield* sync.tick;
      const hide = act('1', 'hide');
      yield* sync.tick;
      expect(action(hide.id).status).toBe('done');
      expect(comments().find((c) => c.externalId === '1')!.hidden).toBe(true);
      expect(JSON.parse(fake.calls.at(-1)!.body as string)).toEqual({ status: 'hold' });
    }),
  );
});
