// Expected failures, each with an HTTP status and a message that is safe to show the owner.
import { Schema } from 'effect';

export class Unauthorized extends Schema.TaggedError<Unauthorized>()(
  'Unauthorized',
  { message: Schema.String },
  { httpApiStatus: 401 },
) {}

export class NotFound extends Schema.TaggedError<NotFound>()(
  'NotFound',
  { message: Schema.String },
  { httpApiStatus: 404 },
) {}

/** The request can't be done as asked (invalid input, a platform that can't take this post). */
export class BadRequest extends Schema.TaggedError<BadRequest>()(
  'BadRequest',
  { message: Schema.String },
  { httpApiStatus: 400 },
) {}

/** The data is in a state that doesn't allow this (e.g. the post is already publishing). */
export class Conflict extends Schema.TaggedError<Conflict>()(
  'Conflict',
  { message: Schema.String },
  { httpApiStatus: 409 },
) {}

/** A platform the server talked to failed. */
export class BadGateway extends Schema.TaggedError<BadGateway>()(
  'BadGateway',
  { message: Schema.String },
  { httpApiStatus: 502 },
) {}

/** Errors any endpoint may return. */
export const ApiErrors = [NotFound, BadRequest, Conflict, BadGateway] as const;
export type ApiError = NotFound | BadRequest | Conflict | BadGateway;
