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
