// Small helpers shared by the HTTP handlers.
import type { Auth, AuthSession } from '@posthub/auth';
import {
  Authorization,
  BadGateway,
  BadRequest,
  Conflict,
  CurrentUser,
  InputValidation,
  NotFound,
  Unauthorized,
  type ApiError,
} from '@posthub/contract';
import { Context, Effect, Layer } from 'effect';
import { HttpServerRequest } from 'effect/http';
import { HttpApiMiddleware } from 'effect/http-api';

const isApiError = (error: unknown): error is ApiError =>
  error instanceof NotFound ||
  error instanceof BadRequest ||
  error instanceof Conflict ||
  error instanceof BadGateway;

/**
 * Runs synchronous database work (e.g. a Drizzle transaction). Throwing an ApiError inside it
 * rolls the transaction back and fails with that error; anything else is a defect.
 */
export const trySync = <A>(work: () => A): Effect.Effect<A, ApiError> =>
  Effect.suspend(() => {
    try {
      return Effect.succeed(work());
    } catch (error) {
      return isApiError(error) ? Effect.fail(error) : Effect.die(error);
    }
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
