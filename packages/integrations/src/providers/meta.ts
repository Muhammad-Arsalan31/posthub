// Facebook Pages + Instagram (Business/Creator accounts linked to a Page) via Facebook Login and the Graph API.
import { PlatformError } from '../errors';
import { fileBlob, form, request, type HttpDeps } from '../http';
import {
  isImage,
  isVideo,
  withLink,
  type ConnectedAccount,
  type OAuthProvider,
  type PlatformAdapter,
} from '../types';

export interface MetaConfig {
  appId: string;
  appSecret: string;
  graphVersion?: string;
}

export interface FacebookPageCredentials {
  pageId: string;
  pageAccessToken: string;
}

export interface InstagramCredentials {
  igUserId: string;
  /** Token of the Facebook Page the Instagram account is linked to. */
  accessToken: string;
}

export const DEFAULT_GRAPH_VERSION = 'v26.0';

const SCOPES = [
  'pages_show_list',
  'pages_manage_posts',
  'pages_read_engagement',
  'business_management',
  'instagram_basic',
  'instagram_content_publish',
];

interface PageResponse {
  data: Array<{
    id: string;
    name: string;
    access_token: string;
    instagram_business_account?: { id: string; username?: string };
  }>;
}

export function createMeta(config: MetaConfig, deps: HttpDeps & { pollIntervalMs?: number }) {
  const version = config.graphVersion ?? DEFAULT_GRAPH_VERSION;
  const graph = `https://graph.facebook.com/${version}`;
  const pollIntervalMs = deps.pollIntervalMs ?? 5000;

  const get = <T>(source: string, path: string, params: Record<string, string>) =>
    request<T>(deps, source, `${graph}/${path}?${new URLSearchParams(params).toString()}`).then(
      (r) => r.data,
    );
  const post = <T>(source: string, url: string, body: URLSearchParams | FormData) =>
    request<T>(deps, source, url, { method: 'POST', body }).then((r) => r.data);

  const provider: OAuthProvider = {
    id: 'meta',

    authorizationUrl({ state, redirectUri }) {
      const params = new URLSearchParams({
        client_id: config.appId,
        redirect_uri: redirectUri,
        state,
        response_type: 'code',
        scope: SCOPES.join(','),
      });
      return `https://www.facebook.com/${version}/dialog/oauth?${params.toString()}`;
    },

    async connect({ code, redirectUri }) {
      const app = { client_id: config.appId, client_secret: config.appSecret };
      const short = await get<{ access_token: string }>('facebook', 'oauth/access_token', {
        ...app,
        redirect_uri: redirectUri,
        code,
      });
      // Page tokens derived from a long-lived user token do not expire.
      const long = await get<{ access_token: string }>('facebook', 'oauth/access_token', {
        ...app,
        grant_type: 'fb_exchange_token',
        fb_exchange_token: short.access_token,
      });
      const pages = await get<PageResponse>('facebook', 'me/accounts', {
        fields: 'id,name,access_token,instagram_business_account{id,username}',
        limit: '100',
        access_token: long.access_token,
      });
      if (pages.data.length === 0) {
        throw new PlatformError(
          'facebook',
          'No Facebook Pages were shared with PostHub. Reconnect and select at least one Page.',
        );
      }

      const accounts: ConnectedAccount[] = [];
      for (const page of pages.data) {
        accounts.push({
          platform: 'facebook',
          externalId: page.id,
          displayName: page.name,
          credentials: {
            pageId: page.id,
            pageAccessToken: page.access_token,
          } satisfies FacebookPageCredentials,
          tokenExpiresAt: null,
        });
        const ig = page.instagram_business_account;
        if (ig) {
          accounts.push({
            platform: 'instagram',
            externalId: ig.id,
            displayName: ig.username ? `@${ig.username}` : `${page.name} (Instagram)`,
            credentials: {
              igUserId: ig.id,
              accessToken: page.access_token,
            } satisfies InstagramCredentials,
            tokenExpiresAt: null,
          });
        }
      }
      return accounts;
    },
  };

  const facebook: PlatformAdapter<FacebookPageCredentials> = {
    platform: 'facebook',

    async publish({ pageId, pageAccessToken }, input) {
      const video = input.media.find(isVideo);
      const images = input.media.filter(isImage);
      const caption = withLink(input.text, input.link);

      if (video) {
        const body = new FormData();
        body.set('access_token', pageAccessToken);
        body.set('title', input.title);
        body.set('description', caption);
        body.set('source', await fileBlob(video), video.fileName);
        const { id } = await post<{ id: string }>(
          'facebook',
          `https://graph-video.facebook.com/${version}/${pageId}/videos`,
          body,
        );
        return { externalId: id, url: `https://www.facebook.com/${pageId}/videos/${id}` };
      }

      if (images.length === 1) {
        const body = new FormData();
        body.set('access_token', pageAccessToken);
        body.set('caption', caption);
        body.set('source', await fileBlob(images[0]!), images[0]!.fileName);
        const photo = await post<{ id: string; post_id?: string }>(
          'facebook',
          `${graph}/${pageId}/photos`,
          body,
        );
        const id = photo.post_id ?? photo.id;
        return { externalId: id, url: `https://www.facebook.com/${id}` };
      }

      const fields: Record<string, string | undefined> = {
        access_token: pageAccessToken,
        message: images.length > 1 ? caption : input.text,
        link: images.length > 1 ? undefined : input.link,
      };
      if (images.length > 1) {
        // Multi-photo post: upload each photo unpublished, then attach them to one feed post.
        for (const [i, image] of images.entries()) {
          const body = new FormData();
          body.set('access_token', pageAccessToken);
          body.set('published', 'false');
          body.set('source', await fileBlob(image), image.fileName);
          const { id } = await post<{ id: string }>('facebook', `${graph}/${pageId}/photos`, body);
          fields[`attached_media[${i}]`] = JSON.stringify({ media_fbid: id });
        }
      }
      const { id } = await post<{ id: string }>(
        'facebook',
        `${graph}/${pageId}/feed`,
        form(fields),
      );
      return { externalId: id, url: `https://www.facebook.com/${id}` };
    },
  };

  const instagram: PlatformAdapter<InstagramCredentials> = {
    platform: 'instagram',

    async publish({ igUserId, accessToken }, input) {
      if (input.media.length !== 1) {
        throw new PlatformError('instagram', 'Instagram posts need exactly one image or video.', {
          retryable: false,
        });
      }
      const media = input.media[0]!;
      if (!media.publicUrl) {
        throw new PlatformError(
          'instagram',
          'Instagram downloads media from a public URL, and this file does not have one.',
          { retryable: false },
        );
      }
      const caption = withLink(input.text, input.link);

      // 1. Create a media container. Instagram fetches the file from publicUrl.
      const container = await post<{ id: string }>(
        'instagram',
        `${graph}/${igUserId}/media`,
        form(
          isVideo(media)
            ? {
                media_type: 'REELS',
                video_url: media.publicUrl,
                caption,
                access_token: accessToken,
              }
            : { image_url: media.publicUrl, caption, access_token: accessToken },
        ),
      );

      // 2. Wait until Instagram has processed it (videos take a while).
      for (let attempt = 0; ; attempt++) {
        const { status_code: status } = await get<{ status_code?: string }>(
          'instagram',
          container.id,
          { fields: 'status_code', access_token: accessToken },
        );
        if (!status || status === 'FINISHED' || status === 'PUBLISHED') break;
        if (status === 'ERROR' || status === 'EXPIRED') {
          throw new PlatformError('instagram', `Media processing failed (${status}).`, {
            retryable: false,
          });
        }
        if (attempt >= 60) {
          throw new PlatformError('instagram', 'Media is still processing.', { retryable: true });
        }
        await deps.sleep(pollIntervalMs);
      }

      // 3. Publish. After this succeeds, nothing below may throw, or a retry would post twice.
      const { id } = await post<{ id: string }>(
        'instagram',
        `${graph}/${igUserId}/media_publish`,
        form({ creation_id: container.id, access_token: accessToken }),
      );
      let url: string | undefined;
      try {
        url = (
          await get<{ permalink?: string }>('instagram', id, {
            fields: 'permalink',
            access_token: accessToken,
          })
        ).permalink;
      } catch {
        // The post exists; the link is only nice to have.
      }
      return { externalId: id, url };
    },
  };

  return { provider, adapters: { facebook, instagram } };
}
