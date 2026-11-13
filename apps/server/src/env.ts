import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// src/ and dist/ sit at the same depth, so these paths work for both `dev` and `start`.
const appDir = fileURLToPath(new URL('..', import.meta.url));
const repoRoot = join(appDir, '..', '..');

const envFile = join(appDir, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const isProduction = process.env.NODE_ENV === 'production';
const port = Number(process.env.PORT ?? 4100);

const secret = process.env.BETTER_AUTH_SECRET;
if (!secret || secret.length < 32) {
  throw new Error(
    'BETTER_AUTH_SECRET must be set (32+ chars). Copy apps/server/.env.example to .env.',
  );
}

const dataDir = process.env.POSTHUB_DATA_DIR ?? join(repoRoot, '.data');

export const env = {
  isProduction,
  port,
  secret,
  // In dev the browser talks to Vite (5173), which proxies /api and /rpc here.
  publicUrl:
    process.env.BETTER_AUTH_URL ??
    (isProduction ? `http://localhost:${port}` : 'http://localhost:5173'),
  dataDir,
  databasePath: join(dataDir, 'posthub.db'),
  mediaDir: join(dataDir, 'media'),
  migrationsDir: process.env.POSTHUB_MIGRATIONS_DIR ?? join(repoRoot, 'packages', 'db', 'drizzle'),
  webDist: process.env.POSTHUB_WEB_DIST ?? join(repoRoot, 'apps', 'web', 'dist'),
};
