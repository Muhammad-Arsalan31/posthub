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
  text: string;
  link?: string;
  media: MediaFile[];
}

export interface PublishResult {
  externalId: string;
  url?: string;
}

/** An account produced by a connect flow, ready to be stored (credentials get encrypted). */
export interface ConnectedAccount<C = unknown> {
  platform: Platform;
  externalId: string;
  displayName: string;
  credentials: C;
  tokenExpiresAt: Date | null;
}

export interface RefreshResult<C> {
  credentials: C;
  tokenExpiresAt: Date | null;
}

/** Publishes to one platform. Method syntax keeps credentials bivariant for the registry. */
export interface PlatformAdapter<C> {
  readonly platform: Platform;
  publish(credentials: C, input: PublishInput): Promise<PublishResult>;
  refresh?(credentials: C): Promise<RefreshResult<C>>;
}

export interface OAuthProvider {
  readonly id: OAuthProviderId;
  authorizationUrl(params: { state: string; redirectUri: string }): string;
  connect(params: { code: string; redirectUri: string }): Promise<ConnectedAccount[]>;
}

export const isImage = (m: MediaFile) => m.mimeType.startsWith('image/');
export const isVideo = (m: MediaFile) => m.mimeType.startsWith('video/');

/** Append the link to the text for platforms without a separate link field. */
export const withLink = (text: string, link?: string) =>
  link && !text.includes(link) ? `${text}\n\n${link}`.trim() : text;
