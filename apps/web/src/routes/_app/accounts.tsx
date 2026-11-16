import {
  Alert,
  Anchor,
  Badge,
  Button,
  Card,
  Group,
  Loader,
  SimpleGrid,
  Stack,
  Table,
  Text,
  Title,
} from '@mantine/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import type { Provider } from '@posthub/contract';
import { ConnectGuide, type GuideStart } from '../../components/connect-guide';
import { api } from '../../lib/api';

const PLATFORM_LABELS: Record<string, string> = {
  youtube: 'YouTube',
  facebook: 'Facebook',
  instagram: 'Instagram',
  linkedin: 'LinkedIn',
  tiktok: 'TikTok',
  wordpress: 'WordPress',
};

interface AccountsSearch {
  connected?: string;
  error?: string;
}

export const Route = createFileRoute('/_app/accounts')({
  // The server redirects back here after OAuth with ?connected=N or ?error=message.
  validateSearch: (search: Record<string, unknown>): AccountsSearch => ({
    connected:
      typeof search.connected === 'string' || typeof search.connected === 'number'
        ? String(search.connected)
        : undefined,
    error: typeof search.error === 'string' ? search.error : undefined,
  }),
  component: AccountsPage,
});

function AccountsPage() {
  const { connected, error } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const queryClient = useQueryClient();
  const accounts = useQuery(api.accounts.list.queryOptions());
  const providers = useQuery(api.accounts.providers.queryOptions());
  // Track the provider by id so the guide sees fresh data (e.g. `configured`) after a save.
  const [guide, setGuide] = useState<{ id: Provider['id']; start: GuideStart } | null>(null);
  const guideProvider = guide && providers.data?.find((p) => p.id === guide.id);
  const openGuide = (provider: Provider, start: GuideStart) => setGuide({ id: provider.id, start });

  const refresh = () => queryClient.invalidateQueries({ queryKey: api.accounts.key() });
  const disconnect = useMutation(api.accounts.disconnect.mutationOptions({ onSuccess: refresh }));
  const clearBanner = () => void navigate({ search: {} });

  return (
    <Stack maw={960}>
      <Title order={2}>Accounts</Title>

      {connected && (
        <Alert color="green" withCloseButton onClose={clearBanner}>
          Connected {connected} account{connected === '1' ? '' : 's'}.
        </Alert>
      )}
      {error && (
        <Alert color="red" title="Connection failed" withCloseButton onClose={clearBanner}>
          {error}
        </Alert>
      )}

      <Card withBorder padding={0}>
        {accounts.isLoading ? (
          <Group p="md">
            <Loader size="sm" />
          </Group>
        ) : accounts.data?.length ? (
          <Table verticalSpacing="sm" horizontalSpacing="md">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Platform</Table.Th>
                <Table.Th>Account</Table.Th>
                <Table.Th>Status</Table.Th>
                <Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {accounts.data.map((account) => (
                <Table.Tr key={account.id}>
                  <Table.Td>{PLATFORM_LABELS[account.platform] ?? account.platform}</Table.Td>
                  <Table.Td>
                    {account.displayName}
                    {account.reconnectFor.includes('metrics') && account.status === 'active' && (
                      <Text size="xs" c="dimmed">
                        Reconnect to let PostHub read this account's numbers.
                      </Text>
                    )}
                  </Table.Td>
                  <Table.Td>
                    <Badge variant="light" color={account.status === 'active' ? 'green' : 'orange'}>
                      {account.status}
                    </Badge>
                  </Table.Td>
                  <Table.Td ta="right">
                    <Button
                      size="xs"
                      variant="subtle"
                      color="red"
                      loading={disconnect.isPending && disconnect.variables?.id === account.id}
                      onClick={() => {
                        if (window.confirm(`Disconnect ${account.displayName}?`)) {
                          disconnect.mutate({ id: account.id });
                        }
                      }}
                    >
                      Disconnect
                    </Button>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        ) : (
          <Text c="dimmed" p="md">
            No accounts connected yet.
          </Text>
        )}
      </Card>

      <Title order={4} mt="md">
        Connect a platform
      </Title>
      <SimpleGrid cols={{ base: 1, sm: 2 }}>
        {providers.data?.map((provider) => (
          <Card key={provider.id} withBorder>
            <Stack gap="xs">
              <Group justify="space-between">
                <Text fw={600}>{provider.label}</Text>
                {!provider.configured ? (
                  <Badge color="gray" variant="light">
                    Not set up
                  </Badge>
                ) : provider.source === 'env' ? (
                  <Badge color="blue" variant="light">
                    From .env
                  </Badge>
                ) : null}
              </Group>

              {provider.kind === 'credentials' ? (
                <Button onClick={() => openGuide(provider, 'connect')}>Connect a site</Button>
              ) : provider.configured ? (
                <Group grow>
                  <Button component="a" href={`/connect/${provider.id}/start`}>
                    Connect {provider.label}
                  </Button>
                  <Button variant="default" onClick={() => openGuide(provider, 'credentials')}>
                    App settings
                  </Button>
                </Group>
              ) : (
                <Button variant="light" onClick={() => openGuide(provider, 'start')}>
                  Set up {provider.label}
                </Button>
              )}

              <Group gap="md">
                <Anchor component="button" size="xs" onClick={() => openGuide(provider, 'start')}>
                  Step-by-step guide
                </Anchor>
                <Anchor href={provider.setupUrl} target="_blank" rel="noreferrer" size="xs">
                  {provider.kind === 'oauth'
                    ? 'Open developer console'
                    : 'About Application Passwords'}
                </Anchor>
              </Group>
            </Stack>
          </Card>
        ))}
      </SimpleGrid>

      {guideProvider && guide && (
        <ConnectGuide
          key={`${guide.id}-${guide.start}`}
          provider={guideProvider}
          start={guide.start}
          onClose={() => setGuide(null)}
          onChanged={() => void refresh()}
        />
      )}
    </Stack>
  );
}
