import {
  ActionIcon,
  Alert,
  Avatar,
  Badge,
  Button,
  Card,
  Group,
  Menu,
  MultiSelect,
  ScrollArea,
  SegmentedControl,
  Stack,
  Text,
  Textarea,
  Title,
  UnstyledButton,
} from '@mantine/core';
import { modals } from '@mantine/modals';
import { notifications } from '@mantine/notifications';
import type { Account, InboxComment, InboxThread } from '@posthub/contract';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import dayjs from 'dayjs';
import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { PLATFORM_COLORS, PLATFORM_LABELS } from '../../lib/platforms';

interface InboxSearch {
  postId?: string;
}

export const Route = createFileRoute('/_app/inbox')({
  validateSearch: (search: Record<string, unknown>): InboxSearch => ({
    postId: typeof search.postId === 'string' ? search.postId : undefined,
  }),
  component: InboxPage,
});

type View = 'open' | 'unread' | 'archived';

const ACTION_LABELS: Record<InboxComment['actions'][number]['kind'], string> = {
  reply: 'Reply',
  like: 'Like',
  unlike: 'Unlike',
  hide: 'Hide',
  unhide: 'Unhide',
  delete: 'Delete',
};

function InboxPage() {
  const { postId } = Route.useSearch();
  const [view, setView] = useState<View>('open');
  const [accountIds, setAccountIds] = useState<string[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const accounts = useQuery(api.accounts.list.queryOptions());
  const input = {
    ...(accountIds.length ? { accountIds } : {}),
    ...(postId ? { postId } : {}),
    ...(view === 'unread' ? { unread: true } : {}),
    ...(view === 'archived' ? { archived: true } : {}),
  };
  const threads = useQuery(api.inbox.list.queryOptions({ input, refetchInterval: 30_000 }));
  const queryClient = useQueryClient();
  const checkNow = useMutation(
    api.inbox.checkNow.mutationOptions({
      onSuccess: () => {
        notifications.show({
          message: 'Checking your posts for new comments. This takes up to a minute.',
        });
        // The worker runs every 30 seconds; look again shortly.
        setTimeout(
          () => void queryClient.invalidateQueries({ queryKey: ['api', 'inbox'] }),
          35_000,
        );
      },
      onError: (error) => notifications.show({ color: 'red', message: error.message }),
    }),
  );
  const supported = (accounts.data ?? []).filter((a) => a.engagement);
  const current = threads.data?.find((t) => t.root.id === selected) ?? null;

  return (
    <Stack maw={1200}>
      <Group justify="space-between">
        <Title order={2}>Inbox</Title>
        <Group gap="xs">
          {postId && (
            <Button component={Link} to="/inbox" variant="subtle" size="xs">
              Showing one post · show all
            </Button>
          )}
          <Button
            variant="default"
            size="xs"
            loading={checkNow.isPending}
            onClick={() => checkNow.mutate(undefined)}
          >
            Check for new comments
          </Button>
        </Group>
      </Group>
      <Group gap="xs" align="flex-end">
        <SegmentedControl
          size="xs"
          value={view}
          onChange={(value) => {
            setSelected(null);
            setView(value as View);
          }}
          data={[
            { value: 'open', label: 'All' },
            { value: 'unread', label: 'Unread' },
            { value: 'archived', label: 'Archived' },
          ]}
        />
        <MultiSelect
          size="xs"
          placeholder={accountIds.length ? undefined : 'All accounts'}
          value={accountIds}
          onChange={setAccountIds}
          data={supported.map((a) => ({
            value: a.id,
            label: `${PLATFORM_LABELS[a.platform]}: ${a.displayName}`,
          }))}
          clearable
          w={320}
          aria-label="Accounts"
        />
      </Group>

      {accounts.data && !supported.length ? (
        <Alert color="blue">
          Comments appear here for YouTube, Facebook, Instagram and WordPress accounts. LinkedIn and
          TikTok don't let PostHub read comments; answer those in their apps.
        </Alert>
      ) : !threads.data?.length ? (
        <Card withBorder p="xl">
          <Text c="dimmed" ta="center">
            {view === 'unread'
              ? 'All caught up.'
              : view === 'archived'
                ? 'Nothing archived.'
                : 'No comments yet. PostHub checks published posts every few minutes.'}
          </Text>
        </Card>
      ) : (
        <Group align="flex-start" wrap="nowrap" gap="md">
          <Card withBorder p={0} w={360} style={{ flexShrink: 0 }}>
            <ScrollArea h={640}>
              {threads.data.map((thread) => (
                <ThreadRow
                  key={thread.root.id}
                  thread={thread}
                  active={thread.root.id === current?.root.id}
                  onSelect={() => setSelected(thread.root.id)}
                />
              ))}
            </ScrollArea>
          </Card>
          {current ? (
            <Conversation
              key={current.root.id}
              rootId={current.root.id}
              account={accounts.data?.find((a) => a.id === current.root.accountId)}
            />
          ) : (
            <Card withBorder style={{ flex: 1 }}>
              <Text c="dimmed">Select a conversation to read and reply.</Text>
            </Card>
          )}
        </Group>
      )}
    </Stack>
  );
}

function ThreadRow(props: { thread: InboxThread; active: boolean; onSelect: () => void }) {
  const { root } = props.thread;
  return (
    <UnstyledButton
      onClick={props.onSelect}
      p="sm"
      w="100%"
      style={{
        display: 'block',
        borderBottom: '1px solid var(--mantine-color-default-border)',
        background: props.active ? 'var(--mantine-color-default-hover)' : undefined,
      }}
    >
      <Group justify="space-between" wrap="nowrap" gap="xs">
        <Text size="sm" fw={props.thread.unread ? 700 : 500} truncate>
          {root.authorName}
        </Text>
        <Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
          {dayjs(props.thread.lastActivityAt).format('D MMM HH:mm')}
        </Text>
      </Group>
      <Text size="sm" lineClamp={2} c={props.thread.unread ? undefined : 'dimmed'}>
        {root.text}
      </Text>
      <Group gap={4} mt={4}>
        <Badge size="xs" variant="light" color={PLATFORM_COLORS[root.platform]}>
          {PLATFORM_LABELS[root.platform]}
        </Badge>
        <Text size="xs" c="dimmed" truncate>
          on {root.postTitle}
        </Text>
        {props.thread.unread > 0 && (
          <Badge size="xs" color="blue">
            {props.thread.unread} new
          </Badge>
        )}
      </Group>
    </UnstyledButton>
  );
}

function Conversation(props: { rootId: string; account: Account | undefined }) {
  const queryClient = useQueryClient();
  const input = { commentId: props.rootId };
  const thread = useQuery(api.inbox.thread.queryOptions({ input, refetchInterval: 15_000 }));
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['api', 'inbox'] });
  const markRead = useMutation(api.inbox.markRead.mutationOptions({ onSuccess: refresh }));
  const archive = useMutation(api.inbox.archive.mutationOptions({ onSuccess: refresh }));
  const capabilities = props.account?.engagement;
  const comments = thread.data ?? [];
  const root = comments[0];

  // Opening a conversation marks it read.
  const unread = comments.filter((c) => !c.read && !c.isOwn).map((c) => c.id);
  const unreadKey = unread.join(',');
  const { mutate } = markRead;
  useEffect(() => {
    if (unreadKey) mutate({ commentIds: unreadKey.split(',') });
  }, [unreadKey, mutate]);

  return (
    <Card withBorder style={{ flex: 1, minWidth: 0 }}>
      <Stack>
        {root && (
          <Group justify="space-between">
            <Text size="sm" c="dimmed">
              {PLATFORM_LABELS[root.platform]} · on{' '}
              <Text
                span
                inherit
                td="underline"
                renderRoot={(rootProps) => (
                  <Link {...rootProps} to="/posts/$postId" params={{ postId: root.postId }} />
                )}
              >
                {root.postTitle}
              </Text>
            </Text>
            <Button
              size="xs"
              variant="default"
              loading={archive.isPending}
              onClick={() => archive.mutate({ commentId: root.id, archived: !root.archived })}
            >
              {root.archived ? 'Move to inbox' : 'Archive'}
            </Button>
          </Group>
        )}
        <ScrollArea.Autosize mah={420}>
          <Stack gap="sm">
            {comments.map((c) => (
              <CommentItem
                key={c.id}
                comment={c}
                capabilities={capabilities ?? null}
                onChanged={refresh}
              />
            ))}
          </Stack>
        </ScrollArea.Autosize>
        {root && capabilities?.reply && (
          // Answer the latest comment from someone else (or the first one).
          <ReplyBox
            commentId={(comments.findLast((c) => !c.isOwn && !c.deleted) ?? root).id}
            onSent={refresh}
          />
        )}
      </Stack>
    </Card>
  );
}

function CommentItem(props: {
  comment: InboxComment;
  capabilities: Account['engagement'];
  onChanged: () => void;
}) {
  const c = props.comment;
  const caps = props.capabilities;
  const onError = (error: Error) => notifications.show({ color: 'red', message: error.message });
  const like = useMutation(
    api.inbox.setLike.mutationOptions({ onSuccess: props.onChanged, onError }),
  );
  const moderate = useMutation(
    api.inbox.moderate.mutationOptions({ onSuccess: props.onChanged, onError }),
  );
  const retry = useMutation(
    api.inbox.retryAction.mutationOptions({ onSuccess: props.onChanged, onError }),
  );
  const confirmDelete = () =>
    modals.openConfirmModal({
      title: 'Delete comment?',
      children: <Text size="sm">It is removed from {PLATFORM_LABELS[c.platform]} too.</Text>,
      labels: { confirm: 'Delete', cancel: 'Cancel' },
      confirmProps: { color: 'red' },
      onConfirm: () => moderate.mutate({ commentId: c.id, action: 'delete' }),
    });

  return (
    <Group
      align="flex-start"
      wrap="nowrap"
      gap="sm"
      pl={c.parentExternalId ? 'xl' : 0}
      opacity={c.deleted || c.hidden ? 0.55 : 1}
    >
      <Avatar src={c.authorAvatarUrl} size="sm" radius="xl" name={c.authorName} />
      <Stack gap={2} style={{ flex: 1, minWidth: 0 }}>
        <Group gap={6}>
          <Text size="sm" fw={600}>
            {c.isOwn ? `${c.authorName} (you)` : c.authorName}
          </Text>
          <Text size="xs" c="dimmed">
            {dayjs(c.createdAt).format('D MMM HH:mm')}
          </Text>
          {c.hidden && (
            <Badge size="xs" color="gray">
              Hidden
            </Badge>
          )}
          {c.deleted && (
            <Badge size="xs" color="gray">
              Deleted
            </Badge>
          )}
          {c.likeCount ? (
            <Text size="xs" c="dimmed">
              {c.likeCount} like{c.likeCount === 1 ? '' : 's'}
            </Text>
          ) : null}
        </Group>
        <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
          {c.text}
        </Text>
        {c.actions.map((a) => (
          <Group key={a.id} gap={6}>
            <Badge size="xs" color={a.status === 'failed' ? 'red' : 'yellow'} variant="light">
              {ACTION_LABELS[a.kind]}: {a.status === 'failed' ? 'failed' : 'sending…'}
            </Badge>
            {a.text && (
              <Text size="xs" c="dimmed" truncate>
                “{a.text}”
              </Text>
            )}
            {a.status === 'failed' && (
              <>
                <Text size="xs" c="red">
                  {a.lastError}
                </Text>
                <Button
                  size="compact-xs"
                  variant="subtle"
                  onClick={() => retry.mutate({ actionId: a.id })}
                >
                  Retry
                </Button>
              </>
            )}
          </Group>
        ))}
      </Stack>
      {!c.deleted && caps && (caps.like || caps.hide || caps.delete) && (
        <Menu position="bottom-end" withinPortal>
          <Menu.Target>
            <ActionIcon variant="subtle" color="gray" aria-label="Comment actions">
              ⋯
            </ActionIcon>
          </Menu.Target>
          <Menu.Dropdown>
            {caps.like && (
              <Menu.Item onClick={() => like.mutate({ commentId: c.id, liked: !c.likedByMe })}>
                {c.likedByMe ? 'Unlike' : 'Like'}
              </Menu.Item>
            )}
            {caps.hide && (
              <Menu.Item
                onClick={() =>
                  moderate.mutate({ commentId: c.id, action: c.hidden ? 'unhide' : 'hide' })
                }
              >
                {c.hidden ? 'Unhide' : 'Hide'}
              </Menu.Item>
            )}
            {caps.delete && (
              <Menu.Item color="red" onClick={confirmDelete}>
                Delete
              </Menu.Item>
            )}
          </Menu.Dropdown>
        </Menu>
      )}
    </Group>
  );
}

function ReplyBox(props: { commentId: string; onSent: () => void }) {
  const [text, setText] = useState('');
  const saved = useQuery(api.savedReplies.list.queryOptions());
  const queryClient = useQueryClient();
  const reply = useMutation(
    api.inbox.reply.mutationOptions({
      onSuccess: () => {
        setText('');
        props.onSent();
      },
      onError: (error) => notifications.show({ color: 'red', message: error.message }),
    }),
  );
  const saveReply = useMutation(
    api.savedReplies.save.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: api.savedReplies.key() });
        notifications.show({ color: 'green', message: 'Saved for next time.' });
      },
    }),
  );

  return (
    <Stack gap="xs">
      <Textarea
        placeholder="Write a reply"
        autosize
        minRows={2}
        maxRows={8}
        value={text}
        onChange={(e) => setText(e.currentTarget.value)}
        aria-label="Reply"
      />
      <Group justify="space-between">
        <Group gap="xs">
          <Menu position="top-start" withinPortal>
            <Menu.Target>
              <Button size="xs" variant="default">
                Saved replies
              </Button>
            </Menu.Target>
            <Menu.Dropdown>
              {(saved.data ?? []).map((s) => (
                <Menu.Item key={s.id} onClick={() => setText(s.body)}>
                  {s.title}
                </Menu.Item>
              ))}
              {!saved.data?.length && <Menu.Label>None yet</Menu.Label>}
              <Menu.Divider />
              <Menu.Item
                disabled={!text.trim()}
                onClick={() =>
                  saveReply.mutate({ title: text.trim().slice(0, 40), body: text.trim() })
                }
              >
                Save this reply
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
        </Group>
        <Button
          size="xs"
          disabled={!text.trim()}
          loading={reply.isPending}
          onClick={() => reply.mutate({ commentId: props.commentId, text })}
        >
          Reply
        </Button>
      </Group>
    </Stack>
  );
}
