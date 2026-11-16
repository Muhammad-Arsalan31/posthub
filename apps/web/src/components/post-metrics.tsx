import { Badge, Button, Card, Group, NumberInput, Stack, Table, Text, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import type { Account, Post, TargetMetrics } from '@posthub/contract';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import dayjs from 'dayjs';
import { useState } from 'react';
import { api } from '../lib/api';
import { PLATFORM_COLORS, PLATFORM_LABELS } from '../lib/platforms';

const COLUMNS = [
  ['views', 'Views'],
  ['likes', 'Likes'],
  ['comments', 'Comments'],
  ['shares', 'Shares'],
] as const;

const format = (value: number | null | undefined) =>
  value === null || value === undefined ? '–' : value.toLocaleString();

/** Short totals for the posts list: "120 views · 7 likes". */
export function totalsText(totals: {
  views: number | null;
  likes: number | null;
  comments: number | null;
}) {
  return [
    totals.views !== null && `${totals.views.toLocaleString()} views`,
    totals.likes !== null && `${totals.likes.toLocaleString()} likes`,
    totals.comments !== null && `${totals.comments.toLocaleString()} comments`,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** Numbers per published target, with a refresh button and hand entry for TikTok. */
export function PostMetrics(props: { post: Post; accounts: Account[] }) {
  const queryClient = useQueryClient();
  const input = { postId: props.post.id };
  const metrics = useQuery(api.metrics.forPost.queryOptions({ input, refetchInterval: 60_000 }));
  const refresh = useMutation(
    api.metrics.refresh.mutationOptions({
      onSuccess: () =>
        notifications.show({ message: 'Numbers will be read again within a minute.' }),
    }),
  );
  const accountsById = new Map(props.accounts.map((a) => [a.id, a]));
  const published = props.post.targets.filter((t) => t.status === 'published');
  if (!published.length) return null;

  const rows = published.map((target) => ({
    target,
    account: accountsById.get(target.socialAccountId),
    metrics: metrics.data?.find((m) => m.targetId === target.id),
  }));

  return (
    <Card withBorder>
      <Stack gap="sm">
        <Group justify="space-between">
          <Title order={5}>Performance</Title>
          <Button
            size="xs"
            variant="default"
            loading={refresh.isPending}
            onClick={() => refresh.mutate(input)}
          >
            Refresh
          </Button>
        </Group>
        <Table>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Account</Table.Th>
              {COLUMNS.map(([, label]) => (
                <Table.Th key={label} ta="right">
                  {label}
                </Table.Th>
              ))}
              <Table.Th>Updated</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {rows.map(({ target, account, metrics: m }) => (
              <Table.Tr key={target.id}>
                <Table.Td>
                  <Group gap={6} wrap="nowrap">
                    {account && (
                      <Badge size="xs" variant="light" color={PLATFORM_COLORS[account.platform]}>
                        {PLATFORM_LABELS[account.platform]}
                      </Badge>
                    )}
                    <Text size="sm" truncate>
                      {account?.displayName ?? 'Removed account'}
                    </Text>
                  </Group>
                </Table.Td>
                {COLUMNS.map(([key, label]) => (
                  <Table.Td key={label} ta="right">
                    {format(m?.latest?.[key])}
                  </Table.Td>
                ))}
                <Table.Td>
                  <UpdatedCell metrics={m} />
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
        {rows
          .filter(({ metrics: m }) => m && !m.automatic)
          .map(({ target, account, metrics: m }) => (
            <ManualEntry
              key={target.id}
              targetId={target.id}
              label={account ? `${PLATFORM_LABELS[account.platform]}: ${account.displayName}` : ''}
              latest={m!.latest}
              onSaved={() => void queryClient.invalidateQueries({ queryKey: api.metrics.key() })}
            />
          ))}
      </Stack>
    </Card>
  );
}

function UpdatedCell({ metrics }: { metrics: TargetMetrics | undefined }) {
  if (!metrics) return null;
  if (metrics.lastError) {
    return (
      <Text size="xs" c="red" title={metrics.lastError}>
        Could not read numbers
      </Text>
    );
  }
  if (!metrics.automatic) {
    return (
      <Text size="xs" c="dimmed">
        {metrics.latest
          ? `Entered ${dayjs(metrics.latest.capturedAt).format('D MMM')}`
          : 'Enter by hand'}
      </Text>
    );
  }
  return (
    <Text size="xs" c="dimmed">
      {metrics.latest
        ? dayjs(metrics.latest.capturedAt).format('D MMM, HH:mm')
        : metrics.nextRunAt
          ? `First read ${dayjs(metrics.nextRunAt).format('HH:mm')}`
          : 'Not read yet'}
    </Text>
  );
}

type Counts = Partial<Record<(typeof COLUMNS)[number][0], number | null>>;

function ManualEntry(props: {
  targetId: string;
  label: string;
  latest: TargetMetrics['latest'];
  onSaved: () => void;
}) {
  const [values, setValues] = useState<Counts>({
    views: props.latest?.views ?? null,
    likes: props.latest?.likes ?? null,
    comments: props.latest?.comments ?? null,
    shares: props.latest?.shares ?? null,
  });
  const save = useMutation(
    api.metrics.setManual.mutationOptions({
      onSuccess: () => {
        notifications.show({ color: 'green', message: 'Numbers saved.' });
        props.onSaved();
      },
      onError: (error) => notifications.show({ color: 'red', message: error.message }),
    }),
  );
  return (
    <Stack gap={4}>
      <Text size="xs" c="dimmed">
        {props.label}: PostHub can't read these numbers. Copy them from the app.
      </Text>
      <Group align="flex-end" gap="xs">
        {COLUMNS.map(([key, label]) => (
          <NumberInput
            key={key}
            size="xs"
            w={100}
            label={label}
            min={0}
            allowDecimal={false}
            value={values[key] ?? ''}
            onChange={(value) =>
              setValues((v) => ({ ...v, [key]: typeof value === 'number' ? value : null }))
            }
          />
        ))}
        <Button
          size="xs"
          loading={save.isPending}
          onClick={() => save.mutate({ targetId: props.targetId, ...values })}
        >
          Save
        </Button>
      </Group>
    </Stack>
  );
}
