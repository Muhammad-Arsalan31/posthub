import { mkdirSync } from 'node:fs';
import { serve } from '@hono/node-server';
import { createIntegrationsManager } from '@posthub/api';
import { createAuth } from '@posthub/auth';
import { createDb, runMigrations } from '@posthub/db';
import { createVault } from '@posthub/integrations';
import { createApp } from './app';
import { env } from './env';

mkdirSync(env.mediaDir, { recursive: true });

const db = createDb(env.databasePath);
runMigrations(db, env.migrationsDir);

const auth = createAuth({ db, baseURL: env.publicUrl, secret: env.secret });
const vault = createVault(env.encryptionKey);
// App credentials from the Accounts page (DB) override those from .env.
const providerApps = createIntegrationsManager({ db, vault, envConfig: env.integrations });
const app = createApp({ db, auth, providerApps, vault });

const server = serve({ fetch: app.fetch, port: env.port, hostname: '127.0.0.1' }, (info) => {
  const enabled = providerApps.current
    .status()
    .filter((p) => p.configured)
    .map((p) => p.label);
  console.log(`PostHub server on http://127.0.0.1:${info.port} (data: ${env.dataDir})`);
  console.log(`Connectors: ${enabled.join(', ')}`);
});

const shutdown = () => server.close(() => process.exit(0));
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
