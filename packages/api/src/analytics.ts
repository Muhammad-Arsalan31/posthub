// Analytics definitions, in one place. Snapshots are cumulative totals, so:
//   - what a target gained in a period is the sum of its snapshot-to-snapshot deltas captured in the
//     period (the first snapshot counts in full), which equals "latest in period minus last before";
//   - a post's value up to a moment is its latest snapshot at or before that moment.
// Engagement is likes + comments + shares + saves; its rate divides by reach, falling back to views.
// Platforms report different metrics, so totals are per metric with the platforms that reported it.
// Everything is plain synchronous code over rows loaded with Drizzle (`loadAnalytics`).
import {
  mediaAsset,
  post,
  postMedia,
  postMetricSnapshot,
  postTarget,
  socialAccount,
  type Db,
  type Platform,
} from '@posthub/db';
import { and, asc, eq, inArray, isNotNull } from 'drizzle-orm';
import { wallClock } from './queue';

export const METRICS = [
  'views',
  'reach',
  'likes',
  'comments',
  'shares',
  'saves',
  'clicks',
  'engagement',
] as const;
export type Metric = (typeof METRICS)[number];
type Stored = Exclude<Metric, 'engagement'>;

export type ContentType = 'video' | 'image' | 'link' | 'text';

export interface SnapshotRow {
  capturedAt: Date;
  views: number | null;
  reach: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
  clicks: number | null;
}

export interface TargetRow {
  targetId: string;
  postId: string;
  title: string;
  accountId: string;
  platform: Platform;
  publishedAt: Date;
  contentType: ContentType;
  /** Oldest first. */
  snapshots: SnapshotRow[];
}

const ENGAGEMENT: Stored[] = ['likes', 'comments', 'shares', 'saves'];

/** A metric's value in one snapshot; null when the platform didn't report it. */
export function metricOf(snapshot: SnapshotRow, metric: Metric): number | null {
  if (metric !== 'engagement') return snapshot[metric];
  const parts = ENGAGEMENT.map((m) => snapshot[m]).filter((v): v is number => v !== null);
  return parts.length ? parts.reduce((a, b) => a + b, 0) : null;
}

/** Engagement divided by reach (or views); null when neither exists or it is zero. */
export function engagementRate(snapshot: SnapshotRow): number | null {
  const engagement = metricOf(snapshot, 'engagement');
  const base = snapshot.reach || snapshot.views;
  return engagement === null || !base ? null : engagement / base;
}

/** Latest snapshot at or before `at`. */
export const latestAt = (target: TargetRow, at = Infinity) =>
  target.snapshots.findLast((s) => s.capturedAt.getTime() <= at);

/** Each snapshot's gain over the previous one with a value for `metric`. */
export function deltas(target: TargetRow, metric: Metric) {
  const out: Array<{ at: number; value: number }> = [];
  let previous = 0;
  for (const snapshot of target.snapshots) {
    const value = metricOf(snapshot, metric);
    if (value === null) continue;
    out.push({ at: snapshot.capturedAt.getTime(), value: value - previous });
    previous = value;
  }
  return out;
}

export interface MetricTotal {
  metric: Metric;
  /** Null when no target reported this metric in the period. */
  value: number | null;
  platforms: Platform[];
}

/** What the targets gained in [from, to], per metric. */
export function totals(targets: TargetRow[], from: number, to: number): MetricTotal[] {
  return METRICS.map((metric) => {
    let value: number | null = null;
    const platforms = new Set<Platform>();
    for (const target of targets) {
      for (const delta of deltas(target, metric)) {
        if (delta.at < from || delta.at > to) continue;
        value = (value ?? 0) + delta.value;
        platforms.add(target.platform);
      }
    }
    return { metric, value, platforms: [...platforms].sort() };
  });
}

/** `YYYY-MM-DD` of `ms` in `timeZone`; weeks start on Monday. */
export function bucketOf(ms: number, timeZone: string, groupBy: 'day' | 'week') {
  const w = wallClock(ms, timeZone);
  const day = new Date(Date.UTC(w.year, w.month - 1, w.day));
  if (groupBy === 'week') day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7));
  return day.toISOString().slice(0, 10);
}

/** Every bucket between `from` and `to`, in order (so empty days show as zero). */
export function bucketsBetween(
  from: number,
  to: number,
  timeZone: string,
  groupBy: 'day' | 'week',
) {
  const first = bucketOf(from, timeZone, groupBy);
  const last = bucketOf(to, timeZone, groupBy);
  const keys: string[] = [];
  const step = groupBy === 'week' ? 7 : 1;
  for (let d = new Date(`${first}T00:00:00Z`); ; d.setUTCDate(d.getUTCDate() + step)) {
    const key = d.toISOString().slice(0, 10);
    if (key > last) break;
    keys.push(key);
    if (keys.length > 800) break;
  }
  return keys;
}

/** Gain per day or week, per platform. */
export function timeseries(
  targets: TargetRow[],
  metric: Metric,
  from: number,
  to: number,
  timeZone: string,
  groupBy: 'day' | 'week',
) {
  const buckets = bucketsBetween(from, to, timeZone, groupBy);
  const values = new Map<string, Partial<Record<Platform, number>>>(buckets.map((b) => [b, {}]));
  const platforms = new Set<Platform>();
  for (const target of targets) {
    for (const delta of deltas(target, metric)) {
      if (delta.at < from || delta.at > to) continue;
      const row = values.get(bucketOf(delta.at, timeZone, groupBy));
      if (!row) continue;
      row[target.platform] = (row[target.platform] ?? 0) + delta.value;
      platforms.add(target.platform);
    }
  }
  return {
    platforms: [...platforms].sort(),
    points: buckets.map((bucket) => ({ bucket, values: values.get(bucket)! })),
  };
}

/** Posts published in [from, to], by their latest value of `metric` up to `to`. */
export function topPosts(
  targets: TargetRow[],
  metric: Metric,
  from: number,
  to: number,
  limit: number,
) {
  const byPost = new Map<
    string,
    {
      postId: string;
      title: string;
      publishedAt: Date;
      value: number | null;
      platforms: Set<Platform>;
    }
  >();
  for (const target of targets) {
    const at = target.publishedAt.getTime();
    if (at < from || at > to) continue;
    const entry = byPost.get(target.postId) ?? {
      postId: target.postId,
      title: target.title,
      publishedAt: target.publishedAt,
      value: null,
      platforms: new Set<Platform>(),
    };
    entry.platforms.add(target.platform);
    if (target.publishedAt < entry.publishedAt) entry.publishedAt = target.publishedAt;
    const latest = latestAt(target, to);
    const value = latest ? metricOf(latest, metric) : null;
    if (value !== null) entry.value = (entry.value ?? 0) + value;
    byPost.set(target.postId, entry);
  }
  return [...byPost.values()]
    .filter((p) => p.value !== null)
    .sort((a, b) => b.value! - a.value!)
    .slice(0, limit)
    .map((p) => ({ ...p, platforms: [...p.platforms].sort() }));
}

/** Average engagement rate by weekday (0 = Sunday) and hour of publishing, in `timeZone`. */
export function bestTimes(targets: TargetRow[], timeZone: string) {
  const cells = new Map<string, { weekday: number; hour: number; total: number; posts: number }>();
  for (const target of targets) {
    const latest = latestAt(target);
    const rate = latest ? engagementRate(latest) : null;
    if (rate === null) continue;
    const w = wallClock(target.publishedAt.getTime(), timeZone);
    const weekday = new Date(Date.UTC(w.year, w.month - 1, w.day)).getUTCDay();
    const key = `${weekday}:${w.hour}`;
    const cell = cells.get(key) ?? { weekday, hour: w.hour, total: 0, posts: 0 };
    cell.total += rate;
    cell.posts++;
    cells.set(key, cell);
  }
  return [...cells.values()].map(({ total, ...cell }) => ({
    ...cell,
    rate: total / cell.posts,
    lowConfidence: cell.posts < 3,
  }));
}

/** Average engagement and engagement rate per kind of post (by its latest numbers). */
export function byContentType(targets: TargetRow[], to = Infinity) {
  const groups = new Map<
    ContentType,
    { posts: Set<string>; engagement: number[]; rates: number[] }
  >();
  for (const target of targets) {
    const group = groups.get(target.contentType) ?? { posts: new Set(), engagement: [], rates: [] };
    group.posts.add(target.postId);
    const latest = latestAt(target, to);
    const engagement = latest ? metricOf(latest, 'engagement') : null;
    const rate = latest ? engagementRate(latest) : null;
    if (engagement !== null) group.engagement.push(engagement);
    if (rate !== null) group.rates.push(rate);
    groups.set(target.contentType, group);
  }
  const average = (values: number[]) =>
    values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
  return [...groups].map(([contentType, group]) => ({
    contentType,
    posts: group.posts.size,
    averageEngagement: average(group.engagement),
    averageRate: average(group.rates),
  }));
}

/** The owner's published targets with their snapshots, optionally for some accounts only. */
export function loadAnalytics(db: Db, userId: string, accountIds?: readonly string[]): TargetRow[] {
  const rows = db
    .select({
      targetId: postTarget.id,
      postId: post.id,
      title: post.title,
      link: post.link,
      accountId: socialAccount.id,
      platform: socialAccount.platform,
      publishedAt: postTarget.publishedAt,
    })
    .from(postTarget)
    .innerJoin(post, eq(post.id, postTarget.postId))
    .innerJoin(socialAccount, eq(socialAccount.id, postTarget.socialAccountId))
    .where(
      and(
        eq(post.userId, userId),
        eq(postTarget.status, 'published'),
        isNotNull(postTarget.publishedAt),
        accountIds?.length ? inArray(socialAccount.id, [...accountIds]) : undefined,
      ),
    )
    .all();
  if (!rows.length) return [];

  const targetIds = rows.map((r) => r.targetId);
  const postIds = [...new Set(rows.map((r) => r.postId))];
  const snapshots = db
    .select()
    .from(postMetricSnapshot)
    .where(inArray(postMetricSnapshot.postTargetId, targetIds))
    .orderBy(asc(postMetricSnapshot.capturedAt))
    .all();
  const media = db
    .select({ postId: postMedia.postId, mimeType: mediaAsset.mimeType })
    .from(postMedia)
    .innerJoin(mediaAsset, eq(mediaAsset.id, postMedia.mediaId))
    .where(inArray(postMedia.postId, postIds))
    .all();

  const contentType = (postId: string, link: string | null): ContentType => {
    const types = media.filter((m) => m.postId === postId).map((m) => m.mimeType);
    if (types.some((t) => t.startsWith('video/'))) return 'video';
    if (types.some((t) => t.startsWith('image/'))) return 'image';
    return link ? 'link' : 'text';
  };

  return rows.map(({ link, publishedAt, ...row }) => ({
    ...row,
    publishedAt: publishedAt!,
    contentType: contentType(row.postId, link),
    snapshots: snapshots.filter((s) => s.postTargetId === row.targetId),
  }));
}

const csvCell = (value: string | number | null) => {
  const text = value === null || value === undefined ? '' : String(value);
  // Quote when needed; a leading = + - @ is neutralised so spreadsheets don't run it as a formula.
  const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return /[",\n\r]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
};

/** One row per target published in [from, to], with its latest numbers up to `to`. */
export function analyticsCsv(targets: TargetRow[], from: number, to: number) {
  const columns: Stored[] = ['views', 'reach', 'likes', 'comments', 'shares', 'saves', 'clicks'];
  const header = ['post', 'platform', 'published_at', ...columns, 'engagement'];
  const rows = targets
    .filter((t) => t.publishedAt.getTime() >= from && t.publishedAt.getTime() <= to)
    .sort((a, b) => a.publishedAt.getTime() - b.publishedAt.getTime())
    .map((target) => {
      const latest = latestAt(target, to);
      return [
        target.title,
        target.platform,
        target.publishedAt.toISOString(),
        ...columns.map((c) => latest?.[c] ?? null),
        latest ? metricOf(latest, 'engagement') : null,
      ];
    });
  return [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
