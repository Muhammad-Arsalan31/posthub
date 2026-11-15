import { call, ORPCError } from '@orpc/server';
import { providerApp } from '@posthub/db';
import { createTestDb, seedUser } from '@posthub/db/testing';
import { describe, expect, it } from 'vite-plus/test';
import { router } from '../index';
import { sessionFor, testContext } from '../testing';
import { Effect } from 'effect';

function setup(env: Parameters<typeof testContext>[2] = {}) {
  const db = createTestDb();
  const ctx = testContext(db, sessionFor(seedUser(db)), env);
  const providers = async () =>
    Object.fromEntries(
      (await call(router.accounts.providers, undefined, { context: ctx })).map((p) => [p.id, p]),
    );
  return { db, ctx, providers };
}

describe('provider apps', () => {
  it('enables a provider immediately and stores the secret encrypted', async () => {
    const { db, ctx, providers } = setup();
    expect((await providers()).linkedin).toMatchObject({ configured: false, source: null });

    await call(
      router.providerApps.save,
      { provider: 'linkedin', clientId: 'li-id', clientSecret: 'li-secret' },
      { context: ctx },
    );

    expect((await providers()).linkedin).toMatchObject({
      configured: true,
      source: 'database',
      clientId: 'li-id',
    });
    expect(ctx.integrations.oauth('linkedin')).toBeDefined();

    const [row] = db.select().from(providerApp).all();
    expect(row!.config).not.toContain('li-secret');
    expect(Effect.runSync(ctx.vault.decrypt(row!.config))).toEqual({
      clientId: 'li-id',
      clientSecret: 'li-secret',
    });
  });

  it('survives a restart (a new manager reads the DB)', async () => {
    const { db, ctx } = setup();
    await call(
      router.providerApps.save,
      { provider: 'meta', clientId: 'app', clientSecret: 's' },
      { context: ctx },
    );
    const restarted = testContext(db, null);
    expect(await restarted.run(restarted.providerApps.describe('meta'))).toEqual({
      source: 'database',
      clientId: 'app',
    });
  });

  it('overrides .env values, and falls back to them when removed', async () => {
    const { ctx, providers } = setup({
      config: { google: { clientId: 'env-id', clientSecret: 'env-s', youtubePrivacy: 'unlisted' } },
    });
    expect((await providers()).google).toMatchObject({ source: 'env', clientId: 'env-id' });

    await call(
      router.providerApps.save,
      { provider: 'google', clientId: 'db-id', clientSecret: 'db-s' },
      { context: ctx },
    );
    expect((await providers()).google).toMatchObject({ source: 'database', clientId: 'db-id' });

    await call(router.providerApps.remove, { provider: 'google' }, { context: ctx });
    expect((await providers()).google).toMatchObject({ source: 'env', clientId: 'env-id' });
  });

  it('keeps the current secret when editing only the client ID', async () => {
    const { ctx, db } = setup();
    const save = (input: { clientId: string; clientSecret?: string }) =>
      call(router.providerApps.save, { provider: 'google', ...input }, { context: ctx });

    await expect(save({ clientId: 'id-1' })).rejects.toSatisfy(
      (e) => e instanceof ORPCError && e.code === 'BAD_REQUEST',
    );
    await save({ clientId: 'id-1', clientSecret: 'secret-1' });
    await save({ clientId: 'id-2', clientSecret: '' });

    const [row] = db.select().from(providerApp).all();
    expect(Effect.runSync(ctx.vault.decrypt(row!.config))).toEqual({
      clientId: 'id-2',
      clientSecret: 'secret-1',
    });
  });

  it('never returns secrets to the client', async () => {
    const { ctx } = setup();
    await call(
      router.providerApps.save,
      { provider: 'linkedin', clientId: 'id', clientSecret: 'top-secret' },
      { context: ctx },
    );
    const payload = JSON.stringify(
      await call(router.accounts.providers, undefined, { context: ctx }),
    );
    expect(payload).not.toContain('top-secret');
  });
});
