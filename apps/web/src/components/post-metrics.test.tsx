import { screen } from '@testing-library/react';
import type { Post } from '@posthub/contract';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { renderRoute } from '../test/render';

const mocks = vi.hoisted(() => ({ list: vi.fn(), forPost: vi.fn() }));

vi.mock('../lib/auth-client', () => ({
  authClient: {
    getSession: async () => ({ data: { user: { id: 'u1', email: 'owner@example.com' } } }),
  },
}));

vi.mock('../lib/api', async (importOriginal) => {
  const original = await importOriginal<typeof import('../lib/api')>();
  const fixed = (key: readonly unknown[], fn: () => Promise<unknown>) => ({
    queryKey: key,
    queryFn: fn,
  });
  const account = (id: string, platform: string, displayName: string) => ({
    id,
    platform,
    displayName,
    externalId: id,
    status: 'active',
    tokenExpiresAt: null,
    createdAt: new Date(),
    reconnectFor: [],
  });
  return {
    ...original,
    client: { ...original.client, posts: { ...original.client.posts, list: mocks.list } },
    api: {
      ...original.api,
      accounts: {
        ...original.api.accounts,
        list: {
          ...original.api.accounts.list,
          queryOptions: () =>
            fixed(['accounts'], async () => [
              account('yt', 'youtube', 'My channel'),
              account('tt', 'tiktok', 'My TikTok'),
            ]),
        },
      },
      metrics: {
        ...original.api.metrics,
        forPost: {
          ...original.api.metrics.forPost,
          queryOptions: () => fixed(['metrics'], mocks.forPost),
        },
      },
    },
  };
});

const target = (id: string, socialAccountId: string) => ({
  id,
  postId: 'p1',
  socialAccountId,
  status: 'published' as const,
  attempts: 1,
  lastError: null,
  externalUrl: null,
  publishedAt: new Date(),
  nextAttemptAt: null,
  firstCommentStatus: 'none' as const,
  firstCommentError: null,
  pinnedAt: null,
});

const published: Post = {
  id: 'p1',
  userId: 'u1',
  title: 'Launch',
  body: '',
  link: null,
  featuredMediaId: null,
  thumbnailMediaId: null,
  wordpressOptions: null,
  firstComment: null,
  pinFirstComment: false,
  status: 'published',
  scheduledAt: new Date(),
  createdAt: new Date(),
  updatedAt: new Date(),
  accountIds: ['yt', 'tt'],
  mediaIds: [],
  targets: [target('t-yt', 'yt'), target('t-tt', 'tt')],
};

const snapshot = (views: number) => ({
  capturedAt: new Date('2030-01-01T10:00:00'),
  source: 'platform' as const,
  views,
  reach: null,
  likes: 12,
  comments: null,
  shares: null,
  saves: null,
  clicks: null,
  watchTimeSec: null,
});

beforeEach(() => {
  mocks.list.mockReset().mockResolvedValue([published]);
  mocks.forPost.mockReset().mockResolvedValue([
    {
      targetId: 't-yt',
      latest: snapshot(1500),
      series: [],
      automatic: true,
      lastRunAt: null,
      nextRunAt: null,
      lastError: null,
    },
    {
      targetId: 't-tt',
      latest: null,
      series: [],
      automatic: false,
      lastRunAt: null,
      nextRunAt: null,
      lastError: null,
    },
  ]);
});

describe('post metrics', () => {
  it('shows numbers per account on a published post, and hand entry for TikTok', async () => {
    await renderRoute('/posts/p1');
    expect(await screen.findByText('Performance')).toBeTruthy();
    expect(await screen.findByText('1,500')).toBeTruthy();
    expect(screen.getByText('12')).toBeTruthy();
    expect(screen.getByText(/TikTok: My TikTok: PostHub can't read these numbers/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeTruthy();
  });
});
