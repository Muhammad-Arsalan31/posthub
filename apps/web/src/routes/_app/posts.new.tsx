import { Anchor, Stack, Title } from '@mantine/core';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { PostEditor } from '../../components/post-editor';

interface NewPostSearch {
  /** Prefilled publish time (ISO), e.g. from a day clicked on the calendar. */
  at?: string;
}

export const Route = createFileRoute('/_app/posts/new')({
  validateSearch: (search: Record<string, unknown>): NewPostSearch => ({
    at:
      typeof search.at === 'string' && !Number.isNaN(Date.parse(search.at)) ? search.at : undefined,
  }),
  component: NewPostPage,
});

function NewPostPage() {
  const { session } = Route.useRouteContext();
  const navigate = useNavigate();
  const { at } = Route.useSearch();

  return (
    <Stack maw={1200}>
      <Anchor component={Link} to="/" size="sm">
        ← All posts
      </Anchor>
      <Title order={2}>New post</Title>
      <PostEditor
        userId={session.user.id}
        initialScheduledAt={at ? new Date(at) : undefined}
        onDone={() => void navigate({ to: '/' })}
      />
    </Stack>
  );
}
