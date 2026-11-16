// Every HTTP route the server answers, as one Layer of routes on Effect's HttpRouter.
import { stat } from 'node:fs/promises';
import {
  ApiRoutes,
  beginOAuth,
  completeOAuth,
  ConnectionError,
  analyticsCsv,
  Database,
  findOwnMedia,
  loadAnalytics,
  type MediaDir,
  ProviderApps,
  Sessions,
} from '@posthub/api';
import type { Auth } from '@posthub/auth';
import { PlatformError, type Vault } from '@posthub/integrations';
import { Cause, type Context, Effect, Layer } from 'effect';
import {
  type HttpPlatform,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
  HttpStaticServer,
} from 'effect/http';
import { version } from '../../../package.json';
import { env } from './env';

export interface AppOptions {
  auth: Auth;
  /** Origin the browser uses; OAuth redirect URIs are built from it. */
  publicUrl?: string;
  /** Built PWA to serve from the same origin (production). */
  webDist?: string;
}

/** Message safe to show the user; unexpected errors stay generic. */
const userMessage = (error: unknown) =>
  error instanceof ConnectionError || error instanceof PlatformError
    ? error.message
    : 'Something went wrong while connecting. Check the server logs.';

const sessionOf = (request: HttpServerRequest.HttpServerRequest) =>
  Effect.flatMap(Sessions, (sessions) => sessions.get(new Headers(request.headers)));

const searchParams = (request: HttpServerRequest.HttpServerRequest) =>
  new URL(request.url, 'http://posthub.local').searchParams;

/**
 * The server's routes: health, better-auth, OAuth redirects, media files, the typed API and,
 * when `webDist` is given, the PWA. Needs the API services (`apiLayer`), `Sessions` and the HTTP platform.
 */
export const appRoutes = ({ auth, publicUrl = env.publicUrl, webDist }: AppOptions) =>
  Layer.unwrap(
    Effect.map(
      Effect.context<
        Sessions | ProviderApps | Database | MediaDir | Vault | HttpPlatform.HttpPlatform
      >(),
      (services) => buildRoutes({ auth, publicUrl, webDist }, services),
    ),
  );

/** Routes whose handlers run with `services`, captured once when the server starts. */
function buildRoutes(
  { auth, publicUrl, webDist }: Required<Pick<AppOptions, 'auth' | 'publicUrl'>> & AppOptions,
  services: Context.Context<
    Sessions | ProviderApps | Database | MediaDir | Vault | HttpPlatform.HttpPlatform
  >,
) {
  const withServices = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.provide(effect, services);
  const accountsPage = (params: Record<string, string>) =>
    HttpServerResponse.redirect(`${publicUrl}/accounts?${new URLSearchParams(params).toString()}`);
  const loginPage = HttpServerResponse.redirect(`${publicUrl}/login`);
  const redirectUri = (provider: string) => `${publicUrl}/connect/${provider}/callback`;

  const health = HttpRouter.add(
    'GET',
    '/health',
    HttpServerResponse.jsonUnsafe({ ok: true, version }),
  );

  // better-auth owns everything under /api/auth.
  const betterAuth = HttpRouter.add('*', '/api/auth/*', (request) =>
    withServices(
      Effect.gen(function* () {
        const web = yield* HttpServerRequest.toWeb(request);
        const response = yield* Effect.promise(() => auth.handler(web));
        return HttpServerResponse.fromWeb(response);
      }).pipe(Effect.orDie),
    ),
  );

  // Platform OAuth: browser navigations, so plain redirects rather than API calls.
  const connectStart = HttpRouter.add('GET', '/connect/:provider/start', (request) =>
    withServices(
      Effect.gen(function* () {
        const session = yield* sessionOf(request);
        if (!session) return loginPage;
        const { provider = '' } = yield* HttpRouter.params;
        const integrations = yield* (yield* ProviderApps).current;
        return yield* beginOAuth({
          integrations,
          userId: session.user.id,
          providerId: provider,
          redirectUri: redirectUri(provider),
        }).pipe(
          Effect.map((url) => HttpServerResponse.redirect(url)),
          Effect.catchCause((cause) =>
            Effect.succeed(accountsPage({ error: userMessage(Cause.squash(cause)) })),
          ),
        );
      }),
    ),
  );

  const connectCallback = HttpRouter.add('GET', '/connect/:provider/callback', (request) =>
    withServices(
      Effect.gen(function* () {
        const session = yield* sessionOf(request);
        if (!session) return loginPage;
        const { provider = '' } = yield* HttpRouter.params;
        const query = searchParams(request);
        const code = query.get('code');
        const state = query.get('state');
        const error = query.get('error');
        if (error || !code || !state) {
          return accountsPage({
            error: query.get('error_description') ?? error ?? 'Connection was cancelled.',
          });
        }
        const integrations = yield* (yield* ProviderApps).current;
        return yield* completeOAuth({
          integrations,
          userId: session.user.id,
          providerId: provider,
          state,
          code,
          redirectUri: redirectUri(provider),
        }).pipe(
          Effect.map((accounts) => accountsPage({ connected: String(accounts.length) })),
          Effect.catchCause((cause) => {
            const failure = Cause.squash(cause);
            // Expired or forged state is routine; platform errors are logged to help debug app setup.
            const log =
              failure instanceof ConnectionError
                ? Effect.void
                : Effect.logError(`[connect:${provider}]`, cause);
            return Effect.as(log, accountsPage({ error: userMessage(failure) }));
          }),
        );
      }),
    ),
  );

  // Uploaded media, for previews in the composer. Owner only; supports Range so videos can seek.
  const files = HttpRouter.add('GET', '/files/:id', (request) =>
    withServices(
      Effect.gen(function* () {
        const session = yield* sessionOf(request);
        if (!session) return HttpServerResponse.empty({ status: 401 });
        const { id = '' } = yield* HttpRouter.params;
        const asset = yield* findOwnMedia(session.user.id, id);
        const stats = asset
          ? yield* Effect.promise(() => stat(asset.path).catch(() => null))
          : null;
        if (!asset || !stats) return HttpServerResponse.empty({ status: 404 });
        const { path } = asset;

        const headers: Record<string, string> = {
          'accept-ranges': 'bytes',
          'cache-control': 'private, max-age=31536000, immutable',
          'x-content-type-options': 'nosniff',
        };
        const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers['range'] ?? '');
        let start = 0;
        let end = stats.size - 1;
        let status = 200;
        if (range && (range[1] || range[2])) {
          start = range[1] ? Number(range[1]) : Math.max(0, stats.size - Number(range[2]));
          end = range[1] && range[2] ? Math.min(Number(range[2]), end) : end;
          if (start > end) {
            return HttpServerResponse.empty({
              status: 416,
              headers: { 'content-range': `bytes */${stats.size}` },
            });
          }
          headers['content-range'] = `bytes ${start}-${end}/${stats.size}`;
          status = 206;
        }
        return yield* HttpServerResponse.file(path, {
          offset: start,
          bytesToRead: end - start + 1,
          status,
          headers,
          contentType: asset.mimeType,
        });
      }).pipe(Effect.orDie),
    ),
  );

  // Analytics as CSV, downloaded with a plain link (the typed API only speaks JSON).
  const analyticsExport = HttpRouter.add('GET', '/analytics/export.csv', (request) =>
    withServices(
      Effect.gen(function* () {
        const session = yield* sessionOf(request);
        if (!session) return HttpServerResponse.empty({ status: 401 });
        const params = searchParams(request);
        const from = Date.parse(params.get('from') ?? '');
        const to = Date.parse(params.get('to') ?? '');
        if (Number.isNaN(from) || Number.isNaN(to) || from > to) {
          return HttpServerResponse.text('Pass from and to as ISO dates.', { status: 400 });
        }
        const accountIds = params.getAll('accountId');
        const database = yield* Database;
        const csv = yield* database.use((db) =>
          analyticsCsv(loadAnalytics(db, session.user.id, accountIds), from, to),
        );
        const name = `posthub-${new Date(from).toISOString().slice(0, 10)}-to-${new Date(to).toISOString().slice(0, 10)}.csv`;
        return HttpServerResponse.text(csv, {
          contentType: 'text/csv; charset=utf-8',
          headers: { 'content-disposition': `attachment; filename="${name}"` },
        });
      }).pipe(Effect.orDie),
    ),
  );

  const routes = Layer.mergeAll(
    health,
    betterAuth,
    connectStart,
    connectCallback,
    files,
    analyticsExport,
    // The typed HTTP API shared with the web app (@posthub/contract).
    ApiRoutes,
  );

  return webDist
    ? Layer.mergeAll(routes, HttpStaticServer.layer({ root: webDist, spa: true }).pipe(Layer.orDie))
    : routes;
}
