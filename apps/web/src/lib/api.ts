// The typed API client (@posthub/contract) plus TanStack Query helpers.
//   await client.posts.list()
//   useQuery(api.media.list.queryOptions())
//   useMutation(api.accounts.disconnect.mutationOptions({ onSuccess }))
//   queryClient.invalidateQueries({ queryKey: api.accounts.key() })
import { fetchApiClient, type PromiseClient } from '@posthub/contract';
import type { QueryKey, UseMutationOptions, UseQueryOptions } from '@tanstack/react-query';

/** Plain typed client. Rejects with the API's typed errors (an Error with a user-facing message). */
export const client: PromiseClient = fetchApiClient({
  baseUrl: window.location.origin,
  credentials: 'include',
});

type Call = (...args: never[]) => Promise<unknown>;
type Input<F extends Call> = Parameters<F>[0];
type Output<F extends Call> = Awaited<ReturnType<F>>;

export interface EndpointUtils<F extends Call> {
  /** Query key for this endpoint, optionally for one input. */
  key(input?: Input<F>): QueryKey;
  queryOptions(
    options?: { input?: Input<F> } & Omit<
      UseQueryOptions<Output<F>, Error>,
      'queryKey' | 'queryFn'
    >,
  ): UseQueryOptions<Output<F>, Error> & { queryKey: QueryKey };
  mutationOptions<Context = unknown>(
    options?: Omit<UseMutationOptions<Output<F>, Error, Input<F>, Context>, 'mutationFn'>,
  ): UseMutationOptions<Output<F>, Error, Input<F>, Context>;
}

type GroupUtils<G> = {
  readonly [E in keyof G]: G[E] extends Call ? EndpointUtils<G[E]> : never;
} & {
  /** Query key prefix for every endpoint in the group (for invalidation). */
  key(): QueryKey;
};

export type ApiUtils = {
  readonly [K in keyof PromiseClient]: PromiseClient[K] extends Call
    ? EndpointUtils<PromiseClient[K]>
    : GroupUtils<PromiseClient[K]>;
};

function endpointUtils(path: string[], call: (input?: unknown) => Promise<unknown>) {
  const key = (input?: unknown): QueryKey =>
    input === undefined ? ['api', ...path] : ['api', ...path, input];
  return {
    key,
    queryOptions: ({ input, ...options }: { input?: unknown } = {}) => ({
      ...options,
      queryKey: key(input),
      queryFn: () => call(input),
    }),
    mutationOptions: (options = {}) => ({
      ...options,
      mutationKey: ['api', ...path],
      mutationFn: (input: unknown) => call(input),
    }),
  };
}

function buildUtils(): ApiUtils {
  const utils: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(client as Record<string, unknown>)) {
    if (typeof value === 'function') {
      utils[name] = endpointUtils([name], value as (input?: unknown) => Promise<unknown>);
      continue;
    }
    const group: Record<string, unknown> = { key: (): QueryKey => ['api', name] };
    for (const [endpoint, call] of Object.entries(value as Record<string, unknown>)) {
      group[endpoint] = endpointUtils(
        [name, endpoint],
        call as (input?: unknown) => Promise<unknown>,
      );
    }
    utils[name] = group;
  }
  return utils as ApiUtils;
}

/** TanStack Query helpers for every endpoint. */
export const api = buildUtils();
