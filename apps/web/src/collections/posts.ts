import { queryCollectionOptions } from '@tanstack/query-db-collection';
import { createCollection } from '@tanstack/react-db';
import type { Post, PostChanges } from '@posthub/contract';
import { client } from '../lib/api';
import { queryClient } from '../lib/query-client';

export type { Post, PostTarget } from '@posthub/contract';

/** Statuses the owner sets; the server's publisher moves posts on from `scheduled`. */
const editableStatus = (status: Post['status']) => (status === 'scheduled' ? 'scheduled' : 'draft');

/** Fields the server accepts from the composer. Targets and timestamps are server-owned. */
function editableFields(post: Partial<Post>) {
  const fields: { -readonly [K in keyof PostChanges]: PostChanges[K] } = {};
  if (post.title !== undefined) fields.title = post.title;
  if (post.body !== undefined) fields.body = post.body;
  if (post.link !== undefined) fields.link = post.link;
  if (post.status !== undefined) fields.status = editableStatus(post.status);
  if (post.scheduledAt !== undefined) fields.scheduledAt = post.scheduledAt;
  if (post.accountIds !== undefined) fields.accountIds = post.accountIds;
  if (post.mediaIds !== undefined) fields.mediaIds = post.mediaIds;
  if (post.featuredMediaId !== undefined) fields.featuredMediaId = post.featuredMediaId;
  if (post.thumbnailMediaId !== undefined) fields.thumbnailMediaId = post.thumbnailMediaId;
  if (post.wordpressOptions !== undefined) fields.wordpressOptions = post.wordpressOptions;
  if (post.firstComment !== undefined) fields.firstComment = post.firstComment;
  if (post.pinFirstComment !== undefined) fields.pinFirstComment = post.pinFirstComment;
  return fields;
}

/**
 * TanStack DB collection backed by oRPC.
 * Components read it with `useLiveQuery`; inserts/updates/deletes apply optimistically,
 * then persist through the handlers below and roll back on failure.
 */
export const postsCollection = createCollection(
  queryCollectionOptions({
    id: 'posts',
    queryKey: ['posts'],
    queryFn: () => client.posts.list(),
    queryClient,
    getKey: (post) => post.id,
    // The publisher works in the background; poll so statuses update on their own.
    refetchInterval: 10_000,
    onInsert: async ({ transaction }) => {
      await Promise.all(
        transaction.mutations.map(({ modified }) =>
          client.posts.create({
            id: modified.id,
            title: modified.title,
            ...editableFields(modified),
          }),
        ),
      );
    },
    onUpdate: async ({ transaction }) => {
      await Promise.all(
        transaction.mutations.map(({ original, changes }) =>
          client.posts.update({ id: original.id, changes: editableFields(changes) }),
        ),
      );
    },
    onDelete: async ({ transaction }) => {
      await Promise.all(
        transaction.mutations.map(({ original }) => client.posts.delete({ id: original.id })),
      );
    },
  }),
);
