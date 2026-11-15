import { ORPCError, os } from '@orpc/server';
import type { AuthSession } from '@posthub/auth';
import type { Db } from '@posthub/db';
import type { Integrations, VaultService } from '@posthub/integrations';
import type { Effect } from 'effect';
import type { ApiServices } from './layer';
import type { ProviderAppsService } from './provider-apps';

export interface Context {
  db: Db;
  session: AuthSession | null;
  /** Connectors as configured right now (a snapshot from `providerApps.current`). */
  integrations: Integrations;
  /** Reads and changes developer-app credentials; changes apply immediately. */
  providerApps: ProviderAppsService;
  vault: VaultService;
  /** Folder holding uploaded media files. */
  mediaDir: string;
  /** Runs API Effect code with the server's services. */
  run: <A, E>(effect: Effect.Effect<A, E, ApiServices>) => Promise<A>;
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
