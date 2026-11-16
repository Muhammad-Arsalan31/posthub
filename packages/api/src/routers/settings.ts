import { Api, BadGateway, BadRequest, CurrentUser } from '@posthub/contract';
import { Effect } from 'effect';
import { HttpApiBuilder } from 'effect/http-api';
import { MediaHosts } from '../media-hosts';

export const SettingsHandlers = HttpApiBuilder.group(Api, 'settings', (handlers) =>
  Effect.gen(function* () {
    const mediaHosts = yield* MediaHosts;
    return handlers.handleAll({
      mediaHost: () =>
        Effect.flatMap(CurrentUser, (user) => Effect.orDie(mediaHosts.describe(user.id))),

      saveMediaHost: ({ payload }) =>
        Effect.gen(function* () {
          const user = yield* CurrentUser;
          yield* mediaHosts.save(user.id, payload);
          return (yield* mediaHosts.describe(user.id))!;
        }).pipe(
          Effect.catchTags({
            MediaHostError: (error) => Effect.fail(new BadRequest({ message: error.message })),
            DatabaseError: Effect.die,
          }),
        ),

      removeMediaHost: () =>
        Effect.flatMap(CurrentUser, (user) =>
          mediaHosts.remove(user.id).pipe(Effect.orDie, Effect.as({ ok: true })),
        ),

      testMediaHost: ({ payload }) =>
        Effect.gen(function* () {
          const user = yield* CurrentUser;
          const host = yield* mediaHosts.build(user.id, payload);
          yield* host
            .check()
            .pipe(Effect.mapError((error) => new BadGateway({ message: error.message })));
          return { ok: true };
        }).pipe(
          Effect.catchTags({
            MediaHostError: (error) => Effect.fail(new BadRequest({ message: error.message })),
            DatabaseError: Effect.die,
          }),
        ),
    });
  }),
);
