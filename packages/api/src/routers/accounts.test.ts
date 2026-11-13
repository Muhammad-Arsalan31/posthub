import { call, ORPCError } from '@orpc/server';
import { oauthState, socialAccount, type Db } from '@posthub/db';
import { createTestDb, seedUser } from '@posthub/db/testing';
import { createFakeFetch } from '@posthub/integrations/testing';
import { beforeEach, describe, expect, it } from 'vite-plus/test';
import { beginOAuth, completeOAuth } from '../connections';
import { router } from '../index';
import type { Context } from '../procedures';
import { sessionFor, testContext } from '../testing';

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
  let ctx: Context;
  let userId: string;

  beforeEach(() => {
    db = createTestDb();
    const owner = seedUser(db);
    userId = owner.id;
    ctx = testContext(db, sessionFor(owner), { config: google, deps: googleFetch() });
  });

  const start = () =>
    new URL(
      beginOAuth({ ...ctx, userId, providerId: 'google', redirectUri: 'http://cb' }),
    ).searchParams.get('state')!;

  it('stores connected accounts with encrypted credentials', async () => {
    const state = start();
    await completeOAuth({
      ...ctx,
      userId,
      providerId: 'google',
      state,
      code: 'c',
      redirectUri: 'http://cb',
    });

    const [row] = db.select().from(socialAccount).all();
    expect(row).toMatchObject({ platform: 'youtube', externalId: 'UC1', displayName: 'Chan' });
    expect(row!.credentials).not.toContain('rt');
    expect(ctx.vault.decrypt(row!.credentials!)).toMatchObject({ refreshToken: 'rt' });
    expect(db.select().from(oauthState).all()).toHaveLength(0);
  });

  it('rejects reused, foreign or mismatched state', async () => {
    const state = start();
    const finish = (overrides: Partial<Parameters<typeof completeOAuth>[0]>) =>
      completeOAuth({
        ...ctx,
        userId,
        providerId: 'google',
        state,
        code: 'c',
        redirectUri: 'x',
        ...overrides,
      });

    await expect(finish({ providerId: 'meta' })).rejects.toThrow(/invalid or expired/);
    // The failed attempt consumed the state, so even the right provider is now refused.
    await expect(finish({})).rejects.toThrow(/invalid or expired/);
    await expect(finish({ state: start(), userId: 'someone-else' })).rejects.toThrow(/invalid/);
  });

  it('updates the existing row when the same channel reconnects', async () => {
    for (let i = 0; i < 2; i++) {
      await completeOAuth({
        ...ctx,
        userId,
        providerId: 'google',
        state: start(),
        code: 'c',
        redirectUri: 'x',
      });
    }
    expect(db.select().from(socialAccount).all()).toHaveLength(1);
  });

  it('refuses providers the server has no credentials for', () => {
    expect(() => beginOAuth({ ...ctx, userId, providerId: 'linkedin', redirectUri: 'x' })).toThrow(
      /not configured/,
    );
  });
});

describe('accounts router', () => {
  it('lists accounts without credentials and disconnects them', async () => {
    const db = createTestDb();
    const owner = seedUser(db);
    const ctx = testContext(db, sessionFor(owner), { config: google, deps: googleFetch() });
    const url = beginOAuth({ ...ctx, userId: owner.id, providerId: 'google', redirectUri: 'x' });
    await completeOAuth({
      ...ctx,
      userId: owner.id,
      providerId: 'google',
      state: new URL(url).searchParams.get('state')!,
      code: 'c',
      redirectUri: 'x',
    });

    const accounts = await call(router.accounts.list, undefined, { context: ctx });
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).not.toHaveProperty('credentials');

    const stranger = testContext(db, sessionFor(seedUser(db)));
    await call(router.accounts.disconnect, { id: accounts[0]!.id }, { context: stranger });
    expect(await call(router.accounts.list, undefined, { context: ctx })).toHaveLength(1);

    await call(router.accounts.disconnect, { id: accounts[0]!.id }, { context: ctx });
    expect(await call(router.accounts.list, undefined, { context: ctx })).toHaveLength(0);
  });

  it('reports which providers are configured', async () => {
    const db = createTestDb();
    const ctx = testContext(db, sessionFor(seedUser(db)), { config: google });
    const providers = await call(router.accounts.providers, undefined, { context: ctx });
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
      ['GET https://wp.example/wp-json/', () => ({ name: 'WP' })],
    ]);
    const ctx = testContext(db, sessionFor(owner), { deps: fake });
    const input = { siteUrl: 'https://wp.example', username: 'u', appPassword: 'p' };

    await expect(call(router.accounts.connectWordPress, input, { context: ctx })).rejects.toSatisfy(
      (e) => e instanceof ORPCError && e.code === 'BAD_REQUEST' && /rejected/.test(e.message),
    );
    expect(db.select().from(socialAccount).all()).toHaveLength(0);
  });
});
