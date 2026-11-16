import {
  Alert,
  Anchor,
  Badge,
  Button,
  Card,
  Group,
  List,
  PasswordInput,
  Stack,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import type { MediaHostSettings } from '@posthub/contract';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { api } from '../../lib/api';

export const Route = createFileRoute('/_app/settings')({ component: SettingsPage });

function SettingsPage() {
  return (
    <Stack maw={720}>
      <Title order={2}>Settings</Title>
      <MediaHostCard />
    </Stack>
  );
}

interface MediaHostForm {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  publicBaseUrl: string;
}

const empty: MediaHostForm = {
  endpoint: '',
  region: 'auto',
  bucket: '',
  accessKeyId: '',
  secretAccessKey: '',
  publicBaseUrl: '',
};

const toForm = (saved: MediaHostSettings | null): MediaHostForm =>
  saved ? { ...saved, secretAccessKey: '', publicBaseUrl: saved.publicBaseUrl ?? '' } : empty;

const isUrl = (value: string) => {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
};

function MediaHostCard() {
  const queryClient = useQueryClient();
  const saved = useQuery(api.settings.mediaHost.queryOptions());
  const [tested, setTested] = useState<string | null>(null); // 'ok' or the error;
  const form = useForm<MediaHostForm>({
    initialValues: empty,
    validate: {
      endpoint: (v) => (isUrl(v.trim()) ? null : 'Enter the full https:// endpoint'),
      region: (v) => (v.trim() ? null : 'Required ("auto" for Cloudflare R2)'),
      bucket: (v) => (v.trim() ? null : 'Required'),
      accessKeyId: (v) => (v.trim() ? null : 'Required'),
      secretAccessKey: (v) => (v.trim() || saved.data ? null : 'Required the first time you save'),
      publicBaseUrl: (v) => (!v.trim() || isUrl(v.trim()) ? null : 'Enter a full https:// URL'),
    },
  });

  const { setValues, resetDirty } = form;
  useEffect(() => {
    if (saved.data === undefined) return;
    setValues(toForm(saved.data));
    resetDirty(toForm(saved.data));
  }, [saved.data, setValues, resetDirty]);

  const payload = () => {
    const v = form.getValues();
    return {
      endpoint: v.endpoint.trim(),
      region: v.region.trim(),
      bucket: v.bucket.trim(),
      accessKeyId: v.accessKeyId.trim(),
      secretAccessKey: v.secretAccessKey,
      publicBaseUrl: v.publicBaseUrl.trim() || null,
    };
  };
  const refresh = () => queryClient.invalidateQueries({ queryKey: api.settings.key() });

  const save = useMutation(
    api.settings.saveMediaHost.mutationOptions({
      onSuccess: async () => {
        await refresh();
        notifications.show({ color: 'green', message: 'Media host saved.' });
      },
    }),
  );
  const test = useMutation(
    api.settings.testMediaHost.mutationOptions({
      onMutate: () => setTested(null),
      onSuccess: () => setTested('ok'),
      onError: (error) => setTested(error.message),
    }),
  );
  const remove = useMutation(api.settings.removeMediaHost.mutationOptions({ onSuccess: refresh }));

  return (
    <Card withBorder padding="lg">
      <Stack>
        <Group justify="space-between">
          <Title order={4}>Media host</Title>
          {saved.data ? (
            <Badge color="green">Set up</Badge>
          ) : (
            <Badge color="gray">Not set up</Badge>
          )}
        </Group>
        <Text size="sm" c="dimmed">
          Instagram downloads photos and videos from a web address instead of accepting uploads.
          PostHub puts each file in your storage bucket just before publishing and deletes it right
          after, so files are reachable only for the few minutes a publish takes.
        </Text>
        <List size="sm" spacing={4}>
          <List.Item>
            Any S3-compatible bucket works:{' '}
            <Anchor href="https://developers.cloudflare.com/r2/" target="_blank" rel="noreferrer">
              Cloudflare R2
            </Anchor>{' '}
            (free tier, region <code>auto</code>), Backblaze B2 or AWS S3.
          </List.Item>
          <List.Item>
            Create an API token with read and write access to one bucket, and paste its key here.
          </List.Item>
          <List.Item>
            Leave <b>Public URL</b> empty to keep the bucket private: PostHub then shares each file
            with a link that expires after an hour.
          </List.Item>
        </List>

        <form
          onSubmit={form.onSubmit(() => {
            save.mutate(payload());
          })}
        >
          <Stack gap="sm">
            <TextInput
              label="Endpoint"
              placeholder="https://<account id>.r2.cloudflarestorage.com"
              {...form.getInputProps('endpoint')}
            />
            <Group grow align="flex-start">
              <TextInput label="Bucket" {...form.getInputProps('bucket')} />
              <TextInput label="Region" {...form.getInputProps('region')} />
            </Group>
            <TextInput label="Access key ID" {...form.getInputProps('accessKeyId')} />
            <PasswordInput
              label="Secret access key"
              placeholder={saved.data ? 'Saved. Leave empty to keep it' : undefined}
              {...form.getInputProps('secretAccessKey')}
            />
            <TextInput
              label="Public URL (optional)"
              description="Only for a public bucket, e.g. https://media.example.com"
              {...form.getInputProps('publicBaseUrl')}
            />

            {tested === 'ok' && (
              <Alert color="green">
                It works: a test file was uploaded, downloaded without credentials, and deleted.
              </Alert>
            )}
            {tested && tested !== 'ok' && (
              <Alert color="red" title="Test failed">
                {tested}
              </Alert>
            )}
            {save.error && <Alert color="red">{save.error.message}</Alert>}

            <Group justify="space-between">
              <Group>
                <Button type="submit" loading={save.isPending}>
                  Save
                </Button>
                <Button
                  variant="default"
                  loading={test.isPending}
                  onClick={() => {
                    if (!form.validate().hasErrors) test.mutate(payload());
                  }}
                >
                  Test
                </Button>
              </Group>
              {saved.data && (
                <Button
                  variant="subtle"
                  color="red"
                  loading={remove.isPending}
                  onClick={() => remove.mutate(undefined)}
                >
                  Remove
                </Button>
              )}
            </Group>
          </Stack>
        </form>
      </Stack>
    </Card>
  );
}
