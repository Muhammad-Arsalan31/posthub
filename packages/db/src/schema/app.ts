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

export const TARGET_STATUSES = ['pending', 'publishing', 'published', 'failed', 'manual'] as const;
export type TargetStatus = (typeof TARGET_STATUSES)[number];

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
    status: text('status', { enum: ['active', 'expired', 'revoked'] })
      .notNull()
      .default('active'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('social_account_platform_external_idx').on(t.platform, t.externalId)],
);

/** Files copied into PostHub's local media folder. */
export const mediaAsset = sqliteTable('media_asset', {
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
});

export const post = sqliteTable(
  'post',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    body: text('body').notNull().default(''),
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
  (t) => [primaryKey({ columns: [t.postId, t.mediaId] })],
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
