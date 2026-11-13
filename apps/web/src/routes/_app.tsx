import { AppShell, Button, Group, NavLink, Text, Title } from '@mantine/core';
import { createFileRoute, Link, Outlet, redirect, useNavigate } from '@tanstack/react-router';
import { authClient } from '../lib/auth-client';

/** Layout + auth guard for every signed-in page. */
export const Route = createFileRoute('/_app')({
  beforeLoad: async () => {
    const { data } = await authClient.getSession();
    if (!data) throw redirect({ to: '/login' });
    return { session: data };
  },
  component: AppLayout,
});

function AppLayout() {
  const { session } = Route.useRouteContext();
  const navigate = useNavigate();

  async function signOut() {
    await authClient.signOut();
    await navigate({ to: '/login' });
  }

  return (
    <AppShell header={{ height: 56 }} navbar={{ width: 220, breakpoint: 'sm' }} padding="md">
      <AppShell.Header px="md">
        <Group h="100%" justify="space-between">
          <Title order={4}>PostHub</Title>
          <Group gap="sm">
            <Text size="sm" c="dimmed">
              {session.user.email}
            </Text>
            <Button size="xs" variant="default" onClick={signOut}>
              Sign out
            </Button>
          </Group>
        </Group>
      </AppShell.Header>
      <AppShell.Navbar p="xs">
        <NavLink component={Link} to="/" label="Posts" />
      </AppShell.Navbar>
      <AppShell.Main>
        <Outlet />
      </AppShell.Main>
    </AppShell>
  );
}
