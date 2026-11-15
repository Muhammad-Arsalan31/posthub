import {
  Alert,
  Anchor,
  Badge,
  Button,
  Card,
  Code,
  CopyButton,
  Group,
  Loader,
  Modal,
  PasswordInput,
  SimpleGrid,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import type { Provider } from '@posthub/contract';
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
  const [wordPressOpen, wordPress] = useDisclosure(false);
  const [setupFor, setSetupFor] = useState<Provider | null>(null);

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
                  <Table.Td>{account.displayName}</Table.Td>
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
                <Button onClick={wordPress.open}>Connect a site</Button>
              ) : provider.configured ? (
                <Group grow>
                  <Button component="a" href={`/connect/${provider.id}/start`}>
                    Connect {provider.label}
                  </Button>
                  <Button variant="default" onClick={() => setSetupFor(provider)}>
                    App settings
                  </Button>
                </Group>
              ) : (
                <Button variant="light" onClick={() => setSetupFor(provider)}>
                  Set up {provider.label}
                </Button>
              )}

              <Anchor href={provider.setupUrl} target="_blank" rel="noreferrer" size="xs">
                {provider.kind === 'oauth'
                  ? 'Open developer console'
                  : 'About Application Passwords'}
              </Anchor>
            </Stack>
          </Card>
        ))}
      </SimpleGrid>

      {setupFor && (
        <AppSetupModal
          key={setupFor.id}
          provider={setupFor}
          onClose={() => setSetupFor(null)}
          onSaved={() => {
            setSetupFor(null);
            void refresh();
          }}
        />
      )}

      <WordPressModal
        opened={wordPressOpen}
        onClose={wordPress.close}
        onConnected={() => {
          wordPress.close();
          void refresh();
        }}
      />
    </Stack>
  );
}

const APP_HELP: Record<string, { idLabel: string; secretLabel: string; steps: string }> = {
  google: {
    idLabel: 'Client ID',
    secretLabel: 'Client secret',
    steps:
      'Google Cloud Console: enable “YouTube Data API v3”, configure the OAuth consent screen, then create an OAuth client ID of type “Web application”.',
  },
  meta: {
    idLabel: 'App ID',
    secretLabel: 'App secret',
    steps:
      'Meta for Developers: create a Business app, add “Facebook Login for Business”, then copy the App ID and secret from App settings → Basic.',
  },
  linkedin: {
    idLabel: 'Client ID',
    secretLabel: 'Client secret',
    steps:
      'LinkedIn Developers: create an app, add the products “Sign In with LinkedIn using OpenID Connect” and “Share on LinkedIn”, then open the Auth tab.',
  },
};

function AppSetupModal(props: { provider: Provider; onClose: () => void; onSaved: () => void }) {
  const { provider } = props;
  const help = APP_HELP[provider.id];
  const [clientId, setClientId] = useState(provider.clientId ?? '');
  const [clientSecret, setClientSecret] = useState('');
  const save = useMutation(api.providerApps.save.mutationOptions({ onSuccess: props.onSaved }));
  const remove = useMutation(api.providerApps.remove.mutationOptions({ onSuccess: props.onSaved }));
  const redirectUrl = `${window.location.origin}/connect/${provider.id}/callback`;
  const providerId = provider.id === 'wordpress' ? null : provider.id;
  const failure = save.error ?? remove.error;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (providerId) save.mutate({ provider: providerId, clientId, clientSecret });
  }

  return (
    <Modal opened onClose={props.onClose} title={`${provider.label} app`}>
      <form onSubmit={submit}>
        <Stack>
          {help && (
            <Text size="sm" c="dimmed">
              {help.steps}
            </Text>
          )}
          <div>
            <Text size="sm" fw={500}>
              Redirect URL
            </Text>
            <Text size="xs" c="dimmed" mb={4}>
              Add this exact URL to the app’s allowed redirect URLs.
            </Text>
            <Group gap="xs" wrap="nowrap">
              <Code style={{ flex: 1, overflowWrap: 'anywhere' }}>{redirectUrl}</Code>
              <CopyButton value={redirectUrl}>
                {({ copied, copy }) => (
                  <Button size="xs" variant="default" onClick={copy}>
                    {copied ? 'Copied' : 'Copy'}
                  </Button>
                )}
              </CopyButton>
            </Group>
          </div>
          <TextInput
            label={help?.idLabel ?? 'Client ID'}
            value={clientId}
            onChange={(e) => setClientId(e.currentTarget.value)}
            required
          />
          <PasswordInput
            label={help?.secretLabel ?? 'Client secret'}
            placeholder={provider.configured ? 'Leave blank to keep the current secret' : undefined}
            value={clientSecret}
            onChange={(e) => setClientSecret(e.currentTarget.value)}
            required={!provider.configured}
          />
          <Text size="xs" c="dimmed">
            Stored encrypted on this computer and used right away. Switching to a different app
            later means reconnecting its accounts.
          </Text>
          {failure && <Alert color="red">{failure.message}</Alert>}
          <Group justify="space-between">
            {provider.source === 'database' && providerId ? (
              <Button
                variant="subtle"
                color="red"
                loading={remove.isPending}
                onClick={() => remove.mutate({ provider: providerId })}
              >
                Remove
              </Button>
            ) : (
              <span />
            )}
            <Button type="submit" loading={save.isPending}>
              Save
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}

function WordPressModal(props: { opened: boolean; onClose: () => void; onConnected: () => void }) {
  const [siteUrl, setSiteUrl] = useState('');
  const [username, setUsername] = useState('');
  const [appPassword, setAppPassword] = useState('');
  const connect = useMutation(
    api.accounts.connectWordPress.mutationOptions({
      onSuccess: () => {
        setAppPassword('');
        props.onConnected();
      },
    }),
  );

  function submit(event: FormEvent) {
    event.preventDefault();
    connect.mutate({ siteUrl, username, appPassword });
  }

  return (
    <Modal opened={props.opened} onClose={props.onClose} title="Connect a WordPress site">
      <form onSubmit={submit}>
        <Stack>
          <TextInput
            label="Site URL"
            placeholder="https://example.com"
            value={siteUrl}
            onChange={(e) => setSiteUrl(e.currentTarget.value)}
            required
          />
          <TextInput
            label="Username"
            value={username}
            onChange={(e) => setUsername(e.currentTarget.value)}
            required
          />
          <PasswordInput
            label="Application Password"
            description="WordPress admin → Users → Profile → Application Passwords"
            value={appPassword}
            onChange={(e) => setAppPassword(e.currentTarget.value)}
            required
          />
          {connect.error && <Alert color="red">{connect.error.message}</Alert>}
          <Button type="submit" loading={connect.isPending}>
            Connect
          </Button>
        </Stack>
      </form>
    </Modal>
  );
}
