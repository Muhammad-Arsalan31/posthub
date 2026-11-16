import { socialAccount } from '@posthub/db';
import { createTestDb, seedUser } from '@posthub/db/testing';
import { createVault, platformError, Vault } from '@posthub/integrations';
import { describe, expect, it } from '@effect/vitest';
import { eq } from 'drizzle-orm';
import { Effect, Layer } from 'effect';
import { TestClock } from 'effect/testing';
import { makeCredentialAccess } from './accounts';
import { Database } from './services';
import { TEST_ENCRYPTION_KEY } from './testing';

const setup = Effect.fnUntraced(function* (tokenExpiresAt: Date | null) {
  yield* TestClock.setTime(new Date('2030-01-01T00:00:00Z').getTime());
  const db = createTestDb();
  const user = seedUser(db);
  const vault = createVault(TEST_ENCRYPTION_KEY);
  const layer = Layer.mergeAll(Database.layer(db), Layer.succeed(Vault, vault));
  const account = db
    .insert(socialAccount)
    .values({
      id: crypto.randomUUID(),
      userId: user.id,
      platform: 'youtube',
      externalId: 'ch1',
      displayName: 'Channel',
      credentials: vault.encrypt({ token: 'old' }),
      tokenExpiresAt,
    })
    .returning()
    .get();
  const access = yield* Effect.provide(makeCredentialAccess, layer);
  const row = () => db.select().from(socialAccount).where(eq(socialAccount.id, account.id)).get()!;
  return { access, vault, row, account: { ...account, credentials: account.credentials! } };
});

describe('credential access', () => {
  it.effect('returns stored credentials when they are not about to expire', () =>
    Effect.gen(function* () {
      const { access, account } = yield* setup(new Date('2030-01-02T00:00:00Z'));
      const refresh = () => Effect.die('should not refresh');
      expect(yield* access.fresh(account, { refresh })).toEqual({ token: 'old' });
    }),
  );

  it.effect('refreshes expiring credentials and stores them', () =>
    Effect.gen(function* () {
      const { access, account, row, vault } = yield* setup(new Date('2030-01-01T00:01:00Z'));
      const expires = new Date('2030-01-01T01:00:00Z');
      const result = yield* access.fresh(account, {
        refresh: () => Effect.succeed({ credentials: { token: 'new' }, tokenExpiresAt: expires }),
      });
      expect(result).toEqual({ token: 'new' });
      expect(row().tokenExpiresAt).toEqual(expires);
      expect(yield* vault.decrypt(row().credentials!)).toEqual({ token: 'new' });
    }),
  );

  it.effect('marks the account expired when the platform rejects the refresh', () =>
    Effect.gen(function* () {
      const { access, account, row } = yield* setup(new Date('2030-01-01T00:01:00Z'));
      const error = yield* Effect.flip(
        access.fresh(account, {
          refresh: () =>
            Effect.fail(platformError('youtube', 'invalid_grant', { retryable: false })),
        }),
      );
      expect(error.message).toBe('youtube: invalid_grant');
      expect(row().status).toBe('expired');
    }),
  );

  it.effect('keeps the account active when the refresh can be retried', () =>
    Effect.gen(function* () {
      const { access, account, row } = yield* setup(new Date('2030-01-01T00:01:00Z'));
      yield* Effect.flip(
        access.fresh(account, {
          refresh: () => Effect.fail(platformError('youtube', 'busy', { status: 503 })),
        }),
      );
      expect(row().status).toBe('active');
    }),
  );
});
