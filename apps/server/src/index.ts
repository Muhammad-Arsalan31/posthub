import { mkdirSync } from 'node:fs';
import { serve } from '@hono/node-server';
import { createIntegrationsManager, createPublisher } from '@posthub/api';
import { createAuth } from '@posthub/auth';
import { createDb, runMigrations } from '@posthub/db';
import { createVault } from '@posthub/integrations';
import { createApp } from './app';
import { version } from '../../../package.json';
import { env } from './env';

mkdirSync(env.mediaDir, { recursive: true });

const db = createDb(env.databasePath);
runMigrations(db, env.migrationsDir);

const auth = createAuth({ db, baseURL: env.publicUrl, secret: env.secret });
const vault = createVault(env.encryptionKey);
// App credentials from the Accounts page (DB) override those from .env.
const providerApps = createIntegrationsManager({ db, vault, envConfig: env.integrations });
const app = createApp({ db, auth, providerApps, vault });

// Publishes due posts in the background, whether or not a browser is open.
const publisher = createPublisher({
  db,
  vault,
  integrations: () => providerApps.current,
  mediaDir: env.mediaDir,
});
publisher.start();

const server = serve({ fetch: app.fetch, port: env.port, hostname: '127.0.0.1' }, (info) => {
  const enabled = providerApps.current
    .status()
    .filter((p) => p.configured)
    .map((p) => p.label);
  console.log(`PostHub v${version} on http://127.0.0.1:${info.port} (data: ${env.dataDir})`);
  console.log(`Connectors: ${enabled.join(', ')}`);
});

const shutdown = () => {
  // Let uploads in progress finish so they aren't left uncertain on the next start.
  server.close();
  void publisher.stop().finally(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
