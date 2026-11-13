import { existsSync } from 'node:fs';
import { relative } from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import { onError, ORPCError } from '@orpc/server';
import { RPCHandler } from '@orpc/server/fetch';
import {
  beginOAuth,
  completeOAuth,
  ConnectionError,
  router,
  type IntegrationsManager,
} from '@posthub/api';
import type { Auth } from '@posthub/auth';
import type { Db } from '@posthub/db';
import { PlatformError, type Vault } from '@posthub/integrations';
import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { env } from './env';

export interface AppDeps {
  db: Db;
  auth: Auth;
  /** Live connector config; app credentials saved in the UI apply without a restart. */
  providerApps: IntegrationsManager;
  vault: Vault;
  /** Origin the browser uses; OAuth redirect URIs are built from it. */
  publicUrl?: string;
  log?: boolean;
}

/** Message safe to show the user; unexpected errors stay generic. */
const userMessage = (error: unknown) =>
  error instanceof ConnectionError || error instanceof PlatformError
    ? error.message
    : 'Something went wrong while connecting. Check the server logs.';

export function createApp({
  db,
  auth,
  providerApps,
  vault,
  publicUrl = env.publicUrl,
  log = true,
}: AppDeps) {
  const app = new Hono();
  if (log) app.use(logger());

  const getSession = (headers: Headers) => auth.api.getSession({ headers });
  const accountsPage = (params: Record<string, string>) =>
    `${publicUrl}/accounts?${new URLSearchParams(params).toString()}`;
  const redirectUri = (provider: string) => `${publicUrl}/connect/${provider}/callback`;

  app.get('/health', (c) => c.json({ ok: true }));

  // better-auth owns everything under /api/auth.
  app.on(['GET', 'POST'], '/api/auth/*', (c) => auth.handler(c.req.raw));

  // Platform OAuth: browser navigations, so plain redirects rather than oRPC.
  app.get('/connect/:provider/start', async (c) => {
    const session = await getSession(c.req.raw.headers);
    if (!session) return c.redirect(`${publicUrl}/login`);
    const provider = c.req.param('provider');
    try {
      return c.redirect(
        beginOAuth({
          db,
          integrations: providerApps.current,
          userId: session.user.id,
          providerId: provider,
          redirectUri: redirectUri(provider),
        }),
      );
    } catch (error) {
      return c.redirect(accountsPage({ error: userMessage(error) }));
    }
  });

  app.get('/connect/:provider/callback', async (c) => {
    const session = await getSession(c.req.raw.headers);
    if (!session) return c.redirect(`${publicUrl}/login`);
    const provider = c.req.param('provider');
    const { code, state, error, error_description: description } = c.req.query();
    if (error || !code || !state) {
      return c.redirect(
        accountsPage({ error: description ?? error ?? 'Connection was cancelled.' }),
      );
    }
    try {
      const accounts = await completeOAuth({
        db,
        integrations: providerApps.current,
        vault,
        userId: session.user.id,
        providerId: provider,
        state,
        code,
        redirectUri: redirectUri(provider),
      });
      return c.redirect(accountsPage({ connected: String(accounts.length) }));
    } catch (err) {
      // Expired or forged state is routine; platform errors are logged to help debug app setup.
      if (!(err instanceof ConnectionError)) {
        console.error(`[connect:${provider}]`, err);
      }
      return c.redirect(accountsPage({ error: userMessage(err) }));
    }
  });

  // oRPC: typed procedures shared with the web app.
  const rpcHandler = new RPCHandler(router, {
    interceptors: [
      onError((error) => {
        // Expected client errors (401, 404, validation) are not worth logging.
        if (error instanceof ORPCError && error.status < 500) return;
        console.error('[rpc]', error);
      }),
    ],
  });

  app.use('/rpc/*', async (c, next) => {
    const session = await getSession(c.req.raw.headers);
    const { matched, response } = await rpcHandler.handle(c.req.raw, {
      prefix: '/rpc',
      context: { db, session, integrations: providerApps.current, providerApps, vault },
    });
    if (matched) return c.newResponse(response.body, response);
    await next();
  });

  // Production: serve the built PWA from the same origin.
  if (env.isProduction && existsSync(env.webDist)) {
    const root = relative(process.cwd(), env.webDist);
    app.use('/*', serveStatic({ root }));
    app.get('*', serveStatic({ root, path: 'index.html' }));
  }

  return app;
}
