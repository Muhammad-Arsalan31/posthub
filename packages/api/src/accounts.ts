// Credential access for background work (publisher, sync worker): decrypt, refresh when about to
// expire, store refreshed tokens, and mark the account expired when the platform rejects the refresh.
import { socialAccount } from '@posthub/db';
import {
  PlatformError,
  refreshIfExpiring,
  Vault,
  type PlatformAdapter,
  type PublishError,
  type VaultError,
} from '@posthub/integrations';
import { eq } from 'drizzle-orm';
import { Effect } from 'effect';
import { Database, type DatabaseError } from './services';

type AccountRow = typeof socialAccount.$inferSelect;

/** Anything that can refresh its credentials: a publish adapter or an insights adapter. */
type Refresher = Pick<PlatformAdapter<unknown>, 'refresh'>;

export interface CredentialAccess {
  /**
   * The account's credentials, refreshed first if they expire soon (and stored again). A refresh
   * the platform rejects (non-retryable) marks the account `expired`: the owner must reconnect.
   */
  fresh(
    account: AccountRow & { credentials: string },
    adapter: Refresher,
  ): Effect.Effect<unknown, PublishError | VaultError | DatabaseError>;
}

export const makeCredentialAccess = Effect.gen(function* () {
  const database = yield* Database;
  const vault = yield* Vault;

  const markExpired = (accountId: string) =>
    database.use((db) =>
      db
        .update(socialAccount)
        .set({ status: 'expired' })
        .where(eq(socialAccount.id, accountId))
        .run(),
    );

  return {
    fresh: (account, adapter) =>
      Effect.gen(function* () {
        const credentials = yield* vault.decrypt(account.credentials);
        const refreshed = yield* refreshIfExpiring(
          adapter as PlatformAdapter<unknown>,
          credentials,
          account.tokenExpiresAt,
        ).pipe(
          Effect.tapError((error) =>
            error instanceof PlatformError && !error.retryable
              ? Effect.orElseSucceed(markExpired(account.id), () => undefined)
              : Effect.void,
          ),
        );
        if (!refreshed) return credentials;
        const stored = vault.encrypt(refreshed.credentials);
        yield* database.use((db) =>
          db
            .update(socialAccount)
            .set({ credentials: stored, tokenExpiresAt: refreshed.tokenExpiresAt })
            .where(eq(socialAccount.id, account.id))
            .run(),
        );
        return refreshed.credentials;
      }),
  } satisfies CredentialAccess;
});
