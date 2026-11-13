import { mkdirSync } from 'node:fs';
import { serve } from '@hono/node-server';
import { createAuth } from '@posthub/auth';
import { createDb, runMigrations } from '@posthub/db';
import { createApp } from './app';
import { env } from './env';

mkdirSync(env.mediaDir, { recursive: true });

const db = createDb(env.databasePath);
runMigrations(db, env.migrationsDir);

const auth = createAuth({ db, baseURL: env.publicUrl, secret: env.secret });
const app = createApp({ db, auth });

const server = serve({ fetch: app.fetch, port: env.port, hostname: '127.0.0.1' }, (info) => {
  console.log(`PostHub server on http://127.0.0.1:${info.port} (data: ${env.dataDir})`);
});

const shutdown = () => server.close(() => process.exit(0));
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
