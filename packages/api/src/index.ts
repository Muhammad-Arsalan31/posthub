import { PLATFORMS } from '@posthub/db';
import { protectedProcedure, publicProcedure } from './procedures';
import { accountsRouter } from './routers/accounts';
import { mediaRouter } from './routers/media';
import { postsRouter } from './routers/posts';
import { providerAppsRouter } from './routers/provider-apps';

export type { Context } from './procedures';
export { beginOAuth, completeOAuth, ConnectionError, saveAccounts } from './connections';
export { createPublisher, INTERRUPTED_MESSAGE, RETRY_DELAYS_MS, type Publisher } from './publisher';
export {
  createIntegrationsManager,
  type AppSource,
  type IntegrationsManager,
} from './provider-apps';

export const router = {
  health: publicProcedure.handler(() => ({ ok: true, time: new Date() })),
  me: protectedProcedure.handler(({ context }) => context.user),
  platforms: publicProcedure.handler(() => PLATFORMS),
  posts: postsRouter,
  media: mediaRouter,
  accounts: accountsRouter,
  providerApps: providerAppsRouter,
};

export type AppRouter = typeof router;
