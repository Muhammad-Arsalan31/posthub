// Facebook Pages + Instagram (Business/Creator accounts linked to a Page) via Facebook Login and the Graph API.
import { Effect } from 'effect';
import type { HttpBody } from 'effect/http';
import { platformError } from '../errors';
import { fileBlob, form, get, multipart, post, type Http } from '../http';
import {
  isImage,
  isVideo,
  withLink,
  type ConnectedAccount,
  type MediaFile,
  type OAuthProvider,
  type PlatformAdapter,
} from '../types';

export interface MetaConfig {
  appId: string;
  appSecret: string;
  graphVersion?: string;
}

export interface MetaOptions {
  /** Instagram processing poll interval. Tests can drive it with TestClock or set it to 0. */
  pollIntervalMs?: number;
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

/** Polls of an Instagram media container before giving up (and retrying later). */
const MAX_STATUS_POLLS = 60;

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

export function createMeta(config: MetaConfig, http: Http, options: MetaOptions = {}) {
  const version = config.graphVersion ?? DEFAULT_GRAPH_VERSION;
  const graph = `https://graph.facebook.com/${version}`;
  const pollIntervalMs = options.pollIntervalMs ?? 5000;

  const graphGet = <T>(source: string, path: string, params: Record<string, string>) =>
    http<T>(source, get(`${graph}/${path}?${new URLSearchParams(params).toString()}`)).pipe(
      Effect.map((r) => r.data),
    );
  const graphPost = <T>(source: string, url: string, body: HttpBody.HttpBody) =>
    http<T>(source, post(url, { body })).pipe(Effect.map((r) => r.data));

  /** A multipart body with the file streamed from disk as `source`. */
  const withSource = (fields: Record<string, string>, file: MediaFile) =>
    Effect.map(fileBlob(file), (blob) => {
      const body = new FormData();
      for (const [key, value] of Object.entries(fields)) body.set(key, value);
      body.set('source', blob, file.fileName);
      return multipart(body);
    });

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

    connect: ({ code, redirectUri }) =>
      Effect.gen(function* () {
        const app = { client_id: config.appId, client_secret: config.appSecret };
        const short = yield* graphGet<{ access_token: string }>('facebook', 'oauth/access_token', {
          ...app,
          redirect_uri: redirectUri,
          code,
        });
        // Page tokens derived from a long-lived user token do not expire.
        const long = yield* graphGet<{ access_token: string }>('facebook', 'oauth/access_token', {
          ...app,
          grant_type: 'fb_exchange_token',
          fb_exchange_token: short.access_token,
        });
        const pages = yield* graphGet<PageResponse>('facebook', 'me/accounts', {
          fields: 'id,name,access_token,instagram_business_account{id,username}',
          limit: '100',
          access_token: long.access_token,
        });
        if (pages.data.length === 0) {
          return yield* platformError(
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
      }),
  };

  const facebook: PlatformAdapter<FacebookPageCredentials> = {
    platform: 'facebook',

    publish: ({ pageId, pageAccessToken }, input) =>
      Effect.gen(function* () {
        const video = input.media.find(isVideo);
        const images = input.media.filter(isImage);
        const caption = withLink(input.text, input.link);

        if (video) {
          const body = yield* withSource(
            { access_token: pageAccessToken, title: input.title, description: caption },
            video,
          );
          const { id } = yield* graphPost<{ id: string }>(
            'facebook',
            `https://graph-video.facebook.com/${version}/${pageId}/videos`,
            body,
          );
          return { externalId: id, url: `https://www.facebook.com/${pageId}/videos/${id}` };
        }

        const [first] = images;
        if (first && images.length === 1) {
          const body = yield* withSource({ access_token: pageAccessToken, caption }, first);
          const photo = yield* graphPost<{ id: string; post_id?: string }>(
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
        // Multi-photo post: upload each photo unpublished, then attach them to one feed post.
        for (const [i, image] of images.entries()) {
          const body = yield* withSource(
            { access_token: pageAccessToken, published: 'false' },
            image,
          );
          const { id } = yield* graphPost<{ id: string }>(
            'facebook',
            `${graph}/${pageId}/photos`,
            body,
          );
          fields[`attached_media[${i}]`] = JSON.stringify({ media_fbid: id });
        }
        const { id } = yield* graphPost<{ id: string }>(
          'facebook',
          `${graph}/${pageId}/feed`,
          form(fields),
        );
        return { externalId: id, url: `https://www.facebook.com/${id}` };
      }),
  };

  /** Waits until Instagram has processed a media container (videos take a while). */
  const awaitProcessing = (containerId: string, accessToken: string) =>
    Effect.gen(function* () {
      for (let attempt = 0; ; attempt++) {
        const { status_code: status } = yield* graphGet<{ status_code?: string }>(
          'instagram',
          containerId,
          { fields: 'status_code', access_token: accessToken },
        );
        if (!status || status === 'FINISHED' || status === 'PUBLISHED') return;
        if (status === 'ERROR' || status === 'EXPIRED') {
          return yield* platformError('instagram', `Media processing failed (${status}).`, {
            retryable: false,
          });
        }
        if (attempt >= MAX_STATUS_POLLS) {
          return yield* platformError('instagram', 'Media is still processing.', {
            retryable: true,
          });
        }
        yield* Effect.sleep(pollIntervalMs);
      }
    });

  const instagram: PlatformAdapter<InstagramCredentials> = {
    platform: 'instagram',
    needsPublicMedia: true,

    publish: ({ igUserId, accessToken }, input) =>
      Effect.gen(function* () {
        const [media] = input.media;
        if (!media || input.media.length !== 1) {
          return yield* platformError(
            'instagram',
            'Instagram posts need exactly one image or video.',
            { retryable: false },
          );
        }
        if (!media.publicUrl) {
          return yield* platformError(
            'instagram',
            'Instagram downloads media from a public URL, and this file does not have one.',
            { retryable: false },
          );
        }
        const caption = withLink(input.text, input.link);

        // 1. Create a media container. Instagram fetches the file from publicUrl.
        const container = yield* graphPost<{ id: string }>(
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

        // 2. Wait until it is processed.
        yield* awaitProcessing(container.id, accessToken);

        // 3. Publish. After this succeeds, nothing below may fail, or a retry would post twice.
        const { id } = yield* graphPost<{ id: string }>(
          'instagram',
          `${graph}/${igUserId}/media_publish`,
          form({ creation_id: container.id, access_token: accessToken }),
        );
        // The post exists; the link is only nice to have.
        const url = yield* graphGet<{ permalink?: string }>('instagram', id, {
          fields: 'permalink',
          access_token: accessToken,
        }).pipe(
          Effect.map((r) => r.permalink),
          Effect.catchCause(() => Effect.succeed(undefined)),
        );
        return { externalId: id, url };
      }),
  };

  return { provider, adapters: { facebook, instagram } };
}
