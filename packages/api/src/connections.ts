// Platform connect flows, shared by the OAuth routes and the accounts router.
import { randomBytes, randomUUID } from 'node:crypto';
import { oauthState, socialAccount } from '@posthub/db';
import { Vault, type ConnectedAccount, type Integrations } from '@posthub/integrations';
import { eq, lt } from 'drizzle-orm';
import { Clock, Effect, Schema } from 'effect';
import { Database } from './services';

const STATE_TTL_MS = 10 * 60_000;

/** A user-facing connection problem: shown on the Accounts page. */
export class ConnectionError extends Schema.TaggedError<ConnectionError>()('ConnectionError', {
  message: Schema.String,
}) {}

const now = Effect.map(Clock.currentTimeMillis, (ms) => new Date(ms));

/** Records a one-time `state` and returns the provider's consent URL. */
export const beginOAuth = Effect.fn('beginOAuth')(function* ({
  integrations,
  userId,
  providerId,
  redirectUri,
}: {
  integrations: Integrations;
  userId: string;
  providerId: string;
  redirectUri: string;
}) {
  const database = yield* Database;
  const provider = integrations.oauth(providerId);
  if (!provider) {
    return yield* new ConnectionError({
      message: `${providerId} is not configured on the server.`,
    });
  }
  const at = yield* now;
  const state = randomBytes(24).toString('base64url');
  yield* database.use((db) => {
    db.delete(oauthState)
      .where(lt(oauthState.createdAt, new Date(at.getTime() - STATE_TTL_MS)))
      .run();
    db.insert(oauthState).values({ state, userId, provider: providerId, createdAt: at }).run();
  });
  return provider.authorizationUrl({ state, redirectUri });
});

/** Validates and consumes `state`, exchanges the code, and stores the resulting accounts. */
export const completeOAuth = Effect.fn('completeOAuth')(function* ({
  integrations,
  userId,
  providerId,
  state,
  code,
  redirectUri,
}: {
  integrations: Integrations;
  userId: string;
  providerId: string;
  state: string;
  code: string;
  redirectUri: string;
}) {
  const database = yield* Database;
  // Consumed whatever happens next, so a state can never be used twice.
  const row = yield* database.transaction(
    database.use((db) => {
      const found = db.select().from(oauthState).where(eq(oauthState.state, state)).get();
      if (found) db.delete(oauthState).where(eq(oauthState.state, state)).run();
      return found;
    }),
  );
  const at = yield* now;
  if (
    !row ||
    row.provider !== providerId ||
    row.userId !== userId ||
    row.createdAt.getTime() < at.getTime() - STATE_TTL_MS
  ) {
    return yield* new ConnectionError({
      message: 'This connection link is invalid or expired. Please try again.',
    });
  }

  const provider = integrations.oauth(providerId);
  if (!provider) {
    return yield* new ConnectionError({
      message: `${providerId} is not configured on the server.`,
    });
  }

  const accounts = yield* provider.connect({ code, redirectUri });
  yield* saveAccounts(userId, accounts);
  return accounts;
});

/** Inserts accounts, or refreshes credentials when the same platform account reconnects. */
export const saveAccounts = Effect.fn('saveAccounts')(function* (
  userId: string,
  accounts: ConnectedAccount[],
) {
  const database = yield* Database;
  const vault = yield* Vault;
  const updatedAt = yield* now;
  yield* database.transaction(
    database.use((db) => {
      for (const account of accounts) {
        const values = {
          userId,
          displayName: account.displayName,
          credentials: vault.encrypt(account.credentials),
          tokenExpiresAt: account.tokenExpiresAt,
          status: 'active' as const,
        };
        db.insert(socialAccount)
          .values({
            id: randomUUID(),
            platform: account.platform,
            externalId: account.externalId,
            ...values,
          })
          .onConflictDoUpdate({
            target: [socialAccount.platform, socialAccount.externalId],
            set: { ...values, updatedAt },
          })
          .run();
      }
    }),
  );
});
