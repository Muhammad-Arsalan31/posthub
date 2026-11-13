import { Card, Center, Loader, SimpleGrid, Stack, Text, Title } from '@mantine/core';
import { modals } from '@mantine/modals';
import { notifications } from '@mantine/notifications';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import dayjs from 'dayjs';
import { MediaDropzone, MediaThumb, RemoveButton, useUploadMedia } from '../../components/media';
import { orpc } from '../../lib/orpc';
import { formatBytes, type MediaItem } from '../../lib/platforms';

export const Route = createFileRoute('/_app/media')({
  component: MediaPage,
});

function MediaPage() {
  const queryClient = useQueryClient();
  const media = useQuery(orpc.media.list.queryOptions());
  const { upload, uploading } = useUploadMedia();
  const remove = useMutation(
    orpc.media.delete.mutationOptions({
      onSuccess: () => queryClient.invalidateQueries({ queryKey: orpc.media.key() }),
      onError: (error) => notifications.show({ color: 'red', message: error.message }),
    }),
  );

  function confirmDelete(item: MediaItem) {
    modals.openConfirmModal({
      title: 'Delete file?',
      children: (
        <Text size="sm">
          “{item.fileName}” will be deleted from this computer and removed from any drafts that use
          it.
        </Text>
      ),
      labels: { confirm: 'Delete', cancel: 'Cancel' },
      confirmProps: { color: 'red' },
      onConfirm: () => remove.mutate({ id: item.id }),
    });
  }

  return (
    <Stack maw={1200}>
      <Title order={2}>Media</Title>
      <MediaDropzone onFiles={(files) => void upload(files)} uploading={uploading} />

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
                <RemoveButton
                  label={`Delete ${item.fileName}`}
                  onClick={() => confirmDelete(item)}
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
