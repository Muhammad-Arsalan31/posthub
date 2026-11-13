import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { defineConfig } from 'vite-plus';

const apiTarget = process.env.POSTHUB_API_URL ?? 'http://127.0.0.1:4100';

export default defineConfig({
  plugins: [
    // Must run before the React plugin.
    tanstackRouter({
      target: 'react',
      autoCodeSplitting: true,
      routeFileIgnorePattern: '\\.test\\.',
    }),
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      pwaAssets: {
        image: 'public/logo.svg',
        preset: 'minimal-2023',
        overrideManifestIcons: true,
      },
      manifest: {
        name: 'PostHub',
        short_name: 'PostHub',
        description: 'Local social media manager',
        theme_color: '#228be6',
        background_color: '#ffffff',
        display: 'standalone',
        start_url: '/',
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico,woff2}'],
        // API, auth, RPC and OAuth routes must always hit the server.
        navigateFallbackDenylist: [/^\/api\//, /^\/rpc\//, /^\/connect\//],
      },
    }),
  ],
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': apiTarget,
      '/rpc': apiTarget,
      '/connect': apiTarget,
    },
  },
});
