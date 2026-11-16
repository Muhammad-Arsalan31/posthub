import {
  Alert,
  Box,
  Button,
  Card,
  Group,
  MultiSelect,
  Select,
  Stack,
  Table,
  Text,
  Title,
  Tooltip,
} from '@mantine/core';
import { BarChart, LineChart } from '@mantine/charts';
import { notifications } from '@mantine/notifications';
import {
  ANALYTICS_METRICS,
  PLATFORMS,
  type AnalyticsMetric,
  type BestTimeCell,
} from '@posthub/contract';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import dayjs from 'dayjs';
import { useState } from 'react';
import {
  FollowersList,
  formatNumber,
  formatPercent,
  isEmpty,
  lastDays,
  METRIC_LABELS,
  platformColor,
  PlatformTable,
  StatTiles,
  TopPostsTable,
} from '../../components/analytics';
import { api, client } from '../../lib/api';
import { PLATFORM_LABELS } from '../../lib/platforms';

export const Route = createFileRoute('/_app/analytics')({ component: AnalyticsPage });

const RANGES = [
  { value: '7', label: 'Last 7 days' },
  { value: '30', label: 'Last 30 days' },
  { value: '90', label: 'Last 90 days' },
  { value: '365', label: 'Last 12 months' },
];
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
/** Display rows Monday first; values are 0 = Sunday like the API. */
const WEEKDAY_VALUES = [1, 2, 3, 4, 5, 6, 0];
const CONTENT_LABELS = { video: 'Video', image: 'Image', link: 'Link', text: 'Text only' };

function AnalyticsPage() {
  const [days, setDays] = useState('30');
  const [accountIds, setAccountIds] = useState<string[]>([]);
  const [metric, setMetric] = useState<AnalyticsMetric>('views');
  // Fixed once per range choice, so queries don't refetch on every render.
  const [period, setPeriod] = useState(() => lastDays(30));
  const range = { ...period, ...(accountIds.length ? { accountIds } : {}) };
  const groupBy = Number(days) > 60 ? 'week' : 'day';

  const accounts = useQuery(api.accounts.list.queryOptions());
  const overview = useQuery(
    api.analytics.overview.queryOptions({ input: range, refetchInterval: 60_000 }),
  );
  const series = useQuery(
    api.analytics.timeseries.queryOptions({
      input: { ...range, metric, groupBy },
      refetchInterval: 60_000,
    }),
  );
  const top = useQuery(
    api.analytics.topPosts.queryOptions({
      input: { ...range, metric, limit: 10 },
      refetchInterval: 60_000,
    }),
  );
  const contentTypes = useQuery(api.analytics.byContentType.queryOptions({ input: range }));

  const exportUrl = `/analytics/export.csv?${new URLSearchParams([
    ['from', period.from.toISOString()],
    ['to', period.to.toISOString()],
    ...accountIds.map((id) => ['accountId', id]),
  ]).toString()}`;

  const platforms = PLATFORMS.filter((p) => series.data?.platforms.includes(p));
  const chartData = (series.data?.points ?? []).map((point) => ({
    bucket: dayjs(point.bucket).format(groupBy === 'week' ? '[w/c] D MMM' : 'D MMM'),
    ...Object.fromEntries(platforms.map((p) => [p, point.values[p] ?? 0])),
  }));
  const barData = (overview.data?.byPlatform ?? []).flatMap(({ platform, totals }) => {
    const value = totals.find((t) => t.metric === metric)?.value;
    return value === null || value === undefined
      ? []
      : [{ platform: PLATFORM_LABELS[platform], value, color: platformColor(platform) }];
  });

  return (
    <Stack maw={1200}>
      <Group justify="space-between">
        <Title order={2}>Analytics</Title>
        <Group gap="xs">
          <Button component="a" href={exportUrl} variant="default" size="xs">
            Download CSV
          </Button>
          <Button component={Link} to="/analytics/report" variant="default" size="xs">
            Printable report
          </Button>
        </Group>
      </Group>

      <Group gap="xs" align="flex-end">
        <Select
          label="Period"
          size="xs"
          value={days}
          allowDeselect={false}
          onChange={(value) => {
            setDays(value ?? '30');
            setPeriod(lastDays(Number(value ?? 30)));
          }}
          data={RANGES}
          w={160}
        />
        <MultiSelect
          label="Accounts"
          size="xs"
          placeholder={accountIds.length ? undefined : 'All accounts'}
          value={accountIds}
          onChange={setAccountIds}
          data={(accounts.data ?? []).map((a) => ({
            value: a.id,
            label: `${PLATFORM_LABELS[a.platform]}: ${a.displayName}`,
          }))}
          clearable
          w={320}
        />
        <Select
          label="Chart metric"
          size="xs"
          value={metric}
          allowDeselect={false}
          onChange={(value) => setMetric((value ?? 'views') as AnalyticsMetric)}
          data={ANALYTICS_METRICS.map((m) => ({ value: m, label: METRIC_LABELS[m] }))}
          w={160}
        />
      </Group>

      {overview.data && isEmpty(overview.data) ? (
        <Alert color="blue" title="No numbers yet">
          Numbers appear here after your first posts are published and PostHub has read them from
          the platforms (within about 15 minutes of publishing, then regularly). TikTok numbers can
          be typed in on the post's page.
        </Alert>
      ) : (
        overview.data && (
          <>
            <StatTiles overview={overview.data} />

            <Card withBorder>
              <Stack gap="sm">
                <Text fw={600}>
                  {METRIC_LABELS[metric]} gained per {groupBy}
                </Text>
                {platforms.length ? (
                  <LineChart
                    h={280}
                    data={chartData}
                    dataKey="bucket"
                    series={platforms.map((p) => ({
                      name: p,
                      label: PLATFORM_LABELS[p],
                      color: platformColor(p),
                    }))}
                    curveType="monotone"
                    strokeWidth={2}
                    withDots={false}
                    withLegend={platforms.length > 1}
                    gridAxis="y"
                    valueFormatter={(v) => formatNumber(v)}
                  />
                ) : (
                  <Text size="sm" c="dimmed">
                    No platform reported {METRIC_LABELS[metric].toLowerCase()} in this period.
                  </Text>
                )}
              </Stack>
            </Card>

            <Group align="stretch" grow wrap="wrap">
              <Card withBorder miw={320}>
                <Stack gap="sm">
                  <Text fw={600}>{METRIC_LABELS[metric]} by platform</Text>
                  {barData.length ? (
                    <BarChart
                      h={220}
                      data={barData}
                      dataKey="platform"
                      series={[{ name: 'value', label: METRIC_LABELS[metric] }]}
                      getBarColor={(_, entry) => (entry as { color: string }).color}
                      gridAxis="y"
                      barProps={{ radius: [4, 4, 0, 0] }}
                      valueFormatter={(v) => formatNumber(v)}
                    />
                  ) : (
                    <Text size="sm" c="dimmed">
                      No platform reported this metric.
                    </Text>
                  )}
                </Stack>
              </Card>
              <Card withBorder miw={320}>
                <Stack gap="sm">
                  <Text fw={600}>Followers</Text>
                  {overview.data.followers.length ? (
                    <FollowersList overview={overview.data} />
                  ) : (
                    <Text size="sm" c="dimmed">
                      Follower counts appear after PostHub has read your accounts once.
                    </Text>
                  )}
                </Stack>
              </Card>
            </Group>

            <Card withBorder>
              <Stack gap="sm">
                <Text fw={600}>Platforms side by side</Text>
                <Text size="xs" c="dimmed">
                  Platforms count differently (views on YouTube, reach on Facebook), so totals are
                  never added across metrics.
                </Text>
                <PlatformTable overview={overview.data} />
              </Stack>
            </Card>

            <Card withBorder>
              <Stack gap="sm">
                <Text fw={600}>Top posts by {METRIC_LABELS[metric].toLowerCase()}</Text>
                <TopPostsTable posts={top.data ?? []} metric={metric} />
              </Stack>
            </Card>

            <Card withBorder>
              <Stack gap="sm">
                <Text fw={600}>By kind of post</Text>
                <Table>
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>Kind</Table.Th>
                      <Table.Th ta="right">Posts</Table.Th>
                      <Table.Th ta="right">Avg. engagement</Table.Th>
                      <Table.Th ta="right">Avg. engagement rate</Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {(contentTypes.data ?? []).map((row) => (
                      <Table.Tr key={row.contentType}>
                        <Table.Td>{CONTENT_LABELS[row.contentType]}</Table.Td>
                        <Table.Td ta="right">{row.posts}</Table.Td>
                        <Table.Td ta="right">{formatNumber(row.averageEngagement)}</Table.Td>
                        <Table.Td ta="right">{formatPercent(row.averageRate)}</Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              </Stack>
            </Card>

            <BestTimes accountIds={accountIds} />
          </>
        )
      )}
    </Stack>
  );
}

/** Sequential blue step (1..6) for a rate, relative to the best cell. */
const step = (rate: number, max: number) => Math.max(1, Math.ceil((rate / max) * 6));

function BestTimes(props: { accountIds: string[] }) {
  const queryClient = useQueryClient();
  const input = props.accountIds.length ? { accountIds: props.accountIds } : {};
  const best = useQuery(api.analytics.bestTimes.queryOptions({ input }));
  const cells = best.data?.cells ?? [];
  const max = Math.max(0, ...cells.map((c) => c.rate));
  const hours = [...new Set(cells.map((c) => c.hour))].sort((a, b) => a - b);
  const cellAt = (weekday: number, hour: number) =>
    cells.find((c) => c.weekday === weekday && c.hour === hour);
  // The best-performing times backed by enough posts.
  const recommended = cells
    .filter((c) => !c.lowConfidence)
    .sort((a, b) => b.rate - a.rate)
    .slice(0, 3);

  const saveTimes = useMutation({
    mutationFn: async (picks: BestTimeCell[]) => {
      const current = await client.queue.slots();
      const slots = [...current.slots];
      for (const pick of picks) {
        const minuteOfDay = pick.hour * 60;
        if (!slots.some((s) => s.weekday === pick.weekday && s.minuteOfDay === minuteOfDay)) {
          slots.push({ weekday: pick.weekday, minuteOfDay, socialAccountId: null });
        }
      }
      return client.queue.saveSlots({ timezone: current.timezone, slots });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: api.queue.key() });
      notifications.show({ color: 'green', message: 'Added to your posting times in Settings.' });
    },
    onError: (error) => notifications.show({ color: 'red', message: error.message }),
  });

  return (
    <Card withBorder>
      <Stack gap="sm">
        <Group justify="space-between">
          <Text fw={600}>Best times to post</Text>
          {recommended.length > 0 && (
            <Button
              size="xs"
              variant="light"
              loading={saveTimes.isPending}
              onClick={() => saveTimes.mutate(recommended)}
            >
              Use the top {recommended.length} as posting times
            </Button>
          )}
        </Group>
        <Text size="xs" c="dimmed">
          Average engagement rate by when posts went out
          {best.data ? ` (${best.data.timezone})` : ''}. Darker is better; outlined cells come from
          fewer than 3 posts, so treat them as hints.
        </Text>
        {!cells.length ? (
          <Text size="sm" c="dimmed">
            Needs published posts with reach or views. Check back after a few weeks of posting.
          </Text>
        ) : (
          <Box style={{ overflowX: 'auto' }}>
            <Box
              role="table"
              aria-label="Engagement rate by weekday and hour"
              style={{
                display: 'grid',
                gridTemplateColumns: `48px repeat(${hours.length}, minmax(36px, 1fr))`,
                gap: 2,
              }}
            >
              <div />
              {hours.map((h) => (
                <Text key={h} size="xs" c="dimmed" ta="center">
                  {String(h).padStart(2, '0')}
                </Text>
              ))}
              {WEEKDAY_VALUES.map((weekday, row) => (
                <HeatmapRow
                  key={weekday}
                  label={WEEKDAYS[row]!}
                  cells={hours.map((h) => cellAt(weekday, h))}
                  max={max}
                />
              ))}
            </Box>
          </Box>
        )}
      </Stack>
    </Card>
  );
}

function HeatmapRow(props: { label: string; cells: Array<BestTimeCell | undefined>; max: number }) {
  return (
    <>
      <Text size="xs" c="dimmed">
        {props.label}
      </Text>
      {props.cells.map((cell, i) =>
        cell ? (
          <Tooltip
            key={i}
            label={`${props.label} ${String(cell.hour).padStart(2, '0')}:00 · ${formatPercent(cell.rate)} · ${cell.posts} post${cell.posts === 1 ? '' : 's'}`}
          >
            <Box
              role="cell"
              aria-label={`${props.label} ${cell.hour}:00, ${formatPercent(cell.rate)} from ${cell.posts} posts`}
              h={28}
              style={{
                borderRadius: 4,
                background: cell.lowConfidence
                  ? 'transparent'
                  : `var(--viz-seq-${step(cell.rate, props.max)})`,
                border: cell.lowConfidence
                  ? `2px solid var(--viz-seq-${step(cell.rate, props.max)})`
                  : undefined,
              }}
            />
          </Tooltip>
        ) : (
          <Box
            key={i}
            role="cell"
            h={28}
            style={{ borderRadius: 4, background: 'var(--mantine-color-default-hover)' }}
          />
        ),
      )}
    </>
  );
}
