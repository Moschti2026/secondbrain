import { db } from "@/db";
import { accounts } from "@/db/schema";
import { syncGoogleDrive } from "@/lib/connectors/google-drive";
import { syncMicrosoft365 } from "@/lib/connectors/microsoft365";
import { syncOneNote } from "@/lib/connectors/onenote";
import { mergeSyncSummaries, type SyncSummary } from "@/lib/connectors/types";

export const runtime = "nodejs";
export const maxDuration = 300;

// Leaves headroom under maxDuration for the current response to still get
// sent; if the actual platform limit is lower (e.g. 60s on some plans),
// the function is simply cut off earlier and picks up next run — no worse
// than before, just less time to make progress in one run.
const OVERALL_DEADLINE_MS = 250_000;

/** Repeats a time-boxed sync call until it reports done, or the shared
 * cron deadline is reached — so a large first sync converges over a few
 * nightly runs instead of one 45s slice per night per user. */
async function syncUntilDoneOrDeadline(
  run: () => Promise<SyncSummary>,
  deadline: number
): Promise<SyncSummary> {
  const rounds: SyncSummary[] = [];
  for (;;) {
    const result = await run();
    rounds.push(result);
    if (result.done || Date.now() > deadline) break;
  }
  return mergeSyncSummaries(rounds);
}

/**
 * Periodic re-sync for every user with a connected account. Wire this up
 * as a Vercel Cron job (see vercel.json) hitting this route with the
 * `Authorization: Bearer $CRON_SECRET` header Vercel adds automatically
 * when CRON_SECRET is set.
 */
export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const connected = await db
    .select({ userId: accounts.userId, provider: accounts.provider })
    .from(accounts);

  const deadline = Date.now() + OVERALL_DEADLINE_MS;
  const results: Record<string, unknown> = {};

  for (const { userId, provider } of connected) {
    if (Date.now() > deadline) {
      results[`${provider}:${userId}`] = { skipped: "out of time this run, continues next run" };
      continue;
    }
    try {
      if (provider === "google") {
        results[`google_drive:${userId}`] = await syncUntilDoneOrDeadline(
          () => syncGoogleDrive(userId),
          deadline
        );
      } else if (provider === "microsoft-entra-id") {
        const files = await syncUntilDoneOrDeadline(() => syncMicrosoft365(userId), deadline);
        const notes = await syncUntilDoneOrDeadline(() => syncOneNote(userId), deadline);
        results[`microsoft365:${userId}`] = mergeSyncSummaries([files, notes]);
      }
    } catch (err) {
      results[`${provider}:${userId}`] = { error: (err as Error).message };
    }
  }

  return Response.json({ results });
}
