import { describe, expect, it } from 'vite-plus/test';
import { refreshIfExpiring } from './refresh';
import type { PlatformAdapter } from './types';
import { createVault } from './vault';

const KEY = 'k'.repeat(32);

describe('vault', () => {
  it('round-trips values and uses a fresh IV each time', () => {
    const vault = createVault(KEY);
    const a = vault.encrypt({ token: 'secret' });
    const b = vault.encrypt({ token: 'secret' });
    expect(a).not.toBe(b);
    expect(a).not.toContain('secret');
    expect(vault.decrypt(a)).toEqual({ token: 'secret' });
  });

  it('rejects tampered data and wrong keys', () => {
    const payload = createVault(KEY).encrypt({ token: 'secret' });
    const tampered = payload.slice(0, -2) + (payload.endsWith('A') ? 'BB' : 'AA');
    expect(() => createVault(KEY).decrypt(tampered)).toThrow();
    expect(() => createVault('x'.repeat(32)).decrypt(payload)).toThrow();
  });

  it('requires a long key', () => {
    expect(() => createVault('short')).toThrow(/32/);
  });
});

describe('refreshIfExpiring', () => {
  const adapter: PlatformAdapter<{ n: number }> = {
    platform: 'youtube',
    publish: async () => ({ externalId: 'x' }),
    refresh: async (c) => ({ credentials: { n: c.n + 1 }, tokenExpiresAt: null }),
  };

  it('refreshes only near expiry', async () => {
    const now = Date.now();
    expect(await refreshIfExpiring(adapter, { n: 1 }, new Date(now + 3_600_000), now)).toBeNull();
    expect(await refreshIfExpiring(adapter, { n: 1 }, null, now)).toBeNull();
    expect(await refreshIfExpiring(adapter, { n: 1 }, new Date(now + 60_000), now)).toEqual({
      credentials: { n: 2 },
      tokenExpiresAt: null,
    });
  });
});
