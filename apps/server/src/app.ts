import { existsSync } from 'node:fs';
import { relative } from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import { onError, ORPCError } from '@orpc/server';
import { RPCHandler } from '@orpc/server/fetch';
import { router } from '@posthub/api';
import type { Auth } from '@posthub/auth';
import type { Db } from '@posthub/db';
import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { env } from './env';

export function createApp({ db, auth, log = true }: { db: Db; auth: Auth; log?: boolean }) {
  const app = new Hono();
  if (log) app.use(logger());

  app.get('/health', (c) => c.json({ ok: true }));

  // better-auth owns everything under /api/auth.
  app.on(['GET', 'POST'], '/api/auth/*', (c) => auth.handler(c.req.raw));

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
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    const { matched, response } = await rpcHandler.handle(c.req.raw, {
      prefix: '/rpc',
      context: { db, session },
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
