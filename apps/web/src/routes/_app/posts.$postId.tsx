import { Alert, Anchor, Loader, Stack, Title } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { useLiveQuery } from '@tanstack/react-db';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { postsCollection } from '../../collections/posts';
import { PostEditor } from '../../components/post-editor';
import { PostMetrics } from '../../components/post-metrics';
import { api } from '../../lib/api';

export const Route = createFileRoute('/_app/posts/$postId')({
  component: EditPostPage,
});

function EditPostPage() {
  const { postId } = Route.useParams();
  const { session } = Route.useRouteContext();
  const navigate = useNavigate();
  const { data, isLoading } = useLiveQuery((q) => q.from({ post: postsCollection }));
  const post = data.find((p) => p.id === postId);
  const accounts = useQuery(api.accounts.list.queryOptions());

  return (
    <Stack maw={1200}>
      <Anchor component={Link} to="/" size="sm">
        ← All posts
      </Anchor>
      <Title order={2}>Edit post</Title>
      {isLoading ? (
        <Loader size="sm" />
      ) : !post ? (
        <Alert color="gray">This post no longer exists.</Alert>
      ) : post.status !== 'draft' && post.status !== 'scheduled' ? (
        <>
          <Alert color="blue">
            This post has started publishing, so it can no longer be edited. Duplicate it from the
            Posts page to make changes.
          </Alert>
          <PostMetrics post={post} accounts={accounts.data ?? []} />
          {post.targets.some((t) => t.status === 'published') && (
            <Anchor
              size="sm"
              renderRoot={(rootProps) => (
                <Link {...rootProps} to="/inbox" search={{ postId: post.id }} />
              )}
            >
              See this post's comments in the inbox
            </Anchor>
          )}
        </>
      ) : (
        <PostEditor
          key={post.id}
          post={post}
          userId={session.user.id}
          onDone={() => void navigate({ to: '/' })}
        />
      )}
    </Stack>
  );
}
