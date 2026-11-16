import { defineConfig } from 'vite-plus';

// Workspace-wide lint + format + staged config for `vp check`.
// App-specific Vite config lives in each app's own vite.config.ts.
export default defineConfig({
  lint: {
    plugins: ['typescript'],
    options: {
      typeAware: true,
      typeCheck: true,
    },
    ignorePatterns: ['**/dist/**', '**/routeTree.gen.ts', 'packages/db/drizzle/**'],
    overrides: [
      {
        files: ['apps/web/**'],
        plugins: ['react'],
        env: { browser: true },
      },
      {
        files: ['apps/server/**', 'packages/**'],
        env: { node: true },
      },
    ],
  },
  fmt: {
    singleQuote: true,
    semi: true,
    printWidth: 100,
    endOfLine: 'lf',
    ignorePatterns: ['**/routeTree.gen.ts', 'packages/db/drizzle/**'],
  },
  staged: {
    '*': 'vp check --fix',
  },
});
