import { ORPCError } from '@orpc/server';
import { z } from 'zod';
import { OAUTH_PROVIDER_IDS, ProviderAppError } from '../provider-apps';
import { protectedProcedure } from '../procedures';

const provider = z.enum(OAUTH_PROVIDER_IDS);

export const providerAppsRouter = {
  save: protectedProcedure
    .input(
      z.object({
        provider,
        clientId: z.string().trim().min(1).max(500),
        clientSecret: z.string().trim().max(500).optional(),
      }),
    )
    .handler(async ({ context, input }) => {
      try {
        await context.run(context.providerApps.save(input.provider, input));
      } catch (error) {
        if (error instanceof ProviderAppError) {
          throw new ORPCError('BAD_REQUEST', { message: error.message });
        }
        throw error;
      }
      return { provider: input.provider };
    }),

  remove: protectedProcedure.input(z.object({ provider })).handler(async ({ context, input }) => {
    await context.run(context.providerApps.remove(input.provider));
    return { provider: input.provider };
  }),
};
