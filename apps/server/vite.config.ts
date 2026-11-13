import { defineConfig } from 'vite-plus';

export default defineConfig({
  pack: {
    entry: ['src/index.ts'],
    format: 'esm',
    platform: 'node',
    // Workspace packages ship as TypeScript source, so bundle them into the server.
    // better-sqlite3 is a native module and must stay external.
    // The bundled server is always the production build.
    define: { 'process.env.NODE_ENV': '"production"' },
    deps: {
      alwaysBundle: [/^@posthub\//],
      neverBundle: ['better-sqlite3'],
    },
  },
  test: {
    environment: 'node',
    env: { BETTER_AUTH_SECRET: 'test-secret-test-secret-test-secret!' },
  },
});
