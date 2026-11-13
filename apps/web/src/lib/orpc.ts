import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { RouterClient } from '@orpc/server';
import { createTanstackQueryUtils } from '@orpc/tanstack-query';
import type { AppRouter } from '@posthub/api';

const link = new RPCLink({
  url: () => `${window.location.origin}/rpc`,
  fetch: (request, init) => fetch(request, { ...init, credentials: 'include' }),
});

/** Plain typed client: `await client.posts.list()` */
export const client: RouterClient<AppRouter> = createORPCClient(link);

/** TanStack Query helpers: `useQuery(orpc.health.queryOptions())` */
export const orpc = createTanstackQueryUtils(client);
