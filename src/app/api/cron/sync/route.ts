import { db } from "@/db";
import { accounts } from "@/db/schema";
import { syncGoogleDrive } from "@/lib/connectors/google-drive";
import { syncMicrosoft365 } from "@/lib/connectors/microsoft365";

export const runtime = "nodejs";
export const maxDuration = 300;

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

  const results: Record<string, unknown> = {};

  for (const { userId, provider } of connected) {
    try {
      if (provider === "google") {
        results[`google_drive:${userId}`] = await syncGoogleDrive(userId);
      } else if (provider === "microsoft-entra-id") {
        results[`microsoft365:${userId}`] = await syncMicrosoft365(userId);
      }
    } catch (err) {
      results[`${provider}:${userId}`] = { error: (err as Error).message };
    }
  }

  return Response.json({ results });
}
