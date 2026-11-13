import { ORPCError } from '@orpc/server';
import { socialAccount } from '@posthub/db';
import { PlatformError } from '@posthub/integrations';
import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { saveAccounts } from '../connections';
import { protectedProcedure } from '../procedures';

/** Everything except credentials, which never leave the server. */
const publicColumns = {
  id: socialAccount.id,
  platform: socialAccount.platform,
  externalId: socialAccount.externalId,
  displayName: socialAccount.displayName,
  status: socialAccount.status,
  tokenExpiresAt: socialAccount.tokenExpiresAt,
  createdAt: socialAccount.createdAt,
};

export const accountsRouter = {
  list: protectedProcedure.handler(({ context }) =>
    context.db
      .select(publicColumns)
      .from(socialAccount)
      .where(eq(socialAccount.userId, context.user.id))
      .orderBy(asc(socialAccount.platform), asc(socialAccount.displayName)),
  ),

  /** Connectable providers, whether they are set up, and where their app credentials come from. */
  providers: protectedProcedure.handler(({ context }) =>
    context.integrations.status().map((provider) => ({
      ...provider,
      ...(provider.id === 'wordpress'
        ? { source: null, clientId: null }
        : context.providerApps.describe(provider.id)),
    })),
  ),

  connectWordPress: protectedProcedure
    .input(
      z.object({
        siteUrl: z.url(),
        username: z.string().trim().min(1),
        appPassword: z.string().trim().min(1),
      }),
    )
    .handler(async ({ context, input }) => {
      try {
        const account = await context.integrations.wordpress.connect(input);
        saveAccounts(context.db, context.vault, context.user.id, [account]);
        return { displayName: account.displayName };
      } catch (error) {
        if (error instanceof PlatformError) {
          throw new ORPCError('BAD_REQUEST', { message: error.message });
        }
        throw error;
      }
    }),

  disconnect: protectedProcedure
    .input(z.object({ id: z.string() }))
    .handler(async ({ context, input }) => {
      await context.db
        .delete(socialAccount)
        .where(and(eq(socialAccount.id, input.id), eq(socialAccount.userId, context.user.id)));
      return { id: input.id };
    }),
};
