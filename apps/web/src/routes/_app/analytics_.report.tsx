import { Button, Card, Group, SegmentedControl, Stack, Text, Title } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import dayjs from 'dayjs';
import { useState } from 'react';
import {
  FollowersList,
  isEmpty,
  PlatformTable,
  StatTiles,
  TopPostsTable,
  type Period,
} from '../../components/analytics';
import { api } from '../../lib/api';

export const Route = createFileRoute('/_app/analytics_/report')({ component: ReportPage });

/** The last full week (Mon–Sun) or calendar month. */
function previousPeriod(kind: 'week' | 'month'): Period {
  if (kind === 'month') {
    const start = dayjs().subtract(1, 'month').startOf('month');
    return { from: start.toDate(), to: start.endOf('month').toDate() };
  }
  const monday = dayjs()
    .startOf('day')
    .subtract((dayjs().day() + 6) % 7, 'day');
  const start = monday.subtract(7, 'day');
  return { from: start.toDate(), to: start.add(6, 'day').endOf('day').toDate() };
}

/** A print-friendly summary; "Save as PDF" in the print dialog makes the report file. */
function ReportPage() {
  const [kind, setKind] = useState<'week' | 'month'>('week');
  const [period, setPeriod] = useState(() => previousPeriod('week'));
  const overview = useQuery(api.analytics.overview.queryOptions({ input: period }));
  const top = useQuery(
    api.analytics.topPosts.queryOptions({ input: { ...period, metric: 'engagement', limit: 10 } }),
  );
  const label =
    kind === 'month'
      ? dayjs(period.from).format('MMMM YYYY')
      : `${dayjs(period.from).format('D MMM')} – ${dayjs(period.to).format('D MMM YYYY')}`;

  return (
    <Stack maw={960}>
      <Group justify="space-between" data-print="hide">
        <Button component={Link} to="/analytics" variant="subtle" size="xs">
          ← Analytics
        </Button>
        <Group gap="xs">
          <SegmentedControl
            size="xs"
            value={kind}
            onChange={(value) => {
              const next = value as 'week' | 'month';
              setKind(next);
              setPeriod(previousPeriod(next));
            }}
            data={[
              { value: 'week', label: 'Last week' },
              { value: 'month', label: 'Last month' },
            ]}
          />
          <Button size="xs" onClick={() => window.print()}>
            Print or save as PDF
          </Button>
        </Group>
      </Group>

      <Title order={2}>Social media report: {label}</Title>
      {overview.data && isEmpty(overview.data) ? (
        <Text c="dimmed">No numbers were recorded in this period.</Text>
      ) : (
        overview.data && (
          <>
            <StatTiles overview={overview.data} />
            <Card withBorder>
              <Text fw={600} mb="xs">
                Platforms
              </Text>
              <PlatformTable overview={overview.data} />
            </Card>
            <Card withBorder>
              <Text fw={600} mb="xs">
                Followers
              </Text>
              <FollowersList overview={overview.data} />
            </Card>
            <Card withBorder>
              <Text fw={600} mb="xs">
                Top posts by engagement
              </Text>
              <TopPostsTable posts={top.data ?? []} metric="engagement" />
            </Card>
          </>
        )
      )}
    </Stack>
  );
}
