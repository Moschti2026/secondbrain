import { mergeSyncSummaries, type SyncSummary } from "./types";

/** Per-invocation budget for GET /api/cron/sync. Stays under the 300s
 * platform limit so the function can persist its cursor and answer. */
export const CRON_SYNC_BUDGET_MS = 240_000;

/** Manual "Sync" clicks stay short; the cron loop is what drains a backlog. */
export const MANUAL_SYNC_BUDGET_MS = 45_000;

/** Do not start a download or embed once less than this remains before the
 * slice deadline. The cron budget is 240s against a 300s platform limit,
 * so one slow file still fits after this margin. */
export const SYNC_SAFETY_MARGIN_MS = 15_000;

export function resolveSyncDeadline(deadline?: number): number {
  return deadline ?? Date.now() + MANUAL_SYNC_BUDGET_MS;
}

export function syncOutOfTime(deadline: number, margin = SYNC_SAFETY_MARGIN_MS): boolean {
  return Date.now() >= deadline - margin;
}

export interface SyncJob {
  key: string;
  run: (deadline: number) => Promise<SyncSummary>;
}

function idleSummary(done: boolean, error?: string): SyncSummary {
  return {
    processed: 0,
    skipped: 0,
    removed: 0,
    errors: error ? [error.slice(0, 500)] : [],
    aliases: 0,
    done,
  };
}

/**
 * Runs each source for an equal slice of `budgetMs` first, then spends
 * whatever time is left on sources that reported more work. One source
 * cannot consume the whole request before the others have started, and a
 * throw in one source does not skip the rest.
 */
export async function runSyncJobs(
  jobs: SyncJob[],
  options: { budgetMs: number; now?: () => number; marginMs?: number }
): Promise<{ hasMore: boolean; results: Record<string, SyncSummary> }> {
  const now = options.now ?? Date.now;
  const marginMs = options.marginMs ?? 5_000;
  const deadline = now() + options.budgetMs;
  const results: Record<string, SyncSummary> = {};

  const slice = Math.max(1_000, Math.floor((deadline - now()) / Math.max(jobs.length, 1)));

  for (const job of jobs) {
    if (now() >= deadline - marginMs) {
      results[job.key] = idleSummary(false);
      continue;
    }
    const jobDeadline = Math.min(deadline, now() + slice);
    try {
      results[job.key] = await job.run(jobDeadline);
    } catch (err) {
      results[job.key] = idleSummary(true, (err as Error).message);
    }
  }

  for (const job of jobs) {
    const current = results[job.key];
    if (!current || current.done) continue;
    if (now() >= deadline - marginMs) break;
    try {
      const more = await job.run(deadline);
      const merged = mergeSyncSummaries([current, more]);
      // The later call is the one that knows whether the source finished.
      results[job.key] = { ...merged, done: more.done, retryAfterMs: more.retryAfterMs };
    } catch (err) {
      const merged = mergeSyncSummaries([
        current,
        idleSummary(true, (err as Error).message),
      ]);
      results[job.key] = merged;
    }
  }

  const hasMore = Object.values(results).some((result) => !result.done);
  return { hasMore, results };
}

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

function clipSyncError(message: string): string {
  return message.slice(0, 500);
}

/** Runs one source and turns a throw into a summary error. Other sources
 * keep running, and the message is logged without request headers. */
async function settleSyncSource(
  label: string,
  run: () => Promise<SyncSummary>
): Promise<SyncSummary> {
  try {
    return await run();
  } catch (err) {
    const message = clipSyncError(`${label}: ${(err as Error).message}`);
    console.error(`[sync] ${message}`);
    return { processed: 0, skipped: 0, removed: 0, errors: [message], done: true };
  }
}

/**
 * OneDrive first, then OneNote. Each source is settled on its own, so a
 * throw in OneNote cannot drop OneDrive's summary or skip it (and the
 * other way around). Pass `deadline` to repeat each source until it
 * reports done or the deadline passes; omit it for a single slice.
 */
export async function syncMicrosoftAccount(
  sources: {
    onedrive: () => Promise<SyncSummary>;
    onenote: () => Promise<SyncSummary>;
  },
  deadline?: number
): Promise<SyncSummary> {
  const runSource = (label: string, source: () => Promise<SyncSummary>) => {
    const settled = () => settleSyncSource(label, source);
    if (deadline === undefined) return settled();
    return syncUntilDoneOrDeadline(settled, deadline);
  };
  const files = await runSource("OneDrive", sources.onedrive);
  const notes = await runSource("OneNote", sources.onenote);
  return mergeSyncSummaries([files, notes]);
}

/** Repeats a time-boxed sync call until it reports done, or the shared
 * deadline is reached — so a large first sync converges over a few runs
 * instead of one short slice per night. */
export async function syncUntilDoneOrDeadline(
  run: () => Promise<SyncSummary>,
  deadline: number
): Promise<SyncSummary> {
  const rounds: SyncSummary[] = [];
  for (;;) {
    const result = await run();
    rounds.push(result);
    if (result.done || Date.now() > deadline) break;
    if (result.retryAfterMs && result.retryAfterMs > 0) {
      const wait = Math.min(result.retryAfterMs, Math.max(0, deadline - Date.now()));
      if (wait < 500) break;
      await new Promise((resolve) => setTimeout(resolve, wait));
      if (Date.now() > deadline) break;
    }
  }
  return mergeSyncSummaries(rounds);
}
