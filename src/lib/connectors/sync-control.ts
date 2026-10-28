import { mergeSyncSummaries, type SyncSummary } from "./types";

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
