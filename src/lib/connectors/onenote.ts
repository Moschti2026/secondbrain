import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { syncState } from "@/db/schema";
import { getValidAccessToken } from "@/lib/oauth";
import { consolidateDuplicates, ingestFile } from "@/lib/ingest";
import { EmbeddingRateLimitError } from "@/lib/embeddings";
import { resolveSyncDeadline, syncOutOfTime, SyncInterrupted } from "./sync-control";
import { recordIngestOutcome, type SyncSummary } from "./types";
import {
  readOneNoteCursor,
  readUnsupportedSections,
  walkOneNote,
  writeOneNoteCursor,
} from "./onenote-pages";

const GRAPH_API = "https://graph.microsoft.com/v1.0";

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
 * once the account has too many sections. Sections that answer with 422 /
 * code 20258 ("Sync of this section is not supported") are stored on this
 * cursor and skipped. They are tried again after a week, or sooner when
 * the section's lastModifiedDateTime changes. That list is not an error.
 *
 * Known limitation: pages deleted in OneNote are not removed from
 * Secondbrain (same tradeoff as local-sync-cli, see its README).
 */
export async function syncOneNote(
  userId: string,
  options: { deadline?: number } = {}
): Promise<SyncSummary> {
  const summary: SyncSummary = { processed: 0, skipped: 0, removed: 0, errors: [], aliases: 0, done: true };
  const deadline = resolveSyncDeadline(options.deadline);
  if (syncOutOfTime(deadline)) return { ...summary, done: false };

  const accessToken = await getValidAccessToken(userId, "microsoft-entra-id");
  if (!accessToken) throw new Error("Microsoft 365 is not connected for this user.");

  await consolidateDuplicates(userId);

  let stopEarly = false;

  const [state] = await db
    .select()
    .from(syncState)
    .where(and(eq(syncState.userId, userId), eq(syncState.provider, "onenote")));

  const outcome = await walkOneNote(readOneNoteCursor(state?.cursor), {
    unsupported: readUnsupportedSections(state?.cursor),
    onUnsupportedSection: () => {
      summary.unsupportedSections = (summary.unsupportedSections ?? 0) + 1;
    },
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

      if (syncOutOfTime(deadline) || stopEarly) return;

      try {
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
          deadline,
        });
        recordIngestOutcome(summary, result, notePage.title || notePage.id);
      } catch (err) {
        if (err instanceof EmbeddingRateLimitError) {
          summary.retryAfterMs = err.retryAfterMs;
          summary.errors.push(err.message.slice(0, 300));
          stopEarly = true;
          return;
        }
        if (err instanceof SyncInterrupted) {
          summary.retryAfterMs = err.retryAfterMs;
          stopEarly = true;
          return;
        }
        throw err;
      }
    },
    onError: (message) => {
      summary.errors.push(message);
    },
    outOfTime: () => stopEarly || syncOutOfTime(deadline),
  });

  summary.done = !outcome.incomplete;
  const cursor =
    outcome.resume || outcome.unsupported.length > 0
      ? writeOneNoteCursor(
          outcome.resume ?? { sectionsUrl: null, pending: [], pagesUrl: null },
          outcome.unsupported
        )
      : null;
  await persistCursor(userId, cursor);
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
