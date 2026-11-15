import { Api, CurrentUser, PLATFORMS } from '@posthub/contract';
import { Clock, Effect } from 'effect';
import { HttpApiBuilder } from 'effect/http-api';

export const SystemHandlers = HttpApiBuilder.group(Api, 'system', (handlers) =>
  Effect.succeed(
    handlers.handleAll({
      health: () => Effect.map(Clock.currentTimeMillis, (ms) => ({ ok: true, time: new Date(ms) })),
      platforms: () => Effect.succeed([...PLATFORMS]),
      me: () => CurrentUser,
    }),
  ),
);
