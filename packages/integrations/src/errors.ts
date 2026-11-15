import { Schema } from 'effect';

export interface PlatformErrorOptions {
  status?: number;
  body?: unknown;
  /** Safe to retry later. Defaults to true for 429/5xx responses. */
  retryable?: boolean;
}

/**
 * A platform said no (or we know the attempt did not happen). `retryable` tells the publisher
 * whether to try again. Network failures are not PlatformErrors: their outcome is unknown.
 */
export class PlatformError extends Schema.TaggedError<PlatformError>()('PlatformError', {
  source: Schema.String,
  message: Schema.String,
  status: Schema.optional(Schema.Number),
  body: Schema.optional(Schema.Unknown),
  retryable: Schema.Boolean,
}) {}

/** Builds a PlatformError whose message is prefixed with its source, e.g. "youtube: ...". */
export const platformError = (
  source: string,
  message: string,
  options: PlatformErrorOptions = {},
): PlatformError =>
  new PlatformError({
    source,
    message: `${source}: ${message}`,
    status: options.status,
    body: options.body,
    retryable:
      options.retryable ??
      (options.status !== undefined && (options.status === 429 || options.status >= 500)),
  });

/** The platform's message without the "source: " prefix. */
export const reason = (error: PlatformError) =>
  error.message.startsWith(`${error.source}: `)
    ? error.message.slice(error.source.length + 2)
    : error.message;
