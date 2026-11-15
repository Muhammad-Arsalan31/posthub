// LinkedIn member posting: Sign In with LinkedIn (OpenID Connect) + Share on LinkedIn (w_member_social).
import { Clock, Effect } from 'effect';
import { platformError } from '../errors';
import { bearer, fileBody, form, get, json, post, put, type Http } from '../http';
import { isImage, isVideo, type OAuthProvider, type PlatformAdapter } from '../types';

export interface LinkedInConfig {
  clientId: string;
  clientSecret: string;
  /** YYYYMM. LinkedIn supports each version for about a year, so bump it periodically. */
  apiVersion?: string;
}

export interface LinkedInCredentials {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  authorUrn: string;
}

export const DEFAULT_LINKEDIN_VERSION = '202608';

const OAUTH = 'https://www.linkedin.com/oauth/v2';
const API = 'https://api.linkedin.com';
const SCOPES = ['openid', 'profile', 'w_member_social'];

interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
}

/** LinkedIn "little text" format: these characters must be backslash-escaped in commentary. */
export const escapeLittleText = (text: string) => text.replace(/[\\|{}@[\]()<>#*_~]/g, '\\$&');

export function createLinkedIn(config: LinkedInConfig, http: Http) {
  const version = config.apiVersion ?? DEFAULT_LINKEDIN_VERSION;

  const token = (fields: Record<string, string>) =>
    http<TokenResponse>(
      'linkedin',
      post(`${OAUTH}/accessToken`, {
        body: form({ client_id: config.clientId, client_secret: config.clientSecret, ...fields }),
      }),
    ).pipe(Effect.map((r) => r.data));

  const provider: OAuthProvider = {
    id: 'linkedin',

    authorizationUrl({ state, redirectUri }) {
      const params = new URLSearchParams({
        response_type: 'code',
        client_id: config.clientId,
        redirect_uri: redirectUri,
        state,
        scope: SCOPES.join(' '),
      });
      return `${OAUTH}/authorization?${params.toString()}`;
    },

    connect: ({ code, redirectUri }) =>
      Effect.gen(function* () {
        const tokens = yield* token({
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri,
        });
        const { data: me } = yield* http<{ sub: string; name?: string }>(
          'linkedin',
          get(`${API}/v2/userinfo`, { headers: bearer(tokens.access_token) }),
        );
        const authorUrn = `urn:li:person:${me.sub}`;
        const expiresAt = (yield* Clock.currentTimeMillis) + tokens.expires_in * 1000;
        return [
          {
            platform: 'linkedin' as const,
            externalId: authorUrn,
            displayName: me.name ?? 'LinkedIn member',
            credentials: {
              accessToken: tokens.access_token,
              refreshToken: tokens.refresh_token,
              expiresAt,
              authorUrn,
            } satisfies LinkedInCredentials,
            tokenExpiresAt: new Date(expiresAt),
          },
        ];
      }),
  };

  const linkedin: PlatformAdapter<LinkedInCredentials> = {
    platform: 'linkedin',

    refresh: (credentials) =>
      Effect.gen(function* () {
        // Standard apps get 60-day tokens without refresh tokens, so the owner must reconnect.
        if (!credentials.refreshToken) {
          return yield* platformError(
            'linkedin',
            'Access expired. Reconnect the LinkedIn account.',
            {
              retryable: false,
            },
          );
        }
        const tokens = yield* token({
          grant_type: 'refresh_token',
          refresh_token: credentials.refreshToken,
        });
        const expiresAt = (yield* Clock.currentTimeMillis) + tokens.expires_in * 1000;
        return {
          credentials: {
            ...credentials,
            accessToken: tokens.access_token,
            refreshToken: tokens.refresh_token ?? credentials.refreshToken,
            expiresAt,
          },
          tokenExpiresAt: new Date(expiresAt),
        };
      }),

    publish: (credentials, input) =>
      Effect.gen(function* () {
        if (input.media.some(isVideo)) {
          return yield* platformError('linkedin', 'Video posts are not supported yet.', {
            retryable: false,
          });
        }
        const headers = {
          ...bearer(credentials.accessToken),
          'linkedin-version': version,
          'x-restli-protocol-version': '2.0.0',
        };

        let content: Record<string, unknown> | undefined;
        const image = input.media.find(isImage);
        if (image) {
          const { data: upload } = yield* http<{ value: { uploadUrl: string; image: string } }>(
            'linkedin',
            post(`${API}/rest/images?action=initializeUpload`, {
              headers,
              body: json({ initializeUploadRequest: { owner: credentials.authorUrn } }),
            }),
          );
          yield* http(
            'linkedin',
            put(upload.value.uploadUrl, {
              headers: bearer(credentials.accessToken),
              body: yield* fileBody(image),
            }),
          );
          content = { media: { id: upload.value.image, title: input.title } };
        } else if (input.link) {
          content = { article: { source: input.link, title: input.title || input.link } };
        }

        const { response } = yield* http(
          'linkedin',
          post(`${API}/rest/posts`, {
            headers,
            body: json({
              author: credentials.authorUrn,
              commentary: escapeLittleText(input.text),
              visibility: 'PUBLIC',
              distribution: {
                feedDistribution: 'MAIN_FEED',
                targetEntities: [],
                thirdPartyDistributionChannels: [],
              },
              ...(content ? { content } : {}),
              lifecycleState: 'PUBLISHED',
              isReshareDisabledByAuthor: false,
            }),
          }),
        );
        const urn = response.headers['x-restli-id'] ?? '';
        return {
          externalId: urn,
          url: urn ? `https://www.linkedin.com/feed/update/${urn}/` : undefined,
        };
      }),
  };

  return { provider, adapters: { linkedin } };
}
