import { createReadStream, existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { Readable } from 'node:stream';
import { serveStatic } from '@hono/node-server/serve-static';
import {
  apiWebHandler,
  beginOAuth,
  completeOAuth,
  ConnectionError,
  Database,
  MediaDir,
  ProviderApps,
  Sessions,
  type ApiServices,
} from '@posthub/api';
import type { Auth } from '@posthub/auth';
import { PlatformError } from '@posthub/integrations';
import { Context, Effect } from 'effect';
import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { version } from '../../../package.json';
import { env } from './env';

export interface AppDeps {
  auth: Auth;
  /** The API's services (database, vault, live connector config, media folder), built once at startup. */
  services: Context.Context<ApiServices>;
  /** Origin the browser uses; OAuth redirect URIs are built from it. */
  publicUrl?: string;
  log?: boolean;
}

/** Message safe to show the user; unexpected errors stay generic. */
const userMessage = (error: unknown) =>
  error instanceof ConnectionError || error instanceof PlatformError
    ? error.message
    : 'Something went wrong while connecting. Check the server logs.';

export function createApp({ auth, services, publicUrl = env.publicUrl, log = true }: AppDeps) {
  const app = new Hono();
  const db = Context.get(services, Database);
  const mediaDir = Context.get(services, MediaDir);
  const providerApps = Context.get(services, ProviderApps);
  /** Runs API Effect code with the server's services. */
  const run = <A, E>(effect: Effect.Effect<A, E, ApiServices>) =>
    Effect.runPromise(Effect.provideContext(effect, services));
  const integrations = () => Effect.runSync(providerApps.current);
  if (log) app.use(logger());

  const getSession = (headers: Headers) => auth.api.getSession({ headers });
  const accountsPage = (params: Record<string, string>) =>
    `${publicUrl}/accounts?${new URLSearchParams(params).toString()}`;
  const redirectUri = (provider: string) => `${publicUrl}/connect/${provider}/callback`;

  app.get('/health', (c) => c.json({ ok: true, version }));

  // better-auth owns everything under /api/auth.
  app.on(['GET', 'POST'], '/api/auth/*', (c) => auth.handler(c.req.raw));

  // Platform OAuth: browser navigations, so plain redirects rather than oRPC.
  app.get('/connect/:provider/start', async (c) => {
    const session = await getSession(c.req.raw.headers);
    if (!session) return c.redirect(`${publicUrl}/login`);
    const provider = c.req.param('provider');
    try {
      return c.redirect(
        await run(
          beginOAuth({
            integrations: integrations(),
            userId: session.user.id,
            providerId: provider,
            redirectUri: redirectUri(provider),
          }),
        ),
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
      const accounts = await run(
        completeOAuth({
          integrations: integrations(),
          userId: session.user.id,
          providerId: provider,
          state,
          code,
          redirectUri: redirectUri(provider),
        }),
      );
      return c.redirect(accountsPage({ connected: String(accounts.length) }));
    } catch (err) {
      // Expired or forged state is routine; platform errors are logged to help debug app setup.
      if (!(err instanceof ConnectionError)) {
        console.error(`[connect:${provider}]`, err);
      }
      return c.redirect(accountsPage({ error: userMessage(err) }));
    }
  });

  // Uploaded media, for previews in the composer. Owner only; supports Range so videos can seek.
  app.get('/files/:id', async (c) => {
    const session = await getSession(c.req.raw.headers);
    if (!session) return c.body(null, 401);
    const asset = await db.query.mediaAsset.findFirst({
      where: (m, { and, eq }) => and(eq(m.id, c.req.param('id')), eq(m.userId, session.user.id)),
    });
    const path = asset && join(mediaDir, asset.storagePath);
    const stats = path ? await stat(path).catch(() => null) : null;
    if (!asset || !path || !stats) return c.body(null, 404);

    const headers: Record<string, string> = {
      'content-type': asset.mimeType,
      'accept-ranges': 'bytes',
      'cache-control': 'private, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
    };
    const range = /^bytes=(\d*)-(\d*)$/.exec(c.req.header('range') ?? '');
    let start = 0;
    let end = stats.size - 1;
    if (range && (range[1] || range[2])) {
      start = range[1] ? Number(range[1]) : Math.max(0, stats.size - Number(range[2]));
      end = range[1] && range[2] ? Math.min(Number(range[2]), end) : end;
      if (start > end) {
        return c.body(null, 416, { 'content-range': `bytes */${stats.size}` });
      }
      headers['content-range'] = `bytes ${start}-${end}/${stats.size}`;
    }
    headers['content-length'] = String(end - start + 1);
    const body = Readable.toWeb(createReadStream(path, { start, end })) as ReadableStream;
    return c.body(body, range && headers['content-range'] ? 206 : 200, headers);
  });

  // The typed HTTP API shared with the web app (@posthub/contract).
  const api = apiWebHandler(services, Sessions.layer(auth));
  app.all('/rpc/*', (c) => api.handler(c.req.raw));

  // Production: serve the built PWA from the same origin.
  if (env.isProduction && existsSync(env.webDist)) {
    const root = relative(process.cwd(), env.webDist);
    app.use('/*', serveStatic({ root }));
    app.get('*', serveStatic({ root, path: 'index.html' }));
  }

  return app;
}
