// LinkedIn member posting: Sign In with LinkedIn (OpenID Connect) + Share on LinkedIn (w_member_social).
import { PlatformError } from '../errors';
import { bearer, fileBlob, form, request, type HttpDeps } from '../http';
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

export function createLinkedIn(config: LinkedInConfig, deps: HttpDeps) {
  const version = config.apiVersion ?? DEFAULT_LINKEDIN_VERSION;

  const token = (fields: Record<string, string>) =>
    request<TokenResponse>(deps, 'linkedin', `${OAUTH}/accessToken`, {
      method: 'POST',
      body: form({ client_id: config.clientId, client_secret: config.clientSecret, ...fields }),
    }).then((r) => r.data);

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

    async connect({ code, redirectUri }) {
      const tokens = await token({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
      });
      const { data: me } = await request<{ sub: string; name?: string }>(
        deps,
        'linkedin',
        `${API}/v2/userinfo`,
        { headers: bearer(tokens.access_token) },
      );
      const authorUrn = `urn:li:person:${me.sub}`;
      const expiresAt = Date.now() + tokens.expires_in * 1000;
      return [
        {
          platform: 'linkedin',
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
    },
  };

  const linkedin: PlatformAdapter<LinkedInCredentials> = {
    platform: 'linkedin',

    async refresh(credentials) {
      // Standard apps get 60-day tokens without refresh tokens, so the owner must reconnect.
      if (!credentials.refreshToken) {
        throw new PlatformError('linkedin', 'Access expired. Reconnect the LinkedIn account.', {
          retryable: false,
        });
      }
      const tokens = await token({
        grant_type: 'refresh_token',
        refresh_token: credentials.refreshToken,
      });
      const expiresAt = Date.now() + tokens.expires_in * 1000;
      return {
        credentials: {
          ...credentials,
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token ?? credentials.refreshToken,
          expiresAt,
        },
        tokenExpiresAt: new Date(expiresAt),
      };
    },

    async publish(credentials, input) {
      if (input.media.some(isVideo)) {
        throw new PlatformError('linkedin', 'Video posts are not supported yet.', {
          retryable: false,
        });
      }
      const headers = {
        ...bearer(credentials.accessToken),
        'linkedin-version': version,
        'x-restli-protocol-version': '2.0.0',
        'content-type': 'application/json',
      };

      let content: Record<string, unknown> | undefined;
      const image = input.media.find(isImage);
      if (image) {
        const { data: upload } = await request<{ value: { uploadUrl: string; image: string } }>(
          deps,
          'linkedin',
          `${API}/rest/images?action=initializeUpload`,
          {
            method: 'POST',
            headers,
            body: JSON.stringify({ initializeUploadRequest: { owner: credentials.authorUrn } }),
          },
        );
        await request(deps, 'linkedin', upload.value.uploadUrl, {
          method: 'PUT',
          headers: bearer(credentials.accessToken),
          body: await fileBlob(image),
        });
        content = { media: { id: upload.value.image, title: input.title } };
      } else if (input.link) {
        content = { article: { source: input.link, title: input.title || input.link } };
      }

      const { response } = await request(deps, 'linkedin', `${API}/rest/posts`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
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
      });
      const urn = response.headers.get('x-restli-id') ?? '';
      return {
        externalId: urn,
        url: urn ? `https://www.linkedin.com/feed/update/${urn}/` : undefined,
      };
    },
  };

  return { provider, adapters: { linkedin } };
}
