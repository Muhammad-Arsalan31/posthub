import { Box, Button, FileButton, Group, Input, Stack, Text } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { formatBytes, type MediaItem } from '../lib/platforms';
import { MediaLibraryModal, MediaThumb, useUploadMedia } from './media';

/** One image chosen from the library or uploaded, e.g. a featured image or thumbnail. */
export function ImagePicker(props: {
  label: string;
  description: string;
  value: MediaItem | null;
  onChange: (item: MediaItem | null) => void;
  /** MIME types offered for upload and in the library. */
  accept: string[];
  /** Shown when nothing is chosen. */
  emptyText: string;
  error?: string | null;
}) {
  const [libraryOpen, library] = useDisclosure(false);
  const { upload, uploading } = useUploadMedia();
  const allowed = (item: MediaItem) =>
    props.accept.some((type) =>
      type.endsWith('/*') ? item.mimeType.startsWith(type.slice(0, -1)) : item.mimeType === type,
    );

  async function uploadOne(file: File | null) {
    if (!file) return;
    const [uploaded] = await upload([file]);
    if (uploaded) props.onChange(uploaded);
  }

  return (
    <Input.Wrapper label={props.label} description={props.description} error={props.error}>
      <Group mt={6} align="center" wrap="nowrap">
        <Box w={88} style={{ flexShrink: 0 }}>
          {props.value ? (
            <MediaThumb item={props.value} />
          ) : (
            <Box
              h={88}
              bg="var(--mantine-color-default-hover)"
              style={{ borderRadius: 'var(--mantine-radius-sm)' }}
            />
          )}
        </Box>
        <Stack gap={6} style={{ minWidth: 0 }}>
          <Text size="xs" c="dimmed" truncate>
            {props.value
              ? `${props.value.fileName} · ${formatBytes(props.value.sizeBytes)}`
              : props.emptyText}
          </Text>
          <Group gap="xs">
            <Button size="compact-sm" variant="default" onClick={library.open}>
              Choose
            </Button>
            <FileButton onChange={(file) => void uploadOne(file)} accept={props.accept.join(',')}>
              {(buttonProps) => (
                <Button
                  {...buttonProps}
                  size="compact-sm"
                  variant="default"
                  loading={uploading > 0}
                >
                  Upload
                </Button>
              )}
            </FileButton>
            {props.value && (
              <Button
                size="compact-sm"
                variant="subtle"
                color="red"
                onClick={() => props.onChange(null)}
              >
                Remove
              </Button>
            )}
          </Group>
        </Stack>
      </Group>
      <MediaLibraryModal
        opened={libraryOpen}
        onClose={library.close}
        selected={props.value ? [props.value.id] : []}
        filter={allowed}
        onToggle={(item) => {
          props.onChange(item.id === props.value?.id ? null : item);
          library.close();
        }}
      />
    </Input.Wrapper>
  );
}
