// A media host: somewhere PostHub puts a file just before publishing, so platforms that download
// media from a URL (Instagram) can fetch it, and removes it from afterwards.
// The S3 implementation works with any S3-compatible bucket (AWS S3, Cloudflare R2, Backblaze B2)
// and signs requests itself (SigV4 over node:crypto), so no AWS SDK is needed.
import { createHash, createHmac } from 'node:crypto';
import { Clock, Effect } from 'effect';
import { HttpBody, HttpClientRequest } from 'effect/http';
import { PlatformError, platformError } from './errors';
import { fetchClient, fileBlob, makeHttp, type PublishError } from './http';
import type { MediaFile } from './types';

export interface MediaHost {
  /** Uploads `file` under `key`; resolves with a URL anyone can fetch for a while. */
  put(file: MediaFile, key: string): Effect.Effect<{ url: string }, PublishError>;
  remove(key: string): Effect.Effect<void, PublishError>;
  /** Uploads a tiny object, fetches it without credentials and deletes it. */
  check(): Effect.Effect<void, PublishError>;
}

export interface S3MediaHostConfig {
  /** e.g. https://<account>.r2.cloudflarestorage.com or https://s3.eu-west-1.amazonaws.com */
  endpoint: string;
  /** `auto` for R2. */
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Public bucket URL. When unset, files are shared with presigned URLs and the bucket stays private. */
  publicBaseUrl?: string;
}

export interface MediaHostDeps {
  fetch?: typeof globalThis.fetch;
}

const SOURCE = 'media-host';
/** Presigned URLs last long enough for Instagram to process a video. */
const PRESIGN_SECONDS = 60 * 60;
const UNSIGNED = 'UNSIGNED-PAYLOAD';

const sha256 = (data: string) => createHash('sha256').update(data).digest('hex');
const hmac = (key: string | Buffer, data: string) =>
  createHmac('sha256', key).update(data).digest();

/** RFC 3986 encoding, as SigV4 wants it. */
const encode = (value: string) =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
export const encodeKey = (key: string) => key.split('/').map(encode).join('/');

/** `20130524T000000Z` */
const amzDate = (date: Date) =>
  date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');

export interface SigningKey {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  service?: string;
}

function signature(key: SigningKey, date: string, canonicalRequest: string) {
  const day = date.slice(0, 8);
  const scope = `${day}/${key.region}/${key.service ?? 's3'}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', date, scope, sha256(canonicalRequest)].join('\n');
  let signing = hmac(`AWS4${key.secretAccessKey}`, day);
  for (const part of [key.region, key.service ?? 's3', 'aws4_request']) {
    signing = hmac(signing, part);
  }
  return { scope, value: createHmac('sha256', signing).update(toSign).digest('hex') };
}

const canonicalQuery = (params: URLSearchParams) =>
  [...params]
    .map(([k, v]) => [encode(k), encode(v)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');

/** Signed headers for a request (authorization header form). Exported for the signature tests. */
export function signHeaders(
  key: SigningKey,
  request: { method: string; url: string; headers?: Record<string, string> },
  now: Date,
) {
  const url = new URL(request.url);
  const date = amzDate(now);
  const headers: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(request.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
    ),
    host: url.host,
    'x-amz-date': date,
  };
  headers['x-amz-content-sha256'] ??= UNSIGNED;
  const names = Object.keys(headers).sort();
  const canonical = [
    request.method,
    url.pathname,
    canonicalQuery(url.searchParams),
    names.map((n) => `${n}:${headers[n]!.trim()}\n`).join(''),
    names.join(';'),
    headers['x-amz-content-sha256'],
  ].join('\n');
  const { scope, value } = signature(key, date, canonical);
  const { host: _host, ...rest } = headers;
  return {
    ...rest,
    authorization: `AWS4-HMAC-SHA256 Credential=${key.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${value}`,
  };
}

/** A presigned GET URL: anyone with it can download the object until it expires. */
export function presignGet(key: SigningKey, url: string, now: Date, expiresSeconds: number) {
  const target = new URL(url);
  const date = amzDate(now);
  const params = new URLSearchParams(target.search);
  params.set('X-Amz-Algorithm', 'AWS4-HMAC-SHA256');
  params.set(
    'X-Amz-Credential',
    `${key.accessKeyId}/${date.slice(0, 8)}/${key.region}/${key.service ?? 's3'}/aws4_request`,
  );
  params.set('X-Amz-Date', date);
  params.set('X-Amz-Expires', String(expiresSeconds));
  params.set('X-Amz-SignedHeaders', 'host');
  const query = canonicalQuery(params);
  const canonical = ['GET', target.pathname, query, `host:${target.host}\n`, 'host', UNSIGNED].join(
    '\n',
  );
  const { value } = signature(key, date, canonical);
  return `${target.origin}${target.pathname}?${query}&X-Amz-Signature=${value}`;
}

/** S3 errors are XML: `<Error><Code>..</Code><Message>..</Message></Error>`. */
const xmlMessage = (error: PlatformError) => {
  const body = typeof error.body === 'string' ? error.body : '';
  const message = /<Message>([^<]*)<\/Message>/.exec(body)?.[1];
  const code = /<Code>([^<]*)<\/Code>/.exec(body)?.[1];
  if (!message && !code) return error;
  return platformError(SOURCE, [code, message].filter(Boolean).join(': '), {
    status: error.status,
    body: error.body,
    retryable: error.retryable,
  });
};

/** Nothing has been posted while the media host is involved, so a network failure is safe to retry. */
const asPlatformError = (action: string) => (error: PublishError) =>
  error instanceof PlatformError
    ? xmlMessage(error)
    : platformError(SOURCE, `Could not reach the media host to ${action} (${error.message}).`, {
        retryable: true,
      });

export function createS3MediaHost(config: S3MediaHostConfig, deps: MediaHostDeps = {}): MediaHost {
  const http = makeHttp(fetchClient(deps.fetch ?? ((input, init) => fetch(input, init))));
  const base = `${config.endpoint.replace(/\/+$/, '')}/${encode(config.bucket)}`;
  const objectUrl = (key: string) => `${base}/${encodeKey(key)}`;
  const signing: SigningKey = config;
  const now = Effect.map(Clock.currentTimeMillis, (ms) => new Date(ms));

  const send = (
    method: 'PUT' | 'DELETE',
    key: string,
    body?: { blob: Blob; contentType: string },
  ) =>
    Effect.gen(function* () {
      const url = objectUrl(key);
      const headers = signHeaders(
        signing,
        {
          method,
          url,
          headers: body
            ? { 'content-type': body.contentType, 'content-length': String(body.blob.size) }
            : {},
        },
        yield* now,
      );
      const request =
        method === 'PUT'
          ? HttpClientRequest.put(url, {
              headers,
              body: HttpBody.raw(body!.blob, { contentType: body!.contentType }),
            })
          : HttpClientRequest.delete(url, { headers });
      yield* http(SOURCE, request);
    });

  const publicUrl = (key: string) =>
    config.publicBaseUrl
      ? Effect.succeed(`${config.publicBaseUrl.replace(/\/+$/, '')}/${encodeKey(key)}`)
      : Effect.map(now, (at) => presignGet(signing, objectUrl(key), at, PRESIGN_SECONDS));

  const putBlob = (key: string, blob: Blob, contentType: string) =>
    Effect.gen(function* () {
      yield* send('PUT', key, { blob, contentType });
      return { url: yield* publicUrl(key) };
    }).pipe(Effect.mapError(asPlatformError('upload a file')));

  const remove = (key: string) =>
    send('DELETE', key).pipe(Effect.mapError(asPlatformError('delete a file')));

  return {
    put: (file, key) => Effect.flatMap(fileBlob(file), (blob) => putBlob(key, blob, file.mimeType)),

    remove,

    check: () =>
      Effect.gen(function* () {
        const key = `posthub-check/${crypto.randomUUID()}.txt`;
        const { url } = yield* putBlob(key, new Blob(['x']), 'text/plain');
        const fetched = yield* http(SOURCE, HttpClientRequest.get(url)).pipe(
          Effect.mapError(asPlatformError('download the test file')),
          Effect.catchTag('PlatformError', (error) =>
            Effect.fail(
              platformError(
                SOURCE,
                `The test file was uploaded, but it can't be downloaded without credentials (${error.message}). Check the bucket's public access or the public URL.`,
                { retryable: false },
              ),
            ),
          ),
          Effect.ensuring(Effect.ignore(remove(key))),
        );
        return fetched.data;
      }).pipe(Effect.asVoid),
  };
}
