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

/** Accepts any WordPress URL people paste (login page, admin, API) and returns the site root. */
export function normalizeSiteUrl(raw: string) {
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
  const path = url.pathname.replace(
    /\/(wp-login\.php|wp-admin|wp-json|xmlrpc\.php|index\.php)(\/.*)?$/i,
    '',
  );
  return `${url.origin}${path}`.replace(/\/+$/, '');
}

/** WordPress REST error code -> what the person should actually do. */
const AUTH_ERRORS: Record<string, string> = {
  // Ambiguous: sites that hide login errors (security plugins) answer this for wrong credentials too.
  rest_not_logged_in:
    'WordPress did not accept the login. Check the username, and use an Application Password ' +
    '(Users → Profile → Application Passwords), not your normal login password. If both are ' +
    'definitely right, the web host may be stripping the Authorization header: add this line at ' +
    'the top of the site’s .htaccess file, then try again: ' +
    'SetEnvIf Authorization "(.*)" HTTP_AUTHORIZATION=$1',
  incorrect_password:
    'That Application Password is not valid. Create one under Users → Profile → Application ' +
    'Passwords; your normal login password will not work here.',
  invalid_username: 'WordPress has no user with that username.',
  invalid_email: 'WordPress has no user with that email address.',
  application_passwords_disabled:
    'Application Passwords are turned off on this site, often by a security plugin.',
};

function authErrorMessage(error: PlatformError) {
  const code = (error.body as { code?: unknown } | undefined)?.code;
  if (typeof code === 'string' && AUTH_ERRORS[code]) return AUTH_ERRORS[code];
  return `WordPress rejected the username or Application Password${typeof code === 'string' ? ` (${code})` : ''}.`;
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
  /** Fetches a REST API index; null unless it is real JSON (not an HTML page). */
  async function apiIndex(url: string) {
    try {
      const res = await deps.fetch(url);
      if (!res.ok) return null;
      const info = (await res.json()) as { name?: string; namespaces?: unknown };
      return Array.isArray(info.namespaces) ? info : null;
    } catch {
      return null;
    }
  }

  async function discoverApiBase(siteUrl: string) {
    const pretty = await apiIndex(`${siteUrl}/wp-json/`);
    if (pretty) return { apiBase: `${siteUrl}/wp-json`, siteName: pretty.name };
    const plain = await apiIndex(`${siteUrl}/?rest_route=/`);
    if (plain) return { apiBase: `${siteUrl}/?rest_route=`, siteName: plain.name };
    throw new PlatformError(
      'wordpress',
      `Could not find the WordPress REST API at ${siteUrl}. Check the site URL, and that no plugin disables the REST API.`,
    );
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
        throw new PlatformError('wordpress', authErrorMessage(error), {
          status: error.status,
          body: error.body,
        });
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
