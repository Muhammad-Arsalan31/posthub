import { Anchor, Stack, Title } from '@mantine/core';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { PostEditor } from '../../components/post-editor';

export const Route = createFileRoute('/_app/posts/new')({
  component: NewPostPage,
});

function NewPostPage() {
  const { session } = Route.useRouteContext();
  const navigate = useNavigate();

  return (
    <Stack maw={1200}>
      <Anchor component={Link} to="/" size="sm">
        ← All posts
      </Anchor>
      <Title order={2}>New post</Title>
      <PostEditor userId={session.user.id} onDone={() => void navigate({ to: '/' })} />
    </Stack>
  );
}
