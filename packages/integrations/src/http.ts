import { openAsBlob } from 'node:fs';
import { Effect } from 'effect';
import {
  FetchHttpClient,
  HttpBody,
  HttpClient,
  HttpClientRequest,
  type HttpClientError,
  type HttpClientResponse,
} from 'effect/http';
import { platformError, type PlatformError } from './errors';
import type { MediaFile } from './types';

/**
 * The request may or may not have reached the platform (network error, connection dropped).
 * Never retried automatically: the post might exist already.
 */
export type TransportError = HttpClientError.HttpClientError;

/** What a platform call can fail with. */
export type PublishError = PlatformError | TransportError;

export interface HttpResult<T> {
  data: T;
  response: HttpClientResponse.HttpClientResponse;
}

/** Sends a request and parses JSON; non-2xx responses become a PlatformError with the platform's message. */
export interface Http {
  <T = unknown>(
    source: string,
    request: HttpClientRequest.HttpClientRequest,
  ): Effect.Effect<HttpResult<T>, PublishError>;
}

const fetchHttpClient = Effect.runSync(
  Effect.provide(HttpClient.HttpClient, FetchHttpClient.layer),
);

/** Effect's fetch-based client, sending every request through `fetch` (a fake one in tests). */
export const fetchClient = (fetch: typeof globalThis.fetch): HttpClient.HttpClient =>
  HttpClient.transformResponse(fetchHttpClient, (response) =>
    Effect.provideService(response, FetchHttpClient.Fetch, fetch),
  );

export function makeHttp(client: HttpClient.HttpClient): Http {
  return <T>(source: string, request: HttpClientRequest.HttpClientRequest) =>
    Effect.gen(function* () {
      const response = yield* client.execute(request);
      const text = yield* response.text;
      const data = parseBody(text);
      if (response.status < 200 || response.status >= 300) {
        return yield* platformError(source, errorMessage(data) ?? `HTTP ${response.status}`, {
          status: response.status,
          body: data,
        });
      }
      return { data: data as T, response };
      // Tracing headers would leak to every platform we call.
    }).pipe(Effect.provideService(HttpClient.TracerPropagationEnabled, false));
}

function parseBody(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function errorMessage(body: unknown): string | undefined {
  if (typeof body === 'string') return body.slice(0, 300) || undefined;
  if (!body || typeof body !== 'object') return undefined;
  const b = body as { error?: unknown; message?: unknown; error_description?: unknown };
  if (typeof b.error_description === 'string') return b.error_description;
  if (b.error && typeof b.error === 'object') {
    const message = (b.error as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  if (typeof b.message === 'string') return b.message;
  if (typeof b.error === 'string') return b.error;
  return undefined;
}

export const get = HttpClientRequest.get;
export const post = HttpClientRequest.post;
export const put = HttpClientRequest.put;

/** URL-encoded form body, skipping undefined values. */
export function form(fields: Record<string, string | undefined>) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) params.set(key, value);
  }
  return HttpBody.raw(params, { contentType: 'application/x-www-form-urlencoded' });
}

export const json = (value: unknown, contentType = 'application/json') =>
  HttpBody.raw(JSON.stringify(value), { contentType });

export const multipart = (data: FormData) => HttpBody.formData(data);

export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

/** Opens a local media file as a Blob that streams from disk instead of loading into memory. */
export const fileBlob = (file: MediaFile) =>
  Effect.tryPromise({
    try: () => openAsBlob(file.path, { type: file.mimeType }),
    catch: () =>
      platformError('media', `Could not read ${file.fileName}. It may have been deleted.`, {
        retryable: false,
      }),
  });

/** A media file as an upload body with its own content type. */
export const fileBody = (file: MediaFile) =>
  Effect.map(fileBlob(file), (blob) => HttpBody.raw(blob, { contentType: file.mimeType }));
