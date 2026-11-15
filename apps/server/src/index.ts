import { existsSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { NodeHttpServer, NodeRuntime } from '@effect/platform-node';
import { apiLayer, ProviderApps, Publisher, publisherWorker, Sessions } from '@posthub/api';
import { createAuth } from '@posthub/auth';
import { createDb, runMigrations } from '@posthub/db';
import { Effect, Layer } from 'effect';
import { HttpRouter } from 'effect/http';
import { appRoutes } from './app';
import { version } from '../../../package.json';
import { env } from './env';

mkdirSync(env.mediaDir, { recursive: true });

const db = createDb(env.databasePath);
runMigrations(db, env.migrationsDir);

const auth = createAuth({ db, baseURL: env.publicUrl, secret: env.secret });

const announce = Layer.effectDiscard(
  Effect.gen(function* () {
    const integrations = yield* (yield* ProviderApps).current;
    const enabled = integrations
      .status()
      .filter((p) => p.configured)
      .map((p) => p.label);
    yield* Effect.logInfo(
      `PostHub v${version} on http://127.0.0.1:${env.port} (data: ${env.dataDir})`,
    );
    yield* Effect.logInfo(`Connectors: ${enabled.join(', ')}`);
  }),
);

const server = HttpRouter.serve(
  appRoutes({
    auth,
    // Production: serve the built PWA from the same origin.
    webDist: env.isProduction && existsSync(env.webDist) ? env.webDist : undefined,
  }),
).pipe(Layer.provide(NodeHttpServer.layer(createServer, { port: env.port, host: '127.0.0.1' })));

// The HTTP server, plus the publisher, which publishes due posts in the background whether or
// not a browser is open. App credentials from the Accounts page (DB) override those from .env.
const main = Layer.mergeAll(server, publisherWorker(), announce).pipe(
  Layer.provide([Publisher.layer(), Sessions.layer(auth)]),
  Layer.provideMerge(
    apiLayer({
      db,
      encryptionKey: env.encryptionKey,
      mediaDir: env.mediaDir,
      envConfig: env.integrations,
    }),
  ),
);

// Ctrl+C / SIGTERM interrupts the program: the server stops accepting requests and the publisher
// waits for uploads in progress, so they aren't left uncertain on the next start.
Layer.launch(main).pipe(NodeRuntime.runMain);
