import { describe, expect, it } from 'vite-plus/test';
import { NotFound } from './errors';
import { fetchApiClient } from './fetch-client';

const post = {
  id: 'p1',
  userId: 'u1',
  title: 'Hello',
  body: '',
  link: null,
  featuredMediaId: null,
  thumbnailMediaId: null,
  wordpressOptions: null,
  firstComment: null,
  pinFirstComment: false,
  status: 'scheduled',
  scheduledAt: '2030-01-01T09:00:00.000Z',
  createdAt: '2029-12-01T00:00:00.000Z',
  updatedAt: '2029-12-01T00:00:00.000Z',
  accountIds: [],
  mediaIds: [],
  targets: [],
};

function fake(respond: (request: Request) => Response) {
  const requests: Request[] = [];
  const client = fetchApiClient({
    baseUrl: 'http://posthub.test',
    fetch: async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      return respond(request);
    },
  });
  return { client, requests };
}

describe('fetchApiClient', () => {
  it('rejects malformed URLs before sending any request', async () => {
    const { client, requests } = fake(() => Response.json(post));
    for (const link of [
      'https://example.com:abc',
      'https://[invalid',
      'https://example.com:99999',
      'ftp://example.com',
      `https://example.com/${'x'.repeat(2000)}`,
    ]) {
      await expect(
        client.posts.create({ id: crypto.randomUUID(), title: 'Link', link }),
      ).rejects.toBeInstanceOf(Error);
      await expect(client.posts.update({ id: 'p1', changes: { link } })).rejects.toBeInstanceOf(
        Error,
      );
      await expect(client.posts.markPosted({ targetId: 't1', url: link })).rejects.toBeInstanceOf(
        Error,
      );
    }
    expect(requests).toHaveLength(0);
  });

  it('calls endpoints by group and decodes dates', async () => {
    const { client, requests } = fake(() => Response.json([post]));
    const [first] = await client.posts.list();
    expect(requests[0]!.method).toBe('GET');
    expect(requests[0]!.url).toBe('http://posthub.test/rpc/posts');
    expect(first!.scheduledAt).toEqual(new Date('2030-01-01T09:00:00Z'));
  });

  it('encodes payloads, including dates', async () => {
    const { client, requests } = fake(() => Response.json(post));
    const id = crypto.randomUUID();
    await client.posts.create({
      id,
      title: 'Hello',
      scheduledAt: new Date('2030-01-01T09:00:00Z'),
    });
    expect(await requests[0]!.json()).toEqual({
      id,
      title: 'Hello',
      scheduledAt: '2030-01-01T09:00:00.000Z',
    });
  });

  it('uploads files as multipart form data', async () => {
    const { client, requests } = fake(() =>
      Response.json({
        id: 'm1',
        fileName: 'a.png',
        mimeType: 'image/png',
        sizeBytes: 3,
        width: null,
        height: null,
        durationMs: null,
        createdAt: '2030-01-01T00:00:00.000Z',
      }),
    );
    await client.media.upload({ file: new File(['img'], 'a.png', { type: 'image/png' }) });
    const form = await requests[0]!.formData();
    expect((form.get('file') as File).name).toBe('a.png');
  });

  it('rejects with the typed error and its message', async () => {
    const { client } = fake(() =>
      Response.json({ _tag: 'NotFound', message: 'No such post.' }, { status: 404 }),
    );
    const error = await client.posts.retry({ targetId: 't1' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NotFound);
    expect(error).toMatchObject({ message: 'No such post.' });
  });
});
