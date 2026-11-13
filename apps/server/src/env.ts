import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IntegrationsConfig } from '@posthub/integrations';

// src/ and dist/ sit at the same depth, so these paths work for both `dev` and `start`.
const appDir = fileURLToPath(new URL('..', import.meta.url));
const repoRoot = join(appDir, '..', '..');

const envFile = join(appDir, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const isProduction = process.env.NODE_ENV === 'production';
const port = Number(process.env.PORT ?? 4100);

function requireSecret(name: string) {
  const value = process.env[name];
  if (!value || value.length < 32) {
    throw new Error(`${name} must be set (32+ chars). Copy apps/server/.env.example to .env.`);
  }
  return value;
}

/** An app's id + secret pair, or undefined when either is missing (provider stays disabled). */
function appCredentials(idVar: string, secretVar: string) {
  const id = process.env[idVar]?.trim();
  const secret = process.env[secretVar]?.trim();
  return id && secret ? { id, secret } : undefined;
}

const optional = (name: string) => process.env[name]?.trim() || undefined;

const google = appCredentials('GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET');
const meta = appCredentials('META_APP_ID', 'META_APP_SECRET');
const linkedin = appCredentials('LINKEDIN_CLIENT_ID', 'LINKEDIN_CLIENT_SECRET');
const youtubePrivacy = optional('YOUTUBE_PRIVACY');

const integrations: IntegrationsConfig = {
  google: google && {
    clientId: google.id,
    clientSecret: google.secret,
    youtubePrivacy:
      youtubePrivacy === 'private' || youtubePrivacy === 'unlisted' ? youtubePrivacy : 'public',
  },
  meta: meta && {
    appId: meta.id,
    appSecret: meta.secret,
    graphVersion: optional('META_GRAPH_VERSION'),
  },
  linkedin: linkedin && {
    clientId: linkedin.id,
    clientSecret: linkedin.secret,
    apiVersion: optional('LINKEDIN_API_VERSION'),
  },
};

const dataDir = process.env.POSTHUB_DATA_DIR ?? join(repoRoot, '.data');

export const env = {
  isProduction,
  port,
  secret: requireSecret('BETTER_AUTH_SECRET'),
  encryptionKey: requireSecret('POSTHUB_ENCRYPTION_KEY'),
  // In dev the browser talks to Vite (5173), which proxies /api, /rpc and /connect here.
  publicUrl:
    process.env.BETTER_AUTH_URL ??
    (isProduction ? `http://localhost:${port}` : 'http://localhost:5173'),
  integrations,
  dataDir,
  databasePath: join(dataDir, 'posthub.db'),
  mediaDir: join(dataDir, 'media'),
  migrationsDir: process.env.POSTHUB_MIGRATIONS_DIR ?? join(repoRoot, 'packages', 'db', 'drizzle'),
  webDist: process.env.POSTHUB_WEB_DIST ?? join(repoRoot, 'apps', 'web', 'dist'),
};
