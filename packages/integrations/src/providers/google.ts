// YouTube via Google OAuth 2.0 + YouTube Data API v3 (resumable uploads).
import { PlatformError } from '../errors';
import { bearer, fileBlob, form, request, type HttpDeps } from '../http';
import {
  isVideo,
  type ConnectedAccount,
  type OAuthProvider,
  type PlatformAdapter,
  type PublishInput,
} from '../types';

export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
  /** Videos from unverified Google Cloud projects are forced to private regardless. */
  youtubePrivacy?: 'public' | 'unlisted' | 'private';
}

export interface YouTubeCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://www.googleapis.com/youtube/v3';
const UPLOAD_URL =
  'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status';
const SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube.readonly',
];

interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
}

export function createGoogle(config: GoogleConfig, deps: HttpDeps) {
  const token = (fields: Record<string, string>) =>
    request<TokenResponse>(deps, 'youtube', TOKEN_URL, {
      method: 'POST',
      body: form({ client_id: config.clientId, client_secret: config.clientSecret, ...fields }),
    }).then((r) => r.data);

  const provider: OAuthProvider = {
    id: 'google',

    authorizationUrl({ state, redirectUri }) {
      const params = new URLSearchParams({
        client_id: config.clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: SCOPES.join(' '),
        access_type: 'offline',
        // Always ask, so Google returns a refresh token on every connect.
        prompt: 'consent',
        include_granted_scopes: 'true',
        state,
      });
      return `${AUTH_URL}?${params.toString()}`;
    },

    async connect({ code, redirectUri }) {
      const tokens = await token({
        code,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      });
      if (!tokens.refresh_token) {
        throw new PlatformError(
          'youtube',
          'Google did not return a refresh token. Remove PostHub from your Google account permissions and connect again.',
        );
      }
      const { data } = await request<{ items?: Array<{ id: string; snippet: { title: string } }> }>(
        deps,
        'youtube',
        `${API}/channels?part=snippet&mine=true`,
        { headers: bearer(tokens.access_token) },
      );
      const channels = data.items ?? [];
      if (channels.length === 0) {
        throw new PlatformError('youtube', 'This Google account has no YouTube channel.');
      }
      const expiresAt = Date.now() + tokens.expires_in * 1000;
      return channels.map((channel): ConnectedAccount<YouTubeCredentials> => ({
        platform: 'youtube',
        externalId: channel.id,
        displayName: channel.snippet.title,
        credentials: {
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token!,
          expiresAt,
        },
        tokenExpiresAt: new Date(expiresAt),
      }));
    },
  };

  const youtube: PlatformAdapter<YouTubeCredentials> = {
    platform: 'youtube',

    async refresh(credentials) {
      const tokens = await token({
        refresh_token: credentials.refreshToken,
        grant_type: 'refresh_token',
      });
      const expiresAt = Date.now() + tokens.expires_in * 1000;
      return {
        credentials: {
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token ?? credentials.refreshToken,
          expiresAt,
        },
        tokenExpiresAt: new Date(expiresAt),
      };
    },

    async publish(credentials, input: PublishInput) {
      const video = input.media.find(isVideo);
      if (!video) {
        throw new PlatformError('youtube', 'YouTube posts need a video.', { retryable: false });
      }

      // 1. Open a resumable upload session with the video metadata.
      const session = await request(deps, 'youtube', UPLOAD_URL, {
        method: 'POST',
        headers: {
          ...bearer(credentials.accessToken),
          'content-type': 'application/json; charset=UTF-8',
          'x-upload-content-type': video.mimeType,
          'x-upload-content-length': String(video.sizeBytes),
        },
        body: JSON.stringify({
          snippet: {
            // YouTube rejects titles over 100 chars or containing angle brackets.
            title: (input.title || video.fileName).replace(/[<>]/g, '').slice(0, 100),
            description: input.text.replace(/[<>]/g, '').slice(0, 5000),
            categoryId: '22',
          },
          status: {
            privacyStatus: config.youtubePrivacy ?? 'public',
            selfDeclaredMadeForKids: false,
          },
        }),
      });
      const uploadUrl = session.response.headers.get('location');
      if (!uploadUrl) {
        throw new PlatformError('youtube', 'Upload session was not created.', { retryable: true });
      }

      // 2. Stream the file to the session URL.
      const { data } = await request<{ id: string }>(deps, 'youtube', uploadUrl, {
        method: 'PUT',
        headers: { ...bearer(credentials.accessToken), 'content-type': video.mimeType },
        body: await fileBlob(video),
      });
      return { externalId: data.id, url: `https://youtu.be/${data.id}` };
    },
  };

  return { provider, adapters: { youtube } };
}
