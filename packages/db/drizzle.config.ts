import { defineConfig } from 'drizzle-kit';

// Dev database lives in <repo>/.data. The server reads POSTHUB_DATA_DIR in production.
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/schema/index.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env.DATABASE_PATH ?? '../../.data/posthub.db',
  },
});
