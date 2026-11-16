import type { Effect } from 'effect';
import type { PublishError } from './http';

export type Platform = 'youtube' | 'linkedin' | 'facebook' | 'instagram' | 'tiktok' | 'wordpress';

/** A connection flow. One OAuth login can yield several accounts (e.g. Meta: Pages + Instagram). */
export type ProviderId = 'google' | 'meta' | 'linkedin' | 'wordpress';
export type OAuthProviderId = Exclude<ProviderId, 'wordpress'>;

/** A file in PostHub's local media folder. */
export interface MediaFile {
  path: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  /** Publicly reachable URL. Instagram downloads media from a URL instead of accepting uploads. */
  publicUrl?: string;
}

export interface PublishInput {
  title: string;
  /** Plain text, for platforms without rich text. */
  text: string;
  /** The same body as HTML (WordPress). Built from `text` when absent. */
  html?: string;
  link?: string;
  media: MediaFile[];
  /** WordPress featured image. Defaults to the first image in `media`. */
  featuredImage?: MediaFile;
  /** YouTube custom thumbnail (JPEG or PNG, up to 2 MB). */
  thumbnail?: MediaFile;
  /** Images placed inside `html`: each <img src="ref"> becomes the uploaded file (WordPress). */
  inlineImages?: Array<{ ref: string; file: MediaFile }>;
  /** WordPress post settings for this site. */
  wordpress?: { categoryIds: number[]; tags: string[] };
}

export interface PublishResult {
  externalId: string;
  url?: string;
  /** Published, but an optional extra failed (e.g. the thumbnail). Shown to the owner. */
  warning?: string;
}

/** An account produced by a connect flow, ready to be stored (credentials get encrypted). */
export interface ConnectedAccount<C = unknown> {
  platform: Platform;
  externalId: string;
  displayName: string;
  credentials: C;
  tokenExpiresAt: Date | null;
  /** OAuth scopes granted, when the platform reports them. */
  grantedScopes?: string[];
}

export interface RefreshResult<C> {
  credentials: C;
  tokenExpiresAt: Date | null;
}

/**
 * Publishes to one platform. Method syntax keeps credentials bivariant for the registry.
 * Once the call that creates the post succeeds, the effect must not fail (a retry would post twice).
 */
export interface PlatformAdapter<C> {
  readonly platform: Platform;
  /** The platform downloads media from `MediaFile.publicUrl` (the publisher puts it on the media host). */
  readonly needsPublicMedia?: boolean;
  publish(credentials: C, input: PublishInput): Effect.Effect<PublishResult, PublishError>;
  refresh?(credentials: C): Effect.Effect<RefreshResult<C>, PublishError>;
}

export interface OAuthProvider {
  readonly id: OAuthProviderId;
  authorizationUrl(params: { state: string; redirectUri: string }): string;
  connect(params: {
    code: string;
    redirectUri: string;
  }): Effect.Effect<ConnectedAccount[], PublishError>;
}

export const isImage = (m: MediaFile) => m.mimeType.startsWith('image/');
export const isVideo = (m: MediaFile) => m.mimeType.startsWith('video/');

/** Append the link to the text for platforms without a separate link field. */
export const withLink = (text: string, link?: string) =>
  link && !text.includes(link) ? `${text}\n\n${link}`.trim() : text;

/** Numbers for one published post. A missing field means "not available", never zero. */
export interface PostMetrics {
  views?: number;
  reach?: number;
  likes?: number;
  comments?: number;
  shares?: number;
  saves?: number;
  clicks?: number;
  watchTimeSec?: number;
  /** Platform-specific extras, kept for later. */
  raw: Record<string, number>;
}

export interface AccountMetrics {
  followers?: number;
  reach?: number;
  raw: Record<string, number>;
}

/**
 * Reads numbers from a platform. Reads are safe to repeat, so callers retry any failure
 * (including network errors) later. `refresh` is the publish adapter's, when it has one.
 */
export interface InsightsAdapter<C> {
  readonly platform: Platform;
  /** OAuth scopes the reads need, beyond what publishing needs. */
  readonly scopes: readonly string[];
  postMetrics(credentials: C, externalPostId: string): Effect.Effect<PostMetrics, PublishError>;
  accountMetrics?(credentials: C): Effect.Effect<AccountMetrics, PublishError>;
  refresh?(credentials: C): Effect.Effect<RefreshResult<C>, PublishError>;
}

/** Drops undefined values and non-numbers, for `raw`. */
export const numbers = (values: Record<string, unknown>): Record<string, number> =>
  Object.fromEntries(
    Object.entries(values).flatMap(([key, value]) => {
      const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
      return typeof n === 'number' && Number.isFinite(n) ? [[key, n]] : [];
    }),
  );

/** A comment as a platform returns it. */
export interface RemoteComment {
  externalId: string;
  /** The comment this one replies to, if any. */
  parentExternalId: string | null;
  authorName: string;
  authorAvatarUrl: string | null;
  authorId: string | null;
  text: string;
  likeCount: number | null;
  /** The owner has liked it (where the platform says). */
  likedByMe: boolean;
  createdAt: Date;
  /** Written by the connected account itself. */
  isOwn: boolean;
  hidden: boolean;
}

/** Where a comment lives: what reply and moderation calls need. */
export interface CommentRef {
  externalId: string;
  /** The top-level comment of its thread (YouTube replies attach there). */
  threadExternalId: string;
  /** The post (video, page post, media, blog post) it is on. */
  postExternalId: string;
}

export interface EngagementCapabilities {
  reply: boolean;
  like: boolean;
  hide: boolean;
  delete: boolean;
}

export type ModerationAction = 'hide' | 'unhide' | 'delete';

/**
 * Reads and answers comments. `reply` creates something: once the creating request succeeds,
 * the effect must not fail (a retry would reply twice).
 */
export interface EngagementAdapter<C> {
  readonly platform: Platform;
  readonly capabilities: EngagementCapabilities;
  /** OAuth scopes the comment calls need. */
  readonly scopes: readonly string[];
  /** Parent used when replying: some platforms flatten replies onto the top-level comment. */
  replyParentId(ref: CommentRef): string;
  listComments(
    credentials: C,
    post: { externalPostId: string; accountExternalId: string },
    cursor?: string,
  ): Effect.Effect<{ comments: RemoteComment[]; next?: string }, PublishError>;
  reply(credentials: C, ref: CommentRef, text: string): Effect.Effect<RemoteComment, PublishError>;
  /** A new top-level comment on a post (the "first comment"). Must not fail once created. */
  postComment(
    credentials: C,
    externalPostId: string,
    text: string,
  ): Effect.Effect<RemoteComment, PublishError>;
  setLike(credentials: C, ref: CommentRef, liked: boolean): Effect.Effect<void, PublishError>;
  moderate(
    credentials: C,
    ref: CommentRef,
    action: ModerationAction,
  ): Effect.Effect<void, PublishError>;
  refresh?(credentials: C): Effect.Effect<RefreshResult<C>, PublishError>;
}
