/** Waits before retry 1, 2 and 3 of a retryable failure (429, 5xx, still processing). */
export const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000];
