import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AuthSession } from '@posthub/auth';
import type { Db } from '@posthub/db';
import { createVault, type IntegrationDeps, type IntegrationsConfig } from '@posthub/integrations';
import type { Context } from './procedures';
import { createIntegrationsManager } from './provider-apps';

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
  const vault = createVault(TEST_ENCRYPTION_KEY);
  const providerApps = createIntegrationsManager({
    db,
    vault,
    envConfig: integrations.config,
    deps: integrations.deps,
  });
  return {
    db,
    session,
    vault,
    mediaDir,
    providerApps,
    // A getter, so saving credentials mid-test is visible like a fresh request would see it.
    get integrations() {
      return providerApps.current;
    },
  };
}
