export interface SyncSummary {
  processed: number;
  skipped: number;
  removed: number;
  errors: string[];
  /** Copies linked to an existing document instead of embedded again. */
  aliases?: number;
  /** OneNote sections Graph refuses with 422 / code 20258. Not errors. */
  unsupportedSections?: number;
  /** false if this call hit its time budget with more work left (a resume
   * cursor was persisted) — the caller should call again immediately to
   * continue, rather than waiting for the next manual click or cron run. */
  done: boolean;
  /** Set when the slice stopped because the embedding provider asked us to
   * back off. Callers should wait about this long before the next slice. */
  retryAfterMs?: number;
}

export function mergeSyncSummaries(summaries: SyncSummary[]): SyncSummary {
  return summaries.reduce((acc, s) => {
    const unsupportedSections = (acc.unsupportedSections ?? 0) + (s.unsupportedSections ?? 0);
    return {
      processed: acc.processed + s.processed,
      skipped: acc.skipped + s.skipped,
      removed: acc.removed + s.removed,
      errors: [...acc.errors, ...s.errors],
      aliases: (acc.aliases ?? 0) + (s.aliases ?? 0),
      done: acc.done && s.done,
      retryAfterMs: Math.max(acc.retryAfterMs ?? 0, s.retryAfterMs ?? 0) || undefined,
      ...(unsupportedSections > 0 ? { unsupportedSections } : {}),
    };
  }, { processed: 0, skipped: 0, removed: 0, errors: [], aliases: 0, done: true });
}

export function recordIngestOutcome(
  summary: SyncSummary,
  result: { skipped: boolean; aliasOf?: string; error?: string },
  label: string
): void {
  if (result.aliasOf) {
    summary.aliases = (summary.aliases ?? 0) + 1;
    summary.skipped += 1;
    return;
  }
  if (result.error) {
    summary.errors.push(`${label}: ${result.error}`.slice(0, 300));
    return;
  }
  if (result.skipped) summary.skipped += 1;
  else summary.processed += 1;
}
