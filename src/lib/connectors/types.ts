export interface SyncSummary {
  processed: number;
  skipped: number;
  removed: number;
  errors: string[];
  /** false if this call hit its time budget with more work left (a resume
   * cursor was persisted) — the caller should call again immediately to
   * continue, rather than waiting for the next manual click or cron run. */
  done: boolean;
  /** Set when the slice stopped because the embedding provider asked us to
   * back off. Callers should wait about this long before the next slice. */
  retryAfterMs?: number;
}

export function mergeSyncSummaries(summaries: SyncSummary[]): SyncSummary {
  return summaries.reduce(
    (acc, s) => ({
      processed: acc.processed + s.processed,
      skipped: acc.skipped + s.skipped,
      removed: acc.removed + s.removed,
      errors: [...acc.errors, ...s.errors],
      done: acc.done && s.done,
      retryAfterMs: Math.max(acc.retryAfterMs ?? 0, s.retryAfterMs ?? 0) || undefined,
    }),
    { processed: 0, skipped: 0, removed: 0, errors: [], done: true }
  );
}
