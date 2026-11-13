import { PLATFORMS } from '@posthub/db';
import { protectedProcedure, publicProcedure } from './procedures';
import { postsRouter } from './routers/posts';

export type { Context } from './procedures';

export const router = {
  health: publicProcedure.handler(() => ({ ok: true, time: new Date() })),
  me: protectedProcedure.handler(({ context }) => context.user),
  platforms: publicProcedure.handler(() => PLATFORMS),
  posts: postsRouter,
};

export type AppRouter = typeof router;
