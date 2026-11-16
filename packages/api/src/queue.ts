// Posting slots: fixed weekly times ("Mon 09:00") that "Add to queue" fills in order.
// Slot times are wall-clock times in the owner's time zone, so 09:00 stays 09:00 across daylight
// saving changes. Everything here is plain synchronous code, so a transaction can call it.
import { post, queueSlot, type Db } from '@posthub/db';
import { and, eq, gte, isNull, or, inArray } from 'drizzle-orm';
import { readSettingRow } from './settings';

export interface Slot {
  /** 0 = Sunday ... 6 = Saturday. */
  weekday: number;
  minuteOfDay: number;
}

/** How far ahead to look for a free slot. */
const SEARCH_DAYS = 7 * 8;

const partsFormat = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string) {
  let format = partsFormat.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    partsFormat.set(timeZone, format);
  }
  return format;
}

/** Wall-clock date and time of `ms` in `timeZone`. */
export function wallClock(ms: number, timeZone: string) {
  const parts: Record<string, number> = {};
  for (const part of formatter(timeZone).formatToParts(new Date(ms))) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  return {
    year: parts.year!,
    month: parts.month!,
    day: parts.day!,
    hour: parts.hour!,
    minute: parts.minute!,
    second: parts.second!,
  };
}

/** Offset of `timeZone` from UTC at instant `ms`, in milliseconds. */
function offsetAt(ms: number, timeZone: string) {
  const w = wallClock(ms, timeZone);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/**
 * The instant at which the wall clock in `timeZone` shows this date and time. A time skipped by
 * a daylight saving change (02:30 when clocks jump from 02:00 to 03:00) moves forward by the gap;
 * a repeated time (when clocks go back) is its first occurrence.
 */
export function zonedTime(
  date: { year: number; month: number; day: number },
  minuteOfDay: number,
  timeZone: string,
) {
  const guess = Date.UTC(date.year, date.month - 1, date.day, 0, minuteOfDay);
  const before = offsetAt(guess - 86_400_000 / 2, timeZone);
  const after = offsetAt(guess + 86_400_000 / 2, timeZone);
  // Earliest candidate first, so a repeated time resolves to its first occurrence.
  const candidates = [guess - Math.max(before, after), guess - Math.min(before, after)];
  for (const candidate of candidates) {
    if (offsetAt(candidate, timeZone) === guess - candidate) return candidate;
  }
  // Skipped by the change: the same wall time with the offset from before the jump.
  return guess - before;
}

/**
 * The first slot time after `now` that is not in `taken` (ms timestamps), or null when no slot
 * is free in the coming weeks (or there are no slots).
 */
export function nextSlotTime(
  slots: Slot[],
  taken: Iterable<number>,
  now: number,
  timeZone: string,
): number | null {
  if (!slots.length) return null;
  const busy = new Set(taken);
  const today = wallClock(now, timeZone);
  for (let offset = 0; offset < SEARCH_DAYS; offset++) {
    // Calendar arithmetic on a UTC date: no time zone involved.
    const day = new Date(Date.UTC(today.year, today.month - 1, today.day + offset));
    const date = {
      year: day.getUTCFullYear(),
      month: day.getUTCMonth() + 1,
      day: day.getUTCDate(),
    };
    const times = slots
      .filter((slot) => slot.weekday === day.getUTCDay())
      .map((slot) => zonedTime(date, slot.minuteOfDay, timeZone))
      .sort((a, b) => a - b);
    const free = times.find((time) => time > now && !busy.has(time));
    if (free !== undefined) return free;
  }
  return null;
}

/** The machine's time zone: the default until the owner saves slots from a browser. */
export const systemTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

export function readTimeZone(db: Db, userId: string) {
  const row = readSettingRow(db, userId, 'timezone');
  return row ? (JSON.parse(row.value) as string) : systemTimeZone();
}

export const readSlots = (db: Db, userId: string) =>
  db.select().from(queueSlot).where(eq(queueSlot.userId, userId)).all();

/**
 * The next free slot for a post going to `accountIds` (global slots plus those accounts' own),
 * skipping times other scheduled posts already have. Synchronous: safe inside a transaction.
 */
export function findNextSlot(
  db: Db,
  userId: string,
  now: number,
  options: { accountIds?: string[]; excludePostId?: string } = {},
): Date | null {
  const accountIds = options.accountIds ?? [];
  const slots = db
    .select()
    .from(queueSlot)
    .where(
      and(
        eq(queueSlot.userId, userId),
        accountIds.length
          ? or(isNull(queueSlot.socialAccountId), inArray(queueSlot.socialAccountId, accountIds))
          : isNull(queueSlot.socialAccountId),
      ),
    )
    .all();
  const taken = db
    .select({ id: post.id, scheduledAt: post.scheduledAt })
    .from(post)
    .where(
      and(
        eq(post.userId, userId),
        eq(post.status, 'scheduled'),
        gte(post.scheduledAt, new Date(now)),
      ),
    )
    .all()
    .filter((p) => p.id !== options.excludePostId && p.scheduledAt)
    .map((p) => p.scheduledAt!.getTime());
  const next = nextSlotTime(slots, taken, now, readTimeZone(db, userId));
  return next === null ? null : new Date(next);
}
