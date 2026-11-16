import {
  Alert,
  Button,
  Code,
  CopyButton,
  Group,
  List,
  Modal,
  PasswordInput,
  Stack,
  Stepper,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { useMutation } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactNode } from 'react';
import type { Provider } from '@posthub/contract';
import { api } from '../lib/api';
import { SETUP_GUIDES, type GuidePhase } from '../lib/setup-guides';

/** Where a guide opens: the first step, the app credentials form, or the final connect step. */
export type GuideStart = 'start' | 'credentials' | 'connect';

interface GuideStep {
  label: string;
  content: ReactNode;
}

/**
 * A step-by-step setup guide for one provider: create the developer app, enter its credentials,
 * prepare the accounts, connect. WordPress has two steps: create an Application Password, connect.
 */
export function ConnectGuide(props: {
  provider: Provider;
  start: GuideStart;
  onClose: () => void;
  /** App credentials were saved or removed, or a WordPress site was connected. */
  onChanged: () => void;
}) {
  const { provider } = props;
  const guide = SETUP_GUIDES[provider.id];
  const oauth = provider.kind === 'oauth';
  const last = (oauth ? 1 : 0) + (guide.prepare ? 1 : 0) + 1;
  const [active, setActive] = useState(() =>
    props.start === 'connect' ? last : props.start === 'credentials' && oauth ? 1 : 0,
  );

  const steps: GuideStep[] = [
    {
      label: guide.create.label,
      content: (
        <PhaseView phase={guide.create}>{oauth && <RedirectUrl provider={provider} />}</PhaseView>
      ),
    },
  ];
  if (oauth) {
    steps.push({
      label: 'App details',
      content: (
        <Stack>
          <Title order={5}>Enter the app details</Title>
          <AppCredentialsForm
            provider={provider}
            idLabel={guide.idLabel}
            secretLabel={guide.secretLabel}
            onSaved={() => {
              props.onChanged();
              setActive((step) => step + 1);
            }}
            onRemoved={props.onChanged}
          />
        </Stack>
      ),
    });
  }
  if (guide.prepare) {
    steps.push({ label: guide.prepare.label, content: <PhaseView phase={guide.prepare} /> });
  }
  steps.push({
    label: guide.connect.label,
    content: (
      <PhaseView phase={guide.connect}>
        {oauth ? (
          provider.configured ? (
            <Button component="a" href={`/connect/${provider.id}/start`}>
              Connect {provider.label}
            </Button>
          ) : (
            <Alert color="yellow">Enter the app details first (step 2).</Alert>
          )
        ) : (
          <WordPressForm
            onConnected={() => {
              props.onChanged();
              props.onClose();
            }}
          />
        )}
      </PhaseView>
    ),
  });

  const current = Math.min(active, last);

  return (
    <Modal opened onClose={props.onClose} title={`Connect ${provider.label}`} size="xl">
      <Stack gap="lg">
        <Stepper active={current} onStepClick={setActive} size="sm" allowNextStepsSelect>
          {steps.map((step) => (
            <Stepper.Step key={step.label} label={step.label} />
          ))}
        </Stepper>

        {steps[current]?.content}

        <Group justify="space-between">
          <Button variant="default" disabled={current === 0} onClick={() => setActive(current - 1)}>
            Back
          </Button>
          {current < last ? (
            <Button variant="light" onClick={() => setActive(current + 1)}>
              Next
            </Button>
          ) : (
            <Button variant="subtle" onClick={props.onClose}>
              Close
            </Button>
          )}
        </Group>
      </Stack>
    </Modal>
  );
}

function PhaseView(props: { phase: GuidePhase; children?: ReactNode }) {
  const { phase } = props;
  return (
    <Stack>
      <Title order={5}>{phase.title}</Title>
      <List type="ordered" spacing="sm" size="sm">
        {phase.steps.map((step, i) => (
          <List.Item key={i}>{step}</List.Item>
        ))}
      </List>
      {props.children}
      {phase.notes?.length ? (
        <Alert variant="light" color="gray" title="Good to know">
          <List size="sm" spacing={4}>
            {phase.notes.map((note, i) => (
              <List.Item key={i}>{note}</List.Item>
            ))}
          </List>
        </Alert>
      ) : null}
    </Stack>
  );
}

function RedirectUrl(props: { provider: Provider }) {
  const redirectUrl = `${window.location.origin}/connect/${props.provider.id}/callback`;
  return (
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
  );
}

function AppCredentialsForm(props: {
  provider: Provider;
  idLabel?: string;
  secretLabel?: string;
  onSaved: () => void;
  onRemoved: () => void;
}) {
  const { provider } = props;
  const [clientId, setClientId] = useState(provider.clientId ?? '');
  const [clientSecret, setClientSecret] = useState('');
  const save = useMutation(
    api.providerApps.save.mutationOptions({
      onSuccess: () => {
        setClientSecret('');
        props.onSaved();
      },
    }),
  );
  const remove = useMutation(
    api.providerApps.remove.mutationOptions({ onSuccess: props.onRemoved }),
  );
  const providerId = provider.id === 'wordpress' ? null : provider.id;
  const failure = save.error ?? remove.error;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (providerId) save.mutate({ provider: providerId, clientId, clientSecret });
  }

  return (
    <form onSubmit={submit}>
      <Stack>
        <TextInput
          label={props.idLabel ?? 'Client ID'}
          value={clientId}
          onChange={(e) => setClientId(e.currentTarget.value)}
          required
        />
        <PasswordInput
          label={props.secretLabel ?? 'Client secret'}
          placeholder={provider.configured ? 'Leave blank to keep the current secret' : undefined}
          value={clientSecret}
          onChange={(e) => setClientSecret(e.currentTarget.value)}
          required={!provider.configured}
        />
        <Text size="xs" c="dimmed">
          Stored encrypted on this computer and used right away. Switching to a different app later
          means reconnecting its accounts.
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
  );
}

function WordPressForm(props: { onConnected: () => void }) {
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
  );
}
