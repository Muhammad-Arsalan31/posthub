import { mkdirSync } from 'node:fs';
import { serve } from '@hono/node-server';
import { apiLayer, ProviderApps, Publisher, publisherWorker } from '@posthub/api';
import { createAuth } from '@posthub/auth';
import { createDb, runMigrations } from '@posthub/db';
import { Effect, Layer, ManagedRuntime } from 'effect';
import { createApp } from './app';
import { version } from '../../../package.json';
import { env } from './env';

mkdirSync(env.mediaDir, { recursive: true });

const db = createDb(env.databasePath);
runMigrations(db, env.migrationsDir);

const auth = createAuth({ db, baseURL: env.publicUrl, secret: env.secret });

// App credentials from the Accounts page (DB) override those from .env. The publisher publishes
// due posts in the background, whether or not a browser is open.
const runtime = ManagedRuntime.make(
  publisherWorker().pipe(
    Layer.provideMerge(Publisher.layer()),
    Layer.provideMerge(
      apiLayer({
        db,
        encryptionKey: env.encryptionKey,
        mediaDir: env.mediaDir,
        envConfig: env.integrations,
      }),
    ),
  ),
);
const services = await runtime.context();
const app = createApp({ auth, services });

const server = serve({ fetch: app.fetch, port: env.port, hostname: '127.0.0.1' }, (info) => {
  void runtime.runPromise(
    Effect.gen(function* () {
      const integrations = yield* (yield* ProviderApps).current;
      const enabled = integrations
        .status()
        .filter((p) => p.configured)
        .map((p) => p.label);
      console.log(`PostHub v${version} on http://127.0.0.1:${info.port} (data: ${env.dataDir})`);
      console.log(`Connectors: ${enabled.join(', ')}`);
    }),
  );
});

const shutdown = () => {
  // Stop polling and let uploads in progress finish, so they aren't left uncertain on the next start.
  server.close();
  void runtime.dispose().finally(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
