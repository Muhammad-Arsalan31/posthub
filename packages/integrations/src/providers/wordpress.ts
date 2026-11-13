// Self-hosted WordPress via the REST API with Application Passwords (Users → Profile → Application Passwords).
import { PlatformError } from '../errors';
import { fileBlob, request, type HttpDeps } from '../http';
import { isImage, type ConnectedAccount, type PlatformAdapter } from '../types';

export interface WordPressCredentials {
  siteUrl: string;
  /** Either `<site>/wp-json` (pretty permalinks) or `<site>/?rest_route=` (plain permalinks). */
  apiBase: string;
  username: string;
  appPassword: string;
}

export interface WordPressConnectInput {
  siteUrl: string;
  username: string;
  appPassword: string;
}

const LOCAL_HOSTS = /^(localhost|127\.0\.0\.1|\[::1\])$|\.(local|test|localhost)$/;

export function endpoint(apiBase: string, path: string, query?: Record<string, string>) {
  const qs = query ? new URLSearchParams(query).toString() : '';
  if (apiBase.endsWith('rest_route=')) return `${apiBase}${path}${qs ? `&${qs}` : ''}`;
  return `${apiBase}${path}${qs ? `?${qs}` : ''}`;
}

const basicAuth = (c: Pick<WordPressCredentials, 'username' | 'appPassword'>) => ({
  authorization: `Basic ${Buffer.from(`${c.username}:${c.appPassword}`).toString('base64')}`,
});

function normalizeSiteUrl(raw: string) {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new PlatformError('wordpress', 'Enter a full site URL, like https://example.com.');
  }
  if (url.protocol !== 'https:' && !LOCAL_HOSTS.test(url.hostname)) {
    throw new PlatformError(
      'wordpress',
      'Use an https:// site URL. Application Passwords should never be sent over plain HTTP.',
    );
  }
  return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
}

/** Plain text to simple HTML paragraphs. */
export function toHtml(text: string, link?: string) {
  const escape = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const paragraphs = text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${escape(p).replace(/\n/g, '<br>')}</p>`);
  if (link) paragraphs.push(`<p><a href="${escape(link)}">${escape(link)}</a></p>`);
  return paragraphs.join('\n');
}

export function createWordPress(deps: HttpDeps) {
  async function discoverApiBase(siteUrl: string) {
    try {
      const res = await deps.fetch(`${siteUrl}/wp-json/`);
      if (res.ok) {
        const info = (await res.json()) as { name?: string };
        return { apiBase: `${siteUrl}/wp-json`, siteName: info.name };
      }
    } catch {
      // Fall through to the plain-permalink form.
    }
    const { data } = await request<{ name?: string }>(
      deps,
      'wordpress',
      `${siteUrl}/?rest_route=/`,
    );
    return { apiBase: `${siteUrl}/?rest_route=`, siteName: data.name };
  }

  async function connect(
    input: WordPressConnectInput,
  ): Promise<ConnectedAccount<WordPressCredentials>> {
    const siteUrl = normalizeSiteUrl(input.siteUrl);
    const { apiBase, siteName } = await discoverApiBase(siteUrl);
    const credentials: WordPressCredentials = {
      siteUrl,
      apiBase,
      username: input.username.trim(),
      // WordPress shows app passwords in groups separated by spaces; both forms work.
      appPassword: input.appPassword.trim(),
    };

    let me: { id: number; name: string };
    try {
      ({ data: me } = await request<{ id: number; name: string }>(
        deps,
        'wordpress',
        endpoint(apiBase, '/wp/v2/users/me', { context: 'edit' }),
        { headers: basicAuth(credentials) },
      ));
    } catch (error) {
      if (error instanceof PlatformError && (error.status === 401 || error.status === 403)) {
        throw new PlatformError(
          'wordpress',
          'WordPress rejected the username or Application Password.',
          { status: error.status },
        );
      }
      throw error;
    }

    return {
      platform: 'wordpress',
      externalId: `${siteUrl}#${me.id}`,
      displayName: `${siteName || new URL(siteUrl).host} (${me.name})`,
      credentials,
      tokenExpiresAt: null,
    };
  }

  const adapter: PlatformAdapter<WordPressCredentials> = {
    platform: 'wordpress',

    async publish(credentials, input) {
      const auth = basicAuth(credentials);

      let featuredMedia: number | undefined;
      const image = input.media.find(isImage);
      if (image) {
        const safeName = image.fileName.replace(/[^\w.-]+/g, '_');
        const { data } = await request<{ id: number }>(
          deps,
          'wordpress',
          endpoint(credentials.apiBase, '/wp/v2/media'),
          {
            method: 'POST',
            headers: {
              ...auth,
              'content-type': image.mimeType,
              'content-disposition': `attachment; filename="${safeName}"`,
            },
            body: await fileBlob(image),
          },
        );
        featuredMedia = data.id;
      }

      const { data: post } = await request<{ id: number; link: string }>(
        deps,
        'wordpress',
        endpoint(credentials.apiBase, '/wp/v2/posts'),
        {
          method: 'POST',
          headers: { ...auth, 'content-type': 'application/json' },
          body: JSON.stringify({
            title: input.title,
            content: toHtml(input.text, input.link),
            status: 'publish',
            ...(featuredMedia ? { featured_media: featuredMedia } : {}),
          }),
        },
      );
      return { externalId: String(post.id), url: post.link };
    },
  };

  return { connect, adapter };
}
