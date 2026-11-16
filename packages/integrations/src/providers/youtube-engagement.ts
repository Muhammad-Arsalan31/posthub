// YouTube comments: commentThreads to read, comments.insert to reply, setModerationStatus to hide.
// Every write costs about 50 units of the daily quota uploads also use.
import { Effect } from 'effect';
import { platformError } from '../errors';
import { bearer, del, get, json, post, type Http } from '../http';
import type { EngagementAdapter, RemoteComment } from '../types';
import type { YouTubeCredentials } from './google';

const API = 'https://www.googleapis.com/youtube/v3';
/** Needed to reply and moderate (youtube.readonly is enough to read). */
export const YOUTUBE_COMMENT_SCOPE = 'https://www.googleapis.com/auth/youtube.force-ssl';

interface CommentResource {
  id: string;
  snippet: {
    parentId?: string;
    authorDisplayName?: string;
    authorProfileImageUrl?: string;
    authorChannelId?: { value?: string };
    textOriginal?: string;
    textDisplay?: string;
    likeCount?: number;
    publishedAt: string;
    viewerRating?: string;
    moderationStatus?: string;
  };
}

interface ThreadList {
  items?: Array<{
    snippet: { topLevelComment: CommentResource };
    replies?: { comments?: CommentResource[] };
  }>;
  nextPageToken?: string;
}

const toComment = (resource: CommentResource, channelId: string): RemoteComment => ({
  externalId: resource.id,
  parentExternalId: resource.snippet.parentId ?? null,
  authorName: resource.snippet.authorDisplayName ?? 'YouTube user',
  authorAvatarUrl: resource.snippet.authorProfileImageUrl ?? null,
  authorId: resource.snippet.authorChannelId?.value ?? null,
  text: resource.snippet.textOriginal ?? resource.snippet.textDisplay ?? '',
  likeCount: resource.snippet.likeCount ?? null,
  likedByMe: resource.snippet.viewerRating === 'like',
  createdAt: new Date(resource.snippet.publishedAt),
  isOwn: resource.snippet.authorChannelId?.value === channelId,
  hidden: resource.snippet.moderationStatus === 'rejected',
});

export function createYouTubeEngagement(
  http: Http,
  refresh: NonNullable<EngagementAdapter<YouTubeCredentials>['refresh']>,
): EngagementAdapter<YouTubeCredentials> {
  const auth = (c: YouTubeCredentials) => ({ headers: bearer(c.accessToken) });

  return {
    platform: 'youtube',
    capabilities: { reply: true, like: false, hide: true, delete: true },
    scopes: [YOUTUBE_COMMENT_SCOPE],
    refresh,

    listComments: (credentials, { externalPostId, accountExternalId }, cursor) =>
      Effect.gen(function* () {
        const params = new URLSearchParams({
          part: 'snippet,replies',
          videoId: externalPostId,
          maxResults: '100',
          textFormat: 'plainText',
          ...(cursor ? { pageToken: cursor } : {}),
        });
        const { data } = yield* http<ThreadList>(
          'youtube',
          get(`${API}/commentThreads?${params.toString()}`, auth(credentials)),
        );
        const comments = (data.items ?? []).flatMap((thread) => [
          toComment(thread.snippet.topLevelComment, accountExternalId),
          // Threads include up to five replies; enough for an inbox.
          ...(thread.replies?.comments ?? []).map((r) => toComment(r, accountExternalId)),
        ]);
        return { comments, next: data.nextPageToken };
      }),

    reply: (credentials, ref, text) =>
      Effect.map(
        http<CommentResource>(
          'youtube',
          post(`${API}/comments?part=snippet`, {
            ...auth(credentials),
            // Replies always attach to the thread's top-level comment.
            body: json({ snippet: { parentId: ref.threadExternalId, textOriginal: text } }),
          }),
        ),
        ({ data }) => ({
          ...toComment(data, ''),
          isOwn: true,
          parentExternalId: ref.threadExternalId,
          createdAt: data.snippet?.publishedAt ? new Date(data.snippet.publishedAt) : new Date(),
        }),
      ),

    postComment: (credentials, videoId, text) =>
      Effect.map(
        http<{ id: string; snippet?: { topLevelComment?: CommentResource } }>(
          'youtube',
          post(`${API}/commentThreads?part=snippet`, {
            ...auth(credentials),
            body: json({
              snippet: { videoId, topLevelComment: { snippet: { textOriginal: text } } },
            }),
          }),
        ),
        ({ data }) => {
          const top = data.snippet?.topLevelComment;
          return top
            ? { ...toComment(top, ''), isOwn: true }
            : {
                externalId: data.id,
                parentExternalId: null,
                authorName: 'You',
                authorAvatarUrl: null,
                authorId: null,
                text,
                likeCount: 0,
                likedByMe: false,
                createdAt: new Date(),
                isOwn: true,
                hidden: false,
              };
        },
      ),

    setLike: () =>
      Effect.fail(
        platformError('youtube', 'YouTube does not let apps like comments.', { retryable: false }),
      ),

    moderate: (credentials, ref, action) =>
      action === 'delete'
        ? Effect.asVoid(
            http(
              'youtube',
              del(`${API}/comments?id=${encodeURIComponent(ref.externalId)}`, auth(credentials)),
            ),
          )
        : Effect.asVoid(
            http(
              'youtube',
              post(
                `${API}/comments/setModerationStatus?${new URLSearchParams({
                  id: ref.externalId,
                  moderationStatus: action === 'hide' ? 'rejected' : 'published',
                }).toString()}`,
                auth(credentials),
              ),
            ),
          ),
  };
}
