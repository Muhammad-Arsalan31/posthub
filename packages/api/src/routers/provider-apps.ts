import { Api, BadRequest } from '@posthub/contract';
import { Effect } from 'effect';
import { HttpApiBuilder } from 'effect/http-api';
import { ProviderApps } from '../provider-apps';

export const ProviderAppsHandlers = HttpApiBuilder.group(Api, 'providerApps', (handlers) =>
  Effect.gen(function* () {
    const providerApps = yield* ProviderApps;

    return handlers.handleAll({
      save: ({ payload }) =>
        providerApps.save(payload.provider, payload).pipe(
          Effect.catchTag('ProviderAppError', (error) =>
            Effect.fail(new BadRequest({ message: error.message })),
          ),
          Effect.as({ provider: payload.provider }),
        ),

      remove: ({ payload }) =>
        providerApps.remove(payload.provider).pipe(Effect.as({ provider: payload.provider })),
    });
  }),
);
