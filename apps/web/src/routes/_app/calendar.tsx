import { Badge, Box, Button, Card, Group, Paper, Select, Stack, Text, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { Schedule, type ScheduleEventData, type ScheduleViewLevel } from '@mantine/schedule';
import { EDITABLE_STATUSES, PLATFORMS, type QueueSlot } from '@posthub/contract';
import { useQuery } from '@tanstack/react-query';
import { useLiveQuery } from '@tanstack/react-db';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import dayjs from 'dayjs';
import { useState, type DragEvent } from 'react';
import { postsCollection, type Post } from '../../collections/posts';
import { api } from '../../lib/api';
import { PLATFORM_COLORS, PLATFORM_LABELS, type Account } from '../../lib/platforms';

export const Route = createFileRoute('/_app/calendar')({ component: CalendarPage });

const STATUS_COLORS: Record<Post['status'], string> = {
  draft: 'gray',
  scheduled: 'blue',
  publishing: 'yellow',
  published: 'green',
  failed: 'red',
};
/** Posts are instants; give them a length so they show up in the week view. */
const EVENT_MINUTES = 30;
/** Time given to a post dropped on a day in the month view. */
const DEFAULT_HOUR = 9;
/** Drag data type for the Unscheduled list. */
const POST_DRAG_TYPE = 'application/x-posthub-post';
const RRULE_DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const FORMAT = 'YYYY-MM-DD HH:mm:ss';

const isEditable = (post: Post) => (EDITABLE_STATUSES as readonly string[]).includes(post.status);

interface Filters {
  accountId: string | null;
  platform: string | null;
  status: string | null;
}

/** A post as a calendar event. */
function postEvent(post: Post, platforms: string[]): ScheduleEventData<{ post: Post }> {
  const start = dayjs(post.scheduledAt);
  return {
    id: post.id,
    title: platforms.length ? `${post.title} · ${platforms.join(', ')}` : post.title,
    start: start.format(FORMAT),
    end: start.add(EVENT_MINUTES, 'minute').format(FORMAT),
    color: STATUS_COLORS[post.status],
    variant: post.status === 'draft' ? 'light' : 'filled',
    payload: { post },
  };
}

/** A weekly queue slot as a faint, repeating background block. */
function slotEvent(slot: QueueSlot, index: number): ScheduleEventData {
  const today = dayjs().startOf('day');
  const first = today
    .add((slot.weekday - today.day() + 7) % 7, 'day')
    .add(slot.minuteOfDay, 'minute');
  return {
    id: `slot-${index}`,
    title: 'Free slot',
    start: first.format(FORMAT),
    end: first.add(EVENT_MINUTES, 'minute').format(FORMAT),
    color: 'gray',
    display: 'background',
    recurrence: {
      rrule: `FREQ=WEEKLY;BYDAY=${RRULE_DAYS[slot.weekday]}`,
      dtstart: first.format(FORMAT),
    },
  };
}

function CalendarPage() {
  const navigate = useNavigate();
  const [view, setView] = useState<ScheduleViewLevel>('month');
  const [filters, setFilters] = useState<Filters>({
    accountId: null,
    platform: null,
    status: null,
  });
  const accounts = useQuery(api.accounts.list.queryOptions());
  const queue = useQuery(api.queue.slots.queryOptions());
  const { data: posts } = useLiveQuery((q) => q.from({ post: postsCollection }));

  const accountsById = new Map((accounts.data ?? []).map((a) => [a.id, a]));
  const platformsOf = (post: Post) => [
    ...new Set(post.accountIds.flatMap((id) => accountsById.get(id)?.platform ?? [])),
  ];
  const visible = posts.filter((post) => {
    if (filters.status && post.status !== filters.status) return false;
    if (filters.accountId && !post.accountIds.includes(filters.accountId)) return false;
    if (filters.platform && !platformsOf(post).includes(filters.platform as Account['platform'])) {
      return false;
    }
    return true;
  });
  const unscheduled = visible.filter((post) => !post.scheduledAt && post.status === 'draft');
  const events: ScheduleEventData[] = [
    ...visible
      .filter((post) => post.scheduledAt)
      .map((post) =>
        postEvent(
          post,
          platformsOf(post).map((p) => PLATFORM_LABELS[p]),
        ),
      ),
    // Free slots only where times are visible; in the month view they would fill every day.
    ...(view === 'month' ? [] : (queue.data?.slots ?? []).map(slotEvent)),
  ];

  const postOf = (event: ScheduleEventData) => posts.find((p) => p.id === event.id);

  function move(postId: string, when: Date) {
    const post = posts.find((p) => p.id === postId);
    if (!post) return;
    if (!isEditable(post)) {
      notifications.show({
        color: 'red',
        message: 'Only drafts and scheduled posts can be moved.',
      });
      return;
    }
    if (post.status === 'scheduled' && when.getTime() < Date.now()) {
      notifications.show({ color: 'red', message: 'Scheduled posts must stay in the future.' });
      return;
    }
    const tx = postsCollection.update(post.id, (draft) => {
      draft.scheduledAt = when;
    });
    tx.when('settled').catch((error: unknown) =>
      notifications.show({
        color: 'red',
        message: error instanceof Error ? error.message : String(error),
      }),
    );
  }

  const createAt = (when: dayjs.Dayjs) =>
    void navigate({ to: '/posts/new', search: { at: when.toISOString() } });

  return (
    <Stack>
      <Group justify="space-between">
        <Title order={2}>Calendar</Title>
        <Button component={Link} to="/posts/new">
          New post
        </Button>
      </Group>

      <Group gap="xs">
        <Select
          size="xs"
          placeholder="All accounts"
          clearable
          value={filters.accountId}
          onChange={(accountId) => setFilters((f) => ({ ...f, accountId }))}
          data={(accounts.data ?? []).map((a) => ({
            value: a.id,
            label: `${PLATFORM_LABELS[a.platform]}: ${a.displayName}`,
          }))}
          aria-label="Account"
        />
        <Select
          size="xs"
          placeholder="All platforms"
          clearable
          value={filters.platform}
          onChange={(platform) => setFilters((f) => ({ ...f, platform }))}
          data={PLATFORMS.map((p) => ({ value: p, label: PLATFORM_LABELS[p] }))}
          aria-label="Platform"
        />
        <Select
          size="xs"
          placeholder="All statuses"
          clearable
          value={filters.status}
          onChange={(status) => setFilters((f) => ({ ...f, status }))}
          data={Object.keys(STATUS_COLORS).map((s) => ({
            value: s,
            label: s[0]!.toUpperCase() + s.slice(1),
          }))}
          aria-label="Status"
        />
      </Group>

      <Group align="flex-start" wrap="nowrap" gap="md">
        <Box style={{ flex: 1, minWidth: 0 }}>
          <Schedule
            view={view}
            onViewChange={setView}
            events={events}
            withEventsDragAndDrop
            canDragEvent={(event) => {
              const post = postOf(event);
              return Boolean(post && isEditable(post));
            }}
            canDropEvent={({ event, start }) => {
              const post = postOf(event);
              return !(post?.status === 'scheduled' && dayjs(start).isBefore(dayjs()));
            }}
            onEventDrop={({ eventId, newStart }) => move(String(eventId), dayjs(newStart).toDate())}
            canDropExternalEvent={({ dataTransfer }) => dataTransfer.types.includes(POST_DRAG_TYPE)}
            onExternalEventDrop={(dataTransfer, dropDateTime) => {
              const id = dataTransfer.getData(POST_DRAG_TYPE);
              let when = dayjs(dropDateTime);
              // A month-view day has no time: use the default posting hour.
              if (view === 'month') when = when.startOf('day').hour(DEFAULT_HOUR);
              if (id) move(id, when.toDate());
            }}
            onEventClick={(event) => {
              if (postOf(event)) {
                void navigate({ to: '/posts/$postId', params: { postId: String(event.id) } });
              }
            }}
            onDayClick={(date) => createAt(dayjs(date).hour(DEFAULT_HOUR))}
            onTimeSlotClick={({ slotStart }) => createAt(dayjs(slotStart))}
            monthViewProps={{ maxEventsPerDay: 4 }}
            weekViewProps={{ startScrollTime: '07:00:00', withAllDaySlots: false }}
            dayViewProps={{ startScrollTime: '07:00:00', withAllDaySlot: false }}
          />
        </Box>

        <Card withBorder w={220} padding="sm" style={{ flexShrink: 0 }}>
          <Stack gap="xs">
            <Text fw={600} size="sm">
              Unscheduled
            </Text>
            <Text size="xs" c="dimmed">
              Drafts without a date. Drag one onto the calendar to give it one.
            </Text>
            {unscheduled.length ? (
              unscheduled.map((post) => (
                <Paper
                  key={post.id}
                  role="link"
                  tabIndex={0}
                  onClick={() =>
                    void navigate({ to: '/posts/$postId', params: { postId: post.id } })
                  }
                  draggable
                  onDragStart={(event: DragEvent) =>
                    event.dataTransfer.setData(POST_DRAG_TYPE, post.id)
                  }
                  withBorder
                  px={8}
                  py={4}
                  radius="sm"
                  style={{
                    display: 'block',
                    cursor: 'grab',
                    color: 'inherit',
                    textDecoration: 'none',
                  }}
                >
                  <Text size="xs" fw={500} truncate>
                    {post.title}
                  </Text>
                  <Group gap={2} mt={2}>
                    {platformsOf(post).map((platform) => (
                      <Badge
                        key={platform}
                        size="xs"
                        variant="light"
                        color={PLATFORM_COLORS[platform]}
                      >
                        {PLATFORM_LABELS[platform]}
                      </Badge>
                    ))}
                  </Group>
                </Paper>
              ))
            ) : (
              <Text size="xs" c="dimmed" fs="italic">
                None
              </Text>
            )}
          </Stack>
        </Card>
      </Group>
    </Stack>
  );
}
