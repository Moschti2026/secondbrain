export interface SyncSummary {
  processed: number;
  skipped: number;
  removed: number;
  errors: string[];
  /** false if this call hit its time budget with more work left (a resume
   * cursor was persisted) — the caller should call again immediately to
   * continue, rather than waiting for the next manual click or cron run. */
  done: boolean;
}

export function mergeSyncSummaries(summaries: SyncSummary[]): SyncSummary {
  return summaries.reduce(
    (acc, s) => ({
      processed: acc.processed + s.processed,
      skipped: acc.skipped + s.skipped,
      removed: acc.removed + s.removed,
      errors: [...acc.errors, ...s.errors],
      done: acc.done && s.done,
    }),
    { processed: 0, skipped: 0, removed: 0, errors: [], done: true }
  );
}
