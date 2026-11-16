import { fetchClient, makeHttp } from './http';
import { createGoogle, type GoogleConfig } from './providers/google';
import { createLinkedIn, type LinkedInConfig } from './providers/linkedin';
import { createMeta, type MetaConfig } from './providers/meta';
import { createWordPress } from './providers/wordpress';
import { createWordPressEngagement } from './providers/wordpress-engagement';
import type {
  EngagementAdapter,
  InsightsAdapter,
  OAuthProvider,
  OAuthProviderId,
  Platform,
  PlatformAdapter,
  ProviderId,
} from './types';

export interface IntegrationsConfig {
  google?: GoogleConfig;
  meta?: MetaConfig;
  linkedin?: LinkedInConfig;
}

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  platforms: Platform[];
  kind: 'oauth' | 'credentials';
  /** Env vars the server needs before this provider can connect. */
  envVars: string[];
  setupUrl: string;
}

export const PROVIDERS: ProviderInfo[] = [
  {
    id: 'google',
    label: 'YouTube',
    platforms: ['youtube'],
    kind: 'oauth',
    envVars: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'],
    setupUrl: 'https://console.cloud.google.com/apis/credentials',
  },
  {
    id: 'meta',
    label: 'Facebook & Instagram',
    platforms: ['facebook', 'instagram'],
    kind: 'oauth',
    envVars: ['META_APP_ID', 'META_APP_SECRET'],
    setupUrl: 'https://developers.facebook.com/apps',
  },
  {
    id: 'linkedin',
    label: 'LinkedIn',
    platforms: ['linkedin'],
    kind: 'oauth',
    envVars: ['LINKEDIN_CLIENT_ID', 'LINKEDIN_CLIENT_SECRET'],
    setupUrl: 'https://www.linkedin.com/developers/apps',
  },
  {
    id: 'wordpress',
    label: 'WordPress',
    platforms: ['wordpress'],
    kind: 'credentials',
    envVars: [],
    setupUrl: 'https://make.wordpress.org/core/2020/11/05/application-passwords-integration-guide/',
  },
];

export interface IntegrationDeps {
  /** Send platform requests through this fetch. Tests pass a fake. */
  fetch?: typeof globalThis.fetch;
  /** Instagram processing poll interval. Tests set it to 0. */
  pollIntervalMs?: number;
}

/** Builds every connector the server has credentials for. Inject `fetch` in tests. */
export function createIntegrations(config: IntegrationsConfig, deps: IntegrationDeps = {}) {
  const http = makeHttp(fetchClient(deps.fetch ?? ((input, init) => fetch(input, init))));
  const providers = new Map<OAuthProviderId, OAuthProvider>();
  const adapters = new Map<Platform, PlatformAdapter<unknown>>();
  const insights = new Map<Platform, InsightsAdapter<unknown>>();
  const engagement = new Map<Platform, EngagementAdapter<unknown>>();

  if (config.google) {
    const google = createGoogle(config.google, http);
    providers.set('google', google.provider);
    adapters.set('youtube', google.adapters.youtube);
    insights.set('youtube', google.insights.youtube);
    engagement.set('youtube', google.engagement.youtube);
  }
  if (config.meta) {
    const meta = createMeta(config.meta, http, { pollIntervalMs: deps.pollIntervalMs });
    providers.set('meta', meta.provider);
    adapters.set('facebook', meta.adapters.facebook);
    adapters.set('instagram', meta.adapters.instagram);
    insights.set('facebook', meta.insights.facebook);
    insights.set('instagram', meta.insights.instagram);
    engagement.set('facebook', meta.engagement.facebook);
    engagement.set('instagram', meta.engagement.instagram);
  }
  if (config.linkedin) {
    const linkedin = createLinkedIn(config.linkedin, http);
    providers.set('linkedin', linkedin.provider);
    adapters.set('linkedin', linkedin.adapters.linkedin);
  }
  const wordpress = createWordPress(http);
  adapters.set('wordpress', wordpress.adapter);
  insights.set('wordpress', wordpress.insights);
  engagement.set('wordpress', createWordPressEngagement(http));

  return {
    oauth: (id: string) => providers.get(id as OAuthProviderId),
    adapter: (platform: Platform) => adapters.get(platform),
    /** Reads post and account numbers; undefined when the platform has no support (LinkedIn, TikTok). */
    insights: (platform: Platform) => insights.get(platform),
    /** Reads and answers comments; undefined for LinkedIn (needs approval) and TikTok. */
    engagement: (platform: Platform) => engagement.get(platform),
    wordpress: { connect: wordpress.connect, categories: wordpress.categories },
    status: () =>
      PROVIDERS.map((p) => ({
        ...p,
        configured: p.kind === 'credentials' || providers.has(p.id as OAuthProviderId),
      })),
  };
}

export type Integrations = ReturnType<typeof createIntegrations>;
