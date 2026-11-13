// Developer-app credentials (client id/secret) per OAuth provider: stored encrypted in the DB,
// merged over apps/server/.env, and applied immediately, with no restart needed.
import { providerApp, type Db } from '@posthub/db';
import {
  createIntegrations,
  type IntegrationDeps,
  type Integrations,
  type IntegrationsConfig,
  type OAuthProviderId,
  type Vault,
} from '@posthub/integrations';
import { eq } from 'drizzle-orm';

export const OAUTH_PROVIDER_IDS = ['google', 'meta', 'linkedin'] as const;

export type AppSource = 'database' | 'env';

export interface AppCredentialsInput {
  clientId: string;
  /** Leave empty to keep the current secret. */
  clientSecret?: string;
}

/** The common id/secret pair, regardless of each provider's field names. */
function readPair(provider: OAuthProviderId, config: IntegrationsConfig) {
  if (provider === 'meta') {
    return config.meta && { clientId: config.meta.appId, clientSecret: config.meta.appSecret };
  }
  return config[provider];
}

function toProviderConfig(provider: OAuthProviderId, clientId: string, clientSecret: string) {
  return provider === 'meta'
    ? { appId: clientId, appSecret: clientSecret }
    : { clientId, clientSecret };
}

export class ProviderAppError extends Error {
  override name = 'ProviderAppError';
}

export function createIntegrationsManager({
  db,
  vault,
  envConfig = {},
  deps,
}: {
  db: Db;
  vault: Vault;
  /** Config from environment variables. Per provider, stored values override these field by field. */
  envConfig?: IntegrationsConfig;
  deps?: IntegrationDeps;
}) {
  let merged: IntegrationsConfig = {};
  let sources: Partial<Record<OAuthProviderId, AppSource>> = {};
  let integrations: Integrations;

  function rebuild() {
    const stored: Record<string, object> = {};
    for (const row of db.select().from(providerApp).all()) {
      try {
        stored[row.provider] = vault.decrypt<object>(row.config);
      } catch {
        console.warn(
          `[provider-apps] could not decrypt ${row.provider}; was the encryption key changed?`,
        );
      }
    }

    const next: Record<string, object> = {};
    const nextSources: typeof sources = {};
    for (const id of OAUTH_PROVIDER_IDS) {
      const fromEnv = envConfig[id];
      const fromDb = stored[id];
      if (fromDb) nextSources[id] = 'database';
      else if (fromEnv) nextSources[id] = 'env';
      if (fromEnv || fromDb) next[id] = { ...fromEnv, ...fromDb };
    }

    merged = next as IntegrationsConfig;
    sources = nextSources;
    integrations = createIntegrations(merged, deps);
  }

  rebuild();

  return {
    /** Current connectors. Read it per request; it is replaced whenever credentials change. */
    get current() {
      return integrations;
    },

    describe(provider: OAuthProviderId) {
      return {
        source: sources[provider] ?? null,
        clientId: readPair(provider, merged)?.clientId ?? null,
      };
    },

    save(provider: OAuthProviderId, input: AppCredentialsInput) {
      const clientId = input.clientId.trim();
      const clientSecret = input.clientSecret?.trim() || readPair(provider, merged)?.clientSecret;
      if (!clientId || !clientSecret) {
        throw new ProviderAppError('Both the client ID and the client secret are required.');
      }
      const config = vault.encrypt(toProviderConfig(provider, clientId, clientSecret));
      db.insert(providerApp)
        .values({ provider, config })
        .onConflictDoUpdate({
          target: providerApp.provider,
          set: { config, updatedAt: new Date() },
        })
        .run();
      rebuild();
    },

    /** Deletes stored credentials; the provider falls back to .env values, if any. */
    remove(provider: OAuthProviderId) {
      db.delete(providerApp).where(eq(providerApp.provider, provider)).run();
      rebuild();
    },
  };
}

export type IntegrationsManager = ReturnType<typeof createIntegrationsManager>;
