export interface SyncSummary {
  processed: number;
  skipped: number;
  removed: number;
  errors: string[];
}

export function mergeSyncSummaries(summaries: SyncSummary[]): SyncSummary {
  return summaries.reduce(
    (acc, s) => ({
      processed: acc.processed + s.processed,
      skipped: acc.skipped + s.skipped,
      removed: acc.removed + s.removed,
      errors: [...acc.errors, ...s.errors],
    }),
    { processed: 0, skipped: 0, removed: 0, errors: [] }
  );
}
