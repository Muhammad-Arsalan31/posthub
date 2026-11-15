// Developer-app credentials (client id/secret) per OAuth provider: stored encrypted in the DB,
// merged over apps/server/.env, and applied immediately, with no restart needed.
import { providerApp } from '@posthub/db';
import {
  createIntegrations,
  Vault,
  type IntegrationDeps,
  type Integrations,
  type IntegrationsConfig,
  type OAuthProviderId,
} from '@posthub/integrations';
import { eq } from 'drizzle-orm';
import { Clock, Context, Effect, Layer, Option, Ref, Schema } from 'effect';
import { Database, type DatabaseError } from './services';

export const OAUTH_PROVIDER_IDS = ['google', 'meta', 'linkedin'] as const;

export type AppSource = 'database' | 'env';

export interface AppCredentialsInput {
  clientId: string;
  /** Leave empty to keep the current secret. */
  clientSecret?: string;
}

/** The owner's input can't be saved (e.g. a missing secret). */
export class ProviderAppError extends Schema.TaggedError<ProviderAppError>()('ProviderAppError', {
  message: Schema.String,
}) {}

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

export interface ProviderAppsService {
  /** Current connectors. Read it per use: it is replaced whenever credentials change. */
  readonly current: Effect.Effect<Integrations>;
  describe(
    provider: OAuthProviderId,
  ): Effect.Effect<{ source: AppSource | null; clientId: string | null }>;
  save(
    provider: OAuthProviderId,
    input: AppCredentialsInput,
  ): Effect.Effect<void, ProviderAppError | DatabaseError>;
  /** Deletes stored credentials; the provider falls back to .env values, if any. */
  remove(provider: OAuthProviderId): Effect.Effect<void, DatabaseError>;
}

export interface ProviderAppsOptions {
  /** Config from environment variables. Per provider, stored values override these field by field. */
  envConfig?: IntegrationsConfig;
  deps?: IntegrationDeps;
}

interface State {
  merged: IntegrationsConfig;
  sources: Partial<Record<OAuthProviderId, AppSource>>;
  integrations: Integrations;
}

export const makeProviderApps = Effect.fnUntraced(function* ({
  envConfig = {},
  deps,
}: ProviderAppsOptions = {}) {
  const database = yield* Database;
  const vault = yield* Vault;

  const load = Effect.gen(function* () {
    const stored: Record<string, object> = {};
    const rows = yield* database.use((db) => db.select().from(providerApp).all());
    for (const row of rows) {
      const config = yield* vault.decrypt<object>(row.config).pipe(
        Effect.map(Option.some),
        Effect.catchTag('VaultError', () =>
          Effect.as(
            Effect.logWarning(
              `[provider-apps] could not decrypt ${row.provider}; was the encryption key changed?`,
            ),
            Option.none(),
          ),
        ),
      );
      if (Option.isSome(config)) stored[row.provider] = config.value;
    }

    const merged: Record<string, object> = {};
    const sources: State['sources'] = {};
    for (const id of OAUTH_PROVIDER_IDS) {
      const fromEnv = envConfig[id];
      const fromDb = stored[id];
      if (fromDb) sources[id] = 'database';
      else if (fromEnv) sources[id] = 'env';
      if (fromEnv || fromDb) merged[id] = { ...fromEnv, ...fromDb };
    }
    return {
      merged: merged as IntegrationsConfig,
      sources,
      integrations: createIntegrations(merged as IntegrationsConfig, deps),
    } satisfies State;
  });

  const state = yield* Ref.make(yield* load);
  const rebuild = Effect.flatMap(load, (next) => Ref.set(state, next));

  return ProviderApps.of({
    current: Effect.map(Ref.get(state), (s) => s.integrations),

    describe: (provider) =>
      Effect.map(Ref.get(state), ({ sources, merged }) => ({
        source: sources[provider] ?? null,
        clientId: readPair(provider, merged)?.clientId ?? null,
      })),

    save: Effect.fnUntraced(function* (provider, input) {
      const { merged } = yield* Ref.get(state);
      const clientId = input.clientId.trim();
      const clientSecret = input.clientSecret?.trim() || readPair(provider, merged)?.clientSecret;
      if (!clientId || !clientSecret) {
        return yield* new ProviderAppError({
          message: 'Both the client ID and the client secret are required.',
        });
      }
      const config = vault.encrypt(toProviderConfig(provider, clientId, clientSecret));
      const updatedAt = new Date(yield* Clock.currentTimeMillis);
      yield* database.use((db) =>
        db
          .insert(providerApp)
          .values({ provider, config })
          .onConflictDoUpdate({ target: providerApp.provider, set: { config, updatedAt } })
          .run(),
      );
      yield* rebuild;
    }),

    remove: (provider) =>
      Effect.andThen(
        database.use((db) =>
          db.delete(providerApp).where(eq(providerApp.provider, provider)).run(),
        ),
        rebuild,
      ),
  });
});

export class ProviderApps extends Context.Service<ProviderApps, ProviderAppsService>()(
  '@posthub/api/ProviderApps',
) {
  static readonly layer = (options: ProviderAppsOptions = {}) =>
    Layer.effect(ProviderApps, makeProviderApps(options));
}
