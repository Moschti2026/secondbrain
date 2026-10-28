/** Raised when a slice should stop cleanly and continue on the next call
 * (rate limit or similar), without marking the sync as failed. */
export class SyncInterrupted extends Error {
  readonly retryAfterMs?: number;
  /** When set, this cursor is persisted before the slice returns. */
  readonly resumeCursor?: string;

  constructor(
    message: string,
    options: { retryAfterMs?: number; resumeCursor?: string } = {}
  ) {
    super(message);
    this.name = "SyncInterrupted";
    this.retryAfterMs = options.retryAfterMs;
    this.resumeCursor = options.resumeCursor;
  }
}
