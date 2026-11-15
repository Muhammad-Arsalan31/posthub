import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { createIntegrations } from '../registry';
import { createFakeFetch, formParams, tempMedia } from '../testing';
import { escapeLittleText, type LinkedInCredentials } from './linkedin';

const config = { linkedin: { clientId: 'lid', clientSecret: 'lsecret' } };
const creds: LinkedInCredentials = {
  accessToken: 'at',
  expiresAt: 0,
  authorUrn: 'urn:li:person:abc',
};
const created = () =>
  new Response(null, { status: 201, headers: { 'x-restli-id': 'urn:li:share:1' } });

describe('linkedin', () => {
  it.effect('connects and derives the author URN from userinfo', () =>
    Effect.gen(function* () {
      const fake = createFakeFetch([
        [
          'POST https://www.linkedin.com/oauth/v2/accessToken',
          () => ({ access_token: 'at', expires_in: 5_184_000 }),
        ],
        ['GET https://api.linkedin.com/v2/userinfo', () => ({ sub: 'abc', name: 'Ada' })],
      ]);
      const [account] = yield* createIntegrations(config, fake)
        .oauth('linkedin')!
        .connect({ code: 'c', redirectUri: 'http://cb' });

      expect(formParams(fake.calls[0]!.body).get('grant_type')).toBe('authorization_code');
      expect(account).toMatchObject({
        platform: 'linkedin',
        externalId: 'urn:li:person:abc',
        displayName: 'Ada',
        credentials: { authorUrn: 'urn:li:person:abc' },
      });
    }),
  );

  it.effect('posts escaped commentary with versioned headers', () =>
    Effect.gen(function* () {
      const fake = createFakeFetch([['POST https://api.linkedin.com/rest/posts', created]]);
      const result = yield* createIntegrations(config, fake).adapter('linkedin')!.publish(creds, {
        title: 'T',
        text: 'Hi (team) #launch @you',
        link: 'https://x.dev',
        media: [],
      });

      const req = fake.calls[0]!;
      expect(req.headers.get('linkedin-version')).toBe('202608');
      expect(req.headers.get('x-restli-protocol-version')).toBe('2.0.0');
      const body = JSON.parse(req.body as string);
      expect(body.commentary).toBe('Hi \\(team\\) \\#launch \\@you');
      expect(body.content).toEqual({ article: { source: 'https://x.dev', title: 'T' } });
      expect(result).toEqual({
        externalId: 'urn:li:share:1',
        url: 'https://www.linkedin.com/feed/update/urn:li:share:1/',
      });
    }),
  );

  it.effect('uploads an image before posting', () =>
    Effect.gen(function* () {
      const fake = createFakeFetch([
        [
          'POST https://api.linkedin.com/rest/images',
          () => ({ value: { uploadUrl: 'https://upload.li/1', image: 'urn:li:image:9' } }),
        ],
        ['PUT https://upload.li/1', () => new Response(null, { status: 201 })],
        ['POST https://api.linkedin.com/rest/posts', created],
      ]);
      yield* createIntegrations(config, fake)
        .adapter('linkedin')!
        .publish(creds, { title: 'T', text: 'Pic', media: [tempMedia('a.png', 'image/png')] });

      expect(JSON.parse(fake.calls[0]!.body as string).initializeUploadRequest.owner).toBe(
        'urn:li:person:abc',
      );
      expect(JSON.parse(fake.calls[2]!.body as string).content).toEqual({
        media: { id: 'urn:li:image:9', title: 'T' },
      });
    }),
  );

  it.effect('asks to reconnect when the token cannot be refreshed', () =>
    Effect.gen(function* () {
      expect(
        yield* Effect.flip(createIntegrations(config).adapter('linkedin')!.refresh!(creds)),
      ).toMatchObject({
        retryable: false,
        message: expect.stringMatching(/Reconnect/),
      });
    }),
  );

  it('escapes every reserved character', () => {
    expect(escapeLittleText('a|b{c}d[e]f<g>h*i_j~k\\')).toBe(
      'a\\|b\\{c\\}d\\[e\\]f\\<g\\>h\\*i\\_j\\~k\\\\',
    );
  });
});
