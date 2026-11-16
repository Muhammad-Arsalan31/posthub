import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { TestClock } from 'effect/testing';
import { PlatformError } from './errors';
import { createS3MediaHost, presignGet, signHeaders } from './media-host';
import { createFakeFetch, tempMedia } from './testing';

// The examples from the AWS SigV4 documentation for S3.
const AWS_EXAMPLE = {
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  region: 'us-east-1',
};
const EXAMPLE_DATE = new Date('2013-05-24T00:00:00Z');

const config = {
  endpoint: 'https://acct.r2.test/',
  region: 'auto',
  bucket: 'media',
  accessKeyId: 'key-id',
  secretAccessKey: 'secret',
};
const OBJECT = 'https://acct.r2.test/media/target-1/image.png';

describe('SigV4', () => {
  it('signs a request like the AWS example', () => {
    const headers = signHeaders(
      AWS_EXAMPLE,
      {
        method: 'GET',
        url: 'https://examplebucket.s3.amazonaws.com/test.txt',
        headers: {
          Range: 'bytes=0-9',
          'x-amz-content-sha256':
            'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        },
      },
      EXAMPLE_DATE,
    );
    expect(headers.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, ' +
        'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, ' +
        'Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    );
  });

  it('presigns a URL like the AWS example', () => {
    const url = presignGet(
      AWS_EXAMPLE,
      'https://examplebucket.s3.amazonaws.com/test.txt',
      EXAMPLE_DATE,
      86400,
    );
    expect(new URL(url).searchParams.get('X-Amz-Signature')).toBe(
      'aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404',
    );
  });
});

describe('S3 media host', () => {
  it.effect('uploads a file and returns a presigned URL', () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(new Date('2030-01-01T00:00:00Z').getTime());
      const fake = createFakeFetch([['PUT https://acct.r2.test/media/', () => new Response('')]]);
      const host = createS3MediaHost(config, { fetch: fake.fetch });

      const { url } = yield* host.put(tempMedia('a.png', 'image/png'), 'target-1/image.png');

      expect(fake.calls[0]).toMatchObject({ method: 'PUT', url: OBJECT, body: '[binary]' });
      expect(fake.calls[0]!.headers.get('authorization')).toContain(
        'Credential=key-id/20300101/auto/s3/aws4_request',
      );
      expect(fake.calls[0]!.headers.get('content-type')).toBe('image/png');
      expect(url.startsWith(`${OBJECT}?X-Amz-Algorithm=AWS4-HMAC-SHA256&`)).toBe(true);
      expect(new URL(url).searchParams.get('X-Amz-Expires')).toBe('3600');
    }),
  );

  it.effect('uses the public base URL when there is one, and removes objects', () =>
    Effect.gen(function* () {
      const fake = createFakeFetch([
        ['PUT https://acct.r2.test/media/', () => new Response('')],
        ['DELETE https://acct.r2.test/media/', () => new Response(null, { status: 204 })],
      ]);
      const host = createS3MediaHost(
        { ...config, publicBaseUrl: 'https://cdn.test/' },
        { fetch: fake.fetch },
      );
      const { url } = yield* host.put(tempMedia('a.png', 'image/png'), 'target-1/image.png');
      expect(url).toBe('https://cdn.test/target-1/image.png');

      yield* host.remove('target-1/image.png');
      expect(fake.calls[1]).toMatchObject({ method: 'DELETE', url: OBJECT });
    }),
  );

  it.effect("reports the bucket's error message", () =>
    Effect.gen(function* () {
      const fake = createFakeFetch([
        [
          'PUT https://acct.r2.test/',
          () =>
            new Response(
              '<?xml version="1.0"?><Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>',
              { status: 403 },
            ),
        ],
      ]);
      const host = createS3MediaHost(config, { fetch: fake.fetch });
      const error = yield* Effect.flip(host.put(tempMedia('a.png', 'image/png'), 'k.png'));
      expect(error).toBeInstanceOf(PlatformError);
      expect(error.message).toBe('media-host: AccessDenied: Access Denied');
      expect((error as PlatformError).retryable).toBe(false);
    }),
  );

  it.effect('a network failure on upload is retryable: nothing was posted yet', () =>
    Effect.gen(function* () {
      const fake = createFakeFetch([
        [
          'PUT https://acct.r2.test/',
          () => {
            throw new TypeError('fetch failed');
          },
        ],
      ]);
      const host = createS3MediaHost(config, { fetch: fake.fetch });
      const error = yield* Effect.flip(host.put(tempMedia('a.png', 'image/png'), 'k.png'));
      expect(error).toBeInstanceOf(PlatformError);
      expect((error as PlatformError).retryable).toBe(true);
    }),
  );

  it.effect('checks the bucket with an upload, an anonymous download and a delete', () =>
    Effect.gen(function* () {
      const fake = createFakeFetch([
        ['PUT https://acct.r2.test/media/posthub-check/', () => new Response('')],
        ['GET https://acct.r2.test/media/posthub-check/', () => new Response('x')],
        ['DELETE https://acct.r2.test/media/posthub-check/', () => new Response(null)],
      ]);
      const host = createS3MediaHost(config, { fetch: fake.fetch });
      yield* host.check();
      expect(fake.calls.map((c) => c.method)).toEqual(['PUT', 'GET', 'DELETE']);
      expect(fake.calls[1]!.headers.get('authorization')).toBeNull();
    }),
  );

  it.effect('a check that cannot download the file says so, and still cleans up', () =>
    Effect.gen(function* () {
      const fake = createFakeFetch([
        ['PUT https://acct.r2.test/', () => new Response('')],
        ['GET https://acct.r2.test/', () => new Response('denied', { status: 403 })],
        ['DELETE https://acct.r2.test/', () => new Response(null)],
      ]);
      const host = createS3MediaHost(config, { fetch: fake.fetch });
      const error = yield* Effect.flip(host.check());
      expect(error.message).toContain("can't be downloaded without credentials");
      expect(fake.calls.map((c) => c.method)).toEqual(['PUT', 'GET', 'DELETE']);
    }),
  );
});
