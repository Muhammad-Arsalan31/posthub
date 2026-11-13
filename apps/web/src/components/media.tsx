import {
  ActionIcon,
  AspectRatio,
  Badge,
  Box,
  Button,
  Card,
  Center,
  Group,
  Image,
  Loader,
  Modal,
  SimpleGrid,
  Stack,
  Text,
} from '@mantine/core';
import { Dropzone } from '@mantine/dropzone';
import { notifications } from '@mantine/notifications';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { client, orpc } from '../lib/orpc';
import { formatBytes, isVideo, mediaUrl, type MediaItem } from '../lib/platforms';

export const MEDIA_ACCEPT = ['image/*', 'video/*'];
const MAX_BYTES = 1024 ** 3;

/** Image or muted video preview, square-cropped. */
export function MediaThumb(props: { item: MediaItem; children?: ReactNode }) {
  const { item } = props;
  return (
    <Box pos="relative">
      <AspectRatio ratio={1}>
        {isVideo(item) ? (
          <video
            src={mediaUrl(item.id)}
            muted
            preload="metadata"
            style={{ objectFit: 'cover', borderRadius: 'var(--mantine-radius-sm)' }}
          />
        ) : (
          <Image src={mediaUrl(item.id)} alt={item.fileName} radius="sm" fit="cover" />
        )}
      </AspectRatio>
      {isVideo(item) && (
        <Badge size="xs" variant="filled" color="dark" pos="absolute" bottom={6} left={6}>
          Video
        </Badge>
      )}
      {props.children}
    </Box>
  );
}

/** Uploads files one by one and refreshes the media library. */
export function useUploadMedia() {
  const queryClient = useQueryClient();
  const [uploading, setUploading] = useState(0);

  async function upload(files: File[]) {
    const uploaded: MediaItem[] = [];
    setUploading((n) => n + files.length);
    try {
      for (const file of files) {
        try {
          uploaded.push(await client.media.upload({ file }));
        } catch (error) {
          notifications.show({
            color: 'red',
            title: `Could not upload ${file.name}`,
            message: error instanceof Error ? error.message : String(error),
          });
        } finally {
          setUploading((n) => n - 1);
        }
      }
    } finally {
      await queryClient.invalidateQueries({ queryKey: orpc.media.key() });
    }
    return uploaded;
  }

  return { upload, uploading };
}

export function MediaDropzone(props: {
  onFiles: (files: File[]) => void;
  uploading: number;
  compact?: boolean;
}) {
  return (
    <Dropzone
      onDrop={props.onFiles}
      onReject={(rejections) =>
        notifications.show({
          color: 'red',
          title: 'Some files were not added',
          message: rejections
            .map((r) => `${r.file.name}: ${r.errors[0]?.message ?? 'not allowed'}`)
            .join('\n'),
        })
      }
      accept={MEDIA_ACCEPT}
      maxSize={MAX_BYTES}
      loading={props.uploading > 0}
      p={props.compact ? 'md' : 'xl'}
    >
      <Stack gap={4} align="center" style={{ pointerEvents: 'none' }}>
        <Text fw={500}>Drop images or videos here, or click to choose</Text>
        <Text size="xs" c="dimmed">
          Up to 1 GB per file. Files are stored on this computer.
        </Text>
      </Stack>
    </Dropzone>
  );
}

/** Pick files that are already in the library. */
export function MediaLibraryModal(props: {
  opened: boolean;
  onClose: () => void;
  selected: string[];
  onToggle: (item: MediaItem) => void;
  /** Only offer matching files (e.g. images for a thumbnail). */
  filter?: (item: MediaItem) => boolean;
}) {
  const query = useQuery({ ...orpc.media.list.queryOptions(), enabled: props.opened });
  const media = { ...query, data: props.filter ? query.data?.filter(props.filter) : query.data };

  return (
    <Modal opened={props.opened} onClose={props.onClose} title="Media library" size="xl">
      {media.isLoading ? (
        <Center p="xl">
          <Loader size="sm" />
        </Center>
      ) : !media.data?.length ? (
        <Text c="dimmed">Nothing uploaded yet.</Text>
      ) : (
        <SimpleGrid cols={{ base: 2, sm: 4 }}>
          {media.data.map((item) => {
            const picked = props.selected.includes(item.id);
            return (
              <Card
                key={item.id}
                withBorder
                padding={4}
                style={{
                  cursor: 'pointer',
                  outline: picked ? '2px solid var(--mantine-primary-color-filled)' : undefined,
                }}
                onClick={() => props.onToggle(item)}
                role="checkbox"
                aria-checked={picked}
                aria-label={item.fileName}
              >
                <MediaThumb item={item} />
                <Text size="xs" truncate mt={4}>
                  {item.fileName}
                </Text>
                <Text size="xs" c="dimmed">
                  {formatBytes(item.sizeBytes)}
                </Text>
              </Card>
            );
          })}
        </SimpleGrid>
      )}
      <Group justify="flex-end" mt="md">
        <Button onClick={props.onClose}>Done</Button>
      </Group>
    </Modal>
  );
}

export function RemoveButton(props: { label: string; onClick: () => void }) {
  return (
    <ActionIcon
      pos="absolute"
      top={6}
      right={6}
      size="sm"
      radius="xl"
      color="dark"
      variant="filled"
      aria-label={props.label}
      onClick={props.onClick}
    >
      ✕
    </ActionIcon>
  );
}
