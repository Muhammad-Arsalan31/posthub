import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { InboxComment } from '@posthub/contract';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { renderRoute } from '../../test/render';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  thread: vi.fn(),
  reply: vi.fn(),
  markRead: vi.fn(),
}));

vi.mock('../../lib/auth-client', () => ({
  authClient: {
    getSession: async () => ({ data: { user: { id: 'u1', email: 'owner@example.com' } } }),
  },
}));

vi.mock('../../lib/api', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../lib/api')>();
  const query = (group: string, name: string, fn: () => Promise<unknown>) => ({
    ...(original.api as unknown as Record<string, Record<string, object>>)[group]![name],
    queryOptions: () => ({ queryKey: ['api', group, name], queryFn: fn }),
  });
  const mutation = (group: string, name: string, fn: (input: unknown) => Promise<unknown>) => ({
    ...(original.api as unknown as Record<string, Record<string, object>>)[group]![name],
    mutationOptions: (options: object) => ({ ...options, mutationFn: fn }),
  });
  return {
    ...original,
    api: {
      ...original.api,
      accounts: {
        ...original.api.accounts,
        list: query('accounts', 'list', async () => [
          {
            id: 'fb',
            platform: 'facebook',
            displayName: 'My Page',
            externalId: 'page',
            status: 'active',
            tokenExpiresAt: null,
            createdAt: new Date(),
            reconnectFor: [],
            engagement: { reply: true, like: true, hide: true, delete: true },
          },
        ]),
      },
      inbox: {
        ...original.api.inbox,
        list: query('inbox', 'list', mocks.list),
        thread: query('inbox', 'thread', mocks.thread),
        unreadCount: query('inbox', 'unreadCount', async () => ({ count: 1 })),
        reply: mutation('inbox', 'reply', mocks.reply),
        markRead: mutation('inbox', 'markRead', mocks.markRead),
      },
      savedReplies: {
        ...original.api.savedReplies,
        list: query('savedReplies', 'list', async () => [
          { id: 's1', title: 'Thanks', body: 'Thank you so much!' },
        ]),
      },
    },
  };
});

const comment = (id: string, text: string, extra: Partial<InboxComment> = {}): InboxComment => ({
  id,
  postId: 'p1',
  postTitle: 'Launch day',
  accountId: 'fb',
  platform: 'facebook',
  externalId: id,
  parentExternalId: null,
  authorName: 'Ann',
  authorAvatarUrl: null,
  text,
  likeCount: 0,
  likedByMe: false,
  hidden: false,
  isOwn: false,
  createdAt: new Date('2030-01-01T10:00:00'),
  read: false,
  archived: false,
  deleted: false,
  actions: [],
  ...extra,
});

beforeEach(() => {
  const root = comment('c1', 'Love this!');
  mocks.list
    .mockReset()
    .mockResolvedValue([{ root, replies: 0, unread: 1, lastActivityAt: root.createdAt }]);
  mocks.thread.mockReset().mockResolvedValue([root]);
  mocks.reply.mockReset().mockResolvedValue({ ok: true });
  mocks.markRead.mockReset().mockResolvedValue({ ok: true });
});

describe('inbox', () => {
  it('shows a conversation, marks it read, and replies with a saved reply', async () => {
    await renderRoute('/inbox');
    // Once in the list, once in the open conversation.
    await waitFor(() => expect(screen.getAllByText('Love this!')).toHaveLength(2));
    await waitFor(() => expect(mocks.markRead).toHaveBeenCalled());
    expect(mocks.markRead.mock.calls[0]![0]).toEqual({ commentIds: ['c1'] });

    const user = userEvent.setup();
    fireEvent.click(screen.getByRole('button', { name: 'Saved replies' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Thanks' }));
    expect((screen.getByLabelText('Reply') as HTMLTextAreaElement).value).toBe(
      'Thank you so much!',
    );
    await user.click(screen.getByRole('button', { name: 'Reply' }));
    await waitFor(() => expect(mocks.reply).toHaveBeenCalled());
    expect(mocks.reply.mock.calls[0]![0]).toEqual({ commentId: 'c1', text: 'Thank you so much!' });
  });
});
