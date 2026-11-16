import {
  Alert,
  Anchor,
  Badge,
  Button,
  Card,
  Checkbox,
  Grid,
  Group,
  Loader,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { DateTimePicker } from '@mantine/dates';
import { useDisclosure } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import dayjs from 'dayjs';
import { useMemo, useState } from 'react';
import { postsCollection, type Post } from '../collections/posts';
import { api } from '../lib/api';
import {
  PLATFORM_COLORS,
  PLATFORM_LABELS,
  PLATFORM_NOTES,
  platformProblem,
  type MediaItem,
} from '../lib/platforms';
import { bodyToText } from '../lib/body';
import { ImagePicker } from './image-picker';
import { RichTextInput } from './rich-text';
import { WordPressOptions, type WordPressOptionsValue } from './wordpress-options';
import {
  MediaDropzone,
  MediaLibraryModal,
  MediaThumb,
  RemoveButton,
  useUploadMedia,
} from './media';

type Action = 'draft' | 'schedule' | 'now';

const isHttpUrl = (value: string) => {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
};

// Event handlers read the clock through this, outside render.
const currentTime = () => new Date();

/** First line of the text, for posts written without a title. */
const titleFromBody = (body: string) => body.trim().split('\n')[0]!.slice(0, 80).trim();

/** What to store: categories only for selected sites, and nothing when nothing is set. */
function wordpressOptionsFor(value: WordPressOptionsValue, accountIds: string[]) {
  const categories = Object.fromEntries(
    Object.entries(value.categories).filter(
      ([accountId, ids]) => accountIds.includes(accountId) && ids.length > 0,
    ),
  );
  return value.tags.length || Object.keys(categories).length
    ? { tags: value.tags, categories }
    : null;
}

/** Composer for a new post or an existing draft/scheduled post. */
export function PostEditor(props: { post?: Post; userId: string; onDone: () => void }) {
  const existing = props.post;
  const [title, setTitle] = useState(existing?.title ?? '');
  const [body, setBody] = useState(existing?.body ?? '');
  const [bodyText, setBodyText] = useState(() => bodyToText(existing?.body ?? ''));
  const [featuredMediaId, setFeaturedMediaId] = useState(existing?.featuredMediaId ?? null);
  const [thumbnailMediaId, setThumbnailMediaId] = useState(existing?.thumbnailMediaId ?? null);
  const [wordpress, setWordpress] = useState<WordPressOptionsValue>(
    existing?.wordpressOptions ?? { tags: [], categories: {} },
  );
  const [link, setLink] = useState(existing?.link ?? '');
  const [accountIds, setAccountIds] = useState<string[]>(existing?.accountIds ?? []);
  const [mediaIds, setMediaIds] = useState<string[]>(existing?.mediaIds ?? []);
  const [scheduledAt, setScheduledAt] = useState<Date | null>(
    existing?.scheduledAt ?? dayjs().add(1, 'hour').startOf('hour').toDate(),
  );
  const [saving, setSaving] = useState<Action | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [libraryOpen, library] = useDisclosure(false);
  // Keeps fresh uploads visible before the library query refetches.
  const [recent, setRecent] = useState<MediaItem[]>([]);

  const accounts = useQuery(api.accounts.list.queryOptions());
  const mediaList = useQuery(api.media.list.queryOptions());
  const mediaHost = useQuery(api.settings.mediaHost.queryOptions());
  const { upload, uploading } = useUploadMedia();

  const mediaById = useMemo(() => {
    const map = new Map<string, MediaItem>();
    for (const item of [...recent, ...(mediaList.data ?? [])]) map.set(item.id, item);
    return map;
  }, [recent, mediaList.data]);
  const media = mediaIds.flatMap((id) => mediaById.get(id) ?? []);
  const featured = (featuredMediaId && mediaById.get(featuredMediaId)) || null;
  const thumbnail = (thumbnailMediaId && mediaById.get(thumbnailMediaId)) || null;
  const pickImage = (set: (id: string | null) => void) => (item: MediaItem | null) => {
    if (item) setRecent((r) => [item, ...r]);
    set(item?.id ?? null);
  };

  const linkValue = link.trim() || null;
  const linkError = linkValue && !isHttpUrl(linkValue) ? 'Enter a full http(s):// URL' : null;
  const selected = (accounts.data ?? []).filter((a) => accountIds.includes(a.id));
  const problems = selected.flatMap((account) => {
    if (account.status !== 'active') return [{ account, message: 'Reconnect this account first.' }];
    const message = platformProblem(
      account.platform,
      {
        text: bodyText,
        link: linkValue,
        media,
        thumbnail,
      },
      { hasMediaHost: Boolean(mediaHost.data) },
    );
    return message ? [{ account, message }] : [];
  });
  const effectiveTitle = title.trim() || titleFromBody(bodyText);
  const hasPlatform = (platform: string) => selected.some((a) => a.platform === platform);
  const youtubeProblem = problems.find((p) => p.account.platform === 'youtube')?.message;
  const canPublish = selected.length > 0 && problems.length === 0 && !linkError && !uploading;

  async function addFiles(files: File[]) {
    const uploaded = await upload(files);
    setRecent((r) => [...uploaded, ...r]);
    setMediaIds((ids) => [...ids, ...uploaded.map((m) => m.id)]);
  }

  async function save(action: Action) {
    setError(null);
    if (!effectiveTitle) return setError('Add a title or some text.');
    if (linkError) return setError(linkError);
    const now = currentTime();
    const when = action === 'now' ? now : scheduledAt;
    if (action === 'schedule' && (!when || when.getTime() < now.getTime())) {
      return setError('Pick a time in the future, or use Publish now.');
    }

    const values = {
      title: effectiveTitle,
      body,
      link: linkValue,
      accountIds,
      mediaIds,
      featuredMediaId,
      thumbnailMediaId,
      wordpressOptions: wordpressOptionsFor(wordpress, accountIds),
      status: action === 'draft' ? ('draft' as const) : ('scheduled' as const),
      scheduledAt: action === 'draft' ? scheduledAt : when,
    };

    setSaving(action);
    try {
      const tx = existing
        ? postsCollection.update(existing.id, (draft) => {
            Object.assign(draft, values);
          })
        : postsCollection.insert({
            ...values,
            id: crypto.randomUUID(),
            userId: props.userId,
            targets: [],
            createdAt: now,
            updatedAt: now,
          });
      await tx.when('settled');
      notifications.show({
        color: 'green',
        message:
          action === 'draft'
            ? 'Draft saved.'
            : action === 'now'
              ? 'Publishing now. Status updates appear on the Posts page.'
              : `Scheduled for ${dayjs(when).format('ddd D MMM, HH:mm')}.`,
      });
      props.onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(null);
    }
  }

  return (
    <Grid gap="lg">
      <Grid.Col span={{ base: 12, md: 7 }}>
        <Stack>
          <TextInput
            label="Title"
            description="The WordPress post title and YouTube video title. Other platforms only use the text."
            placeholder={titleFromBody(bodyText) || 'Give the post a title'}
            value={title}
            onChange={(e) => setTitle(e.currentTarget.value)}
            maxLength={200}
          />
          <RichTextInput
            label="Text"
            description={`${bodyText.length.toLocaleString()} characters`}
            initialValue={existing?.body ?? ''}
            onChange={({ html, text }) => {
              setBody(html);
              setBodyText(text);
            }}
          />
          <TextInput
            label="Link"
            placeholder="https://example.com/article (optional)"
            value={link}
            onChange={(e) => setLink(e.currentTarget.value)}
            error={linkError}
          />

          <Stack gap="xs">
            <Group justify="space-between">
              <Text fw={500} size="sm">
                Media
              </Text>
              <Button size="compact-sm" variant="subtle" onClick={library.open}>
                Choose from library
              </Button>
            </Group>
            {media.length > 0 && (
              <SimpleGrid cols={{ base: 3, sm: 4 }} spacing="xs">
                {media.map((item, index) => (
                  <MediaThumb key={item.id} item={item}>
                    <RemoveButton
                      label={`Remove ${item.fileName}`}
                      onClick={() => setMediaIds((ids) => ids.filter((id) => id !== item.id))}
                    />
                    {index === 0 && media.length > 1 && (
                      <Badge size="xs" pos="absolute" top={6} left={6}>
                        First
                      </Badge>
                    )}
                  </MediaThumb>
                ))}
              </SimpleGrid>
            )}
            <MediaDropzone
              onFiles={(files) => void addFiles(files)}
              uploading={uploading}
              compact
            />
          </Stack>
        </Stack>
      </Grid.Col>

      <Grid.Col span={{ base: 12, md: 5 }}>
        <Stack>
          <Card withBorder>
            <Stack gap="sm">
              <Title order={5}>Post to</Title>
              {accounts.isLoading ? (
                <Loader size="sm" />
              ) : !accounts.data?.length ? (
                <Text size="sm" c="dimmed">
                  No accounts connected.{' '}
                  <Anchor component={Link} to="/accounts">
                    Connect one
                  </Anchor>{' '}
                  to publish.
                </Text>
              ) : (
                accounts.data.map((account) => {
                  const problem = problems.find((p) => p.account.id === account.id);
                  const checked = accountIds.includes(account.id);
                  return (
                    <Checkbox.Card
                      key={account.id}
                      checked={checked}
                      onClick={() =>
                        setAccountIds((ids) =>
                          checked ? ids.filter((id) => id !== account.id) : [...ids, account.id],
                        )
                      }
                      p="sm"
                      radius="md"
                      aria-label={`${PLATFORM_LABELS[account.platform]}: ${account.displayName}`}
                    >
                      <Group wrap="nowrap" align="flex-start">
                        <Checkbox.Indicator mt={2} />
                        <Stack gap={2} style={{ flex: 1, minWidth: 0 }}>
                          <Group gap={6} wrap="nowrap">
                            <Badge
                              size="xs"
                              variant="light"
                              color={PLATFORM_COLORS[account.platform]}
                            >
                              {PLATFORM_LABELS[account.platform]}
                            </Badge>
                            <Text size="sm" fw={500} truncate>
                              {account.displayName}
                            </Text>
                          </Group>
                          {checked && problem ? (
                            <Text size="xs" c="red">
                              {problem.message}
                            </Text>
                          ) : (
                            checked &&
                            PLATFORM_NOTES[account.platform] && (
                              <Text size="xs" c="dimmed">
                                {PLATFORM_NOTES[account.platform]}
                              </Text>
                            )
                          )}
                        </Stack>
                      </Group>
                    </Checkbox.Card>
                  );
                })
              )}
              {!!accounts.data?.length && (
                <Anchor component={Link} to="/accounts" size="sm">
                  Connect another account
                </Anchor>
              )}
            </Stack>
          </Card>

          {(hasPlatform('wordpress') || hasPlatform('youtube')) && (
            <Card withBorder>
              <Stack gap="md">
                <Title order={5}>Platform options</Title>
                {hasPlatform('wordpress') && (
                  <WordPressOptions
                    accounts={selected.filter((a) => a.platform === 'wordpress')}
                    value={wordpress}
                    onChange={setWordpress}
                  />
                )}
                {hasPlatform('wordpress') && (
                  <ImagePicker
                    label="WordPress featured image"
                    description="Shown on archive pages and link previews."
                    value={featured}
                    onChange={pickImage(setFeaturedMediaId)}
                    accept={['image/*']}
                    emptyText={'Not chosen: the first image in the post is used.'}
                  />
                )}
                {hasPlatform('youtube') && (
                  <ImagePicker
                    label="YouTube thumbnail"
                    description="JPEG or PNG, up to 2 MB, ideally 1280×720. Needs a verified channel."
                    value={thumbnail}
                    onChange={pickImage(setThumbnailMediaId)}
                    accept={['image/jpeg', 'image/png']}
                    emptyText="Not chosen: YouTube picks a frame from the video."
                    error={youtubeProblem?.includes('thumbnail') ? youtubeProblem : null}
                  />
                )}
              </Stack>
            </Card>
          )}

          <Card withBorder>
            <Stack gap="sm">
              <Title order={5}>When</Title>
              <DateTimePicker
                label="Publish at"
                value={scheduledAt ? dayjs(scheduledAt).format('YYYY-MM-DD HH:mm:ss') : null}
                onChange={(value) => setScheduledAt(value ? dayjs(value).toDate() : null)}
                minDate={dayjs().format('YYYY-MM-DD')}
                valueFormat="ddd D MMM YYYY, HH:mm"
                clearable
              />
              {error && (
                <Alert color="red" style={{ whiteSpace: 'pre-line' }}>
                  {error}
                </Alert>
              )}
              <Button
                onClick={() => void save('schedule')}
                loading={saving === 'schedule'}
                disabled={!canPublish || !scheduledAt || (saving !== null && saving !== 'schedule')}
              >
                {existing?.status === 'scheduled' ? 'Update schedule' : 'Schedule'}
              </Button>
              <Button
                variant="light"
                onClick={() => void save('now')}
                loading={saving === 'now'}
                disabled={!canPublish || (saving !== null && saving !== 'now')}
              >
                Publish now
              </Button>
              <Button
                variant="default"
                onClick={() => void save('draft')}
                loading={saving === 'draft'}
                disabled={uploading > 0 || (saving !== null && saving !== 'draft')}
              >
                {existing?.status === 'scheduled' ? 'Unschedule (back to draft)' : 'Save draft'}
              </Button>
              {!selected.length && (
                <Text size="xs" c="dimmed">
                  Select at least one account to schedule or publish. Drafts can be saved anytime.
                </Text>
              )}
            </Stack>
          </Card>
        </Stack>
      </Grid.Col>

      <MediaLibraryModal
        opened={libraryOpen}
        onClose={library.close}
        selected={mediaIds}
        onToggle={(item) =>
          setMediaIds((ids) =>
            ids.includes(item.id) ? ids.filter((id) => id !== item.id) : [...ids, item.id],
          )
        }
      />
    </Grid>
  );
}
