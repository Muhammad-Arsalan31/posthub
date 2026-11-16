const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** How often to read a post's numbers, by its age; null once it is old enough to stop. */
export function nextMetricsRun(publishedAt: number, now: number): number | null {
  const age = now - publishedAt;
  if (age < 48 * HOUR) return now + HOUR;
  if (age < 7 * DAY) return now + 6 * HOUR;
  if (age < 30 * DAY) return now + DAY;
  if (age < 90 * DAY) return now + 7 * DAY;
  return null;
}
