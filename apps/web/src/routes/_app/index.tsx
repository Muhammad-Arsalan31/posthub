import {
  ActionIcon,
  Anchor,
  Badge,
  Button,
  Card,
  Center,
  CopyButton,
  Group,
  Loader,
  Menu,
  SegmentedControl,
  Stack,
  Text,
  Title,
  Tooltip,
} from '@mantine/core';
import { modals } from '@mantine/modals';
import { notifications } from '@mantine/notifications';
import { useQuery } from '@tanstack/react-query';
import { useLiveQuery } from '@tanstack/react-db';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import dayjs from 'dayjs';
import { useState } from 'react';
import { postsCollection, type Post, type PostTarget } from '../../collections/posts';
import { bodyToText } from '../../lib/body';
import { client, orpc } from '../../lib/orpc';
import { PLATFORM_COLORS, PLATFORM_LABELS, type Account } from '../../lib/platforms';

export const Route = createFileRoute('/_app/')({
  component: PostsPage,
});

const FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'draft', label: 'Drafts' },
  { value: 'scheduled', label: 'Scheduled' },
  { value: 'publishing', label: 'Publishing' },
  { value: 'published', label: 'Published' },
  { value: 'failed', label: 'Failed' },
] as const;
type Filter = (typeof FILTERS)[number]['value'];

const STATUS_COLORS: Record<string, string> = {
  draft: 'gray',
  scheduled: 'blue',
  publishing: 'yellow',
  pending: 'gray',
  published: 'green',
  failed: 'red',
  manual: 'grape',
};

const formatTime = (date: Date) => dayjs(date).format('ddd D MMM YYYY, HH:mm');

function PostsPage() {
  const { session } = Route.useRouteContext();
  const [filter, setFilter] = useState<Filter>('all');
  const accounts = useQuery(orpc.accounts.list.queryOptions());
  const { data: posts, isLoading } = useLiveQuery((q) =>
    q.from({ post: postsCollection }).orderBy(({ post }) => post.updatedAt, 'desc'),
  );

  const accountsById = new Map((accounts.data ?? []).map((a) => [a.id, a]));
  const counts = new Map<string, number>();
  for (const post of posts) counts.set(post.status, (counts.get(post.status) ?? 0) + 1);
  const visible = filter === 'all' ? posts : posts.filter((p) => p.status === filter);

  function duplicate(post: Post) {
    const now = new Date();
    postsCollection.insert({
      ...post,
      id: crypto.randomUUID(),
      userId: session.user.id,
      title: `${post.title} (copy)`,
      status: 'draft',
      targets: [],
      createdAt: now,
      updatedAt: now,
    });
  }

  function confirmDelete(post: Post) {
    modals.openConfirmModal({
      title: 'Delete post?',
      children: (
        <Text size="sm">
          “{post.title}” will be removed from PostHub. Anything already published stays on the
          platforms.
        </Text>
      ),
      labels: { confirm: 'Delete', cancel: 'Cancel' },
      confirmProps: { color: 'red' },
      onConfirm: () => {
        const tx = postsCollection.delete(post.id);
        tx.when('settled').catch((error: unknown) =>
          notifications.show({
            color: 'red',
            message: error instanceof Error ? error.message : String(error),
          }),
        );
      },
    });
  }

  return (
    <Stack maw={960}>
      <Group justify="space-between">
        <Title order={2}>Posts</Title>
        <Button component={Link} to="/posts/new">
          New post
        </Button>
      </Group>

      <SegmentedControl
        value={filter}
        onChange={(value) => setFilter(value as Filter)}
        data={FILTERS.map((f) => ({
          value: f.value,
          label:
            f.value === 'all' || !counts.get(f.value)
              ? f.label
              : `${f.label} (${counts.get(f.value)})`,
        }))}
        style={{ alignSelf: 'flex-start', maxWidth: '100%', overflowX: 'auto' }}
      />

      {isLoading ? (
        <Center p="xl">
          <Loader size="sm" />
        </Center>
      ) : visible.length === 0 ? (
        <Card withBorder p="xl">
          <Stack align="center" gap="xs">
            <Text fw={500}>{posts.length ? 'Nothing here.' : 'No posts yet.'}</Text>
            <Text size="sm" c="dimmed">
              Write a post once, then send it to any of your connected accounts.
            </Text>
            {!posts.length && (
              <Button component={Link} to="/posts/new" mt="xs">
                Create your first post
              </Button>
            )}
          </Stack>
        </Card>
      ) : (
        visible.map((post) => (
          <PostCard
            key={post.id}
            post={post}
            accountsById={accountsById}
            onDuplicate={() => duplicate(post)}
            onDelete={() => confirmDelete(post)}
          />
        ))
      )}
    </Stack>
  );
}

function PostCard(props: {
  post: Post;
  accountsById: Map<string, Account>;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const { post } = props;
  const navigate = useNavigate();
  const editable = post.status === 'draft' || post.status === 'scheduled';

  const when =
    post.status === 'scheduled' && post.scheduledAt
      ? `Scheduled for ${formatTime(post.scheduledAt)}`
      : post.status === 'draft'
        ? `Draft, edited ${dayjs(post.updatedAt).format('D MMM, HH:mm')}`
        : post.scheduledAt
          ? `Sent ${formatTime(post.scheduledAt)}`
          : null;

  return (
    <Card withBorder padding="md">
      <Stack gap="sm">
        <Group justify="space-between" wrap="nowrap" align="flex-start">
          <Stack gap={2} style={{ minWidth: 0 }}>
            {editable ? (
              <Anchor
                renderRoot={(rootProps) => (
                  <Link {...rootProps} to="/posts/$postId" params={{ postId: post.id }} />
                )}
                fw={600}
                c="inherit"
                truncate
              >
                {post.title}
              </Anchor>
            ) : (
              <Text fw={600} truncate>
                {post.title}
              </Text>
            )}
            {when && (
              <Text size="xs" c="dimmed">
                {when}
                {post.mediaIds.length > 0 &&
                  ` · ${post.mediaIds.length} file${post.mediaIds.length === 1 ? '' : 's'}`}
              </Text>
            )}
          </Stack>
          <Group gap="xs" wrap="nowrap">
            <Badge variant="light" color={STATUS_COLORS[post.status]}>
              {post.status}
            </Badge>
            <Menu position="bottom-end" withinPortal>
              <Menu.Target>
                <ActionIcon variant="subtle" color="gray" aria-label="Post actions">
                  ⋯
                </ActionIcon>
              </Menu.Target>
              <Menu.Dropdown>
                {editable && (
                  <Menu.Item
                    onClick={() =>
                      void navigate({ to: '/posts/$postId', params: { postId: post.id } })
                    }
                  >
                    Edit
                  </Menu.Item>
                )}
                <Menu.Item onClick={props.onDuplicate}>Duplicate as draft</Menu.Item>
                <Menu.Item color="red" onClick={props.onDelete}>
                  Delete
                </Menu.Item>
              </Menu.Dropdown>
            </Menu>
          </Group>
        </Group>

        {post.body && (
          <Text size="sm" lineClamp={3} style={{ whiteSpace: 'pre-line' }}>
            {bodyToText(post.body)}
          </Text>
        )}

        {post.accountIds.length > 0 && (
          <Stack gap={6}>
            {post.accountIds.map((accountId) => (
              <TargetRow
                key={accountId}
                account={props.accountsById.get(accountId)}
                target={post.targets.find((t) => t.socialAccountId === accountId)}
                post={post}
              />
            ))}
          </Stack>
        )}
      </Stack>
    </Card>
  );
}

/** One platform of a post: its status, and what the owner can do about it. */
function TargetRow(props: { account?: Account; target?: PostTarget; post: Post }) {
  const { account, target, post } = props;
  const [busy, setBusy] = useState(false);
  const started = post.status !== 'draft' && post.status !== 'scheduled';

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    try {
      await action();
      await postsCollection.utils.refetch();
    } catch (error) {
      notifications.show({
        color: 'red',
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(false);
    }
  }

  // Before publishing starts, every target is simply waiting.
  const status = !target ? 'pending' : started || target.status === 'manual' ? target.status : null;
  const retryAt =
    target?.status === 'pending' && target.nextAttemptAt
      ? `Retrying ${dayjs(target.nextAttemptAt).format('HH:mm')}`
      : null;

  return (
    <Group justify="space-between" wrap="nowrap" gap="xs">
      <Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
        {account && (
          <Badge size="sm" variant="light" color={PLATFORM_COLORS[account.platform]}>
            {PLATFORM_LABELS[account.platform]}
          </Badge>
        )}
        <Stack gap={0} style={{ minWidth: 0 }}>
          <Text size="sm" truncate>
            {account?.displayName ?? 'Disconnected account'}
          </Text>
          {target?.lastError && (
            <Text
              size="xs"
              c={
                target.status === 'failed'
                  ? 'red'
                  : target.status === 'published'
                    ? 'orange'
                    : 'dimmed'
              }
            >
              {target.lastError}
            </Text>
          )}
          {target?.status === 'manual' && started && (
            <Text size="xs" c="dimmed">
              Post this on TikTok yourself, then mark it as posted.
            </Text>
          )}
        </Stack>
      </Group>
      <Group gap={6} wrap="nowrap">
        {retryAt && (
          <Text size="xs" c="dimmed">
            {retryAt}
          </Text>
        )}
        {target?.status === 'published' && target.externalUrl && (
          <Anchor href={target.externalUrl} target="_blank" rel="noreferrer" size="sm">
            View
          </Anchor>
        )}
        {target?.status === 'failed' && (
          <Button
            size="compact-xs"
            variant="light"
            loading={busy}
            onClick={() => void run(() => client.posts.retry({ targetId: target.id }))}
          >
            Retry
          </Button>
        )}
        {target?.status === 'manual' && started && (
          <>
            <CopyButton value={bodyToText(post.body)}>
              {({ copied, copy }) => (
                <Button size="compact-xs" variant="default" onClick={copy}>
                  {copied ? 'Copied' : 'Copy text'}
                </Button>
              )}
            </CopyButton>
            <Tooltip label="Done posting it in the TikTok app">
              <Button
                size="compact-xs"
                variant="light"
                loading={busy}
                onClick={() => void run(() => client.posts.markPosted({ targetId: target.id }))}
              >
                Mark posted
              </Button>
            </Tooltip>
          </>
        )}
        {status && (
          <Badge size="sm" variant="dot" color={STATUS_COLORS[status]}>
            {status}
          </Badge>
        )}
      </Group>
    </Group>
  );
}
