import { describe, expect, it } from 'vite-plus/test';
import { createIntegrations } from '../registry';
import { createFakeFetch, formParams, tempMedia } from '../testing';

const G = 'https://graph.facebook.com/v26.0';
const config = { meta: { appId: 'app', appSecret: 'secret' } };
const deps = (fake: ReturnType<typeof createFakeFetch>) => ({ ...fake, pollIntervalMs: 0 });

describe('meta connect', () => {
  it('turns one login into Page and Instagram accounts', async () => {
    const fake = createFakeFetch([
      [
        `GET ${G}/oauth/access_token`,
        (req) => ({
          access_token: req.url.includes('fb_exchange_token') ? 'long' : 'short',
        }),
      ],
      [
        `GET ${G}/me/accounts`,
        () => ({
          data: [
            {
              id: 'p1',
              name: 'My Page',
              access_token: 'page-token',
              instagram_business_account: { id: 'ig1', username: 'mybrand' },
            },
            { id: 'p2', name: 'Other Page', access_token: 'page-token-2' },
          ],
        }),
      ],
    ]);
    const accounts = await createIntegrations(config, deps(fake))
      .oauth('meta')!
      .connect({ code: 'c', redirectUri: 'http://cb' });

    expect(fake.calls[1]!.url).toContain('fb_exchange_token=short');
    expect(fake.calls[2]!.url).toContain('access_token=long');
    expect(accounts.map((a) => [a.platform, a.externalId, a.displayName])).toEqual([
      ['facebook', 'p1', 'My Page'],
      ['instagram', 'ig1', '@mybrand'],
      ['facebook', 'p2', 'Other Page'],
    ]);
    expect(accounts[1]!.credentials).toEqual({ igUserId: 'ig1', accessToken: 'page-token' });
  });

  it('explains when no Pages were shared', async () => {
    const fake = createFakeFetch([
      [`GET ${G}/oauth/access_token`, () => ({ access_token: 't' })],
      [`GET ${G}/me/accounts`, () => ({ data: [] })],
    ]);
    await expect(
      createIntegrations(config, deps(fake))
        .oauth('meta')!
        .connect({ code: 'c', redirectUri: 'x' }),
    ).rejects.toThrow(/No Facebook Pages/);
  });
});

describe('facebook publish', () => {
  const creds = { pageId: 'p1', pageAccessToken: 'pt' };

  it('posts text with a link to the feed', async () => {
    const fake = createFakeFetch([[`POST ${G}/p1/feed`, () => ({ id: 'p1_99' })]]);
    const result = await createIntegrations(config, deps(fake))
      .adapter('facebook')!
      .publish(creds, { title: 't', text: 'Hello', link: 'https://x.dev', media: [] });

    const params = formParams(fake.calls[0]!.body);
    expect(params.get('message')).toBe('Hello');
    expect(params.get('link')).toBe('https://x.dev');
    expect(result).toEqual({ externalId: 'p1_99', url: 'https://www.facebook.com/p1_99' });
  });

  it('uploads a single photo with its caption', async () => {
    const fake = createFakeFetch([[`POST ${G}/p1/photos`, () => ({ id: 'ph', post_id: 'p1_5' })]]);
    const result = await createIntegrations(config, deps(fake))
      .adapter('facebook')!
      .publish(creds, { title: 't', text: 'Pic', media: [tempMedia('a.jpg', 'image/jpeg')] });

    const body = fake.calls[0]!.body as FormData;
    expect(body.get('caption')).toBe('Pic');
    expect(body.get('source')).toBeInstanceOf(Blob);
    expect(result.externalId).toBe('p1_5');
  });

  it('attaches multiple photos to one feed post', async () => {
    let n = 0;
    const fake = createFakeFetch([
      [`POST ${G}/p1/photos`, () => ({ id: `ph${++n}` })],
      [`POST ${G}/p1/feed`, () => ({ id: 'p1_7' })],
    ]);
    await createIntegrations(config, deps(fake))
      .adapter('facebook')!
      .publish(creds, {
        title: 't',
        text: 'Album',
        media: [tempMedia('a.jpg', 'image/jpeg'), tempMedia('b.png', 'image/png')],
      });

    expect((fake.calls[0]!.body as FormData).get('published')).toBe('false');
    const feed = formParams(fake.calls[2]!.body);
    expect(feed.get('attached_media[0]')).toBe('{"media_fbid":"ph1"}');
    expect(feed.get('attached_media[1]')).toBe('{"media_fbid":"ph2"}');
  });
});

describe('instagram publish', () => {
  const creds = { igUserId: 'ig1', accessToken: 'pt' };

  it('creates a container, waits for processing, then publishes', async () => {
    const statuses = ['IN_PROGRESS', 'FINISHED'];
    const fake = createFakeFetch([
      [`POST ${G}/ig1/media_publish`, () => ({ id: 'm1' })],
      [`POST ${G}/ig1/media`, () => ({ id: 'cont1' })],
      [`GET ${G}/cont1`, () => ({ status_code: statuses.shift() })],
      [`GET ${G}/m1`, () => ({ permalink: 'https://instagram.com/p/abc' })],
    ]);
    const result = await createIntegrations(config, deps(fake))
      .adapter('instagram')!
      .publish(creds, {
        title: 't',
        text: 'Caption',
        media: [tempMedia('a.jpg', 'image/jpeg', { publicUrl: 'https://cdn.example/a.jpg' })],
      });

    expect(formParams(fake.calls[0]!.body).get('image_url')).toBe('https://cdn.example/a.jpg');
    expect(fake.calls.filter((c) => c.url.startsWith(`${G}/cont1`))).toHaveLength(2);
    expect(formParams(fake.calls[3]!.body).get('creation_id')).toBe('cont1');
    expect(result).toEqual({ externalId: 'm1', url: 'https://instagram.com/p/abc' });
  });

  it('publishes videos as Reels', async () => {
    const fake = createFakeFetch([
      [`POST ${G}/ig1/media_publish`, () => ({ id: 'm2' })],
      [`POST ${G}/ig1/media`, () => ({ id: 'c2' })],
      [`GET ${G}/c2`, () => ({ status_code: 'FINISHED' })],
      [`GET ${G}/m2`, () => new Response('boom', { status: 500 })],
    ]);
    const result = await createIntegrations(config, deps(fake))
      .adapter('instagram')!
      .publish(creds, {
        title: 't',
        text: 'Reel',
        media: [tempMedia('v.mp4', 'video/mp4', { publicUrl: 'https://cdn.example/v.mp4' })],
      });

    expect(formParams(fake.calls[0]!.body).get('media_type')).toBe('REELS');
    // A failed permalink lookup must not fail an already-published post.
    expect(result).toEqual({ externalId: 'm2', url: undefined });
  });

  it('requires a public media URL', async () => {
    await expect(
      createIntegrations(config)
        .adapter('instagram')!
        .publish(creds, { title: 't', text: 'x', media: [tempMedia('a.jpg', 'image/jpeg')] }),
    ).rejects.toMatchObject({ retryable: false, message: expect.stringMatching(/public URL/) });
  });
});
