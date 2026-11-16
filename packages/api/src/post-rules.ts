// What each platform's adapter can actually publish. Checked before a post is scheduled, so
// problems show up in the composer instead of as failed targets later.
// apps/web/src/lib/platforms.ts mirrors these for live hints; keep them in sync.
import type { Platform } from '@posthub/db';
import { htmlToText, isHtmlBody } from '@posthub/integrations';

/** YouTube accepts JPEG or PNG thumbnails up to 2 MB. */
export const THUMBNAIL_MAX_BYTES = 2 * 1024 * 1024;

interface RuleInput {
  /** Editor HTML (or plain text for older posts). */
  body: string;
  link: string | null;
  media: Array<{ mimeType: string }>;
  thumbnail?: { mimeType: string; sizeBytes: number } | null;
}

const isVideo = (m: { mimeType: string }) => m.mimeType.startsWith('video/');

export interface RuleOptions {
  /** The owner has a media host, so platforms that download media from a URL can be used. */
  hasMediaHost?: boolean;
}

/** A reason this post can't go to `platform`, or null when it can. */
export function platformProblem(
  platform: Platform,
  post: RuleInput,
  options: RuleOptions = {},
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
      return (isHtmlBody(post.body) ? htmlToText(post.body) : post.body.trim()) ||
        post.link ||
        post.media.length
        ? null
        : 'Facebook needs text, a link or media.';
    case 'tiktok':
    case 'wordpress':
      return null;
  }
}

/** TikTok has no API for private tools: those targets are handed off to the owner. */
export const isManualPlatform = (platform: Platform) => platform === 'tiktok';
