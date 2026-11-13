import { createAuthClient } from 'better-auth/react';

// Same origin as the app: Vite proxies /api in dev, the server serves both in production.
export const authClient = createAuthClient({
  baseURL: window.location.origin,
  basePath: '/api/auth',
});
