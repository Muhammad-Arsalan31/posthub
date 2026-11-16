import { appSetting } from '@posthub/db';
import { createTestDb, seedUser } from '@posthub/db/testing';
import { createFakeFetch } from '@posthub/integrations/testing';
import { Effect } from 'effect';
import { describe, expect, it } from 'vite-plus/test';
import { sessionFor, testContext } from '../testing';

const input = {
  endpoint: 'https://acct.r2.test',
  region: 'auto',
  bucket: 'media',
  accessKeyId: 'key-id',
  secretAccessKey: 'top-secret',
};

function setup(routes: Parameters<typeof createFakeFetch>[0] = []) {
  const db = createTestDb();
  const fake = createFakeFetch(routes);
  const ctx = testContext(db, sessionFor(seedUser(db)), { deps: { fetch: fake.fetch } });
  return { db, ctx, fake };
}

describe('settings: media host', () => {
  it('saves the media host with the secret encrypted, and never returns it', async () => {
    const { db, ctx } = setup();
    expect(await ctx.api.settings.mediaHost()).toBeNull();

    const saved = await ctx.api.settings.saveMediaHost({ ...input, publicBaseUrl: null });
    expect(saved).toEqual({
      endpoint: 'https://acct.r2.test',
      region: 'auto',
      bucket: 'media',
      accessKeyId: 'key-id',
      publicBaseUrl: null,
    });
    expect(JSON.stringify(await ctx.api.settings.mediaHost())).not.toContain('top-secret');

    const [row] = db.select().from(appSetting).all();
    expect(row).toMatchObject({ key: 'mediaHost', secret: true });
    expect(row!.value).not.toContain('top-secret');
    expect(Effect.runSync(ctx.vault.decrypt(row!.value))).toMatchObject({
      secretAccessKey: 'top-secret',
    });
  });

  it('keeps the current secret when it is left empty, and requires one at first', async () => {
    const { db, ctx } = setup();
    const { secretAccessKey: _secret, ...withoutSecret } = input;
    await expect(ctx.api.settings.saveMediaHost(withoutSecret)).rejects.toSatisfy(
      (e) => e._tag === 'BadRequest',
    );
    await ctx.api.settings.saveMediaHost(input);
    await ctx.api.settings.saveMediaHost({
      ...withoutSecret,
      bucket: 'other',
      secretAccessKey: '',
    });

    const [row] = db.select().from(appSetting).all();
    expect(Effect.runSync(ctx.vault.decrypt(row!.value))).toMatchObject({
      bucket: 'other',
      secretAccessKey: 'top-secret',
    });
  });

  it('is scoped to its owner', async () => {
    const { db, ctx } = setup();
    await ctx.api.settings.saveMediaHost(input);
    const other = testContext(db, sessionFor(seedUser(db)));
    expect(await other.api.settings.mediaHost()).toBeNull();
    await other.api.settings.removeMediaHost();
    expect(await ctx.api.settings.mediaHost()).not.toBeNull();

    await ctx.api.settings.removeMediaHost();
    expect(await ctx.api.settings.mediaHost()).toBeNull();
  });

  it('tests the settings with a round trip, and reports failures as BadGateway', async () => {
    const { ctx, fake } = setup([
      ['PUT https://acct.r2.test/media/', () => new Response('')],
      ['GET https://acct.r2.test/media/', () => new Response('nope', { status: 403 })],
      ['DELETE https://acct.r2.test/media/', () => new Response(null)],
    ]);
    const error = await ctx.api.settings.testMediaHost(input).catch((e: unknown) => e);
    expect(error).toMatchObject({ _tag: 'BadGateway' });
    expect((error as Error).message).toContain("can't be downloaded");
    expect(fake.calls.map((c) => c.method)).toEqual(['PUT', 'GET', 'DELETE']);
  });

  it('refuses signed-out callers', async () => {
    const db = createTestDb();
    const ctx = testContext(db, null);
    const response = await ctx.fetch('/rpc/settings/media-host');
    expect(response.status).toBe(401);
  });
});
