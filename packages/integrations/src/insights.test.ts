import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { PlatformError } from './errors';
import { createIntegrations } from './registry';
import { createFakeFetch } from './testing';

const GRAPH = 'https://graph.facebook.com/v26.0';
const config = {
  google: { clientId: 'g', clientSecret: 's' },
  meta: { appId: 'a', appSecret: 's' },
  linkedin: { clientId: 'l', clientSecret: 's' },
};
const build = (routes: Parameters<typeof createFakeFetch>[0]) => {
  const fake = createFakeFetch(routes);
  return { fake, integrations: createIntegrations(config, { fetch: fake.fetch }) };
};

describe('insights', () => {
  it('is available for YouTube, Facebook, Instagram and WordPress only', () => {
    const { integrations } = build([]);
    expect(integrations.insights('youtube')).toBeDefined();
    expect(integrations.insights('wordpress')).toBeDefined();
    expect(integrations.insights('linkedin')).toBeUndefined();
    expect(integrations.insights('tiktok')).toBeUndefined();
  });

  it.effect('reads YouTube video and channel statistics', () =>
    Effect.gen(function* () {
      const { fake, integrations } = build([
        [
          'GET https://www.googleapis.com/youtube/v3/videos',
          () => ({
            items: [{ statistics: { viewCount: '120', likeCount: '7', commentCount: '2' } }],
          }),
        ],
        [
          'GET https://www.googleapis.com/youtube/v3/channels',
          () => ({ items: [{ statistics: { subscriberCount: '42', viewCount: '900' } }] }),
        ],
      ]);
      const youtube = integrations.insights('youtube')!;
      const credentials = { accessToken: 't', refreshToken: 'r', expiresAt: 0 };
      expect(yield* youtube.postMetrics(credentials, 'vid1')).toEqual({
        views: 120,
        likes: 7,
        comments: 2,
        raw: { viewCount: 120, likeCount: 7, commentCount: 2 },
      });
      expect(fake.calls[0]!.url).toContain('id=vid1');
      expect(fake.calls[0]!.headers.get('authorization')).toBe('Bearer t');
      expect((yield* youtube.accountMetrics!(credentials)).followers).toBe(42);
    }),
  );

  it.effect('a deleted YouTube video is a permanent error', () =>
    Effect.gen(function* () {
      const { integrations } = build([
        ['GET https://www.googleapis.com/youtube/v3/videos', () => ({ items: [] })],
      ]);
      const error = yield* Effect.flip(
        integrations.insights('youtube')!.postMetrics({ accessToken: 't' }, 'gone'),
      );
      expect(error).toBeInstanceOf(PlatformError);
      expect((error as PlatformError).retryable).toBe(false);
    }),
  );

  it.effect('reads Facebook counts, and keeps them when insights are refused', () =>
    Effect.gen(function* () {
      const { integrations } = build([
        [
          `GET ${GRAPH}/p1_2/insights`,
          () => Response.json({ error: { message: 'metric retired' } }, { status: 400 }),
        ],
        [
          `GET ${GRAPH}/p1_2`,
          () => ({
            reactions: { summary: { total_count: 5 } },
            comments: { summary: { total_count: 3 } },
          }),
        ],
      ]);
      const metrics = yield* integrations
        .insights('facebook')!
        .postMetrics({ pageId: 'p1', pageAccessToken: 't' }, 'p1_2');
      // No `shares` field means none; reach was refused, so it stays unknown.
      expect(metrics).toEqual({
        likes: 5,
        comments: 3,
        shares: 0,
        reach: undefined,
        clicks: undefined,
        raw: { reactions: 5, comments: 3, shares: 0 },
      });
    }),
  );

  it.effect('reads Instagram counts and insights', () =>
    Effect.gen(function* () {
      const { integrations } = build([
        [
          `GET ${GRAPH}/m1/insights`,
          () => ({
            data: [
              { name: 'reach', values: [{ value: 300 }] },
              { name: 'saved', values: [{ value: 4 }] },
            ],
          }),
        ],
        [`GET ${GRAPH}/m1`, () => ({ like_count: 20, comments_count: 1 })],
        [`GET ${GRAPH}/ig1`, () => ({ followers_count: 1000 })],
      ]);
      const instagram = integrations.insights('instagram')!;
      const credentials = { igUserId: 'ig1', accessToken: 't' };
      expect(yield* instagram.postMetrics(credentials, 'm1')).toMatchObject({
        likes: 20,
        comments: 1,
        reach: 300,
        saves: 4,
      });
      expect((yield* instagram.accountMetrics!(credentials)).followers).toBe(1000);
    }),
  );

  it.effect('counts WordPress comments from the X-WP-Total header', () =>
    Effect.gen(function* () {
      const { fake, integrations } = build([
        [
          'GET https://blog.test/wp-json/wp/v2/comments',
          () => Response.json([{ id: 1 }], { headers: { 'x-wp-total': '9' } }),
        ],
      ]);
      const metrics = yield* integrations.insights('wordpress')!.postMetrics(
        {
          siteUrl: 'https://blog.test',
          apiBase: 'https://blog.test/wp-json',
          username: 'u',
          appPassword: 'p',
        },
        '7',
      );
      expect(metrics).toEqual({ comments: 9, raw: { comments: 9 } });
      expect(fake.calls[0]!.url).toContain('post=7');
    }),
  );
});
