import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { TestClock } from 'effect/testing';
import { refreshIfExpiring } from './refresh';
import type { PlatformAdapter } from './types';
import { createVault } from './vault';

const KEY = 'k'.repeat(32);

describe('vault', () => {
  it.effect('round-trips values and uses a fresh IV each time', () =>
    Effect.gen(function* () {
      const vault = createVault(KEY);
      const a = vault.encrypt({ token: 'secret' });
      const b = vault.encrypt({ token: 'secret' });
      expect(a).not.toBe(b);
      expect(a).not.toContain('secret');
      expect(yield* vault.decrypt(a)).toEqual({ token: 'secret' });
    }),
  );

  it.effect('rejects tampered data and wrong keys', () =>
    Effect.gen(function* () {
      const payload = createVault(KEY).encrypt({ token: 'secret' });
      const tampered = payload.slice(0, -2) + (payload.endsWith('A') ? 'BB' : 'AA');
      expect(yield* Effect.flip(createVault(KEY).decrypt(tampered))).toMatchObject({
        _tag: 'VaultError',
      });
      const wrongKey = yield* Effect.flip(createVault('x'.repeat(32)).decrypt(payload));
      expect(wrongKey.message).toMatch(/encryption key/);
    }),
  );

  it('requires a long key', () => {
    expect(() => createVault('short')).toThrow(/32/);
  });
});

describe('refreshIfExpiring', () => {
  const adapter: PlatformAdapter<{ n: number }> = {
    platform: 'youtube',
    publish: () => Effect.succeed({ externalId: 'x' }),
    refresh: (c) => Effect.succeed({ credentials: { n: c.n + 1 }, tokenExpiresAt: null }),
  };

  it.effect('refreshes only near expiry', () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(1_000_000);
      const inAnHour = new Date(1_000_000 + 3_600_000);
      expect(yield* refreshIfExpiring(adapter, { n: 1 }, inAnHour)).toBeNull();
      expect(yield* refreshIfExpiring(adapter, { n: 1 }, null)).toBeNull();
      expect(yield* refreshIfExpiring(adapter, { n: 1 }, new Date(1_000_000 + 60_000))).toEqual({
        credentials: { n: 2 },
        tokenExpiresAt: null,
      });
    }),
  );
});
