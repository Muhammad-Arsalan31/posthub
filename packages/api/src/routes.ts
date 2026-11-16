// The HTTP API's server side: every handler group, plus the middleware the contract declares.
import { Api } from '@posthub/contract';
import { NodeHttpServer } from '@effect/platform-node';
import { type Context, Layer } from 'effect';
import { HttpRouter } from 'effect/http';
import { HttpApiBuilder } from 'effect/http-api';
import { AuthorizationLive, InputValidationLive, type Sessions } from './http-support';
import type { ApiServices } from './layer';
import { AccountsHandlers } from './routers/accounts';
import { MediaHandlers } from './routers/media';
import { PostsHandlers } from './routers/posts';
import { ProviderAppsHandlers } from './routers/provider-apps';
import { AnalyticsHandlers } from './routers/analytics';
import { InboxHandlers, SavedRepliesHandlers } from './routers/inbox';
import { MetricsHandlers } from './routers/metrics';
import { QueueHandlers } from './routers/queue';
import { SettingsHandlers } from './routers/settings';
import { SystemHandlers } from './routers/system';

/**
 * Routes for the whole API. Needs the API services (`apiLayer`), `Sessions`, and the HTTP
 * platform services (file system and path, for multipart uploads).
 */
export const ApiRoutes = HttpApiBuilder.layer(Api).pipe(
  Layer.provide([
    SystemHandlers,
    PostsHandlers,
    MediaHandlers,
    AccountsHandlers,
    ProviderAppsHandlers,
    SettingsHandlers,
    QueueHandlers,
    MetricsHandlers,
    AnalyticsHandlers,
    InboxHandlers,
    SavedRepliesHandlers,
  ]),
  Layer.provide([AuthorizationLive, InputValidationLive]),
);

/**
 * Serves the API as a fetch-style handler over already-built API services, so the server's
 * runtime (and the publisher) share one ProviderApps state with request handlers.
 */
export function apiWebHandler(
  services: Context.Context<ApiServices>,
  sessions: Layer.Layer<Sessions>,
  options: { log?: boolean } = {},
) {
  return HttpRouter.toWebHandler(
    ApiRoutes.pipe(
      Layer.provide([sessions, Layer.succeedContext(services), NodeHttpServer.layerHttpServices]),
    ),
    { disableLogger: !options.log },
  );
}
