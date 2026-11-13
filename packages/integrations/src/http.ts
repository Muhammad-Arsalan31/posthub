import { openAsBlob } from 'node:fs';
import { PlatformError } from './errors';
import type { MediaFile } from './types';

export interface HttpDeps {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
}

export interface HttpResult<T> {
  data: T;
  response: Response;
}

/** fetch + JSON parsing; non-2xx responses become a PlatformError with the platform's message. */
export async function request<T>(
  deps: HttpDeps,
  source: string,
  url: string,
  init?: RequestInit,
): Promise<HttpResult<T>> {
  const response = await deps.fetch(url, init);
  const text = await response.text();
  let data: unknown;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!response.ok) {
    throw new PlatformError(source, errorMessage(data) ?? `HTTP ${response.status}`, {
      status: response.status,
      body: data,
    });
  }
  return { data: data as T, response };
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

/** URL-encoded form body, skipping undefined values. */
export function form(fields: Record<string, string | undefined>) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) params.set(key, value);
  }
  return params;
}

export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

/** Stream a local media file as an upload body without loading it into memory. */
export const fileBlob = (file: MediaFile) => openAsBlob(file.path, { type: file.mimeType });
