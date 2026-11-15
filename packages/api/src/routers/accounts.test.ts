import { oauthState, socialAccount, type Db } from '@posthub/db';
import { createTestDb, seedUser } from '@posthub/db/testing';
import { createFakeFetch } from '@posthub/integrations/testing';
import { beforeEach, describe, expect, it } from 'vite-plus/test';
import { beginOAuth, completeOAuth } from '../connections';
import { sessionFor, testContext, type TestContext } from '../testing';
import { Effect } from 'effect';

const google = { google: { clientId: 'gid', clientSecret: 'gs' } };
const googleFetch = () =>
  createFakeFetch([
    [
      'POST https://oauth2.googleapis.com/token',
      () => ({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 }),
    ],
    [
      'GET https://www.googleapis.com/youtube/v3/channels',
      () => ({ items: [{ id: 'UC1', snippet: { title: 'Chan' } }] }),
    ],
  ]);

describe('OAuth connect flow', () => {
  let db: Db;
  let ctx: TestContext;
  let userId: string;

  beforeEach(() => {
    db = createTestDb();
    const owner = seedUser(db);
    userId = owner.id;
    ctx = testContext(db, sessionFor(owner), { config: google, deps: googleFetch() });
  });

  const start = async () =>
    new URL(
      await ctx.run(beginOAuth({ ...ctx, userId, providerId: 'google', redirectUri: 'http://cb' })),
    ).searchParams.get('state')!;

  it('stores connected accounts with encrypted credentials', async () => {
    const state = await start();
    await ctx.run(
      completeOAuth({
        ...ctx,
        userId,
        providerId: 'google',
        state,
        code: 'c',
        redirectUri: 'http://cb',
      }),
    );

    const [row] = db.select().from(socialAccount).all();
    expect(row).toMatchObject({ platform: 'youtube', externalId: 'UC1', displayName: 'Chan' });
    expect(row!.credentials).not.toContain('rt');
    expect(Effect.runSync(ctx.vault.decrypt(row!.credentials!))).toMatchObject({
      refreshToken: 'rt',
    });
    expect(db.select().from(oauthState).all()).toHaveLength(0);
  });

  it('rejects reused, foreign or mismatched state', async () => {
    const state = await start();
    const finish = (overrides: Partial<Parameters<typeof completeOAuth>[0]>) =>
      ctx.run(
        completeOAuth({
          ...ctx,
          userId,
          providerId: 'google',
          state,
          code: 'c',
          redirectUri: 'x',
          ...overrides,
        }),
      );

    await expect(finish({ providerId: 'meta' })).rejects.toThrow(/invalid or expired/);
    // The failed attempt consumed the state, so even the right provider is now refused.
    await expect(finish({})).rejects.toThrow(/invalid or expired/);
    await expect(finish({ state: await start(), userId: 'someone-else' })).rejects.toThrow(
      /invalid/,
    );
  });

  it('updates the existing row when the same channel reconnects', async () => {
    for (let i = 0; i < 2; i++) {
      await ctx.run(
        completeOAuth({
          ...ctx,
          userId,
          providerId: 'google',
          state: await start(),
          code: 'c',
          redirectUri: 'x',
        }),
      );
    }
    expect(db.select().from(socialAccount).all()).toHaveLength(1);
  });

  it('refuses providers the server has no credentials for', async () => {
    await expect(
      ctx.run(beginOAuth({ ...ctx, userId, providerId: 'linkedin', redirectUri: 'x' })),
    ).rejects.toThrow(/not configured/);
  });
});

describe('accounts router', () => {
  it('lists accounts without credentials and disconnects them', async () => {
    const db = createTestDb();
    const owner = seedUser(db);
    const ctx = testContext(db, sessionFor(owner), { config: google, deps: googleFetch() });
    const url = await ctx.run(
      beginOAuth({ ...ctx, userId: owner.id, providerId: 'google', redirectUri: 'x' }),
    );
    await ctx.run(
      completeOAuth({
        ...ctx,
        userId: owner.id,
        providerId: 'google',
        state: new URL(url).searchParams.get('state')!,
        code: 'c',
        redirectUri: 'x',
      }),
    );

    const accounts = await ctx.api.accounts.list();
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).not.toHaveProperty('credentials');

    const stranger = testContext(db, sessionFor(seedUser(db)));
    await stranger.api.accounts.disconnect({ id: accounts[0]!.id });
    expect(await ctx.api.accounts.list()).toHaveLength(1);

    await ctx.api.accounts.disconnect({ id: accounts[0]!.id });
    expect(await ctx.api.accounts.list()).toHaveLength(0);
  });

  it('reports which providers are configured', async () => {
    const db = createTestDb();
    const ctx = testContext(db, sessionFor(seedUser(db)), { config: google });
    const providers = await ctx.api.accounts.providers();
    expect(Object.fromEntries(providers.map((p) => [p.id, p.configured]))).toEqual({
      google: true,
      meta: false,
      linkedin: false,
      wordpress: true,
    });
  });

  it('connects WordPress and surfaces platform errors as BAD_REQUEST', async () => {
    const db = createTestDb();
    const owner = seedUser(db);
    const fake = createFakeFetch([
      ['GET https://wp.example/wp-json/wp/v2/users/me', () => new Response('{}', { status: 401 })],
      ['GET https://wp.example/wp-json/', () => ({ name: 'WP', namespaces: ['wp/v2'] })],
    ]);
    const ctx = testContext(db, sessionFor(owner), { deps: fake });
    const input = { siteUrl: 'https://wp.example', username: 'u', appPassword: 'p' };

    await expect(ctx.api.accounts.connectWordPress(input)).rejects.toSatisfy(
      (e) => e._tag === 'BadRequest' && /rejected/.test(e.message),
    );
    expect(db.select().from(socialAccount).all()).toHaveLength(0);
  });
});
