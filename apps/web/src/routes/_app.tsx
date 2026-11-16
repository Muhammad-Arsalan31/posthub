import { Anchor, AppShell, Button, Group, NavLink, Text, Title } from '@mantine/core';
import { createFileRoute, Link, Outlet, redirect, useNavigate } from '@tanstack/react-router';
import { ThemeToggle } from '../components/theme-toggle';
import { UpdateNotice } from '../components/update-notice';
import { authClient } from '../lib/auth-client';
import { APP_VERSION, RELEASE_NOTES_URL } from '../lib/version';

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
            <ThemeToggle />
            <Button size="xs" variant="default" onClick={signOut}>
              Sign out
            </Button>
          </Group>
        </Group>
      </AppShell.Header>
      <AppShell.Navbar p="xs">
        <AppShell.Section grow>
          <NavLink component={Link} to="/" label="Posts" activeOptions={{ exact: false }} />
          <NavLink component={Link} to="/calendar" label="Calendar" />
          <NavLink component={Link} to="/media" label="Media" />
          <NavLink component={Link} to="/accounts" label="Accounts" />
          <NavLink component={Link} to="/settings" label="Settings" />
        </AppShell.Section>
        <AppShell.Section px="sm" py="xs">
          <Anchor href={RELEASE_NOTES_URL} target="_blank" rel="noreferrer" size="xs" c="dimmed">
            v{APP_VERSION} · Release notes
          </Anchor>
        </AppShell.Section>
      </AppShell.Navbar>
      <AppShell.Main>
        <UpdateNotice />
        <Outlet />
      </AppShell.Main>
    </AppShell>
  );
}
