// A Promise-based view of the typed API client: `await client.posts.list()`.
// Used by the web app (TanStack Query) and by tests. Rejects with the endpoint's typed error
// (e.g. `BadRequest`, `NotFound`), which is an Error with a user-facing `message`.
import type { Brand, Effect } from 'effect';
import type {
  HttpApi,
  HttpApiClient,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiSchema,
} from 'effect/http-api';
import { Api } from './api';

type Groups = typeof Api extends HttpApi.HttpApi<infer _Id, infer G> ? G : never;

type IsMultipart<P> = P extends Brand.Brand<HttpApiSchema.MultipartTypeId> ? true : false;

/** The argument list of an endpoint: its payload, or `{ file }` for uploads, or nothing. */
type Args<E extends HttpApiEndpoint.ConstraintRequest> = [E['~Payload']['Type']] extends [never]
  ? []
  : IsMultipart<E['~Payload']['Type']> extends true
    ? [input: { file: File }]
    : [input: E['~Payload']['Type']];

type Method<E extends HttpApiEndpoint.ConstraintRequest> = (
  ...args: Args<E>
) => Promise<HttpApiClient.SuccessType<E['~Success']>>;

type GroupMethods<G> = {
  readonly [
    E in Extract<
      HttpApiGroup.Endpoints<G>,
      HttpApiEndpoint.ConstraintRequest
    > as HttpApiEndpoint.Identifier<E>
  ]: Method<E>;
};

export type PromiseClient = {
  readonly [
    G in Extract<Groups, { readonly topLevel: false }> as HttpApiGroup.Identifier<G>
  ]: GroupMethods<G>;
} & GroupMethods<Extract<Groups, { readonly topLevel: true }>>;

/** What an endpoint takes and returns, e.g. `ApiInput<'posts', 'update'>`. */
export type ApiOutput<
  G extends keyof PromiseClient,
  E extends keyof PromiseClient[G],
> = PromiseClient[G][E] extends (...args: never) => Promise<infer A> ? A : never;
export type ApiInput<
  G extends keyof PromiseClient,
  E extends keyof PromiseClient[G],
> = PromiseClient[G][E] extends (...args: infer P) => Promise<unknown> ? P[0] : never;

export type EffectClient = HttpApiClient.ForApi<typeof Api>;

type AnyMethod = (request?: unknown) => Effect.Effect<unknown, unknown>;

/** What the facade reads from each group definition at runtime. */
interface GroupDefinition {
  readonly identifier: string;
  readonly topLevel: boolean;
  readonly endpoints: Record<string, unknown>;
}

/** Wraps an Effect client; `run` executes each call (e.g. `ManagedRuntime.runPromise`). */
export function promiseClient(
  client: EffectClient,
  run: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>,
): PromiseClient {
  const request = (input: unknown) => {
    if (input === undefined) return undefined;
    if (input && typeof input === 'object' && 'file' in input && input.file instanceof Blob) {
      const body = new FormData();
      body.set('file', input.file);
      return { payload: body };
    }
    return { payload: input };
  };

  const methodsOf = (group: GroupDefinition, target: Record<string, AnyMethod>) => {
    const out: Record<string, (input?: unknown) => Promise<unknown>> = {};
    for (const name of Object.keys(group.endpoints)) {
      out[name] = (input) => run(target[name]!(request(input)));
    }
    return out;
  };

  const result: Record<string, unknown> = {};
  const raw = client as unknown as Record<string, unknown>;
  for (const group of Object.values(Api.groups) as unknown as GroupDefinition[]) {
    if (group.topLevel) {
      Object.assign(result, methodsOf(group, raw as Record<string, AnyMethod>));
    } else {
      result[group.identifier] = methodsOf(
        group,
        raw[group.identifier] as Record<string, AnyMethod>,
      );
    }
  }
  return result as PromiseClient;
}
