export interface PlatformErrorOptions {
  status?: number;
  body?: unknown;
  /** Safe to retry later. Defaults to true for 429/5xx responses. */
  retryable?: boolean;
}

/** Any failure talking to a platform. `retryable` tells the publisher whether to try again. */
export class PlatformError extends Error {
  readonly source: string;
  readonly status: number | undefined;
  readonly body: unknown;
  readonly retryable: boolean;

  constructor(source: string, message: string, options: PlatformErrorOptions = {}) {
    super(`${source}: ${message}`);
    this.name = 'PlatformError';
    this.source = source;
    this.status = options.status;
    this.body = options.body;
    this.retryable =
      options.retryable ??
      (options.status !== undefined && (options.status === 429 || options.status >= 500));
  }
}
