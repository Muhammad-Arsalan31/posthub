import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AuthSession } from '@posthub/auth';
import type { Db } from '@posthub/db';
import type { IntegrationDeps, IntegrationsConfig } from '@posthub/integrations';
import { Effect, Layer } from 'effect';
import { apiLayer, rpcContext } from './layer';
import type { Context } from './procedures';

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

/**
 * An oRPC context backed by a test DB. `config` acts as the .env provider config.
 * Pass a fake fetch to exercise connectors.
 */
export function testContext(
  db: Db,
  session: AuthSession | null,
  integrations: { config?: IntegrationsConfig; deps?: IntegrationDeps } = {},
  mediaDir = mkdtempSync(join(tmpdir(), 'posthub-media-')),
): Context {
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
  return rpcContext(services, session);
}
