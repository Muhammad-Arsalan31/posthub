// Platform labels and publishing rules for the composer.
// The rules mirror packages/api/src/post-rules.ts (the server enforces them); keep them in sync.
import type { Platform } from '@posthub/contract';

export type { Account, MediaItem, Platform } from '@posthub/contract';

export const PLATFORM_LABELS: Record<Platform, string> = {
  youtube: 'YouTube',
  facebook: 'Facebook',
  instagram: 'Instagram',
  linkedin: 'LinkedIn',
  tiktok: 'TikTok',
  wordpress: 'WordPress',
};

export const PLATFORM_COLORS: Record<Platform, string> = {
  youtube: 'red',
  facebook: 'blue',
  instagram: 'pink',
  linkedin: 'indigo',
  tiktok: 'dark',
  wordpress: 'cyan',
};

export const isVideo = (m: { mimeType: string }) => m.mimeType.startsWith('video/');

/** A reason the post can't go to `platform`, or null when it can. */
export const THUMBNAIL_MAX_BYTES = 2 * 1024 * 1024;

export function platformProblem(
  platform: Platform,
  post: {
    /** Plain text of the body. */
    text: string;
    link: string | null;
    media: Array<{ mimeType: string }>;
    thumbnail?: { mimeType: string; sizeBytes: number } | null;
  },
  /** `hasMediaHost` comes from the settings.mediaHost query. */
  options: { hasMediaHost?: boolean } = {},
): string | null {
  const hasVideo = post.media.some(isVideo);
  switch (platform) {
    case 'youtube':
      if (!hasVideo) return 'YouTube needs a video.';
      if (post.thumbnail && !['image/jpeg', 'image/png'].includes(post.thumbnail.mimeType)) {
        return 'The YouTube thumbnail must be a JPEG or PNG.';
      }
      if (post.thumbnail && post.thumbnail.sizeBytes > THUMBNAIL_MAX_BYTES) {
        return 'The YouTube thumbnail must be 2 MB or smaller.';
      }
      return null;
    case 'instagram':
      if (post.media.length !== 1) return 'Instagram needs exactly one image or video.';
      return options.hasMediaHost
        ? null
        : 'Set up a media host in Settings to publish to Instagram.';
    case 'linkedin':
      return hasVideo ? 'LinkedIn video posts are not supported yet.' : null;
    case 'facebook':
      return post.text.trim() || post.link || post.media.length
        ? null
        : 'Facebook needs text, a link or media.';
    case 'tiktok':
    case 'wordpress':
      return null;
  }
}

/** Short notes about how each platform uses the post, shown next to the account. */
export const PLATFORM_NOTES: Partial<Record<Platform, string>> = {
  wordpress: 'Publishes a blog post with the formatting kept and the media below the text.',
  linkedin: 'Uses the first image only.',
  youtube: 'Uploads the video with the title, and the text as its description.',
  tiktok: 'Manual: PostHub reminds you, then you post it yourself.',
};

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

export const mediaUrl = (id: string) => `/files/${id}`;

/** Longest first comment each platform takes (Instagram also allows at most 30 hashtags). */
export const FIRST_COMMENT_LIMITS: Partial<Record<Platform, number>> = {
  youtube: 10_000,
  facebook: 8_000,
  instagram: 2_200,
};

/** Platforms PostHub can post a first comment on (mirrors the server's comment connectors). */
export const FIRST_COMMENT_PLATFORMS: Platform[] = [
  'youtube',
  'facebook',
  'instagram',
  'wordpress',
];

/** Platforms where an automatically posted first comment can be pinned by the owner. */
export const PIN_COMMENT_PLATFORMS: Platform[] = ['youtube', 'facebook', 'instagram'];

/** How each platform handles pinning, for the composer and the post page. */
export const PIN_NOTES: Record<Platform, string> = {
  youtube: 'Pin it in YouTube Studio: Comments, then ⋮ next to the comment, then Pin.',
  facebook: 'Pin it on the post: ⋯ next to the comment, then Pin comment.',
  instagram: 'Pin it in the Instagram app: swipe left on the comment, then tap the pin.',
  linkedin: 'LinkedIn has no pinned comments, and PostHub cannot comment there yet.',
  wordpress: 'WordPress has no pinned comments.',
  tiktok: 'TikTok is posted by hand: add and pin the comment in the app.',
};

/** Mirrors firstCommentProblem in packages/api/src/post-rules.ts. */
export function firstCommentProblem(platform: Platform, comment: string): string | null {
  const text = comment.trim();
  if (!text) return null;
  const limit = FIRST_COMMENT_LIMITS[platform];
  if (limit && text.length > limit) {
    return `The first comment is too long for this platform (at most ${limit.toLocaleString()} characters).`;
  }
  if (platform === 'instagram' && (text.match(/#[\p{L}\p{N}_]+/gu)?.length ?? 0) > 30) {
    return 'Instagram allows at most 30 hashtags in a comment.';
  }
  return null;
}
