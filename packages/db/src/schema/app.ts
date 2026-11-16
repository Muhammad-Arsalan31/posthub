// PostHub domain tables: connected platforms, media, posts and per-platform targets.
import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import { user } from './auth';

export const PLATFORMS = [
  'youtube',
  'linkedin',
  'facebook',
  'instagram',
  'tiktok',
  'wordpress',
] as const;
export type Platform = (typeof PLATFORMS)[number];

export const POST_STATUSES = ['draft', 'scheduled', 'publishing', 'published', 'failed'] as const;
export type PostStatus = (typeof POST_STATUSES)[number];

export const SYNC_JOB_KINDS = ['post_metrics', 'account_metrics'] as const;
export type SyncJobKind = (typeof SYNC_JOB_KINDS)[number];

/** `paused`: waiting for the owner to reconnect the account. `done`: nothing more to fetch. */
export const SYNC_JOB_STATUSES = ['pending', 'running', 'paused', 'done'] as const;

export const TARGET_STATUSES = ['pending', 'publishing', 'published', 'failed', 'manual'] as const;
export type TargetStatus = (typeof TARGET_STATUSES)[number];

export interface WordPressPostOptions {
  tags: string[];
  /** Category ids on each site, keyed by social account id. */
  categories: Record<string, number[]>;
}

const createdAt = () =>
  integer('created_at', { mode: 'timestamp_ms' })
    .notNull()
    .default(sql`(unixepoch() * 1000)`);
const updatedAt = () =>
  integer('updated_at', { mode: 'timestamp_ms' })
    .notNull()
    .default(sql`(unixepoch() * 1000)`)
    .$onUpdate(() => new Date());

/** A connected account, page or site on one platform. Credentials are stored encrypted. */
export const socialAccount = sqliteTable(
  'social_account',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    platform: text('platform', { enum: PLATFORMS }).notNull(),
    externalId: text('external_id').notNull(),
    displayName: text('display_name').notNull(),
    credentials: text('credentials'),
    tokenExpiresAt: integer('token_expires_at', { mode: 'timestamp_ms' }),
    /** OAuth scopes granted at the last connect. Null for accounts connected before this was recorded. */
    grantedScopes: text('granted_scopes', { mode: 'json' }).$type<string[]>(),
    status: text('status', { enum: ['active', 'expired', 'revoked'] })
      .notNull()
      .default('active'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('social_account_platform_external_idx').on(t.platform, t.externalId)],
);

/** Files copied into PostHub's local media folder. `storagePath` is relative to the media folder. */
export const mediaAsset = sqliteTable(
  'media_asset',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    fileName: text('file_name').notNull(),
    mimeType: text('mime_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    storagePath: text('storage_path').notNull(),
    width: integer('width'),
    height: integer('height'),
    durationMs: integer('duration_ms'),
    createdAt: createdAt(),
  },
  (t) => [index('media_asset_user_idx').on(t.userId)],
);

export const post = sqliteTable(
  'post',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    body: text('body').notNull().default(''),
    /** Optional link shared with the post (a separate field on platforms that support one). */
    link: text('link'),
    /** WordPress featured image. Null means the first attached image. */
    featuredMediaId: text('featured_media_id').references(() => mediaAsset.id, {
      onDelete: 'set null',
    }),
    /** WordPress tags (by name, shared by every site) and categories (ids, per account). */
    wordpressOptions: text('wordpress_options', { mode: 'json' }).$type<WordPressPostOptions>(),
    /** YouTube custom thumbnail. */
    thumbnailMediaId: text('thumbnail_media_id').references(() => mediaAsset.id, {
      onDelete: 'set null',
    }),
    status: text('status', { enum: POST_STATUSES }).notNull().default('draft'),
    scheduledAt: integer('scheduled_at', { mode: 'timestamp_ms' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('post_user_idx').on(t.userId),
    index('post_status_scheduled_idx').on(t.status, t.scheduledAt),
  ],
);

export const postMedia = sqliteTable(
  'post_media',
  {
    postId: text('post_id')
      .notNull()
      .references(() => post.id, { onDelete: 'cascade' }),
    mediaId: text('media_id')
      .notNull()
      .references(() => mediaAsset.id, { onDelete: 'cascade' }),
    position: integer('position').notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.postId, t.mediaId] }),
    index('post_media_media_idx').on(t.mediaId),
  ],
);

/** One row per (post, account): each platform publishes, fails and retries independently. */
export const postTarget = sqliteTable(
  'post_target',
  {
    id: text('id').primaryKey(),
    postId: text('post_id')
      .notNull()
      .references(() => post.id, { onDelete: 'cascade' }),
    socialAccountId: text('social_account_id')
      .notNull()
      .references(() => socialAccount.id, { onDelete: 'cascade' }),
    captionOverride: text('caption_override'),
    status: text('status', { enum: TARGET_STATUSES }).notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    lockedAt: integer('locked_at', { mode: 'timestamp_ms' }),
    /** After a retryable failure: do not try again before this time. */
    nextAttemptAt: integer('next_attempt_at', { mode: 'timestamp_ms' }),
    externalPostId: text('external_post_id'),
    externalUrl: text('external_url'),
    lastError: text('last_error'),
    publishedAt: integer('published_at', { mode: 'timestamp_ms' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('post_target_post_account_idx').on(t.postId, t.socialAccountId),
    index('post_target_status_idx').on(t.status),
  ],
);

/** Short-lived OAuth `state` values: CSRF protection for platform connect flows. */
export const oauthState = sqliteTable('oauth_state', {
  state: text('state').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  provider: text('provider').notNull(),
  createdAt: createdAt(),
});

/**
 * Developer-app credentials per OAuth provider (client id/secret), entered in the UI.
 * `config` is vault-encrypted JSON. Overrides values from apps/server/.env.
 */
export const providerApp = sqliteTable('provider_app', {
  provider: text('provider').primaryKey(),
  config: text('config').notNull(),
  updatedAt: updatedAt(),
});

/**
 * Per-user settings that are not developer-app credentials (media host, queue slots, AI...).
 * `value` is JSON, or vault-encrypted JSON when `secret` is set. Secrets never reach the client.
 */
export const appSetting = sqliteTable(
  'app_setting',
  {
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    value: text('value').notNull(),
    secret: integer('secret', { mode: 'boolean' }).notNull().default(false),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.key] })],
);

/**
 * A file put on the media host for one target's publish. The row is written before the upload and
 * removed after the object is deleted, so objects left behind by a crash are cleaned up at start.
 */
export const hostedMedia = sqliteTable(
  'hosted_media',
  {
    key: text('key').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    targetId: text('target_id').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('hosted_media_target_idx').on(t.targetId)],
);

/**
 * A weekly posting time ("Mon 09:00") that "Add to queue" fills. The time is wall-clock time in
 * the owner's time zone (`app_setting` key `timezone`). A null account means any account.
 */
export const queueSlot = sqliteTable(
  'queue_slot',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    /** 0 = Sunday ... 6 = Saturday. */
    weekday: integer('weekday').notNull(),
    minuteOfDay: integer('minute_of_day').notNull(),
    socialAccountId: text('social_account_id').references(() => socialAccount.id, {
      onDelete: 'cascade',
    }),
    createdAt: createdAt(),
  },
  (t) => [index('queue_slot_user_idx').on(t.userId)],
);

/**
 * Background pulls (metrics, later comments). One row per (kind, subject), rescheduled after each
 * run. Reads are safe to repeat, so a job interrupted while `running` simply runs again.
 */
export const syncJob = sqliteTable(
  'sync_job',
  {
    id: text('id').primaryKey(),
    kind: text('kind', { enum: SYNC_JOB_KINDS }).notNull(),
    /** A post target id (post_metrics) or a social account id (account_metrics). */
    subjectId: text('subject_id').notNull(),
    socialAccountId: text('social_account_id')
      .notNull()
      .references(() => socialAccount.id, { onDelete: 'cascade' }),
    status: text('status', { enum: SYNC_JOB_STATUSES }).notNull().default('pending'),
    /** Failed runs in a row (reset on success). */
    attempts: integer('attempts').notNull().default(0),
    nextRunAt: integer('next_run_at', { mode: 'timestamp_ms' }),
    lastRunAt: integer('last_run_at', { mode: 'timestamp_ms' }),
    lastError: text('last_error'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('sync_job_kind_subject_idx').on(t.kind, t.subjectId),
    index('sync_job_due_idx').on(t.status, t.nextRunAt),
  ],
);

/** Platform numbers for one published target at one moment. A null metric means "not available". */
export const postMetricSnapshot = sqliteTable(
  'post_metric_snapshot',
  {
    id: text('id').primaryKey(),
    postTargetId: text('post_target_id')
      .notNull()
      .references(() => postTarget.id, { onDelete: 'cascade' }),
    capturedAt: integer('captured_at', { mode: 'timestamp_ms' }).notNull(),
    /** `manual` when the owner typed the numbers in (TikTok). */
    source: text('source', { enum: ['platform', 'manual'] })
      .notNull()
      .default('platform'),
    views: integer('views'),
    reach: integer('reach'),
    likes: integer('likes'),
    comments: integer('comments'),
    shares: integer('shares'),
    saves: integer('saves'),
    clicks: integer('clicks'),
    watchTimeSec: integer('watch_time_sec'),
    raw: text('raw', { mode: 'json' }).$type<Record<string, number>>(),
  },
  (t) => [index('post_metric_target_time_idx').on(t.postTargetId, t.capturedAt)],
);

export const accountMetricSnapshot = sqliteTable(
  'account_metric_snapshot',
  {
    id: text('id').primaryKey(),
    socialAccountId: text('social_account_id')
      .notNull()
      .references(() => socialAccount.id, { onDelete: 'cascade' }),
    capturedAt: integer('captured_at', { mode: 'timestamp_ms' }).notNull(),
    followers: integer('followers'),
    reach: integer('reach'),
    raw: text('raw', { mode: 'json' }).$type<Record<string, number>>(),
  },
  (t) => [index('account_metric_account_time_idx').on(t.socialAccountId, t.capturedAt)],
);
