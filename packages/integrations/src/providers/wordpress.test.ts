import { describe, expect, it } from 'vite-plus/test';
import { createIntegrations } from '../registry';
import { createFakeFetch, tempMedia } from '../testing';
import { endpoint, normalizeSiteUrl, postContent, type WordPressCredentials } from './wordpress';

const login = { siteUrl: 'https://blog.example.com/', username: 'admin', appPassword: 'abcd efgh' };
const basic = `Basic ${Buffer.from('admin:abcd efgh').toString('base64')}`;

describe('wordpress connect', () => {
  it('validates credentials against /users/me', async () => {
    const fake = createFakeFetch([
      ['GET https://blog.example.com/wp-json/wp/v2/users/me', () => ({ id: 3, name: 'Admin' })],
      ['GET https://blog.example.com/wp-json/', () => ({ name: 'My Blog', namespaces: ['wp/v2'] })],
    ]);
    const account = await createIntegrations({}, fake).wordpress.connect(login);

    expect(fake.calls[1]!.headers.get('authorization')).toBe(basic);
    expect(account).toMatchObject({
      platform: 'wordpress',
      externalId: 'https://blog.example.com#3',
      displayName: 'My Blog (Admin)',
      credentials: { apiBase: 'https://blog.example.com/wp-json' },
    });
  });

  it('falls back to ?rest_route= on plain-permalink sites', async () => {
    const fake = createFakeFetch([
      ['GET https://blog.example.com/wp-json/', () => new Response('nope', { status: 404 })],
      ['GET https://blog.example.com/?rest_route=/wp/v2/users/me', () => ({ id: 1, name: 'A' })],
      [
        'GET https://blog.example.com/?rest_route=/',
        () => ({ name: 'Plain', namespaces: ['wp/v2'] }),
      ],
    ]);
    const account = await createIntegrations({}, fake).wordpress.connect(login);
    expect(account.credentials.apiBase).toBe('https://blog.example.com/?rest_route=');
    expect(fake.calls[2]!.url).toBe(
      'https://blog.example.com/?rest_route=/wp/v2/users/me&context=edit',
    );
  });

  it('rejects bad passwords with a friendly message', async () => {
    const fake = createFakeFetch([
      [
        'GET https://blog.example.com/wp-json/wp/v2/users/me',
        () => new Response('{}', { status: 401 }),
      ],
      ['GET https://blog.example.com/wp-json/', () => ({ name: 'B', namespaces: ['wp/v2'] })],
    ]);
    await expect(createIntegrations({}, fake).wordpress.connect(login)).rejects.toThrow(
      /rejected the username/,
    );
  });

  it('explains each WordPress auth error code', async () => {
    const attempt = (code: string) => {
      const fake = createFakeFetch([
        [
          'GET https://blog.example.com/wp-json/wp/v2/users/me',
          () => Response.json({ code, message: 'x' }, { status: 401 }),
        ],
        ['GET https://blog.example.com/wp-json/', () => ({ name: 'B', namespaces: ['wp/v2'] })],
      ]);
      return createIntegrations({}, fake).wordpress.connect(login);
    };
    await expect(attempt('rest_not_logged_in')).rejects.toThrow(/HTTP_AUTHORIZATION/);
    await expect(attempt('incorrect_password')).rejects.toThrow(/normal login password/);
    await expect(attempt('invalid_username')).rejects.toThrow(/no user with that username/);
    await expect(attempt('application_passwords_disabled')).rejects.toThrow(/turned off/);
  });

  it('ignores HTML pages when discovering the API', async () => {
    const fake = createFakeFetch([
      ['GET https://blog.example.com/wp-json/', () => new Response('<html>login</html>')],
      ['GET https://blog.example.com/?rest_route=/', () => new Response('<html></html>')],
    ]);
    await expect(createIntegrations({}, fake).wordpress.connect(login)).rejects.toThrow(
      /Could not find the WordPress REST API/,
    );
  });

  it('refuses plain http for remote sites', async () => {
    await expect(
      createIntegrations({}).wordpress.connect({ ...login, siteUrl: 'http://blog.example.com' }),
    ).rejects.toThrow(/https/);
  });
});

describe('wordpress publish', () => {
  const creds: WordPressCredentials = {
    siteUrl: 'https://blog.example.com',
    apiBase: 'https://blog.example.com/wp-json',
    username: 'admin',
    appPassword: 'abcd efgh',
  };

  it('uploads media, embeds it in the content and sets the first image as featured', async () => {
    let nextId = 41;
    const fake = createFakeFetch([
      [
        'POST https://blog.example.com/wp-json/wp/v2/media',
        (req) => {
          nextId += 1;
          const name = /filename="(.+)"/.exec(req.headers.get('content-disposition')!)![1];
          return { id: nextId, source_url: `https://blog.example.com/uploads/${name}` };
        },
      ],
      [
        'POST https://blog.example.com/wp-json/wp/v2/posts',
        () => ({ id: 7, link: 'https://blog.example.com/hello' }),
      ],
    ]);
    const result = await createIntegrations({}, fake)
      .adapter('wordpress')!
      .publish(creds, {
        title: 'Hello',
        text: 'Line one\nline two\n\n<b>Para</b>',
        link: 'https://example.com/more',
        media: [tempMedia('clip.mp4', 'video/mp4'), tempMedia('cover photo.jpg', 'image/jpeg')],
      });

    expect(fake.calls.map((c) => c.headers.get('content-disposition'))).toEqual([
      'attachment; filename="clip.mp4"',
      'attachment; filename="cover_photo.jpg"',
      null,
    ]);
    const post = JSON.parse(fake.calls[2]!.body as string);
    expect(post).toMatchObject({ title: 'Hello', status: 'publish', featured_media: 43 });
    expect(post.content).toBe(
      [
        '<p>Line one<br>line two</p>',
        '<p>&lt;b&gt;Para&lt;/b&gt;</p>',
        '<!-- wp:video {"id":42} -->',
        '<figure class="wp-block-video"><video controls src="https://blog.example.com/uploads/clip.mp4"></video></figure>',
        '<!-- /wp:video -->',
        '<!-- wp:image {"id":43,"sizeSlug":"large"} -->',
        '<figure class="wp-block-image size-large"><img src="https://blog.example.com/uploads/cover_photo.jpg" alt="" class="wp-image-43"/></figure>',
        '<!-- /wp:image -->',
        '<p><a href="https://example.com/more">https://example.com/more</a></p>',
      ].join('\n'),
    );
    expect(result).toEqual({ externalId: '7', url: 'https://blog.example.com/hello' });
  });

  it('uses the HTML body and the chosen featured image', async () => {
    let nextId = 0;
    const fake = createFakeFetch([
      [
        'POST https://blog.example.com/wp-json/wp/v2/media',
        () => ({ id: ++nextId, source_url: `https://blog.example.com/u/${nextId}` }),
      ],
      ['POST https://blog.example.com/wp-json/wp/v2/posts', () => ({ id: 9, link: 'x' })],
    ]);
    const adapter = createIntegrations({}, fake).adapter('wordpress')!;
    const attached = tempMedia('a.png', 'image/png');
    const cover = tempMedia('cover.jpg', 'image/jpeg');

    // A featured image that is not attached is uploaded on its own and not embedded.
    await adapter.publish(creds, {
      title: 'Rich',
      text: 'ignored',
      html: '<h2>Hi</h2><p><strong>bold</strong></p>',
      media: [attached],
      featuredImage: cover,
    });
    let post = JSON.parse(fake.calls[2]!.body as string);
    expect(post.featured_media).toBe(2);
    expect(post.content).toMatch(
      /^<h2>Hi<\/h2><p><strong>bold<\/strong><\/p>\n<!-- wp:image \{"id":1,/,
    );
    expect(post.content).not.toContain('"id":2');

    // An attached featured image reuses its upload.
    fake.calls.length = 0;
    await adapter.publish(creds, {
      title: 'Again',
      text: 'x',
      media: [cover, attached],
      featuredImage: attached,
    });
    expect(fake.calls).toHaveLength(3);
    post = JSON.parse(fake.calls[2]!.body as string);
    expect(post.featured_media).toBe(4);
  });

  it('keeps inline images where they were written and sets categories and tags', async () => {
    let nextMedia = 100;
    const fake = createFakeFetch([
      [
        'POST https://blog.example.com/wp-json/wp/v2/media',
        () => ({ id: ++nextMedia, source_url: `https://blog.example.com/u/${nextMedia}.png` }),
      ],
      [
        'GET https://blog.example.com/wp-json/wp/v2/tags',
        (req) =>
          new URL(req.url).searchParams.get('search')?.toLowerCase() === 'r&d'
            ? [{ id: 5, name: 'R&amp;D' }]
            : [],
      ],
      ['POST https://blog.example.com/wp-json/wp/v2/tags', () => ({ id: 6 })],
      ['POST https://blog.example.com/wp-json/wp/v2/posts', () => ({ id: 9, link: 'x' })],
    ]);
    const photo = tempMedia('photo.png', 'image/png');
    await createIntegrations({}, fake)
      .adapter('wordpress')!
      .publish(creds, {
        title: 'Story',
        text: 'ignored',
        html: '<p>Before</p><img src="/files/abc" alt="A &amp; B"><p>After</p>',
        media: [],
        inlineImages: [{ ref: '/files/abc', file: photo }],
        wordpress: { categoryIds: [3, 4], tags: ['r&d', 'New tag', 'New tag'] },
      });

    const post = JSON.parse(fake.calls.at(-1)!.body as string);
    expect(post.content).toBe(
      [
        '<p>Before</p>',
        '<!-- wp:image {"id":101,"sizeSlug":"large"} -->',
        '<figure class="wp-block-image size-large"><img src="https://blog.example.com/u/101.png" alt="A &amp; B" class="wp-image-101"/></figure>',
        '<!-- /wp:image -->',
        '<p>After</p>',
      ].join('\n'),
    );
    // The inline image doubles as the featured image when nothing else is set.
    expect(post).toMatchObject({ featured_media: 101, categories: [3, 4], tags: [5, 6] });
    expect(fake.calls.filter((c) => c.method === 'POST' && c.url.endsWith('/tags'))).toHaveLength(
      1,
    );
  });

  it('reuses an existing tag when WordPress reports term_exists', async () => {
    const fake = createFakeFetch([
      ['GET https://blog.example.com/wp-json/wp/v2/tags', () => []],
      [
        'POST https://blog.example.com/wp-json/wp/v2/tags',
        () =>
          Response.json(
            { code: 'term_exists', message: 'exists', data: { status: 400, term_id: 77 } },
            { status: 400 },
          ),
      ],
      ['POST https://blog.example.com/wp-json/wp/v2/posts', () => ({ id: 9, link: 'x' })],
    ]);
    await createIntegrations({}, fake)
      .adapter('wordpress')!
      .publish(creds, {
        title: 't',
        text: 'x',
        media: [],
        wordpress: { categoryIds: [], tags: ['Café'] },
      });
    const post = JSON.parse(fake.calls.at(-1)!.body as string);
    expect(post.tags).toEqual([77]);
    expect(post).not.toHaveProperty('categories');
  });

  it('lists categories across pages', async () => {
    const fake = createFakeFetch([
      [
        'GET https://blog.example.com/wp-json/wp/v2/categories',
        (req) =>
          new Response(
            JSON.stringify(
              new URL(req.url).searchParams.get('page') === '1'
                ? [{ id: 1, name: 'News &amp; Views', parent: 0 }]
                : [{ id: 2, name: 'Tech', parent: 1 }],
            ),
            { headers: { 'x-wp-totalpages': '2' } },
          ),
      ],
    ]);
    expect(await createIntegrations({}, fake).wordpress.categories(creds)).toEqual([
      { id: 1, name: 'News & Views', parent: 0 },
      { id: 2, name: 'Tech', parent: 1 },
    ]);
  });

  it('publishes text-only posts without uploads', async () => {
    const fake = createFakeFetch([
      ['POST https://blog.example.com/wp-json/wp/v2/posts', () => ({ id: 8, link: 'x' })],
    ]);
    await createIntegrations({}, fake)
      .adapter('wordpress')!
      .publish(creds, { title: 'Hi', text: 'Just text', media: [] });
    const post = JSON.parse(fake.calls[0]!.body as string);
    expect(post).not.toHaveProperty('featured_media');
    expect(post.content).toBe('<p>Just text</p>');
  });

  it('reduces pasted login, admin and API URLs to the site root', () => {
    expect(normalizeSiteUrl('https://urbannerves.com/wp-login.php')).toBe(
      'https://urbannerves.com',
    );
    expect(normalizeSiteUrl('https://x.com/wp-admin/post-new.php?x=1')).toBe('https://x.com');
    expect(normalizeSiteUrl('https://x.com/blog/wp-json/wp/v2')).toBe('https://x.com/blog');
    expect(normalizeSiteUrl(' https://x.com/blog/ ')).toBe('https://x.com/blog');
  });

  it('builds endpoints for both API base styles', () => {
    expect(endpoint('https://s/wp-json', '/wp/v2/posts', { a: '1' })).toBe(
      'https://s/wp-json/wp/v2/posts?a=1',
    );
    expect(endpoint('https://s/?rest_route=', '/wp/v2/posts', { a: '1' })).toBe(
      'https://s/?rest_route=/wp/v2/posts&a=1',
    );
  });

  it('appends links to the HTML', () => {
    expect(postContent('<p>Hi</p>', 'https://x.dev')).toBe(
      '<p>Hi</p>\n<p><a href="https://x.dev">https://x.dev</a></p>',
    );
  });
});
