import { describe, expect, it } from 'vite-plus/test';
import {
  bestTimes,
  bucketOf,
  bucketsBetween,
  byContentType,
  engagementRate,
  timeseries,
  topPosts,
  totals,
  type SnapshotRow,
  type TargetRow,
} from './analytics';

const at = (iso: string) => new Date(iso).getTime();
const snap = (iso: string, values: Partial<SnapshotRow>): SnapshotRow => ({
  capturedAt: new Date(iso),
  views: null,
  reach: null,
  likes: null,
  comments: null,
  shares: null,
  saves: null,
  clicks: null,
  ...values,
});
const target = (over: Partial<TargetRow> & Pick<TargetRow, 'snapshots'>): TargetRow => ({
  targetId: crypto.randomUUID(),
  postId: 'p1',
  title: 'Post',
  accountId: 'a1',
  platform: 'youtube',
  publishedAt: new Date('2030-01-01T09:00:00Z'),
  contentType: 'video',
  ...over,
});

const video = target({
  snapshots: [
    snap('2030-01-01T10:00:00Z', { views: 100, likes: 5 }),
    snap('2030-01-05T10:00:00Z', { views: 300, likes: 9 }),
    snap('2030-01-12T10:00:00Z', { views: 350, likes: 10 }),
  ],
});
const page = target({
  postId: 'p2',
  platform: 'facebook',
  contentType: 'image',
  snapshots: [snap('2030-01-06T10:00:00Z', { reach: 80, likes: 4, comments: 1 })],
});

describe('totals', () => {
  it('counts what was gained in the period, from cumulative snapshots', () => {
    const week = totals([video, page], at('2030-01-02T00:00:00Z'), at('2030-01-08T23:59:59Z'));
    const by = Object.fromEntries(week.map((t) => [t.metric, t]));
    // 300 - 100 gained between the snapshots on the 1st and the 5th.
    expect(by.views).toEqual({ metric: 'views', value: 200, platforms: ['youtube'] });
    expect(by.likes).toEqual({ metric: 'likes', value: 4 + 4, platforms: ['facebook', 'youtube'] });
    // Views and reach are never added together.
    expect(by.reach).toEqual({ metric: 'reach', value: 80, platforms: ['facebook'] });
    expect(by.clicks!.value).toBeNull();
  });

  it('counts a post in full in the period of its first snapshot', () => {
    const first = totals([video], at('2030-01-01T00:00:00Z'), at('2030-01-01T23:59:59Z'));
    expect(first.find((t) => t.metric === 'views')!.value).toBe(100);
  });
});

describe('engagement', () => {
  it('divides by reach, falls back to views, and stays empty without either', () => {
    expect(engagementRate(snap('2030-01-01', { reach: 50, views: 1000, likes: 5 }))).toBe(0.1);
    expect(engagementRate(snap('2030-01-01', { views: 200, likes: 4, comments: 6 }))).toBe(0.05);
    expect(engagementRate(snap('2030-01-01', { likes: 4 }))).toBeNull();
    expect(engagementRate(snap('2030-01-01', { views: 10 }))).toBeNull();
  });
});

describe('buckets', () => {
  it('groups by week starting Monday, across a year boundary', () => {
    // Thursday 2026-12-31 and Sunday 2027-01-03 share the week of Monday 2026-12-28.
    expect(bucketOf(at('2026-12-31T12:00:00Z'), 'UTC', 'week')).toBe('2026-12-28');
    expect(bucketOf(at('2027-01-03T12:00:00Z'), 'UTC', 'week')).toBe('2026-12-28');
    expect(bucketOf(at('2027-01-04T12:00:00Z'), 'UTC', 'week')).toBe('2027-01-04');
    expect(
      bucketsBetween(at('2026-12-20T00:00:00Z'), at('2027-01-05T00:00:00Z'), 'UTC', 'week'),
    ).toEqual(['2026-12-14', '2026-12-21', '2026-12-28', '2027-01-04']);
  });

  it('uses the owner time zone for days', () => {
    // 23:30 UTC is already the next day in Berlin.
    expect(bucketOf(at('2030-01-01T23:30:00Z'), 'Europe/Berlin', 'day')).toBe('2030-01-02');
  });

  it('builds a series per platform with empty days included', () => {
    const series = timeseries(
      [video, page],
      'likes',
      at('2030-01-04T00:00:00Z'),
      at('2030-01-06T23:59:59Z'),
      'UTC',
      'day',
    );
    expect(series).toEqual({
      platforms: ['facebook', 'youtube'],
      points: [
        { bucket: '2030-01-04', values: {} },
        { bucket: '2030-01-05', values: { youtube: 4 } },
        { bucket: '2030-01-06', values: { facebook: 4 } },
      ],
    });
  });
});

describe('top posts, best times and content types', () => {
  it('ranks posts published in the period by their latest value', () => {
    const top = topPosts(
      [video, page],
      'likes',
      at('2030-01-01T00:00:00Z'),
      at('2030-01-31T00:00:00Z'),
      5,
    );
    expect(top.map((p) => [p.postId, p.value])).toEqual([
      ['p1', 10],
      ['p2', 4],
    ]);
  });

  it('averages engagement rate by weekday and hour of publishing, and flags small samples', () => {
    const rated = (iso: string, reach: number, likes: number) =>
      target({
        publishedAt: new Date(iso),
        snapshots: [snap('2030-02-01T00:00:00Z', { reach, likes })],
      });
    const cells = bestTimes(
      [
        rated('2030-01-07T08:10:00Z', 100, 10), // Monday 09:10 in Berlin
        rated('2030-01-14T08:50:00Z', 100, 20),
        rated('2030-01-21T08:30:00Z', 100, 30),
        rated('2030-01-08T17:00:00Z', 100, 5),
      ],
      'Europe/Berlin',
    );
    expect(cells).toContainEqual({
      weekday: 1,
      hour: 9,
      posts: 3,
      rate: expect.closeTo(0.2),
      lowConfidence: false,
    });
    expect(cells).toContainEqual({
      weekday: 2,
      hour: 18,
      posts: 1,
      rate: 0.05,
      lowConfidence: true,
    });
  });

  it('compares kinds of posts', () => {
    expect(byContentType([video, page])).toEqual([
      { contentType: 'video', posts: 1, averageEngagement: 10, averageRate: 10 / 350 },
      { contentType: 'image', posts: 1, averageEngagement: 5, averageRate: 5 / 80 },
    ]);
  });
});
