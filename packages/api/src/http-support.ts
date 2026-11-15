// Small helpers shared by the HTTP handlers.
import type { Auth, AuthSession } from '@posthub/auth';
import {
  Authorization,
  BadRequest,
  Conflict,
  CurrentUser,
  InputValidation,
  NotFound,
  Unauthorized,
} from '@posthub/contract';
import type { Db } from '@posthub/db';
import { Context, Effect, Layer } from 'effect';
import { HttpServerRequest } from 'effect/http';
import { HttpApiMiddleware } from 'effect/http-api';
import { DatabaseError, type DatabaseService } from './services';

/** Database access for HTTP handlers: a failing statement is a bug, so it becomes a defect (a logged 500). */
export interface HandlerDatabase {
  readonly query: <A>(query: (db: Db) => A) => Effect.Effect<A>;
  /** Runs `effect` in one transaction; failing with an ApiError rolls it back. */
  readonly transaction: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
}

export const handlerDatabase = (database: DatabaseService): HandlerDatabase => ({
  query: (query) => Effect.orDie(database.use(query)),
  transaction: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    // Only BEGIN/COMMIT can fail with a DatabaseError here: queries inside already die on errors.
    database.transaction(effect).pipe(
      Effect.catchIf(
        (error): error is DatabaseError => error instanceof DatabaseError,
        (error) => Effect.die(error),
      ),
    ) as Effect.Effect<A, E, R>,
});

export const notFound = (message = 'Not found.') => new NotFound({ message });
export const badRequest = (message: string) => new BadRequest({ message });
export const conflict = (message: string) => new Conflict({ message });

export interface SessionsService {
  /** The session for these request headers (the better-auth cookie), or null. */
  get(headers: Headers): Effect.Effect<AuthSession | null>;
}

export class Sessions extends Context.Service<Sessions, SessionsService>()(
  '@posthub/api/Sessions',
) {
  static readonly layer = (auth: Auth) =>
    Layer.succeed(Sessions, {
      get: (headers) => Effect.promise(() => auth.api.getSession({ headers })),
    });
}

/** Signed-in endpoints get the session's user as CurrentUser; everyone else gets a 401. */
export const AuthorizationLive = Layer.effect(
  Authorization,
  Effect.gen(function* () {
    const sessions = yield* Sessions;
    return Authorization.of((httpEffect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const session = yield* sessions.get(new Headers(request.headers));
        if (!session) return yield* new Unauthorized({ message: 'Sign in to continue.' });
        return yield* Effect.provideService(httpEffect, CurrentUser, session.user);
      }),
    );
  }),
);

/** Invalid input becomes a BadRequest that says what is wrong. */
export const InputValidationLive = HttpApiMiddleware.layerSchemaErrorTransform(
  InputValidation,
  (error) => Effect.fail(new BadRequest({ message: error.cause.message })),
);
