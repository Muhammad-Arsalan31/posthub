import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { createIntegrations } from '../registry';
import { createFakeFetch, formParams, tempMedia } from '../testing';
import type { YouTubeCredentials } from './google';

const config = { google: { clientId: 'gid', clientSecret: 'gsecret' } };
const creds: YouTubeCredentials = { accessToken: 'at', refreshToken: 'rt', expiresAt: 0 };

describe('youtube', () => {
  it('builds an offline consent URL', () => {
    const url = new URL(
      createIntegrations(config).oauth('google')!.authorizationUrl({
        state: 's1',
        redirectUri: 'http://localhost:5173/connect/google/callback',
      }),
    );
    expect(url.origin).toBe('https://accounts.google.com');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('state')).toBe('s1');
    expect(url.searchParams.get('scope')).toContain('youtube.upload');
  });

  it.effect('exchanges the code and returns each channel', () =>
    Effect.gen(function* () {
      const fake = createFakeFetch([
        [
          'POST https://oauth2.googleapis.com/token',
          () => ({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 }),
        ],
        [
          'GET https://www.googleapis.com/youtube/v3/channels',
          () => ({ items: [{ id: 'UC1', snippet: { title: 'My Channel' } }] }),
        ],
      ]);
      const accounts = yield* createIntegrations(config, fake)
        .oauth('google')!
        .connect({ code: 'c1', redirectUri: 'http://cb' });

      expect(formParams(fake.calls[0]!.body).get('code')).toBe('c1');
      expect(fake.calls[1]!.headers.get('authorization')).toBe('Bearer at');
      expect(accounts).toEqual([
        expect.objectContaining({
          platform: 'youtube',
          externalId: 'UC1',
          displayName: 'My Channel',
          credentials: expect.objectContaining({ refreshToken: 'rt' }),
        }),
      ]);
    }),
  );

  it.effect('fails clearly when Google omits the refresh token', () =>
    Effect.gen(function* () {
      const fake = createFakeFetch([
        ['POST https://oauth2.googleapis.com/token', () => ({ access_token: 'at', expires_in: 1 })],
      ]);
      const error = yield* Effect.flip(
        createIntegrations(config, fake).oauth('google')!.connect({ code: 'c', redirectUri: 'x' }),
      );
      expect(error.message).toMatch(/refresh token/);
    }),
  );

  it.effect('uploads a video with a resumable session', () =>
    Effect.gen(function* () {
      const fake = createFakeFetch([
        [
          'POST https://www.googleapis.com/upload/youtube/v3/videos',
          () => new Response(null, { headers: { location: 'https://upload.example/session' } }),
        ],
        ['PUT https://upload.example/session', () => ({ id: 'vid1' })],
      ]);
      const result = yield* createIntegrations(config, fake)
        .adapter('youtube')!
        .publish(creds, {
          title: 'Launch <day>',
          text: 'Description',
          media: [tempMedia('clip.mp4', 'video/mp4')],
        });

      expect(result).toEqual({ externalId: 'vid1', url: 'https://youtu.be/vid1' });
      const meta = JSON.parse(fake.calls[0]!.body as string);
      expect(meta.snippet.title).toBe('Launch day');
      expect(fake.calls[0]!.headers.get('x-upload-content-type')).toBe('video/mp4');
      expect(fake.calls[1]!.body).toBe('[binary]');
    }),
  );

  it.effect('sets a custom thumbnail, and only warns when that fails', () =>
    Effect.gen(function* () {
      let thumbnailStatus = 200;
      const fake = createFakeFetch([
        [
          'POST https://www.googleapis.com/upload/youtube/v3/videos',
          () => new Response(null, { headers: { location: 'https://upload.example/session' } }),
        ],
        ['PUT https://upload.example/session', () => ({ id: 'vid1' })],
        [
          'POST https://www.googleapis.com/upload/youtube/v3/thumbnails/set',
          () =>
            thumbnailStatus === 200
              ? {}
              : Response.json({ error: { message: 'Forbidden' } }, { status: thumbnailStatus }),
        ],
      ]);
      const adapter = createIntegrations(config, fake).adapter('youtube')!;
      const input = {
        title: 'Launch',
        text: 'Description',
        media: [tempMedia('clip.mp4', 'video/mp4')],
        thumbnail: tempMedia('thumb.png', 'image/png'),
      };

      expect(yield* adapter.publish(creds, input)).toEqual({
        externalId: 'vid1',
        url: 'https://youtu.be/vid1',
      });
      expect(fake.calls[2]!.url).toBe(
        'https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=vid1',
      );
      expect(fake.calls[2]!.headers.get('content-type')).toBe('image/png');

      thumbnailStatus = 403;
      const result = yield* adapter.publish(creds, input);
      expect(result).toMatchObject({ externalId: 'vid1' });
      expect(result.warning).toMatch(/thumbnail was not set: Forbidden/);
    }),
  );

  it.effect('refuses posts without a video, without retrying', () =>
    Effect.gen(function* () {
      const error = yield* createIntegrations(config)
        .adapter('youtube')!
        .publish(creds, { title: 't', text: 'x', media: [] })
        .pipe(Effect.flip);
      expect(error).toMatchObject({ retryable: false });
    }),
  );

  it.effect('refreshes the access token', () =>
    Effect.gen(function* () {
      const fake = createFakeFetch([
        [
          'POST https://oauth2.googleapis.com/token',
          () => ({ access_token: 'new', expires_in: 3600 }),
        ],
      ]);
      const refreshed = yield* createIntegrations(config, fake).adapter('youtube')!.refresh!(creds);
      expect(refreshed.credentials).toMatchObject({ accessToken: 'new', refreshToken: 'rt' });
      expect(formParams(fake.calls[0]!.body).get('grant_type')).toBe('refresh_token');
    }),
  );
});
