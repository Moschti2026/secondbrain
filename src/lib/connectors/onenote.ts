import { getValidAccessToken } from "@/lib/oauth";
import { ingestFile } from "@/lib/ingest";
import type { SyncSummary } from "./types";

const GRAPH_API = "https://graph.microsoft.com/v1.0";
const PAGE_SIZE = 100;

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
 * fetch + hash compare).
 *
 * Known limitation: pages deleted in OneNote are not removed from
 * Secondbrain (same tradeoff as local-sync-cli, see its README).
 */
export async function syncOneNote(userId: string): Promise<SyncSummary> {
  const summary: SyncSummary = { processed: 0, skipped: 0, removed: 0, errors: [] };

  const accessToken = await getValidAccessToken(userId, "microsoft-entra-id");
  if (!accessToken) throw new Error("Microsoft 365 is not connected for this user.");

  let url: string | undefined =
    `${GRAPH_API}/me/onenote/pages?$top=${PAGE_SIZE}&$select=id,title,lastModifiedDateTime,links`;

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
    }

    url = page["@odata.nextLink"];
  }

  return summary;
}
