import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { syncState } from "@/db/schema";
import { getValidAccessToken } from "@/lib/oauth";
import { ingestFile } from "@/lib/ingest";
import type { SyncSummary } from "./types";

const GRAPH_API = "https://graph.microsoft.com/v1.0";
const PAGE_SIZE = 100;
// See google-drive.ts for why this exists: a single HTTP request can't
// safely assume a full re-scan finishes within one call.
const MAX_RUNTIME_MS = 45_000;

interface OneNotePage {
  id: string;
  title: string;
  lastModifiedDateTime?: string;
  links?: { oneNoteWebUrl?: { href?: string } };
}

interface OneNotePagesResponse {
  value: OneNotePage[];
  "@odata.nextLink"?: string;
}

async function graphFetch(accessToken: string, url: string) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) {
    throw new Error(`Microsoft Graph (OneNote) request failed: ${res.status} ${await res.text()}`);
  }
  return res;
}

/**
 * Syncs every OneNote page the user has access to. Unlike Drive/OneDrive,
 * Microsoft Graph has no delta/changes endpoint for OneNote, so this does a
 * full re-list on every run; the content-hash check in ingestFile still
 * makes re-syncing unchanged pages cheap (no re-embedding, just a Graph
 * fetch + hash compare). A run that doesn't finish in time persists its
 * current page URL as a resume point for the next call, rather than always
 * restarting from page one (which could otherwise never make progress past
 * the first page on a large notebook).
 *
 * Known limitation: pages deleted in OneNote are not removed from
 * Secondbrain (same tradeoff as local-sync-cli, see its README).
 */
export async function syncOneNote(userId: string): Promise<SyncSummary> {
  const summary: SyncSummary = { processed: 0, skipped: 0, removed: 0, errors: [] };
  const deadline = Date.now() + MAX_RUNTIME_MS;

  const accessToken = await getValidAccessToken(userId, "microsoft-entra-id");
  if (!accessToken) throw new Error("Microsoft 365 is not connected for this user.");

  const [state] = await db
    .select()
    .from(syncState)
    .where(and(eq(syncState.userId, userId), eq(syncState.provider, "onenote")));

  let url: string | undefined =
    state?.cursor || `${GRAPH_API}/me/onenote/pages?$top=${PAGE_SIZE}&$select=id,title,lastModifiedDateTime,links`;

  while (url) {
    const res = await graphFetch(accessToken, url);
    const page = (await res.json()) as OneNotePagesResponse;

    for (const notePage of page.value) {
      try {
        const contentRes = await graphFetch(
          accessToken,
          `${GRAPH_API}/me/onenote/pages/${notePage.id}/content`
        );
        const buffer = Buffer.from(await contentRes.arrayBuffer());

        const result = await ingestFile({
          userId,
          kind: "microsoft365",
          externalId: `onenote:${notePage.id}`,
          title: notePage.title || "Ohne Titel",
          mimeType: "text/html",
          webUrl: notePage.links?.oneNoteWebUrl?.href ?? null,
          sourceUpdatedAt: notePage.lastModifiedDateTime
            ? new Date(notePage.lastModifiedDateTime)
            : null,
          buffer,
        });
        if (result.skipped) summary.skipped += 1;
        else summary.processed += 1;
      } catch (err) {
        summary.errors.push(`${notePage.title}: ${(err as Error).message}`);
      }

      if (Date.now() > deadline) {
        await persistCursor(userId, url);
        return summary;
      }
    }

    url = page["@odata.nextLink"];
    if (Date.now() > deadline && url) {
      await persistCursor(userId, url);
      return summary;
    }
  }

  // Full pass completed: clear the resume cursor so the next run starts
  // a fresh re-scan from page one again.
  await persistCursor(userId, null);
  return summary;
}

async function persistCursor(userId: string, cursor: string | null) {
  await db
    .insert(syncState)
    .values({ userId, provider: "onenote", cursor, status: "idle", lastSyncedAt: new Date() })
    .onConflictDoUpdate({
      target: [syncState.userId, syncState.provider],
      set: { cursor, status: "idle", lastSyncedAt: new Date() },
    });
}
