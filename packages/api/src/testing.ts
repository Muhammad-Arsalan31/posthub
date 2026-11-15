import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AuthSession } from '@posthub/auth';
import type { Db } from '@posthub/db';
import type { IntegrationDeps, IntegrationsConfig } from '@posthub/integrations';
import { fetchApiClient, type PromiseClient } from '@posthub/contract';
import { Vault, type Integrations, type VaultService } from '@posthub/integrations';
import { Context, Effect, Layer } from 'effect';
import { Sessions } from './http-support';
import { apiLayer, type ApiServices } from './layer';
import { ProviderApps, type ProviderAppsService } from './provider-apps';
import { apiWebHandler } from './routes';
import { MediaDir } from './services';

export const TEST_ENCRYPTION_KEY = 'test-encryption-key-test-encryption-key';

export function sessionFor(u: { id: string; email: string; name: string }): AuthSession {
  const now = new Date();
  return {
    user: { ...u, emailVerified: false, image: null, createdAt: now, updatedAt: now },
    session: {
      id: crypto.randomUUID(),
      token: 'test',
      userId: u.id,
      expiresAt: new Date(Date.now() + 60_000),
      createdAt: now,
      updatedAt: now,
    },
  } as AuthSession;
}

export interface TestContext {
  /** The API as the web app sees it, signed in as `session` (or signed out). */
  api: PromiseClient;
  /** Raw requests to the API (e.g. input the typed client would refuse to send). */
  fetch: (path: string, init?: RequestInit) => Promise<Response>;
  session: AuthSession | null;
  db: Db;
  vault: VaultService;
  mediaDir: string;
  providerApps: ProviderAppsService;
  /** Connectors as configured right now. */
  readonly integrations: Integrations;
  /** Runs API Effect code with the same services the handlers use. */
  run: <A, E>(effect: Effect.Effect<A, E, ApiServices>) => Promise<A>;
}

/**
 * The whole HTTP API over a test DB, called through the same client the web app uses.
 * `config` acts as the .env provider config; pass a fake fetch in `deps` to exercise connectors.
 */
export function testContext(
  db: Db,
  session: AuthSession | null,
  integrations: { config?: IntegrationsConfig; deps?: IntegrationDeps } = {},
  mediaDir = mkdtempSync(join(tmpdir(), 'posthub-media-')),
): TestContext {
  const services = Effect.runSync(
    Effect.scoped(
      Layer.build(
        apiLayer({
          db,
          encryptionKey: TEST_ENCRYPTION_KEY,
          mediaDir,
          envConfig: integrations.config,
          integrationDeps: integrations.deps,
        }),
      ),
    ),
  );
  return contextFor(services, session, db);
}

/** Another caller (e.g. a different user) against the same services. */
export function contextFor(
  services: Context.Context<ApiServices>,
  session: AuthSession | null,
  db: Db,
): TestContext {
  const sessions = Layer.succeed(Sessions, { get: () => Effect.succeed(session) });
  const { handler } = apiWebHandler(services, sessions);
  const providerApps = Context.get(services, ProviderApps);
  return {
    api: fetchApiClient({
      baseUrl: 'http://posthub.test',
      fetch: (input, init) => handler(new Request(input, init)),
    }),
    fetch: (path, init) => handler(new Request(new URL(path, 'http://posthub.test'), init)),
    session,
    db,
    vault: Context.get(services, Vault),
    mediaDir: Context.get(services, MediaDir),
    providerApps,
    get integrations() {
      return Effect.runSync(providerApps.current);
    },
    run: (effect) => Effect.runPromise(Effect.provideContext(effect, services)),
  };
}
