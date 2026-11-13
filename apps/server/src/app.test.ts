import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { RouterClient } from '@orpc/server';
import type { AppRouter } from '@posthub/api';
import { createAuth } from '@posthub/auth';
import { createTestDb } from '@posthub/db/testing';
import { describe, expect, it } from 'vite-plus/test';
import { createApp } from './app';

const baseURL = 'http://localhost:5173';

function setup() {
  const db = createTestDb();
  const auth = createAuth({ db, baseURL, secret: 'test-secret-test-secret-test-secret!' });
  const app = createApp({ db, auth, log: false });

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
    expect(await (await app.request('/health')).json()).toEqual({ ok: true });
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
