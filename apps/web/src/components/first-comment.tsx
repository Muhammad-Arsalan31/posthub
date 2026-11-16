import { Badge, Button, Card, Group, Stack, Switch, Text, Textarea, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import type { Account } from '@posthub/contract';
import { useMutation } from '@tanstack/react-query';
import { postsCollection, type Post, type PostTarget } from '../collections/posts';
import { api } from '../lib/api';
import {
  FIRST_COMMENT_PLATFORMS,
  PIN_NOTES,
  PLATFORM_LABELS,
  type Platform,
} from '../lib/platforms';

/** The composer's "First comment" field and its pin reminder switch. */
export function FirstCommentField(props: {
  value: string;
  onChange: (value: string) => void;
  pin: boolean;
  onPinChange: (pin: boolean) => void;
  platforms: Platform[];
}) {
  const hasText = Boolean(props.value.trim());
  const skipped = props.platforms.filter((p) => !FIRST_COMMENT_PLATFORMS.includes(p));
  return (
    <Stack gap={6}>
      <Textarea
        label="First comment"
        description="Posted under the post right after it goes out: links, hashtags or a call to action."
        placeholder="Optional"
        autosize
        minRows={1}
        maxRows={6}
        value={props.value}
        onChange={(e) => props.onChange(e.currentTarget.value)}
      />
      {hasText && skipped.length > 0 && (
        <Text size="xs" c="dimmed">
          Not posted on {skipped.map((p) => PLATFORM_LABELS[p]).join(', ')}.
        </Text>
      )}
      {hasText && (
        <Switch
          label="Remind me to pin it"
          description="No platform lets apps pin comments, so PostHub links you to the post to pin it there."
          checked={props.pin}
          onChange={(e) => props.onPinChange(e.currentTarget.checked)}
        />
      )}
      {hasText && props.pin && (
        <Stack gap={2}>
          {props.platforms.map((platform) => (
            <Text key={platform} size="xs" c="dimmed">
              {PLATFORM_LABELS[platform]}: {PIN_NOTES[platform]}
            </Text>
          ))}
        </Stack>
      )}
    </Stack>
  );
}

const STATUS_TEXT: Record<PostTarget['firstCommentStatus'], string> = {
  none: '',
  pending: 'Waiting to be posted',
  posting: 'Posting…',
  posted: 'Posted',
  failed: 'Failed',
};

/** Pinning needs the owner to be in a comment's platform. */
export const needsPin = (post: Post, target: PostTarget) =>
  post.pinFirstComment && target.firstCommentStatus === 'posted' && !target.pinnedAt;

/** The first comment on each account, with the pin handoff. */
export function FirstCommentStatus(props: { post: Post; accounts: Account[] }) {
  const accountsById = new Map(props.accounts.map((a) => [a.id, a]));
  const targets = props.post.targets.filter((t) => t.firstCommentStatus !== 'none');
  const onError = (error: Error) => notifications.show({ color: 'red', message: error.message });
  const update = (post: Post) => postsCollection.utils.writeUpdate({ ...post });
  const retry = useMutation(
    api.posts.retryFirstComment.mutationOptions({ onSuccess: update, onError }),
  );
  const markPinned = useMutation(
    api.posts.markPinned.mutationOptions({ onSuccess: update, onError }),
  );
  if (!props.post.firstComment || !targets.length) return null;

  return (
    <Card withBorder>
      <Stack gap="sm">
        <Title order={5}>First comment</Title>
        <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
          {props.post.firstComment}
        </Text>
        {targets.map((target) => {
          const account = accountsById.get(target.socialAccountId);
          const platform = account?.platform;
          return (
            <Stack key={target.id} gap={4}>
              <Group gap="xs">
                <Text size="sm" fw={500}>
                  {platform ? PLATFORM_LABELS[platform] : 'Account'}: {account?.displayName}
                </Text>
                <Badge
                  size="xs"
                  variant="light"
                  color={
                    target.firstCommentStatus === 'failed'
                      ? 'red'
                      : target.firstCommentStatus === 'posted'
                        ? 'green'
                        : 'gray'
                  }
                >
                  {STATUS_TEXT[target.firstCommentStatus]}
                </Badge>
                {target.pinnedAt && (
                  <Badge size="xs" variant="light" color="grape">
                    Pinned
                  </Badge>
                )}
              </Group>
              {target.firstCommentError && (
                <Text size="xs" c="red">
                  {target.firstCommentError}
                </Text>
              )}
              {target.firstCommentStatus === 'failed' && (
                <Button
                  size="compact-xs"
                  variant="light"
                  w="fit-content"
                  loading={retry.isPending}
                  onClick={() => retry.mutate({ targetId: target.id })}
                >
                  Retry the comment
                </Button>
              )}
              {props.post.pinFirstComment && target.firstCommentStatus === 'posted' && platform && (
                <Group gap="xs">
                  {!target.pinnedAt && target.externalUrl && (
                    <Button
                      size="compact-xs"
                      component="a"
                      href={target.externalUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Pin it on {PLATFORM_LABELS[platform]}
                    </Button>
                  )}
                  <Button
                    size="compact-xs"
                    variant="default"
                    loading={markPinned.isPending}
                    onClick={() =>
                      markPinned.mutate({ targetId: target.id, pinned: !target.pinnedAt })
                    }
                  >
                    {target.pinnedAt ? 'Not pinned after all' : 'Mark as pinned'}
                  </Button>
                  {!target.pinnedAt && (
                    <Text size="xs" c="dimmed">
                      {PIN_NOTES[platform]}
                    </Text>
                  )}
                </Group>
              )}
            </Stack>
          );
        })}
      </Stack>
    </Card>
  );
}
