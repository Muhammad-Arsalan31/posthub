import { queryCollectionOptions } from '@tanstack/query-db-collection';
import { createCollection } from '@tanstack/react-db';
import { client } from '../lib/orpc';
import { queryClient } from '../lib/query-client';

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
    onInsert: async ({ transaction }) => {
      await Promise.all(
        transaction.mutations.map(({ modified }) =>
          client.posts.create({
            id: modified.id,
            title: modified.title,
            body: modified.body,
            status: modified.status,
            scheduledAt: modified.scheduledAt,
          }),
        ),
      );
    },
    onUpdate: async ({ transaction }) => {
      await Promise.all(
        transaction.mutations.map(({ original, changes }) =>
          client.posts.update({ id: original.id, changes }),
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
