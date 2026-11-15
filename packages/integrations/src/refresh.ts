import { Clock, Effect } from 'effect';
import type { PublishError } from './http';
import type { PlatformAdapter, RefreshResult } from './types';

const REFRESH_MARGIN_MS = 5 * 60_000;

/**
 * Refreshes credentials if they expire within 5 minutes. Succeeds with null when no refresh was needed.
 * `now` defaults to the Clock.
 */
export const refreshIfExpiring = Effect.fnUntraced(function* <C>(
  adapter: PlatformAdapter<C>,
  credentials: C,
  tokenExpiresAt: Date | null,
  now?: number,
): Effect.fn.Return<RefreshResult<C> | null, PublishError> {
  if (!adapter.refresh || !tokenExpiresAt) return null;
  const current = now ?? (yield* Clock.currentTimeMillis);
  if (tokenExpiresAt.getTime() - current > REFRESH_MARGIN_MS) return null;
  return yield* adapter.refresh(credentials);
});
