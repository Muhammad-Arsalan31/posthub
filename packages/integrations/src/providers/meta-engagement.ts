// Facebook Page and Instagram comments through the Graph API.
import { Effect } from 'effect';
import { platformError, reason } from '../errors';
import { del, form, get, post, type Http } from '../http';
import type { EngagementAdapter, RemoteComment } from '../types';
import type { FacebookPageCredentials, InstagramCredentials } from './meta';

export const FACEBOOK_COMMENT_SCOPES = ['pages_read_user_content', 'pages_manage_engagement'];
export const INSTAGRAM_COMMENT_SCOPES = ['instagram_manage_comments'];

interface FacebookComment {
  id: string;
  message?: string;
  created_time: string;
  like_count?: number;
  user_likes?: boolean;
  is_hidden?: boolean;
  from?: { id: string; name?: string; picture?: { data?: { url?: string } } };
  parent?: { id: string };
}

interface InstagramComment {
  id: string;
  text?: string;
  timestamp: string;
  like_count?: number;
  hidden?: boolean;
  username?: string;
  from?: { id: string; username?: string };
}

interface Page<T> {
  data?: T[];
  paging?: { cursors?: { after?: string }; next?: string };
}

/** A comment the account just wrote. */
const ownComment = (
  externalId: string,
  parentExternalId: string | null,
  text: string,
  authorId: string,
): RemoteComment => ({
  externalId,
  parentExternalId,
  authorName: 'You',
  authorAvatarUrl: null,
  authorId,
  text,
  likeCount: 0,
  likedByMe: false,
  createdAt: new Date(),
  isOwn: true,
  hidden: false,
});

/** Instagram's wording for media it can't take comments on yet. */
const NOT_READY = /not (yet )?(ready|available)|try again|processing/i;

const IG_FIELDS = 'id,text,timestamp,like_count,hidden,username,from{id,username}';

export function createMetaEngagement(graph: string, http: Http) {
  const call = <T>(source: string, request: Parameters<Http>[1]) =>
    Effect.map(http<T>(source, request), (r) => r.data);
  const query = (params: Record<string, string | undefined>) =>
    new URLSearchParams(
      Object.entries(params).filter((e): e is [string, string] => e[1] !== undefined),
    ).toString();
  const nextCursor = (page: Page<unknown>) =>
    page.paging?.next ? page.paging.cursors?.after : undefined;

  const facebookComment = (c: FacebookComment, pageId: string): RemoteComment => ({
    externalId: c.id,
    parentExternalId: c.parent?.id ?? null,
    authorName: c.from?.name ?? 'Facebook user',
    authorAvatarUrl: c.from?.picture?.data?.url ?? null,
    authorId: c.from?.id ?? null,
    text: c.message ?? '',
    likeCount: c.like_count ?? null,
    likedByMe: c.user_likes ?? false,
    createdAt: new Date(c.created_time),
    isOwn: c.from?.id === pageId,
    hidden: c.is_hidden ?? false,
  });

  const facebook: EngagementAdapter<FacebookPageCredentials> = {
    platform: 'facebook',
    capabilities: { reply: true, like: true, hide: true, delete: true },
    scopes: FACEBOOK_COMMENT_SCOPES,
    replyParentId: (ref) => ref.externalId,

    listComments: ({ pageId, pageAccessToken }, { externalPostId }, cursor) =>
      Effect.map(
        call<Page<FacebookComment>>(
          'facebook',
          get(
            `${graph}/${externalPostId}/comments?${query({
              // `stream` returns replies too, each with its parent.
              filter: 'stream',
              order: 'chronological',
              fields:
                'id,message,created_time,like_count,user_likes,is_hidden,from{id,name,picture},parent{id}',
              limit: '100',
              after: cursor,
              access_token: pageAccessToken,
            })}`,
          ),
        ),
        (page) => ({
          comments: (page.data ?? []).map((c) => facebookComment(c, pageId)),
          next: nextCursor(page),
        }),
      ),

    reply: ({ pageId, pageAccessToken }, ref, text) =>
      Effect.gen(function* () {
        const { id } = yield* call<{ id: string }>(
          'facebook',
          post(`${graph}/${ref.externalId}/comments`, {
            body: form({ message: text, access_token: pageAccessToken }),
          }),
        );
        return {
          externalId: id,
          parentExternalId: ref.externalId,
          authorName: 'You',
          authorAvatarUrl: null,
          authorId: pageId,
          text,
          likeCount: 0,
          likedByMe: false,
          createdAt: new Date(),
          isOwn: true,
          hidden: false,
        };
      }),

    postComment: ({ pageId, pageAccessToken }, postId, text) =>
      Effect.map(
        call<{ id: string }>(
          'facebook',
          post(`${graph}/${postId}/comments`, {
            body: form({ message: text, access_token: pageAccessToken }),
          }),
        ),
        ({ id }) => ownComment(id, null, text, pageId),
      ),

    setLike: ({ pageAccessToken }, ref, liked) =>
      Effect.asVoid(
        call(
          'facebook',
          liked
            ? post(`${graph}/${ref.externalId}/likes`, {
                body: form({ access_token: pageAccessToken }),
              })
            : del(`${graph}/${ref.externalId}/likes?${query({ access_token: pageAccessToken })}`),
        ),
      ),

    moderate: ({ pageAccessToken }, ref, action) =>
      Effect.asVoid(
        call(
          'facebook',
          action === 'delete'
            ? del(`${graph}/${ref.externalId}?${query({ access_token: pageAccessToken })}`)
            : post(`${graph}/${ref.externalId}`, {
                body: form({
                  is_hidden: String(action === 'hide'),
                  access_token: pageAccessToken,
                }),
              }),
        ),
      ),
  };

  const instagramComment = (
    c: InstagramComment,
    igUserId: string,
    parent: string | null,
  ): RemoteComment => ({
    externalId: c.id,
    parentExternalId: parent,
    authorName: c.username ?? c.from?.username ?? 'Instagram user',
    authorAvatarUrl: null,
    authorId: c.from?.id ?? null,
    text: c.text ?? '',
    likeCount: c.like_count ?? null,
    likedByMe: false,
    createdAt: new Date(c.timestamp),
    isOwn: c.from?.id === igUserId,
    hidden: c.hidden ?? false,
  });

  const instagram: EngagementAdapter<InstagramCredentials> = {
    platform: 'instagram',
    capabilities: { reply: true, like: false, hide: true, delete: true },
    scopes: INSTAGRAM_COMMENT_SCOPES,
    replyParentId: (ref) => ref.threadExternalId,

    listComments: ({ igUserId, accessToken }, { externalPostId }, cursor) =>
      Effect.map(
        call<Page<InstagramComment & { replies?: Page<InstagramComment> }>>(
          'instagram',
          get(
            `${graph}/${externalPostId}/comments?${query({
              fields: `${IG_FIELDS},replies{${IG_FIELDS}}`,
              limit: '50',
              after: cursor,
              access_token: accessToken,
            })}`,
          ),
        ),
        (page) => ({
          comments: (page.data ?? []).flatMap((c) => [
            instagramComment(c, igUserId, null),
            ...(c.replies?.data ?? []).map((r) => instagramComment(r, igUserId, c.id)),
          ]),
          next: nextCursor(page),
        }),
      ),

    reply: ({ igUserId, accessToken }, ref, text) =>
      Effect.gen(function* () {
        // Instagram replies attach to the top-level comment.
        const { id } = yield* call<{ id: string }>(
          'instagram',
          post(`${graph}/${ref.threadExternalId}/replies`, {
            body: form({ message: text, access_token: accessToken }),
          }),
        );
        return {
          externalId: id,
          parentExternalId: ref.threadExternalId,
          authorName: 'You',
          authorAvatarUrl: null,
          authorId: igUserId,
          text,
          likeCount: 0,
          likedByMe: false,
          createdAt: new Date(),
          isOwn: true,
          hidden: false,
        };
      }),

    postComment: ({ igUserId, accessToken }, mediaId, text) =>
      call<{ id: string }>(
        'instagram',
        post(`${graph}/${mediaId}/comments`, {
          body: form({ message: text, access_token: accessToken }),
        }),
      ).pipe(
        Effect.map(({ id }) => ownComment(id, null, text, igUserId)),
        // Fresh media can refuse comments for a moment: that is worth retrying.
        Effect.mapError((error) =>
          error._tag === 'PlatformError' && !error.retryable && NOT_READY.test(error.message)
            ? platformError('instagram', reason(error), { status: error.status, retryable: true })
            : error,
        ),
      ),

    setLike: () =>
      Effect.fail(
        platformError('instagram', 'Instagram does not let apps like comments.', {
          retryable: false,
        }),
      ),

    moderate: ({ accessToken }, ref, action) =>
      Effect.asVoid(
        call(
          'instagram',
          action === 'delete'
            ? del(`${graph}/${ref.externalId}?${query({ access_token: accessToken })}`)
            : post(`${graph}/${ref.externalId}`, {
                body: form({ hide: String(action === 'hide'), access_token: accessToken }),
              }),
        ),
      ),
  };

  return { facebook, instagram };
}
