import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { syncState } from "@/db/schema";
import { getValidAccessToken } from "@/lib/oauth";
import { ingestFile } from "@/lib/ingest";
import { SUPPORTED_MIME_TYPES } from "@/lib/extract";

const GRAPH_API = "https://graph.microsoft.com/v1.0";
const MAX_FILE_BYTES = 20 * 1024 * 1024; // 20 MB safety cap per file

interface DriveItem {
  id: string;
  name: string;
  webUrl?: string;
  lastModifiedDateTime?: string;
  size?: number;
  file?: { mimeType: string };
  folder?: unknown;
  deleted?: unknown;
  "@microsoft.graph.downloadUrl"?: string;
}

interface DeltaPage {
  value: DriveItem[];
  "@odata.nextLink"?: string;
  "@odata.deltaLink"?: string;
}

async function graphFetch(accessToken: string, url: string) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) {
    throw new Error(`Microsoft Graph request failed: ${res.status} ${await res.text()}`);
  }
  return res;
}

async function downloadItem(item: DriveItem): Promise<Buffer | null> {
  if (!item.file) return null; // folder or other non-file item
  const mimeType = item.file.mimeType;
  if (!SUPPORTED_MIME_TYPES.includes(mimeType)) return null;
  if (item.size && item.size > MAX_FILE_BYTES) return null;

  const downloadUrl = item["@microsoft.graph.downloadUrl"];
  if (!downloadUrl) return null;

  // The pre-authenticated download URL needs no Authorization header.
  const res = await fetch(downloadUrl);
  if (!res.ok) throw new Error(`Download failed for ${item.name}: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

export interface SyncSummary {
  processed: number;
  skipped: number;
  removed: number;
  errors: string[];
}

/**
 * Incrementally syncs the user's OneDrive using Microsoft Graph's delta
 * query. SharePoint site libraries are out of scope for this first pass
 * (the Sites.Read.All scope is already requested so that's a follow-up,
 * not a new OAuth consent).
 */
export async function syncMicrosoft365(userId: string): Promise<SyncSummary> {
  const summary: SyncSummary = { processed: 0, skipped: 0, removed: 0, errors: [] };

  await db
    .insert(syncState)
    .values({ userId, provider: "microsoft365", status: "syncing" })
    .onConflictDoUpdate({
      target: [syncState.userId, syncState.provider],
      set: { status: "syncing", lastError: null },
    });

  try {
    const accessToken = await getValidAccessToken(userId, "microsoft-entra-id");
    if (!accessToken) throw new Error("Microsoft 365 is not connected for this user.");

    const [state] = await db
      .select()
      .from(syncState)
      .where(and(eq(syncState.userId, userId), eq(syncState.provider, "microsoft365")));

    let url =
      state?.cursor ??
      `${GRAPH_API}/me/drive/root/delta?$select=id,name,webUrl,lastModifiedDateTime,size,file,folder,deleted`;
    let newCursor = state?.cursor ?? null;

    while (url) {
      const res = await graphFetch(accessToken, url);
      const page = (await res.json()) as DeltaPage;

      for (const item of page.value) {
        try {
          if (item.deleted) {
            summary.removed += 1;
            continue;
          }
          if (item.folder) continue;

          const buffer = await downloadItem(item);
          if (!buffer) {
            summary.skipped += 1;
            continue;
          }

          const result = await ingestFile({
            userId,
            kind: "microsoft365",
            externalId: item.id,
            title: item.name,
            mimeType: item.file?.mimeType ?? null,
            webUrl: item.webUrl ?? null,
            sourceUpdatedAt: item.lastModifiedDateTime ? new Date(item.lastModifiedDateTime) : null,
            buffer,
          });
          if (result.skipped) summary.skipped += 1;
          else summary.processed += 1;
        } catch (err) {
          summary.errors.push(`${item.name}: ${(err as Error).message}`);
        }
      }

      if (page["@odata.deltaLink"]) newCursor = page["@odata.deltaLink"];
      url = page["@odata.nextLink"] ?? "";
    }

    await db
      .update(syncState)
      .set({ cursor: newCursor, status: "idle", lastSyncedAt: new Date(), lastError: null })
      .where(and(eq(syncState.userId, userId), eq(syncState.provider, "microsoft365")));
  } catch (err) {
    await db
      .update(syncState)
      .set({ status: "error", lastError: (err as Error).message })
      .where(and(eq(syncState.userId, userId), eq(syncState.provider, "microsoft365")));
    throw err;
  }

  return summary;
}
