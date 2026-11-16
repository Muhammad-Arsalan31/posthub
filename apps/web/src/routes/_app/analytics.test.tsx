import { screen } from '@testing-library/react';
import type { AnalyticsOverview } from '@posthub/contract';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { renderRoute } from '../../test/render';

const mocks = vi.hoisted(() => ({ overview: vi.fn() }));

vi.mock('../../lib/auth-client', () => ({
  authClient: {
    getSession: async () => ({ data: { user: { id: 'u1', email: 'owner@example.com' } } }),
  },
}));

vi.mock('../../lib/api', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../lib/api')>();
  const fixed = (name: string, fn: () => Promise<unknown>) => ({
    ...(original.api.analytics as Record<string, object>)[name],
    queryOptions: () => ({ queryKey: ['analytics', name], queryFn: fn }),
  });
  return {
    ...original,
    api: {
      ...original.api,
      accounts: {
        ...original.api.accounts,
        list: {
          ...original.api.accounts.list,
          queryOptions: () => ({ queryKey: ['a'], queryFn: async () => [] }),
        },
      },
      analytics: {
        ...original.api.analytics,
        overview: fixed('overview', mocks.overview),
        timeseries: fixed('timeseries', async () => ({ platforms: [], points: [] })),
        topPosts: fixed('topPosts', async () => []),
        byContentType: fixed('byContentType', async () => []),
        bestTimes: fixed('bestTimes', async () => ({ timezone: 'UTC', cells: [] })),
      },
    },
  };
});

const metrics = [
  'views',
  'reach',
  'likes',
  'comments',
  'shares',
  'saves',
  'clicks',
  'engagement',
] as const;
const totals = (values: Partial<Record<(typeof metrics)[number], number>>) =>
  metrics.map((metric) => ({
    metric,
    value: values[metric] ?? null,
    platforms: values[metric] === undefined ? [] : (['youtube'] as const).slice(),
  }));

const overview = (
  current: Parameters<typeof totals>[0],
  previous: Parameters<typeof totals>[0],
): AnalyticsOverview => ({
  totals: totals(current),
  previous: totals(previous),
  byPlatform: [],
  followers: [],
});

beforeEach(() => {
  mocks.overview.mockReset();
});

describe('analytics page', () => {
  it('explains where numbers come from on a new install', async () => {
    mocks.overview.mockResolvedValue(overview({}, {}));
    await renderRoute('/analytics');
    expect(await screen.findByText('No numbers yet', {}, { timeout: 15_000 })).toBeTruthy();
  });

  it('shows totals with the change against the previous period', async () => {
    mocks.overview.mockResolvedValue(overview({ views: 1500, likes: 30 }, { views: 1000 }));
    await renderRoute('/analytics');
    expect(await screen.findByText('1,500')).toBeTruthy();
    expect(screen.getByText(/▲ 50% vs previous period/)).toBeTruthy();
    expect(screen.getAllByText('From YouTube').length).toBeGreaterThan(0);
  });
});
