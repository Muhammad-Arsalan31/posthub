import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { RouterClient } from '@orpc/server';
import { createIntegrationsManager, type AppRouter } from '@posthub/api';
import { createAuth } from '@posthub/auth';
import { createTestDb } from '@posthub/db/testing';
import { createVault } from '@posthub/integrations';
import { createFakeFetch } from '@posthub/integrations/testing';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import { createApp } from './app';

const baseURL = 'http://localhost:5173';

function setup() {
  const db = createTestDb();
  const auth = createAuth({ db, baseURL, secret: 'test-secret-test-secret-test-secret!' });
  const google = createFakeFetch([
    [
      'POST https://oauth2.googleapis.com/token',
      () => ({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 }),
    ],
    [
      'GET https://www.googleapis.com/youtube/v3/channels',
      () => ({ items: [{ id: 'UC1', snippet: { title: 'My Channel' } }] }),
    ],
  ]);
  const vault = createVault('test-encryption-key-test-encryption-key');
  // Google comes from "env"; other providers can be added at runtime through the API.
  const providerApps = createIntegrationsManager({
    db,
    vault,
    envConfig: { google: { clientId: 'gid', clientSecret: 'gsecret' } },
    deps: { fetch: google.fetch },
  });
  const mediaDir = mkdtempSync(join(tmpdir(), 'posthub-server-media-'));
  const app = createApp({
    db,
    auth,
    providerApps,
    vault,
    mediaDir,
    publicUrl: baseURL,
    log: false,
  });

  const rpc = (cookie?: string): RouterClient<AppRouter> =>
    createORPCClient(
      new RPCLink({
        url: `${baseURL}/rpc`,
        headers: cookie ? { cookie } : {},
        fetch: async (request) => app.fetch(request),
      }),
    );

  return { app, rpc };
}

async function signUp(app: ReturnType<typeof setup>['app']) {
  const res = await app.request(`${baseURL}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: baseURL },
    body: JSON.stringify({ email: 'me@posthub.local', password: 'password123', name: 'Me' }),
  });
  expect(res.status).toBe(200);
  return res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
}

describe('server', () => {
  it('reports health', async () => {
    const { app, rpc } = setup();
    expect(await (await app.request('/health')).json()).toMatchObject({
      ok: true,
      version: expect.any(String),
    });
    expect(await rpc().health()).toMatchObject({ ok: true });
  });

  it('blocks protected procedures without a session', async () => {
    const { rpc } = setup();
    await expect(rpc().posts.list()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('signs up and uses the session cookie for oRPC calls', async () => {
    const { app, rpc } = setup();
    const client = rpc(await signUp(app));

    expect(await client.me()).toMatchObject({ email: 'me@posthub.local' });

    const id = crypto.randomUUID();
    await client.posts.create({ id, title: 'First post' });
    const posts = await client.posts.list();
    expect(posts.map((p) => p.id)).toEqual([id]);
    expect(posts[0]?.createdAt).toBeInstanceOf(Date);
  });
});

describe('media files', () => {
  it('uploads through oRPC and serves files to their owner, with ranges', async () => {
    const { app, rpc } = setup();
    const cookie = await signUp(app);
    const file = new File(['0123456789'], 'clip.mp4', { type: 'video/mp4' });
    const uploaded = await rpc(cookie).media.upload({ file });

    const url = `/files/${uploaded.id}`;
    const full = await app.request(url, { headers: { cookie } });
    expect(full.status).toBe(200);
    expect(full.headers.get('content-type')).toBe('video/mp4');
    expect(await full.text()).toBe('0123456789');

    const part = await app.request(url, {
      headers: { cookie, range: 'bytes=2-5' },
    });
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe('bytes 2-5/10');
    expect(await part.text()).toBe('2345');

    expect((await app.request(url)).status).toBe(401);
    expect((await app.request('/files/nope', { headers: { cookie } })).status).toBe(404);
  });
});

describe('connect routes', () => {
  it('sends signed-out users to login', async () => {
    const { app } = setup();
    const res = await app.request('/connect/google/start');
    expect(res.headers.get('location')).toBe(`${baseURL}/login`);
  });

  it('runs the full OAuth round trip and lists the new account', async () => {
    const { app, rpc } = setup();
    const cookie = await signUp(app);

    const start = await app.request('/connect/google/start', { headers: { cookie } });
    const consent = new URL(start.headers.get('location')!);
    expect(consent.origin).toBe('https://accounts.google.com');
    expect(consent.searchParams.get('redirect_uri')).toBe(`${baseURL}/connect/google/callback`);

    const state = consent.searchParams.get('state')!;
    const callback = await app.request(`/connect/google/callback?code=abc&state=${state}`, {
      headers: { cookie },
    });
    expect(callback.headers.get('location')).toBe(`${baseURL}/accounts?connected=1`);

    const accounts = await rpc(cookie).accounts.list();
    expect(accounts).toMatchObject([{ platform: 'youtube', displayName: 'My Channel' }]);
  });

  it('reports provider errors and unconfigured providers on the Accounts page', async () => {
    const { app } = setup();
    const cookie = await signUp(app);

    const denied = await app.request(
      '/connect/google/callback?error=access_denied&error_description=User+said+no',
      { headers: { cookie } },
    );
    expect(new URL(denied.headers.get('location')!).searchParams.get('error')).toBe('User said no');

    const missing = await app.request('/connect/linkedin/start', { headers: { cookie } });
    expect(new URL(missing.headers.get('location')!).searchParams.get('error')).toMatch(
      /not configured/,
    );

    const forged = await app.request('/connect/google/callback?code=x&state=forged', {
      headers: { cookie },
    });
    expect(new URL(forged.headers.get('location')!).searchParams.get('error')).toMatch(/expired/);
  });

  it('uses app credentials saved in the UI without a restart', async () => {
    const { app, rpc } = setup();
    const cookie = await signUp(app);
    const before = await app.request('/connect/linkedin/start', { headers: { cookie } });
    expect(before.headers.get('location')).toContain('/accounts?error=');

    await rpc(cookie).providerApps.save({
      provider: 'linkedin',
      clientId: 'li-id',
      clientSecret: 'li-secret',
    });

    const after = await app.request('/connect/linkedin/start', { headers: { cookie } });
    const consent = new URL(after.headers.get('location')!);
    expect(consent.origin).toBe('https://www.linkedin.com');
    expect(consent.searchParams.get('client_id')).toBe('li-id');
  });
});
