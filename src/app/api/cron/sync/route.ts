import { db } from "@/db";
import { accounts } from "@/db/schema";
import { syncGoogleDrive } from "@/lib/connectors/google-drive";
import { syncMicrosoft365 } from "@/lib/connectors/microsoft365";
import { syncOneNote } from "@/lib/connectors/onenote";
import { CRON_SYNC_BUDGET_MS, runSyncJobs, type SyncJob } from "@/lib/connectors/sync-control";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Periodic re-sync for every user with a connected account. Wire this up
 * as a Vercel Cron job (see vercel.json) hitting this route with the
 * `Authorization: Bearer $CRON_SECRET` header Vercel adds automatically
 * when CRON_SECRET is set.
 *
 * Each invocation stops around {@link CRON_SYNC_BUDGET_MS} and persists
 * cursors in `sync_state`. Call again while `hasMore` is true.
 */
export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const connected = await db
    .select({ userId: accounts.userId, provider: accounts.provider })
    .from(accounts);

  const jobs: SyncJob[] = [];
  for (const { userId, provider } of connected) {
    if (provider === "google") {
      jobs.push({
        key: `google_drive:${userId}`,
        run: (deadline) => syncGoogleDrive(userId, { deadline }),
      });
    } else if (provider === "microsoft-entra-id") {
      // Separate jobs so a long OneDrive backlog cannot skip OneNote, and
      // a failure in one source stays in that source's summary.
      jobs.push({
        key: `onedrive:${userId}`,
        run: (deadline) => syncMicrosoft365(userId, { deadline }),
      });
      jobs.push({
        key: `onenote:${userId}`,
        run: (deadline) => syncOneNote(userId, { deadline }),
      });
    }
  }

  const { hasMore, results } = await runSyncJobs(jobs, { budgetMs: CRON_SYNC_BUDGET_MS });
  return Response.json({ hasMore, results });
}
