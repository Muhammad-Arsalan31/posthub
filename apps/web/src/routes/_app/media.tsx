import {
  Button,
  Card,
  Center,
  Checkbox,
  Group,
  Loader,
  SimpleGrid,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import { modals } from '@mantine/modals';
import { notifications } from '@mantine/notifications';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import dayjs from 'dayjs';
import { useState } from 'react';
import { MediaDropzone, MediaThumb, RemoveButton, useUploadMedia } from '../../components/media';
import { api, client } from '../../lib/api';
import { formatBytes, type MediaItem } from '../../lib/platforms';

export const Route = createFileRoute('/_app/media')({
  component: MediaPage,
});

function MediaPage() {
  const queryClient = useQueryClient();
  const media = useQuery(api.media.list.queryOptions());
  const { upload, uploading } = useUploadMedia();
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const selected = media.data?.filter((item) => selectedIds.includes(item.id)) ?? [];
  const remove = useMutation({
    mutationFn: async (items: MediaItem[]) => {
      const failures: string[] = [];
      for (const item of items) {
        try {
          await client.media.delete({ id: item.id });
          setSelectedIds((ids) => ids.filter((id) => id !== item.id));
          queryClient.setQueryData<MediaItem[]>(api.media.list.key(), (current) =>
            current?.filter((file) => file.id !== item.id),
          );
        } catch (error) {
          failures.push(
            `${item.fileName}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      return failures;
    },
    onSuccess: (failures) => {
      if (failures.length) {
        notifications.show({
          color: 'red',
          title: `Could not delete ${failures.length === 1 ? '1 file' : `${failures.length} files`}`,
          message: failures.join('\n'),
        });
      }
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: api.media.key() }),
  });

  function confirmDelete(items: MediaItem[]) {
    modals.openConfirmModal({
      title: items.length === 1 ? 'Delete file?' : `Delete ${items.length} files?`,
      children: (
        <Text size="sm">
          {items.length === 1 ? `“${items[0]!.fileName}”` : `These ${items.length} files`} will be
          deleted from this computer and removed from any drafts that use them. This cannot be
          undone.
        </Text>
      ),
      labels: { confirm: 'Delete', cancel: 'Cancel' },
      confirmProps: { color: 'red' },
      onConfirm: () => remove.mutate(items),
    });
  }

  return (
    <Stack maw={1200}>
      <Title order={2}>Media</Title>
      <MediaDropzone onFiles={(files) => void upload(files)} uploading={uploading} />

      {!!media.data?.length && (
        <Group justify="space-between">
          <Group>
            <Checkbox
              label="Select all"
              checked={selected.length === media.data.length}
              indeterminate={selected.length > 0 && selected.length < media.data.length}
              disabled={remove.isPending}
              onChange={(event) =>
                setSelectedIds(
                  event.currentTarget.checked ? media.data!.map((item) => item.id) : [],
                )
              }
            />
            <Text size="sm" c="dimmed" role="status">
              {selected.length} selected
            </Text>
          </Group>
          <Button
            color="red"
            disabled={!selected.length}
            loading={remove.isPending}
            onClick={() => confirmDelete(selected)}
          >
            Delete selected{selected.length > 0 ? ` (${selected.length})` : ''}
          </Button>
        </Group>
      )}

      {media.isLoading ? (
        <Center p="xl">
          <Loader size="sm" />
        </Center>
      ) : !media.data?.length ? (
        <Text c="dimmed">No media yet. Uploaded files can be attached to any post.</Text>
      ) : (
        <SimpleGrid cols={{ base: 2, sm: 3, md: 5 }}>
          {media.data.map((item) => (
            <Card key={item.id} withBorder padding={6}>
              <MediaThumb item={item}>
                <Checkbox
                  pos="absolute"
                  top={6}
                  left={6}
                  aria-label={`Select ${item.fileName}`}
                  checked={selectedIds.includes(item.id)}
                  disabled={remove.isPending}
                  onChange={(event) => {
                    const checked = event.currentTarget.checked;
                    setSelectedIds((ids) =>
                      checked ? [...ids, item.id] : ids.filter((id) => id !== item.id),
                    );
                  }}
                />
                <RemoveButton
                  label={`Delete ${item.fileName}`}
                  disabled={remove.isPending}
                  onClick={() => confirmDelete([item])}
                />
              </MediaThumb>
              <Text size="xs" truncate mt={6} title={item.fileName}>
                {item.fileName}
              </Text>
              <Text size="xs" c="dimmed">
                {formatBytes(item.sizeBytes)} · {dayjs(item.createdAt).format('D MMM YYYY')}
              </Text>
            </Card>
          ))}
        </SimpleGrid>
      )}
    </Stack>
  );
}
