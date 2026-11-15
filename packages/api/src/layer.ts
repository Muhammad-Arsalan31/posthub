import type { AuthSession } from '@posthub/auth';
import type { Db } from '@posthub/db';
import { Vault, type IntegrationDeps, type IntegrationsConfig } from '@posthub/integrations';
import { Context, Effect, Layer } from 'effect';
import type { Context as RpcContext } from './procedures';
import { ProviderApps } from './provider-apps';
import { Database, MediaDir } from './services';

export type ApiServices = Database | Vault | MediaDir | ProviderApps;

export interface ApiLayerOptions {
  db: Db;
  encryptionKey: string;
  mediaDir: string;
  /** Connector config from environment variables; app credentials saved in the UI win. */
  envConfig?: IntegrationsConfig;
  /** Fake fetch etc. in tests. */
  integrationDeps?: IntegrationDeps;
}

/** Everything the API needs, built from server config. */
export const apiLayer = (options: ApiLayerOptions) =>
  ProviderApps.layer({ envConfig: options.envConfig, deps: options.integrationDeps }).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Database.layer(options.db),
        Vault.layer(options.encryptionKey),
        MediaDir.layer(options.mediaDir),
      ),
    ),
  );

/** The oRPC context for one request, backed by built API services. */
export function rpcContext(
  services: Context.Context<ApiServices>,
  session: AuthSession | null,
): RpcContext {
  const providerApps = Context.get(services, ProviderApps);
  return {
    db: Context.get(services, Database),
    session,
    vault: Context.get(services, Vault),
    mediaDir: Context.get(services, MediaDir),
    providerApps,
    // A getter, so credentials saved mid-request (or mid-test) apply to the next use.
    get integrations() {
      return Effect.runSync(providerApps.current);
    },
    run: (effect) => Effect.runPromise(Effect.provideContext(effect, services)),
  };
}
