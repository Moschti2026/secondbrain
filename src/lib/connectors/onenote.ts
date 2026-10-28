import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { syncState } from "@/db/schema";
import { getValidAccessToken } from "@/lib/oauth";
import { ingestFile } from "@/lib/ingest";
import type { SyncSummary } from "./types";
import {
  readOneNoteCursor,
  walkOneNote,
  writeOneNoteCursor,
} from "./onenote-pages";

const GRAPH_API = "https://graph.microsoft.com/v1.0";
// See google-drive.ts for why this exists: a single HTTP request can't
// safely assume a full re-scan finishes within one call.
const MAX_RUNTIME_MS = 45_000;

async function graphFetch(accessToken: string, url: string) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 300);
    throw new Error(`Microsoft Graph (OneNote) request failed: ${res.status} ${body}`);
  }
  return res;
}

/**
 * Syncs every OneNote page the user has access to. Unlike Drive/OneDrive,
 * Microsoft Graph has no delta/changes endpoint for OneNote, so this does a
 * full re-list on every run; the content-hash check in ingestFile still
 * makes re-syncing unchanged pages cheap (no re-embedding, just a Graph
 * fetch + hash compare). A run that doesn't finish in time persists its
 * section/page position as a resume point for the next call.
 *
 * Pages are listed per section (`/me/onenote/sections/{id}/pages`). The
 * global `/me/onenote/pages` collection fails with Graph 400 / code 20266
 * once the account has too many sections.
 *
 * Known limitation: pages deleted in OneNote are not removed from
 * Secondbrain (same tradeoff as local-sync-cli, see its README).
 */
export async function syncOneNote(userId: string): Promise<SyncSummary> {
  const summary: SyncSummary = { processed: 0, skipped: 0, removed: 0, errors: [], done: true };
  const deadline = Date.now() + MAX_RUNTIME_MS;

  const accessToken = await getValidAccessToken(userId, "microsoft-entra-id");
  if (!accessToken) throw new Error("Microsoft 365 is not connected for this user.");

  const [state] = await db
    .select()
    .from(syncState)
    .where(and(eq(syncState.userId, userId), eq(syncState.provider, "onenote")));

  const outcome = await walkOneNote(readOneNoteCursor(state?.cursor), {
    fetchJson: async (url) => {
      const res = await graphFetch(accessToken, url);
      return res.json();
    },
    onPage: async (notePage, section) => {
      const contentRes = await graphFetch(
        accessToken,
        `${GRAPH_API}/me/onenote/pages/${encodeURIComponent(notePage.id)}/content`
      );
      const buffer = Buffer.from(await contentRes.arrayBuffer());

      const result = await ingestFile({
        userId,
        kind: "microsoft365",
        externalId: `onenote:${notePage.id}`,
        folderPath: section.displayName ? `OneNote/${section.displayName}` : "OneNote",
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
    },
    onError: (message) => {
      summary.errors.push(message);
    },
    outOfTime: () => Date.now() > deadline,
  });

  summary.done = !outcome.incomplete;
  await persistCursor(userId, outcome.resume ? writeOneNoteCursor(outcome.resume) : null);
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
