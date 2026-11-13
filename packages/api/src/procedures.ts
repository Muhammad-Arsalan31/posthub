import { ORPCError, os } from '@orpc/server';
import type { AuthSession } from '@posthub/auth';
import type { Db } from '@posthub/db';
import type { Integrations, Vault } from '@posthub/integrations';
import type { IntegrationsManager } from './provider-apps';

export interface Context {
  db: Db;
  session: AuthSession | null;
  /** Connectors as configured right now (a snapshot from `providerApps.current`). */
  integrations: Integrations;
  /** Reads and changes developer-app credentials; changes apply immediately. */
  providerApps: IntegrationsManager;
  vault: Vault;
}

export const publicProcedure = os.$context<Context>();

export const protectedProcedure = publicProcedure.use(({ context, next }) => {
  if (!context.session) {
    throw new ORPCError('UNAUTHORIZED');
  }
  return next({
    context: { session: context.session, user: context.session.user },
  });
});
