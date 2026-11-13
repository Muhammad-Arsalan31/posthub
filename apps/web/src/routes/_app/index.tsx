import {
  ActionIcon,
  Badge,
  Button,
  Card,
  Group,
  Stack,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { useLiveQuery } from '@tanstack/react-db';
import { createFileRoute } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { postsCollection } from '../../collections/posts';

export const Route = createFileRoute('/_app/')({
  component: PostsPage,
});

function PostsPage() {
  const { session } = Route.useRouteContext();
  const [title, setTitle] = useState('');
  const { data: posts, isLoading } = useLiveQuery((q) =>
    q.from({ post: postsCollection }).orderBy(({ post }) => post.createdAt, 'desc'),
  );

  function addDraft(event: FormEvent) {
    event.preventDefault();
    if (!title.trim()) return;
    const now = new Date();
    postsCollection.insert({
      id: crypto.randomUUID(),
      userId: session.user.id,
      title: title.trim(),
      body: '',
      status: 'draft',
      scheduledAt: null,
      createdAt: now,
      updatedAt: now,
    });
    setTitle('');
  }

  return (
    <Stack maw={720}>
      <Title order={2}>Posts</Title>
      <form onSubmit={addDraft}>
        <Group align="end">
          <TextInput
            flex={1}
            label="New draft"
            placeholder="What do you want to post?"
            value={title}
            onChange={(e) => setTitle(e.currentTarget.value)}
          />
          <Button type="submit">Add draft</Button>
        </Group>
      </form>

      {isLoading && <Text c="dimmed">Loading…</Text>}
      {!isLoading && posts.length === 0 && <Text c="dimmed">No posts yet.</Text>}

      {posts.map((post) => (
        <Card key={post.id} withBorder padding="sm">
          <Group justify="space-between">
            <div>
              <Text fw={500}>{post.title}</Text>
              <Text size="xs" c="dimmed">
                {post.createdAt.toLocaleString()}
              </Text>
            </div>
            <Group gap="xs">
              <Badge variant="light">{post.status}</Badge>
              <ActionIcon
                variant="subtle"
                color="red"
                aria-label="Delete post"
                onClick={() => postsCollection.delete(post.id)}
              >
                ✕
              </ActionIcon>
            </Group>
          </Group>
        </Card>
      ))}
    </Stack>
  );
}
