import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import type { PlatformError } from './errors';
import { createIntegrations } from './registry';
import { createFakeFetch, formParams } from './testing';

const GRAPH = 'https://graph.facebook.com/v26.0';
const YT = 'https://www.googleapis.com/youtube/v3';
const WP = 'https://blog.test/wp-json';
const config = {
  google: { clientId: 'g', clientSecret: 's' },
  meta: { appId: 'a', appSecret: 's' },
};
const build = (routes: Parameters<typeof createFakeFetch>[0]) => {
  const fake = createFakeFetch(routes);
  return { fake, integrations: createIntegrations(config, { fetch: fake.fetch }) };
};
const ref = { externalId: 'c2', threadExternalId: 'c1', postExternalId: '7' };

describe('engagement', () => {
  it.effect('Instagram reads all nested reply pages before returning the top-level cursor', () =>
    Effect.gen(function* () {
      const resource = (id: string) => ({
        id,
        text: id,
        timestamp: '2030-01-01T10:00:00Z',
        from: { id: 'ig1' },
      });
      const { fake, integrations } = build([
        [
          `GET ${GRAPH}/media/comments`,
          () => ({
            data: [
              {
                ...resource('root'),
                replies: {
                  data: [resource('r1')],
                  paging: {
                    cursors: { after: 'reply2' },
                    next: `${GRAPH}/root/replies?after=reply2`,
                  },
                },
              },
            ],
            paging: { cursors: { after: 'top2' }, next: `${GRAPH}/media/comments?after=top2` },
          }),
        ],
        [
          `GET ${GRAPH}/root/replies`,
          (req) =>
            new URL(req.url).searchParams.get('after') === 'reply2'
              ? {
                  data: [resource('r2')],
                  paging: {
                    cursors: { after: 'reply3' },
                    next: `${GRAPH}/root/replies?after=reply3`,
                  },
                }
              : { data: [resource('r3')] },
        ],
      ]);
      const page = yield* integrations
        .engagement('instagram')!
        .listComments(
          { igUserId: 'ig1', accessToken: 't' },
          { externalPostId: 'media', accountExternalId: 'ig1' },
        );
      expect(page.comments.map((c) => [c.externalId, c.parentExternalId, c.isOwn])).toEqual([
        ['root', null, true],
        ['r1', 'root', true],
        ['r2', 'root', true],
        ['r3', 'root', true],
      ]);
      expect(page.next).toBe('top2');
      expect(fake.calls.slice(1).map((c) => new URL(c.url).searchParams.get('after'))).toEqual([
        'reply2',
        'reply3',
      ]);
    }),
  );

  it.effect('Instagram fails the read if a nested reply page cannot be fetched', () =>
    Effect.gen(function* () {
      const { integrations } = build([
        [
          `GET ${GRAPH}/media/comments`,
          () => ({
            data: [
              {
                id: 'root',
                timestamp: '2030-01-01T10:00:00Z',
                replies: {
                  data: [],
                  paging: {
                    cursors: { after: 'reply2' },
                    next: `${GRAPH}/root/replies?after=reply2`,
                  },
                },
              },
            ],
          }),
        ],
        [
          `GET ${GRAPH}/root/replies`,
          () => Response.json({ error: { message: 'Try later' } }, { status: 503 }),
        ],
      ]);
      const error = yield* Effect.flip(
        integrations
          .engagement('instagram')!
          .listComments(
            { igUserId: 'ig1', accessToken: 't' },
            { externalPostId: 'media', accountExternalId: 'ig1' },
          ),
      );
      expect(error).toMatchObject({ _tag: 'PlatformError', retryable: true });
    }),
  );

  it.effect('WordPress refuses an unidentified comment read when the identity lookup fails', () =>
    Effect.gen(function* () {
      const { fake, integrations } = build([
        [
          `GET ${WP}/wp/v2/users/me`,
          () => Response.json({ message: 'Try later' }, { status: 503 }),
        ],
        [`GET ${WP}/wp/v2/comments`, () => []],
      ]);
      const error = yield* Effect.flip(
        integrations
          .engagement('wordpress')!
          .listComments(
            { siteUrl: 'https://blog.test', apiBase: WP, username: 'me', appPassword: 'p' },
            { externalPostId: '7', accountExternalId: 'x' },
          ),
      );
      expect(error).toMatchObject({ _tag: 'PlatformError', retryable: true });
      expect(fake.calls).toHaveLength(1);
    }),
  );

  it.effect('YouTube fetches every page of replies when the embedded replies are incomplete', () =>
    Effect.gen(function* () {
      const resource = (id: string, parentId?: string) => ({
        id,
        snippet: {
          textOriginal: id,
          parentId,
          authorChannelId: { value: 'me' },
          publishedAt: '2030-01-01T10:00:00Z',
        },
      });
      const { fake, integrations } = build([
        [
          `GET ${YT}/commentThreads`,
          () => ({
            items: [
              {
                snippet: { topLevelComment: resource('root'), totalReplyCount: 3 },
                replies: { comments: [resource('r1', 'root')] },
              },
            ],
            nextPageToken: 'threads2',
          }),
        ],
        [
          `GET ${YT}/comments`,
          (req) =>
            new URL(req.url).searchParams.get('pageToken') === 'replies2'
              ? { items: [resource('r3', 'root')] }
              : {
                  items: [resource('r1', 'root'), resource('r2', 'root')],
                  nextPageToken: 'replies2',
                },
        ],
      ]);
      const result = yield* integrations
        .engagement('youtube')!
        .listComments(
          { accessToken: 't', refreshToken: 'r', expiresAt: 0 },
          { externalPostId: 'vid', accountExternalId: 'me' },
        );
      expect(result.comments.map((c) => c.externalId)).toEqual(['root', 'r1', 'r2', 'r3']);
      expect(result.next).toBe('threads2');
      expect(fake.calls.slice(1).map((c) => new URL(c.url).searchParams.get('parentId'))).toEqual([
        'root',
        'root',
      ]);
    }),
  );

  it('has no comment support for LinkedIn and TikTok', () => {
    const { integrations } = build([]);
    expect(integrations.engagement('linkedin')).toBeUndefined();
    expect(integrations.engagement('tiktok')).toBeUndefined();
    expect(integrations.engagement('facebook')!.capabilities).toEqual({
      reply: true,
      like: true,
      hide: true,
      delete: true,
    });
  });

  it.effect('YouTube does not report a complete read when a reply page fails', () =>
    Effect.gen(function* () {
      const { integrations } = build([
        [
          `GET ${YT}/commentThreads`,
          () => ({
            items: [
              {
                snippet: {
                  topLevelComment: { id: 'root', snippet: { publishedAt: '2030-01-01T10:00:00Z' } },
                  totalReplyCount: 1,
                },
              },
            ],
          }),
        ],
        [
          `GET ${YT}/comments`,
          () => Response.json({ error: { message: 'Try later' } }, { status: 503 }),
        ],
      ]);
      const error = yield* Effect.flip(
        integrations
          .engagement('youtube')!
          .listComments(
            { accessToken: 't', refreshToken: 'r', expiresAt: 0 },
            { externalPostId: 'vid', accountExternalId: 'me' },
          ),
      );
      expect(error).toMatchObject({ _tag: 'PlatformError', retryable: true });
    }),
  );

  it.effect('YouTube: lists threads with replies, replies on the thread, hides', () =>
    Effect.gen(function* () {
      const comment = (id: string, channel: string, extra = {}) => ({
        id,
        snippet: {
          authorDisplayName: channel,
          authorChannelId: { value: channel },
          textOriginal: `text ${id}`,
          likeCount: 2,
          publishedAt: '2030-01-01T10:00:00Z',
          ...extra,
        },
      });
      const { fake, integrations } = build([
        [
          `GET ${YT}/commentThreads`,
          () => ({
            items: [
              {
                snippet: { topLevelComment: comment('c1', 'fan') },
                replies: { comments: [comment('c2', 'me', { parentId: 'c1' })] },
              },
            ],
            nextPageToken: 'page2',
          }),
        ],
        [`POST ${YT}/comments/setModerationStatus`, () => new Response(null, { status: 204 })],
        [`POST ${YT}/comments`, () => comment('c3', 'me')],
      ]);
      const youtube = integrations.engagement('youtube')!;
      const credentials = { accessToken: 't', refreshToken: 'r', expiresAt: 0 };
      const page = yield* youtube.listComments(credentials, {
        externalPostId: 'vid',
        accountExternalId: 'me',
      });
      expect(page.next).toBe('page2');
      expect(page.comments.map((c) => [c.externalId, c.parentExternalId, c.isOwn])).toEqual([
        ['c1', null, false],
        ['c2', 'c1', true],
      ]);

      const reply = yield* youtube.reply(credentials, ref, 'Thanks!');
      expect(reply).toMatchObject({ externalId: 'c3', parentExternalId: 'c1', isOwn: true });
      expect(JSON.parse(fake.calls[1]!.body as string)).toEqual({
        snippet: { parentId: 'c1', textOriginal: 'Thanks!' },
      });

      yield* youtube.moderate(credentials, ref, 'hide');
      expect(fake.calls[2]!.url).toContain('moderationStatus=rejected');

      const error = yield* Effect.flip(youtube.setLike(credentials, ref, true));
      expect((error as PlatformError).retryable).toBe(false);
    }),
  );

  it.effect('Facebook: lists the stream with parents, replies, likes, hides and deletes', () =>
    Effect.gen(function* () {
      const { fake, integrations } = build([
        [
          `GET ${GRAPH}/p1/comments`,
          () => ({
            data: [
              {
                id: 'c1',
                message: 'Hi',
                created_time: '2030-01-01T10:00:00+0000',
                from: { id: 'u1', name: 'Ann' },
              },
              {
                id: 'c2',
                message: 'Hello',
                created_time: '2030-01-01T11:00:00+0000',
                from: { id: 'page' },
                parent: { id: 'c1' },
              },
            ],
            paging: { cursors: { after: 'cur' } },
          }),
        ],
        [`POST ${GRAPH}/c2/comments`, () => ({ id: 'c3' })],
        [`POST ${GRAPH}/c2/likes`, () => ({ success: true })],
        [`POST ${GRAPH}/c2`, () => ({ success: true })],
        [`DELETE ${GRAPH}/c2`, () => ({ success: true })],
      ]);
      const facebook = integrations.engagement('facebook')!;
      const credentials = { pageId: 'page', pageAccessToken: 't' };
      const page = yield* facebook.listComments(credentials, {
        externalPostId: 'p1',
        accountExternalId: 'page',
      });
      // No `next` link: this was the last page.
      expect(page.next).toBeUndefined();
      expect(page.comments[1]).toMatchObject({ parentExternalId: 'c1', isOwn: true });

      expect((yield* facebook.reply(credentials, ref, 'Thanks')).externalId).toBe('c3');
      yield* facebook.setLike(credentials, ref, true);
      yield* facebook.moderate(credentials, ref, 'hide');
      expect(formParams(fake.calls[3]!.body).get('is_hidden')).toBe('true');
      yield* facebook.moderate(credentials, ref, 'delete');
      expect(fake.calls.map((c) => c.method)).toEqual(['GET', 'POST', 'POST', 'POST', 'DELETE']);
    }),
  );

  it.effect('Instagram: replies attach to the top-level comment', () =>
    Effect.gen(function* () {
      const { fake, integrations } = build([
        [
          `GET ${GRAPH}/m1/comments`,
          () => ({
            data: [
              {
                id: 'c1',
                text: 'Nice',
                timestamp: '2030-01-01T10:00:00+0000',
                username: 'fan',
                replies: {
                  data: [
                    {
                      id: 'c2',
                      text: 'Thanks',
                      timestamp: '2030-01-01T11:00:00+0000',
                      from: { id: 'ig1' },
                    },
                  ],
                },
              },
            ],
          }),
        ],
        [`POST ${GRAPH}/c1/replies`, () => ({ id: 'c3' })],
      ]);
      const instagram = integrations.engagement('instagram')!;
      const credentials = { igUserId: 'ig1', accessToken: 't' };
      const page = yield* instagram.listComments(credentials, {
        externalPostId: 'm1',
        accountExternalId: 'ig1',
      });
      expect(page.comments.map((c) => [c.externalId, c.parentExternalId, c.isOwn])).toEqual([
        ['c1', null, false],
        ['c2', 'c1', true],
      ]);
      yield* instagram.reply(credentials, ref, 'Hi');
      expect(fake.calls[1]!.url).toBe(`${GRAPH}/c1/replies`);
    }),
  );

  it.effect(
    'WordPress: pages through comments, including held ones, and replies with a parent',
    () =>
      Effect.gen(function* () {
        const { fake, integrations } = build([
          [`GET ${WP}/wp/v2/users/me`, () => ({ id: 5 })],
          [
            `GET ${WP}/wp/v2/comments`,
            () =>
              Response.json(
                [
                  {
                    id: 1,
                    parent: 0,
                    author: 0,
                    author_name: 'Ann',
                    content: { rendered: '<p>Great &amp; useful</p>' },
                    date_gmt: '2030-01-01T10:00:00',
                    status: 'hold',
                  },
                  {
                    id: 2,
                    parent: 1,
                    author: 5,
                    author_name: 'Me',
                    content: { rendered: '<p>Thanks</p>' },
                    date_gmt: '2030-01-01T11:00:00',
                    status: 'approved',
                  },
                ],
                { headers: { 'x-wp-totalpages': '2' } },
              ),
          ],
          [
            `POST ${WP}/wp/v2/comments`,
            () => ({ id: 3, parent: 2, author: 5, date_gmt: '2030-01-02T00:00:00' }),
          ],
        ]);
        const wordpress = integrations.engagement('wordpress')!;
        const credentials = {
          siteUrl: 'https://blog.test',
          apiBase: WP,
          username: 'me',
          appPassword: 'p',
        };
        const page = yield* wordpress.listComments(credentials, {
          externalPostId: '7',
          accountExternalId: 'x',
        });
        expect(page.next).toBe('2');
        expect(page.comments[0]).toMatchObject({
          text: 'Great & useful',
          hidden: true,
          isOwn: false,
        });
        expect(page.comments[0]!.createdAt.toISOString()).toBe('2030-01-01T10:00:00.000Z');
        expect(page.comments[1]).toMatchObject({ parentExternalId: '1', isOwn: true });

        const reply = yield* wordpress.reply(
          credentials,
          { externalId: '2', threadExternalId: '1', postExternalId: '7' },
          'Yes',
        );
        expect(reply).toMatchObject({ externalId: '3', isOwn: true, text: 'Yes' });
        expect(JSON.parse(fake.calls[2]!.body as string)).toEqual({
          post: 7,
          parent: 2,
          content: 'Yes',
        });
      }),
  );
});

describe('first comments', () => {
  it.effect('YouTube starts a new thread on the video', () =>
    Effect.gen(function* () {
      const { fake, integrations } = build([[`POST ${YT}/commentThreads`, () => ({ id: 't1' })]]);
      const posted = yield* integrations
        .engagement('youtube')!
        .postComment({ accessToken: 't', refreshToken: 'r', expiresAt: 0 }, 'vid', 'Links below');
      expect(posted).toMatchObject({ externalId: 't1', isOwn: true, parentExternalId: null });
      expect(JSON.parse(fake.calls[0]!.body as string)).toEqual({
        snippet: { videoId: 'vid', topLevelComment: { snippet: { textOriginal: 'Links below' } } },
      });
    }),
  );

  it.effect('Instagram media that is not ready for comments yet is worth retrying', () =>
    Effect.gen(function* () {
      const { integrations } = build([
        [
          `POST ${GRAPH}/m1/comments`,
          () =>
            Response.json(
              { error: { message: 'The media is not ready yet, please try again later.' } },
              { status: 400 },
            ),
        ],
      ]);
      const error = yield* Effect.flip(
        integrations
          .engagement('instagram')!
          .postComment({ igUserId: 'ig1', accessToken: 't' }, 'm1', 'Hi'),
      );
      expect((error as PlatformError).retryable).toBe(true);
    }),
  );
});
