import { PLATFORMS } from '@posthub/db';
import { protectedProcedure, publicProcedure } from './procedures';
import { accountsRouter } from './routers/accounts';
import { mediaRouter } from './routers/media';
import { postsRouter } from './routers/posts';
import { providerAppsRouter } from './routers/provider-apps';

export type { Context } from './procedures';
export { beginOAuth, completeOAuth, ConnectionError, saveAccounts } from './connections';
export { apiLayer, rpcContext, type ApiLayerOptions, type ApiServices } from './layer';
export {
  INTERRUPTED_MESSAGE,
  Publisher,
  publisherWorker,
  RETRY_DELAYS_MS,
  type PublisherOptions,
} from './publisher';
export {
  makeProviderApps,
  ProviderAppError,
  ProviderApps,
  type AppSource,
  type ProviderAppsService,
} from './provider-apps';
export { Database, MediaDir } from './services';

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
