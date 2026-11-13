import type { PlatformAdapter, RefreshResult } from './types';

const REFRESH_MARGIN_MS = 5 * 60_000;

/** Refreshes credentials if they expire within 5 minutes. Returns null when no refresh was needed. */
export async function refreshIfExpiring<C>(
  adapter: PlatformAdapter<C>,
  credentials: C,
  tokenExpiresAt: Date | null,
  now = Date.now(),
): Promise<RefreshResult<C> | null> {
  if (!adapter.refresh || !tokenExpiresAt) return null;
  if (tokenExpiresAt.getTime() - now > REFRESH_MARGIN_MS) return null;
  return adapter.refresh(credentials);
}
