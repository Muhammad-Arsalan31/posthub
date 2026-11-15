import { Effect } from 'effect';
import { ORPCError } from '@orpc/server';
import { socialAccount } from '@posthub/db';
import { PlatformError, type WordPressCredentials } from '@posthub/integrations';
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
    context.run(
      Effect.forEach(context.integrations.status(), (provider) =>
        provider.id === 'wordpress'
          ? Effect.succeed({ ...provider, source: null, clientId: null })
          : Effect.map(context.providerApps.describe(provider.id), (app) => ({
              ...provider,
              ...app,
            })),
      ),
    ),
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
        const account = await context.run(context.integrations.wordpress.connect(input));
        await context.run(saveAccounts(context.user.id, [account]));
        return { displayName: account.displayName };
      } catch (error) {
        if (error instanceof PlatformError) {
          throw new ORPCError('BAD_REQUEST', { message: error.message });
        }
        throw error;
      }
    }),

  /** Categories on a connected WordPress site, for the composer. */
  wordpressCategories: protectedProcedure
    .input(z.object({ accountId: z.string() }))
    .handler(async ({ context, input }) => {
      const account = context.db
        .select({ credentials: socialAccount.credentials })
        .from(socialAccount)
        .where(
          and(
            eq(socialAccount.id, input.accountId),
            eq(socialAccount.userId, context.user.id),
            eq(socialAccount.platform, 'wordpress'),
          ),
        )
        .get();
      if (!account?.credentials) throw new ORPCError('NOT_FOUND');
      try {
        return await context.run(
          Effect.flatMap(
            context.vault.decrypt<WordPressCredentials>(account.credentials),
            context.integrations.wordpress.categories,
          ),
        );
      } catch (error) {
        if (error instanceof PlatformError) {
          throw new ORPCError('BAD_GATEWAY', { message: error.message });
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
