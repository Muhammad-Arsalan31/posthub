import { describe, expect, it } from 'vite-plus/test';
import { createIntegrations } from '../registry';
import { createFakeFetch, tempMedia } from '../testing';
import { endpoint, normalizeSiteUrl, toHtml, type WordPressCredentials } from './wordpress';

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

  it('uploads a featured image and publishes the post', async () => {
    const fake = createFakeFetch([
      ['POST https://blog.example.com/wp-json/wp/v2/media', () => ({ id: 42 })],
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
        media: [tempMedia('cover photo.jpg', 'image/jpeg')],
      });

    expect(fake.calls[0]!.headers.get('content-disposition')).toBe(
      'attachment; filename="cover_photo.jpg"',
    );
    const post = JSON.parse(fake.calls[1]!.body as string);
    expect(post).toMatchObject({ title: 'Hello', status: 'publish', featured_media: 42 });
    expect(post.content).toBe('<p>Line one<br>line two</p>\n<p>&lt;b&gt;Para&lt;/b&gt;</p>');
    expect(result).toEqual({ externalId: '7', url: 'https://blog.example.com/hello' });
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
    expect(toHtml('Hi', 'https://x.dev')).toBe(
      '<p>Hi</p>\n<p><a href="https://x.dev">https://x.dev</a></p>',
    );
  });
});
