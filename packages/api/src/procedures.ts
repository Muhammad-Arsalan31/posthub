import { ORPCError, os } from '@orpc/server';
import type { AuthSession } from '@posthub/auth';
import type { Db } from '@posthub/db';

export interface Context {
  db: Db;
  session: AuthSession | null;
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
