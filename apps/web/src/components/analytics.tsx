// Pieces shared by the analytics page and the printable report.
import { Anchor, Badge, Card, Group, SimpleGrid, Stack, Table, Text } from '@mantine/core';
import type {
  AnalyticsMetric,
  AnalyticsOverview,
  MetricTotal,
  Platform,
  TopPost,
} from '@posthub/contract';
import { Link } from '@tanstack/react-router';
import dayjs from 'dayjs';
import { PLATFORM_LABELS } from '../lib/platforms';

export const METRIC_LABELS: Record<AnalyticsMetric, string> = {
  views: 'Views',
  reach: 'Reach',
  likes: 'Likes',
  comments: 'Comments',
  shares: 'Shares',
  saves: 'Saves',
  clicks: 'Clicks',
  engagement: 'Engagement',
};

/** Tiles on the overview, in reading order. */
export const TILE_METRICS: AnalyticsMetric[] = [
  'views',
  'reach',
  'engagement',
  'likes',
  'comments',
  'shares',
];

/** Each platform's fixed chart color (chart-colors.css). */
export const platformColor = (platform: Platform) => `var(--viz-${platform})`;

export const formatNumber = (value: number | null | undefined) =>
  value === null || value === undefined ? '–' : Math.round(value).toLocaleString();

export const formatPercent = (value: number | null | undefined) =>
  value === null || value === undefined ? '–' : `${(value * 100).toFixed(1)}%`;

export interface Period {
  from: Date;
  to: Date;
}

/** The last `days` days, ending now. */
export const lastDays = (days: number): Period => ({
  from: dayjs()
    .subtract(days - 1, 'day')
    .startOf('day')
    .toDate(),
  to: dayjs().endOf('day').toDate(),
});

const platformsNote = (platforms: Platform[]) =>
  platforms.length ? `From ${platforms.map((p) => PLATFORM_LABELS[p]).join(', ')}` : 'Not reported';

function change(current: number | null, previous: number | null) {
  if (current === null || previous === null || previous === 0) return null;
  return (current - previous) / previous;
}

/** Headline numbers with the change against the previous period of the same length. */
export function StatTiles(props: { overview: AnalyticsOverview }) {
  const byMetric = (list: MetricTotal[], metric: AnalyticsMetric) =>
    list.find((t) => t.metric === metric);
  return (
    <SimpleGrid cols={{ base: 2, sm: 3, lg: 6 }}>
      {TILE_METRICS.map((metric) => {
        const current = byMetric(props.overview.totals, metric);
        const delta = change(
          current?.value ?? null,
          byMetric(props.overview.previous, metric)?.value ?? null,
        );
        return (
          <Card key={metric} withBorder padding="sm">
            <Text size="xs" c="dimmed">
              {METRIC_LABELS[metric]}
            </Text>
            <Text fw={700} size="xl">
              {formatNumber(current?.value)}
            </Text>
            {delta !== null && (
              <Text size="xs" c="dimmed">
                {delta >= 0 ? '▲' : '▼'} {Math.abs(delta * 100).toFixed(0)}% vs previous period
              </Text>
            )}
            <Text size="xs" c="dimmed" truncate>
              {platformsNote(current?.platforms ?? [])}
            </Text>
          </Card>
        );
      })}
    </SimpleGrid>
  );
}

/** Totals per platform, side by side. Different platforms report different metrics. */
export function PlatformTable(props: { overview: AnalyticsOverview }) {
  const metrics: AnalyticsMetric[] = [
    'views',
    'reach',
    'likes',
    'comments',
    'shares',
    'engagement',
  ];
  return (
    <Table.ScrollContainer minWidth={560}>
      <Table>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Platform</Table.Th>
            {metrics.map((m) => (
              <Table.Th key={m} ta="right">
                {METRIC_LABELS[m]}
              </Table.Th>
            ))}
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {props.overview.byPlatform.map(({ platform, totals }) => (
            <Table.Tr key={platform}>
              <Table.Td>
                <Group gap={6} wrap="nowrap">
                  <span
                    aria-hidden
                    style={{
                      width: 10,
                      height: 10,
                      borderRadius: 2,
                      background: platformColor(platform),
                    }}
                  />
                  {PLATFORM_LABELS[platform]}
                </Group>
              </Table.Td>
              {metrics.map((m) => (
                <Table.Td key={m} ta="right">
                  {formatNumber(totals.find((t) => t.metric === m)?.value)}
                </Table.Td>
              ))}
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  );
}

export function TopPostsTable(props: { posts: TopPost[]; metric: AnalyticsMetric }) {
  if (!props.posts.length) {
    return (
      <Text size="sm" c="dimmed">
        No published posts with {METRIC_LABELS[props.metric].toLowerCase()} in this period.
      </Text>
    );
  }
  return (
    <Table>
      <Table.Thead>
        <Table.Tr>
          <Table.Th>Post</Table.Th>
          <Table.Th>Published</Table.Th>
          <Table.Th ta="right">{METRIC_LABELS[props.metric]}</Table.Th>
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {props.posts.map((post) => (
          <Table.Tr key={post.postId}>
            <Table.Td>
              <Stack gap={2}>
                <Anchor
                  size="sm"
                  c="inherit"
                  renderRoot={(rootProps) => (
                    <Link {...rootProps} to="/posts/$postId" params={{ postId: post.postId }} />
                  )}
                >
                  {post.title}
                </Anchor>
                <Group gap={4}>
                  {post.platforms.map((p) => (
                    <Badge key={p} size="xs" variant="outline" color="gray">
                      {PLATFORM_LABELS[p]}
                    </Badge>
                  ))}
                </Group>
              </Stack>
            </Table.Td>
            <Table.Td>{dayjs(post.publishedAt).format('D MMM YYYY')}</Table.Td>
            <Table.Td ta="right">{formatNumber(post.value)}</Table.Td>
          </Table.Tr>
        ))}
      </Table.Tbody>
    </Table>
  );
}

export function FollowersList(props: { overview: AnalyticsOverview }) {
  if (!props.overview.followers.length) return null;
  return (
    <Table>
      <Table.Thead>
        <Table.Tr>
          <Table.Th>Account</Table.Th>
          <Table.Th ta="right">Followers</Table.Th>
          <Table.Th ta="right">Change</Table.Th>
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {props.overview.followers.map((f) => (
          <Table.Tr key={f.accountId}>
            <Table.Td>
              {PLATFORM_LABELS[f.platform]}: {f.displayName}
            </Table.Td>
            <Table.Td ta="right">{formatNumber(f.followers)}</Table.Td>
            <Table.Td ta="right">
              {f.change === null ? '–' : `${f.change >= 0 ? '+' : ''}${f.change.toLocaleString()}`}
            </Table.Td>
          </Table.Tr>
        ))}
      </Table.Tbody>
    </Table>
  );
}

/** True when nothing has been measured yet (a new install). */
export const isEmpty = (overview: AnalyticsOverview) =>
  overview.totals.every((t) => t.value === null) &&
  overview.previous.every((t) => t.value === null) &&
  !overview.followers.length;
