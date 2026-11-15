// YouTube via Google OAuth 2.0 + YouTube Data API v3 (resumable uploads).
import { Cause, Clock, Effect } from 'effect';
import { platformError, reason, PlatformError } from '../errors';
import { bearer, fileBody, form, get, json, post, put, type Http } from '../http';
import {
  isVideo,
  type ConnectedAccount,
  type OAuthProvider,
  type PlatformAdapter,
  type PublishResult,
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
const THUMBNAIL_URL = 'https://www.googleapis.com/upload/youtube/v3/thumbnails/set';
const SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube.readonly',
];

interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
}

/** Why an optional step failed, in words for the owner. */
const failureReason = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause);
  if (error instanceof PlatformError) return reason(error);
  return error instanceof Error ? error.message : String(error);
};

export function createGoogle(config: GoogleConfig, http: Http) {
  const token = (fields: Record<string, string>) =>
    http<TokenResponse>(
      'youtube',
      post(TOKEN_URL, {
        body: form({ client_id: config.clientId, client_secret: config.clientSecret, ...fields }),
      }),
    ).pipe(Effect.map((r) => r.data));

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

    connect: ({ code, redirectUri }) =>
      Effect.gen(function* () {
        const tokens = yield* token({
          code,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code',
        });
        const refreshToken = tokens.refresh_token;
        if (!refreshToken) {
          return yield* platformError(
            'youtube',
            'Google did not return a refresh token. Remove PostHub from your Google account permissions and connect again.',
          );
        }
        const { data } = yield* http<{ items?: Array<{ id: string; snippet: { title: string } }> }>(
          'youtube',
          get(`${API}/channels?part=snippet&mine=true`, { headers: bearer(tokens.access_token) }),
        );
        const channels = data.items ?? [];
        if (channels.length === 0) {
          return yield* platformError('youtube', 'This Google account has no YouTube channel.');
        }
        const expiresAt = (yield* Clock.currentTimeMillis) + tokens.expires_in * 1000;
        return channels.map((channel): ConnectedAccount<YouTubeCredentials> => ({
          platform: 'youtube',
          externalId: channel.id,
          displayName: channel.snippet.title,
          credentials: { accessToken: tokens.access_token, refreshToken, expiresAt },
          tokenExpiresAt: new Date(expiresAt),
        }));
      }),
  };

  const youtube: PlatformAdapter<YouTubeCredentials> = {
    platform: 'youtube',

    refresh: (credentials) =>
      Effect.gen(function* () {
        const tokens = yield* token({
          refresh_token: credentials.refreshToken,
          grant_type: 'refresh_token',
        });
        const expiresAt = (yield* Clock.currentTimeMillis) + tokens.expires_in * 1000;
        return {
          credentials: {
            accessToken: tokens.access_token,
            refreshToken: tokens.refresh_token ?? credentials.refreshToken,
            expiresAt,
          },
          tokenExpiresAt: new Date(expiresAt),
        };
      }),

    publish: (credentials, input) =>
      Effect.gen(function* () {
        const video = input.media.find(isVideo);
        if (!video) {
          return yield* platformError('youtube', 'YouTube posts need a video.', {
            retryable: false,
          });
        }

        // 1. Open a resumable upload session with the video metadata.
        const session = yield* http(
          'youtube',
          post(UPLOAD_URL, {
            headers: {
              ...bearer(credentials.accessToken),
              'x-upload-content-type': video.mimeType,
              'x-upload-content-length': String(video.sizeBytes),
            },
            body: json(
              {
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
              },
              'application/json; charset=UTF-8',
            ),
          }),
        );
        const uploadUrl = session.response.headers['location'];
        if (!uploadUrl) {
          return yield* platformError('youtube', 'Upload session was not created.', {
            retryable: true,
          });
        }

        // 2. Stream the file to the session URL.
        const { data } = yield* http<{ id: string }>(
          'youtube',
          put(uploadUrl, {
            headers: bearer(credentials.accessToken),
            body: yield* fileBody(video),
          }),
        );
        const result: PublishResult = { externalId: data.id, url: `https://youtu.be/${data.id}` };

        // 3. Optional custom thumbnail. The video exists now, so nothing below may fail:
        //    any failure becomes a warning instead of a retry that would upload the video twice.
        const thumbnail = input.thumbnail;
        if (!thumbnail) return result;
        return yield* Effect.gen(function* () {
          const url = `${THUMBNAIL_URL}?videoId=${encodeURIComponent(data.id)}`;
          yield* http(
            'youtube',
            post(url, {
              headers: bearer(credentials.accessToken),
              body: yield* fileBody(thumbnail),
            }),
          );
          return result;
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.succeed({
              ...result,
              warning: `Published, but the thumbnail was not set: ${failureReason(cause)}. Custom thumbnails need a verified YouTube channel.`,
            }),
          ),
        );
      }),
  };

  return { provider, adapters: { youtube } };
}
