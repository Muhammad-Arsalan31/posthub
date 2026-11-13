// Platform connect flows, shared by the Hono OAuth routes and the oRPC accounts router.
import { randomBytes, randomUUID } from 'node:crypto';
import { oauthState, socialAccount, type Db } from '@posthub/db';
import type { ConnectedAccount, Integrations, Vault } from '@posthub/integrations';
import { eq, lt } from 'drizzle-orm';

const STATE_TTL_MS = 10 * 60_000;

/** A user-facing connection problem: shown on the Accounts page. */
export class ConnectionError extends Error {
  override name = 'ConnectionError';
}

interface Deps {
  db: Db;
  integrations: Integrations;
}

/** Records a one-time `state` and returns the provider's consent URL. */
export function beginOAuth({
  db,
  integrations,
  userId,
  providerId,
  redirectUri,
}: Deps & { userId: string; providerId: string; redirectUri: string }) {
  const provider = integrations.oauth(providerId);
  if (!provider) throw new ConnectionError(`${providerId} is not configured on the server.`);

  db.delete(oauthState)
    .where(lt(oauthState.createdAt, new Date(Date.now() - STATE_TTL_MS)))
    .run();
  const state = randomBytes(24).toString('base64url');
  db.insert(oauthState).values({ state, userId, provider: providerId }).run();
  return provider.authorizationUrl({ state, redirectUri });
}

/** Validates and consumes `state`, exchanges the code, and stores the resulting accounts. */
export async function completeOAuth({
  db,
  integrations,
  vault,
  userId,
  providerId,
  state,
  code,
  redirectUri,
}: Deps & {
  vault: Vault;
  userId: string;
  providerId: string;
  state: string;
  code: string;
  redirectUri: string;
}) {
  const row = db.select().from(oauthState).where(eq(oauthState.state, state)).get();
  if (row) db.delete(oauthState).where(eq(oauthState.state, state)).run();
  if (
    !row ||
    row.provider !== providerId ||
    row.userId !== userId ||
    row.createdAt.getTime() < Date.now() - STATE_TTL_MS
  ) {
    throw new ConnectionError('This connection link is invalid or expired. Please try again.');
  }

  const provider = integrations.oauth(providerId);
  if (!provider) throw new ConnectionError(`${providerId} is not configured on the server.`);

  const accounts = await provider.connect({ code, redirectUri });
  saveAccounts(db, vault, userId, accounts);
  return accounts;
}

/** Inserts accounts, or refreshes credentials when the same platform account reconnects. */
export function saveAccounts(db: Db, vault: Vault, userId: string, accounts: ConnectedAccount[]) {
  db.transaction((tx) => {
    for (const account of accounts) {
      const values = {
        userId,
        displayName: account.displayName,
        credentials: vault.encrypt(account.credentials),
        tokenExpiresAt: account.tokenExpiresAt,
        status: 'active' as const,
      };
      tx.insert(socialAccount)
        .values({
          id: randomUUID(),
          platform: account.platform,
          externalId: account.externalId,
          ...values,
        })
        .onConflictDoUpdate({
          target: [socialAccount.platform, socialAccount.externalId],
          set: { ...values, updatedAt: new Date() },
        })
        .run();
    }
  });
}
