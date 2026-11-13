// Self-hosted WordPress via the REST API with Application Passwords (Users → Profile → Application Passwords).
import { PlatformError } from '../errors';
import { fileBlob, request, type HttpDeps } from '../http';
import { decodeEntities, escapeHtml, textToHtml } from '../content';
import {
  isImage,
  isVideo,
  type ConnectedAccount,
  type MediaFile,
  type PlatformAdapter,
} from '../types';

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

/** An uploaded attachment, embedded in the post as a block-editor image or video. */
export interface EmbeddedMedia {
  id: number;
  url: string;
  kind: 'image' | 'video';
  /** Alt text, already HTML-escaped. */
  alt?: string;
}

/** A category on a WordPress site, for the composer's picker. */
export interface WordPressCategory {
  id: number;
  name: string;
  parent: number;
}

function mediaBlock({ id, url, kind, alt = '' }: EmbeddedMedia) {
  const src = escapeHtml(url);
  return kind === 'image'
    ? [
        `<!-- wp:image {"id":${id},"sizeSlug":"large"} -->`,
        `<figure class="wp-block-image size-large"><img src="${src}" alt="${alt}" class="wp-image-${id}"/></figure>`,
        '<!-- /wp:image -->',
      ].join('\n')
    : [
        `<!-- wp:video {"id":${id}} -->`,
        `<figure class="wp-block-video"><video controls src="${src}"></video></figure>`,
        '<!-- /wp:video -->',
      ].join('\n');
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Swaps each inline image (an <img> whose src is `ref`) for a WordPress image block, so it stays
 * where it was written. A wrapping paragraph is dropped: a block can't sit inside one.
 */
export function replaceInlineImages(
  html: string,
  images: Array<{ ref: string; media: EmbeddedMedia }>,
) {
  let out = html;
  for (const { ref, media } of images) {
    const tag = new RegExp(`(<p>)?<img\\b[^>]*\\bsrc="${escapeRegExp(ref)}"[^>]*>(</p>)?`, 'gi');
    out = out.replace(tag, (match) => {
      const alt = /\balt="([^"]*)"/i.exec(match)?.[1] ?? '';
      return `\n${mediaBlock({ ...media, alt })}\n`;
    });
  }
  return out.replace(/\n{2,}/g, '\n').trim();
}

/** The post body (HTML), then the media, then the link. */
export function postContent(html: string, link?: string, media: EmbeddedMedia[] = []) {
  const parts = html.trim() ? [html.trim()] : [];
  parts.push(...media.map(mediaBlock));
  if (link) parts.push(`<p><a href="${escapeHtml(link)}">${escapeHtml(link)}</a></p>`);
  return parts.join('\n');
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

      const upload = async (file: MediaFile) => {
        const safeName = file.fileName.replace(/[^\w.-]+/g, '_');
        const { data } = await request<{ id: number; source_url: string }>(
          deps,
          'wordpress',
          endpoint(credentials.apiBase, '/wp/v2/media'),
          {
            method: 'POST',
            headers: {
              ...auth,
              'content-type': file.mimeType,
              'content-disposition': `attachment; filename="${safeName}"`,
            },
            body: await fileBlob(file),
          },
        );
        return data;
      };

      // Upload every image and video, in order. Many themes don't show the featured image on the
      // post page, so attached media is also embedded in the content.
      const embedded: Array<EmbeddedMedia & { path: string }> = [];
      for (const file of input.media) {
        const kind = isImage(file) ? 'image' : isVideo(file) ? 'video' : null;
        if (!kind) continue;
        const data = await upload(file);
        embedded.push({ id: data.id, url: data.source_url, kind, path: file.path });
      }

      // Images placed inside the text: uploaded once each, then swapped in where they were written.
      const inline: Array<{ ref: string; media: EmbeddedMedia; path: string }> = [];
      for (const { ref, file } of input.inlineImages ?? []) {
        const data = await upload(file);
        inline.push({
          ref,
          path: file.path,
          media: { id: data.id, url: data.source_url, kind: 'image' },
        });
      }

      // The chosen featured image (reusing an upload when possible), else the first image.
      const uploadedId = (path: string) =>
        embedded.find((m) => m.path === path)?.id ?? inline.find((m) => m.path === path)?.media.id;
      const chosen = input.featuredImage;
      const featuredMedia = chosen
        ? (uploadedId(chosen.path) ?? (await upload(chosen)).id)
        : (embedded.find((m) => m.kind === 'image')?.id ?? inline[0]?.media.id);

      const options = input.wordpress;
      const tagIds = options?.tags.length ? await resolveTags(credentials, options.tags) : [];
      const html = replaceInlineImages(input.html ?? textToHtml(input.text), inline);

      const { data: post } = await request<{ id: number; link: string }>(
        deps,
        'wordpress',
        endpoint(credentials.apiBase, '/wp/v2/posts'),
        {
          method: 'POST',
          headers: { ...auth, 'content-type': 'application/json' },
          body: JSON.stringify({
            title: input.title,
            content: postContent(html, input.link, embedded),
            status: 'publish',
            ...(featuredMedia ? { featured_media: featuredMedia } : {}),
            ...(options?.categoryIds.length ? { categories: options.categoryIds } : {}),
            ...(tagIds.length ? { tags: tagIds } : {}),
          }),
        },
      );
      return { externalId: String(post.id), url: post.link };
    },
  };

  /** Tag ids by name, creating tags the site doesn't have yet. */
  async function resolveTags(credentials: WordPressCredentials, names: string[]) {
    const auth = basicAuth(credentials);
    const ids: number[] = [];
    for (const name of [...new Set(names.map((n) => n.trim()).filter(Boolean))]) {
      const { data: found } = await request<Array<{ id: number; name: string }>>(
        deps,
        'wordpress',
        endpoint(credentials.apiBase, '/wp/v2/tags', { search: name, per_page: '100' }),
        { headers: auth },
      );
      // WordPress returns names HTML-escaped (e.g. "R&amp;D").
      const match = found.find((t) => decodeEntities(t.name).toLowerCase() === name.toLowerCase());
      if (match) {
        ids.push(match.id);
        continue;
      }
      try {
        const { data: created } = await request<{ id: number }>(
          deps,
          'wordpress',
          endpoint(credentials.apiBase, '/wp/v2/tags'),
          {
            method: 'POST',
            headers: { ...auth, 'content-type': 'application/json' },
            body: JSON.stringify({ name }),
          },
        );
        ids.push(created.id);
      } catch (error) {
        // Already exists (e.g. differs only by accents): WordPress names the existing tag's id.
        const body = error instanceof PlatformError ? error.body : undefined;
        const termId = (body as { data?: { term_id?: unknown } } | undefined)?.data?.term_id;
        if (typeof termId === 'number') {
          ids.push(termId);
          continue;
        }
        throw error;
      }
    }
    return ids;
  }

  /** Every category on the site (up to 500), for picking when composing. */
  async function categories(credentials: WordPressCredentials): Promise<WordPressCategory[]> {
    const all: WordPressCategory[] = [];
    for (let page = 1; page <= 5; page++) {
      const { data, response } = await request<WordPressCategory[]>(
        deps,
        'wordpress',
        endpoint(credentials.apiBase, '/wp/v2/categories', {
          per_page: '100',
          page: String(page),
          orderby: 'name',
          _fields: 'id,name,parent',
        }),
        { headers: basicAuth(credentials) },
      );
      all.push(...data.map((c) => ({ ...c, name: decodeEntities(c.name) })));
      if (page >= Number(response.headers.get('x-wp-totalpages') ?? 1)) break;
    }
    return all;
  }

  return { connect, adapter, categories };
}
