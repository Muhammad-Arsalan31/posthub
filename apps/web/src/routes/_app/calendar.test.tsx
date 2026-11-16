import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { Post } from '@posthub/contract';
import dayjs from 'dayjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { renderRoute } from '../../test/render';

const mocks = vi.hoisted(() => ({ list: vi.fn(), update: vi.fn() }));

vi.mock('../../lib/auth-client', () => ({
  authClient: {
    getSession: async () => ({ data: { user: { id: 'u1', email: 'owner@example.com' } } }),
  },
}));

vi.mock('../../lib/api', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../lib/api')>();
  const fixed = (key: readonly unknown[], value: unknown) => ({
    queryKey: key,
    queryFn: async () => value,
  });
  return {
    ...original,
    client: {
      ...original.client,
      posts: { ...original.client.posts, list: mocks.list, update: mocks.update },
    },
    api: {
      ...original.api,
      accounts: {
        ...original.api.accounts,
        list: { ...original.api.accounts.list, queryOptions: () => fixed(['accounts'], []) },
      },
      queue: {
        ...original.api.queue,
        slots: {
          ...original.api.queue.slots,
          queryOptions: () => fixed(['queue'], { timezone: 'UTC', slots: [] }),
        },
      },
    },
  };
});

// The calendar opens on the current month; pin it so the future-only rule is stable.
const NOW = new Date('2030-01-10T12:00:00');
const base = dayjs('2030-01-15T10:00:00');
const post = (id: string, status: Post['status'], scheduledAt: Date | null): Post => ({
  id,
  userId: 'u1',
  title: `Post ${id}`,
  body: '',
  link: null,
  featuredMediaId: null,
  thumbnailMediaId: null,
  wordpressOptions: null,
  firstComment: null,
  pinFirstComment: false,
  status,
  scheduledAt,
  createdAt: new Date(),
  updatedAt: new Date(),
  accountIds: [],
  mediaIds: [],
  targets: [],
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  mocks.list
    .mockReset()
    .mockResolvedValue([
      post('a', 'scheduled', base.toDate()),
      post('b', 'published', base.add(1, 'day').toDate()),
      post('c', 'draft', null),
    ]);
  mocks.update.mockReset().mockImplementation(async ({ id }) => ({ id }));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('calendar', () => {
  // Published posts can't move; the Unscheduled list is draggable onto the calendar.
  it('shows posts on their day and drafts without a date in the side list', async () => {
    await renderRoute('/calendar');
    expect(await screen.findByText('Post a')).toBeTruthy();
    expect(screen.getByText('Post b')).toBeTruthy();
    expect(screen.getByText('Post c').closest('[draggable="true"]')).toBeTruthy();
    expect(screen.getByText('Post b').closest('[draggable="true"]')).toBeNull();
    expect(screen.getByText('Post a').closest('[draggable="true"]')).toBeTruthy();
  });

  it('moves a post dropped on another day, keeping its time', async () => {
    await renderRoute('/calendar');
    const event = (await screen.findByText('Post a')).closest('button')!;
    const target = base.add(3, 'day');
    const store = new Map<string, string>();
    const dataTransfer = {
      setData: (k: string, v: string) => store.set(k, v),
      getData: (k: string) => store.get(k) ?? '',
      get types() {
        return [...store.keys()];
      },
      effectAllowed: 'move',
      dropEffect: 'move',
      setDragImage: () => {},
    };
    const day = screen.getByRole('button', { name: target.format('MMMM D, YYYY') });
    fireEvent.dragStart(event, { dataTransfer });
    fireEvent.dragEnter(day, { dataTransfer });
    fireEvent.dragOver(day, { dataTransfer });
    fireEvent.drop(day, { dataTransfer });
    await waitFor(() => expect(mocks.update).toHaveBeenCalled());
    expect(mocks.update.mock.calls[0]![0]).toEqual({
      id: 'a',
      changes: { scheduledAt: target.toDate() },
    });
  });
});
