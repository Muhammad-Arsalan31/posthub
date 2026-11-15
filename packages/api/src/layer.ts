import type { Db } from '@posthub/db';
import { Vault, type IntegrationDeps, type IntegrationsConfig } from '@posthub/integrations';
import { Layer } from 'effect';
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
