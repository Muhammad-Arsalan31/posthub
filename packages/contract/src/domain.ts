// What the server sends the web app. Shared by both sides, so it must stay free of server code.
import { Schema } from 'effect';

export const PLATFORMS = [
  'youtube',
  'linkedin',
  'facebook',
  'instagram',
  'tiktok',
  'wordpress',
] as const;
export const Platform = Schema.Literals(PLATFORMS);
export type Platform = typeof Platform.Type;

export const POST_STATUSES = ['draft', 'scheduled', 'publishing', 'published', 'failed'] as const;
export const PostStatus = Schema.Literals(POST_STATUSES);
export type PostStatus = typeof PostStatus.Type;

/** Statuses the owner can set. The publisher moves posts on from `scheduled`. */
export const EDITABLE_STATUSES = ['draft', 'scheduled'] as const;
export const EditableStatus = Schema.Literals(EDITABLE_STATUSES);

export const TARGET_STATUSES = ['pending', 'publishing', 'published', 'failed', 'manual'] as const;
export const TargetStatus = Schema.Literals(TARGET_STATUSES);
export type TargetStatus = typeof TargetStatus.Type;

export const ACCOUNT_STATUSES = ['active', 'expired', 'revoked'] as const;
export const AccountStatus = Schema.Literals(ACCOUNT_STATUSES);

export const PROVIDER_IDS = ['google', 'meta', 'linkedin', 'wordpress'] as const;
export const ProviderId = Schema.Literals(PROVIDER_IDS);
export const OAUTH_PROVIDER_IDS = ['google', 'meta', 'linkedin'] as const;
export const OAuthProviderId = Schema.Literals(OAUTH_PROVIDER_IDS);

const Strings = Schema.mutable(Schema.Array(Schema.String));

/** WordPress tags (names, shared by every site) and category ids per social account id. */
export const WordPressOptions = Schema.Struct({
  tags: Strings,
  categories: Schema.Record(Schema.String, Schema.mutable(Schema.Array(Schema.Number))),
});
export type WordPressOptions = typeof WordPressOptions.Type;

export const User = Schema.Struct({
  id: Schema.String,
  email: Schema.String,
  name: Schema.String,
  emailVerified: Schema.Boolean,
  image: Schema.optional(Schema.NullOr(Schema.String)),
  createdAt: Schema.Date,
  updatedAt: Schema.Date,
});
export type User = typeof User.Type;

/** One post on one account: publishes, fails and retries on its own. */
export const PostTarget = Schema.Struct({
  id: Schema.String,
  postId: Schema.String,
  socialAccountId: Schema.String,
  status: TargetStatus,
  attempts: Schema.Number,
  lastError: Schema.NullOr(Schema.String),
  externalUrl: Schema.NullOr(Schema.String),
  publishedAt: Schema.NullOr(Schema.Date),
  nextAttemptAt: Schema.NullOr(Schema.Date),
});
export type PostTarget = typeof PostTarget.Type;

/** A post with its selected accounts, media (in order) and per-platform publish state. */
export const Post = Schema.Struct({
  id: Schema.String,
  userId: Schema.String,
  title: Schema.String,
  /** Editor HTML (plain text in older posts). */
  body: Schema.String,
  link: Schema.NullOr(Schema.String),
  /** WordPress featured image; null uses the first attached image. */
  featuredMediaId: Schema.NullOr(Schema.String),
  /** YouTube custom thumbnail. */
  thumbnailMediaId: Schema.NullOr(Schema.String),
  wordpressOptions: Schema.NullOr(WordPressOptions),
  status: PostStatus,
  scheduledAt: Schema.NullOr(Schema.Date),
  createdAt: Schema.Date,
  updatedAt: Schema.Date,
  accountIds: Strings,
  mediaIds: Strings,
  targets: Schema.mutable(Schema.Array(PostTarget)),
});
export type Post = typeof Post.Type;

/** An uploaded file. Its location on disk never leaves the server. */
export const MediaItem = Schema.Struct({
  id: Schema.String,
  fileName: Schema.String,
  mimeType: Schema.String,
  sizeBytes: Schema.Number,
  width: Schema.NullOr(Schema.Number),
  height: Schema.NullOr(Schema.Number),
  durationMs: Schema.NullOr(Schema.Number),
  createdAt: Schema.Date,
});
export type MediaItem = typeof MediaItem.Type;

/** A connected account, page or site. Its credentials never leave the server. */
export const Account = Schema.Struct({
  id: Schema.String,
  platform: Platform,
  externalId: Schema.String,
  displayName: Schema.String,
  status: AccountStatus,
  tokenExpiresAt: Schema.NullOr(Schema.Date),
  createdAt: Schema.Date,
  /** Features this account lacks permissions for: reconnecting it grants them. */
  reconnectFor: Schema.mutable(Schema.Array(Schema.Literals(['metrics']))),
});
export type Account = typeof Account.Type;

/** A connectable provider, whether it is set up, and where its app credentials come from. */
export const Provider = Schema.Struct({
  id: ProviderId,
  label: Schema.String,
  platforms: Schema.mutable(Schema.Array(Platform)),
  kind: Schema.Literals(['oauth', 'credentials']),
  /** Env vars the server needs before this provider can connect. */
  envVars: Strings,
  setupUrl: Schema.String,
  configured: Schema.Boolean,
  source: Schema.NullOr(Schema.Literals(['database', 'env'])),
  clientId: Schema.NullOr(Schema.String),
});
export type Provider = typeof Provider.Type;

export const WordPressCategory = Schema.Struct({
  id: Schema.Number,
  name: Schema.String,
  parent: Schema.Number,
});
export type WordPressCategory = typeof WordPressCategory.Type;

/** The media host (S3-compatible bucket) as the settings page sees it. The secret never leaves the server. */
export const MediaHostSettings = Schema.Struct({
  endpoint: Schema.String,
  region: Schema.String,
  bucket: Schema.String,
  accessKeyId: Schema.String,
  publicBaseUrl: Schema.NullOr(Schema.String),
});
export type MediaHostSettings = typeof MediaHostSettings.Type;

/** A weekly posting time in the owner's time zone. A null account means any account. */
export const QueueSlot = Schema.Struct({
  /** 0 = Sunday ... 6 = Saturday. */
  weekday: Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 0, maximum: 6 })),
  minuteOfDay: Schema.Number.check(
    Schema.isInt(),
    Schema.isBetween({ minimum: 0, maximum: 24 * 60 - 1 }),
  ),
  socialAccountId: Schema.NullOr(Schema.String),
});
export type QueueSlot = typeof QueueSlot.Type;

const isTimeZone = (value: string) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
};

export const TimeZone = Schema.String.check(
  Schema.makeFilter(isTimeZone, { message: 'Unknown time zone.' }),
);

export const QueueSettings = Schema.Struct({
  timezone: TimeZone,
  slots: Schema.mutable(Schema.Array(QueueSlot)),
});
export type QueueSettings = typeof QueueSettings.Type;

const Count = Schema.NullOr(Schema.Number);

/** A post's numbers on one platform at one moment. Null means "not available", not zero. */
export const MetricSnapshot = Schema.Struct({
  capturedAt: Schema.Date,
  source: Schema.Literals(['platform', 'manual']),
  views: Count,
  reach: Count,
  likes: Count,
  comments: Count,
  shares: Count,
  saves: Count,
  clicks: Count,
  watchTimeSec: Count,
});
export type MetricSnapshot = typeof MetricSnapshot.Type;

/** One target's numbers: the latest, the history, and when they are read next. */
export const TargetMetrics = Schema.Struct({
  targetId: Schema.String,
  latest: Schema.NullOr(MetricSnapshot),
  series: Schema.mutable(Schema.Array(MetricSnapshot)),
  /** Whether PostHub reads this platform's numbers itself (false: enter them by hand). */
  automatic: Schema.Boolean,
  lastRunAt: Schema.NullOr(Schema.Date),
  nextRunAt: Schema.NullOr(Schema.Date),
  lastError: Schema.NullOr(Schema.String),
});
export type TargetMetrics = typeof TargetMetrics.Type;

/** Latest numbers of a post, summed over its targets. */
export const PostTotals = Schema.Struct({
  postId: Schema.String,
  views: Count,
  likes: Count,
  comments: Count,
});
export type PostTotals = typeof PostTotals.Type;
