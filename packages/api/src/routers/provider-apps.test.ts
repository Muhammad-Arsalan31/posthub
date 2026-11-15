import { providerApp } from '@posthub/db';
import { createTestDb, seedUser } from '@posthub/db/testing';
import { describe, expect, it } from 'vite-plus/test';
import { sessionFor, testContext } from '../testing';
import { Effect } from 'effect';

function setup(env: Parameters<typeof testContext>[2] = {}) {
  const db = createTestDb();
  const ctx = testContext(db, sessionFor(seedUser(db)), env);
  const providers = async () =>
    Object.fromEntries((await ctx.api.accounts.providers()).map((p) => [p.id, p]));
  return { db, ctx, providers };
}

describe('provider apps', () => {
  it('enables a provider immediately and stores the secret encrypted', async () => {
    const { db, ctx, providers } = setup();
    expect((await providers()).linkedin).toMatchObject({ configured: false, source: null });

    await ctx.api.providerApps.save({
      provider: 'linkedin',
      clientId: 'li-id',
      clientSecret: 'li-secret',
    });

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
    await ctx.api.providerApps.save({ provider: 'meta', clientId: 'app', clientSecret: 's' });
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

    await ctx.api.providerApps.save({
      provider: 'google',
      clientId: 'db-id',
      clientSecret: 'db-s',
    });
    expect((await providers()).google).toMatchObject({ source: 'database', clientId: 'db-id' });

    await ctx.api.providerApps.remove({ provider: 'google' });
    expect((await providers()).google).toMatchObject({ source: 'env', clientId: 'env-id' });
  });

  it('keeps the current secret when editing only the client ID', async () => {
    const { ctx, db } = setup();
    const save = (input: { clientId: string; clientSecret?: string }) =>
      ctx.api.providerApps.save({ provider: 'google', ...input });

    await expect(save({ clientId: 'id-1' })).rejects.toSatisfy((e) => e._tag === 'BadRequest');
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
    await ctx.api.providerApps.save({
      provider: 'linkedin',
      clientId: 'id',
      clientSecret: 'top-secret',
    });
    const payload = JSON.stringify(await ctx.api.accounts.providers());
    expect(payload).not.toContain('top-secret');
  });
});
