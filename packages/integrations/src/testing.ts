import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MediaFile } from './types';

export interface RecordedRequest {
  method: string;
  url: string;
  headers: Headers;
  /** String bodies as-is, URLSearchParams as a string, FormData as-is, binary as '[binary]'. */
  body: string | FormData | undefined;
}

type Responder = (req: RecordedRequest) => unknown;

/**
 * A fetch stand-in. Routes are `"METHOD url-prefix"` keys, matched in order.
 * A responder returns a Response, or any value to be sent as JSON.
 */
export function createFakeFetch(routes: Array<[string, Responder]>) {
  const calls: RecordedRequest[] = [];

  const fakeFetch = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    const raw = init?.body;
    const body =
      raw === undefined || raw === null
        ? undefined
        : typeof raw === 'string'
          ? raw
          : raw instanceof URLSearchParams
            ? raw.toString()
            : raw instanceof FormData
              ? raw
              : '[binary]';
    const recorded: RecordedRequest = { method, url, headers: new Headers(init?.headers), body };
    calls.push(recorded);

    const route = routes.find(([key]) => {
      const space = key.indexOf(' ');
      return key.slice(0, space) === method && url.startsWith(key.slice(space + 1));
    });
    if (!route) throw new Error(`Unexpected request: ${method} ${url}`);
    const result = await route[1](recorded);
    return result instanceof Response ? result : Response.json(result ?? {});
  };

  return { fetch: fakeFetch as typeof fetch, calls };
}

/** Writes a small temp file and describes it as a MediaFile. */
export function tempMedia(
  fileName: string,
  mimeType: string,
  extra: Partial<MediaFile> = {},
): MediaFile {
  const dir = mkdtempSync(join(tmpdir(), 'posthub-test-'));
  const path = join(dir, fileName);
  writeFileSync(path, 'fake-media-bytes');
  return { path, fileName, mimeType, sizeBytes: 16, ...extra };
}

export const formParams = (body: RecordedRequest['body']) =>
  new URLSearchParams(typeof body === 'string' ? body : '');
