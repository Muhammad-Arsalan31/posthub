// WordPress comments through the REST API (Application Password of an editor or admin).
import { Effect } from 'effect';
import { htmlToText } from '../content';
import { platformError } from '../errors';
import { del, get, json, post, type Http } from '../http';
import type { EngagementAdapter, RemoteComment } from '../types';
import { endpoint, type WordPressCredentials } from './wordpress';

interface WordPressComment {
  id: number;
  parent: number;
  author: number;
  author_name?: string;
  author_avatar_urls?: Record<string, string>;
  content?: { rendered?: string };
  date_gmt: string;
  status?: string;
}

const basicAuth = (c: WordPressCredentials) => ({
  authorization: `Basic ${Buffer.from(`${c.username}:${c.appPassword}`).toString('base64')}`,
});

export function createWordPressEngagement(http: Http): EngagementAdapter<WordPressCredentials> {
  const call = <T>(request: Parameters<Http>[1]) =>
    Effect.map(http<T>('wordpress', request), (r) => r);

  /** The connected user's id, to tell own comments apart. */
  const me = (c: WordPressCredentials) =>
    Effect.map(
      call<{ id: number }>(
        get(endpoint(c.apiBase, '/wp/v2/users/me', { _fields: 'id' }), { headers: basicAuth(c) }),
      ),
      (r) => r.data.id,
    );

  const toComment = (c: WordPressComment, userId: number | null): RemoteComment => ({
    externalId: String(c.id),
    parentExternalId: c.parent ? String(c.parent) : null,
    authorName: c.author_name || 'Visitor',
    authorAvatarUrl: c.author_avatar_urls?.['48'] ?? null,
    authorId: c.author ? String(c.author) : null,
    text: htmlToText(c.content?.rendered ?? ''),
    likeCount: null,
    likedByMe: false,
    // date_gmt has no zone designator.
    createdAt: new Date(`${c.date_gmt}Z`),
    isOwn: userId !== null && c.author === userId,
    hidden: c.status === 'hold' || c.status === 'unapproved',
  });

  return {
    platform: 'wordpress',
    capabilities: { reply: true, like: false, hide: true, delete: true },
    scopes: [],
    replyParentId: (ref) => ref.externalId,

    listComments: (credentials, { externalPostId }, cursor) =>
      Effect.gen(function* () {
        const userId = yield* me(credentials).pipe(Effect.orElseSucceed(() => null));
        const page = Number(cursor ?? '1');
        const { data, response } = yield* call<WordPressComment[]>(
          get(
            endpoint(credentials.apiBase, '/wp/v2/comments', {
              post: externalPostId,
              per_page: '100',
              page: String(page),
              orderby: 'date_gmt',
              order: 'asc',
              // Held comments too, so the owner can approve them from the inbox.
              status: 'all',
              context: 'edit',
            }),
            { headers: basicAuth(credentials) },
          ),
        );
        const pages = Number(response.headers['x-wp-totalpages'] ?? 1);
        return {
          comments: data.map((c) => toComment(c, userId)),
          next: page < pages ? String(page + 1) : undefined,
        };
      }),

    reply: (credentials, ref, text) =>
      Effect.gen(function* () {
        const { data } = yield* call<WordPressComment>(
          post(endpoint(credentials.apiBase, '/wp/v2/comments'), {
            headers: basicAuth(credentials),
            body: json({
              post: Number(ref.postExternalId),
              parent: Number(ref.externalId),
              content: text,
            }),
          }),
        );
        // The reply exists now: nothing below may fail.
        return { ...toComment(data, data.author), isOwn: true, text };
      }),

    postComment: (credentials, postId, text) =>
      Effect.map(
        call<WordPressComment>(
          post(endpoint(credentials.apiBase, '/wp/v2/comments'), {
            headers: basicAuth(credentials),
            body: json({ post: Number(postId), content: text }),
          }),
        ),
        ({ data }) => ({ ...toComment(data, data.author), isOwn: true, text }),
      ),

    setLike: () =>
      Effect.fail(
        platformError('wordpress', 'WordPress comments cannot be liked.', { retryable: false }),
      ),

    moderate: (credentials, ref, action) =>
      Effect.asVoid(
        call(
          action === 'delete'
            ? del(endpoint(credentials.apiBase, `/wp/v2/comments/${ref.externalId}`), {
                headers: basicAuth(credentials),
              })
            : post(endpoint(credentials.apiBase, `/wp/v2/comments/${ref.externalId}`), {
                headers: basicAuth(credentials),
                // Hidden means "held for moderation"; unhiding approves it.
                body: json({ status: action === 'hide' ? 'hold' : 'approved' }),
              }),
        ),
      ),
  };
}
