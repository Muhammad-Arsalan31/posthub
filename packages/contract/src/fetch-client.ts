import { Effect } from 'effect';
import { FetchHttpClient, HttpClient } from 'effect/http';
import { HttpApiClient } from 'effect/http-api';
import { Api } from './api';
import { promiseClient, type PromiseClient } from './client';

export interface FetchApiClientOptions {
  /** Origin of the server, e.g. `window.location.origin`. */
  baseUrl: string;
  /** Defaults to the global fetch. Tests pass a handler that serves the API in-process. */
  fetch?: typeof globalThis.fetch;
  /** `include` sends the session cookie. */
  credentials?: RequestInit['credentials'];
}

/** A Promise client for the API over fetch: `await client.posts.list()`. */
export function fetchApiClient(options: FetchApiClientOptions): PromiseClient {
  const client = Effect.runSync(
    Effect.provide(HttpApiClient.make(Api, { baseUrl: options.baseUrl }), FetchHttpClient.layer),
  );
  const fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  return promiseClient(client, (effect) =>
    Effect.runPromise(
      effect.pipe(
        Effect.provideService(FetchHttpClient.Fetch, fetch),
        Effect.provideService(FetchHttpClient.RequestInit, { credentials: options.credentials }),
        Effect.provideService(HttpClient.TracerPropagationEnabled, false),
      ),
    ),
  );
}
