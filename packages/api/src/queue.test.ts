import { describe, expect, it } from 'vite-plus/test';
import { nextSlotTime, zonedTime } from './queue';

const at = (iso: string) => new Date(iso).getTime();
const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
// Monday 2030-01-07.
const MONDAY_9 = { weekday: 1, minuteOfDay: 9 * 60 };
const WEDNESDAY_1730 = { weekday: 3, minuteOfDay: 17 * 60 + 30 };

describe('nextSlotTime', () => {
  it.each([
    [{ year: 2030, month: 9, day: 29 }, 150, 'Pacific/Auckland', '2030-09-28T14:30:00.000Z'],
    [{ year: 2030, month: 4, day: 7 }, 150, 'Pacific/Auckland', '2030-04-06T13:30:00.000Z'],
    [{ year: 2030, month: 10, day: 6 }, 135, 'Australia/Lord_Howe', '2030-10-05T15:45:00.000Z'],
    [{ year: 2030, month: 4, day: 7 }, 105, 'Australia/Lord_Howe', '2030-04-06T14:45:00.000Z'],
  ] as const)(
    'resolves DST gaps and overlaps near the date line: %j %i %s',
    (date, minute, zone, expected) => {
      expect(iso(zonedTime(date, minute, zone))).toBe(expected);
    },
  );

  it('finds the next slot after now in the owner time zone', () => {
    const now = at('2030-01-07T07:00:00Z'); // 08:00 in Berlin, Monday
    expect(iso(nextSlotTime([MONDAY_9, WEDNESDAY_1730], [], now, 'Europe/Berlin'))).toBe(
      '2030-01-07T08:00:00.000Z',
    );
    // 09:00 has passed: Wednesday 17:30.
    expect(
      iso(
        nextSlotTime([MONDAY_9, WEDNESDAY_1730], [], at('2030-01-07T08:00:00Z'), 'Europe/Berlin'),
      ),
    ).toBe('2030-01-09T16:30:00.000Z');
  });

  it('skips slots other posts already have', () => {
    const now = at('2030-01-07T00:00:00Z');
    const taken = [at('2030-01-07T09:00:00Z'), at('2030-01-14T09:00:00Z')];
    expect(iso(nextSlotTime([MONDAY_9], taken, now, 'UTC'))).toBe('2030-01-21T09:00:00.000Z');
  });

  it('returns null without slots', () => {
    expect(nextSlotTime([], [], at('2030-01-07T00:00:00Z'), 'UTC')).toBeNull();
  });

  it('keeps the wall-clock time across daylight saving changes', () => {
    // Europe/Berlin moves to summer time on Sunday 2030-03-31.
    const sunday9 = { weekday: 0, minuteOfDay: 9 * 60 };
    expect(iso(nextSlotTime([sunday9], [], at('2030-03-25T00:00:00Z'), 'Europe/Berlin'))).toBe(
      '2030-03-31T07:00:00.000Z', // 09:00 CEST
    );
    expect(iso(nextSlotTime([sunday9], [], at('2030-03-20T00:00:00Z'), 'Europe/Berlin'))).toBe(
      '2030-03-24T08:00:00.000Z', // 09:00 CET
    );
  });

  it('moves a time skipped by the spring change forward, and takes the first of a repeated one', () => {
    // New York: 02:30 does not exist on 2030-03-10; 01:30 happens twice on 2030-11-03.
    expect(iso(zonedTime({ year: 2030, month: 3, day: 10 }, 150, 'America/New_York'))).toBe(
      '2030-03-10T07:30:00.000Z', // 03:30 EDT
    );
    expect(iso(zonedTime({ year: 2030, month: 11, day: 3 }, 90, 'America/New_York'))).toBe(
      '2030-11-03T05:30:00.000Z', // 01:30 EDT, the first one
    );
  });
});
