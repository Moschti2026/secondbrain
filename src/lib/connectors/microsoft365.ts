import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { syncState } from "@/db/schema";
import { getValidAccessToken } from "@/lib/oauth";
import { ingestFile } from "@/lib/ingest";
import { EmbeddingRateLimitError } from "@/lib/embeddings";
import { listPendingDocuments, settleUnindexed } from "@/lib/index-queue";
import { unwrapOneDriveCursor, wrapOneDriveCursor } from "@/lib/graph-cursor";
import {
  isIgnoredVaultPath,
  isIngestableMime,
  resolveIngestMimeType,
  shouldSkipForSize,
} from "@/lib/sync-filters";
import { SyncInterrupted } from "./sync-control";
import type { SyncSummary } from "./types";

const GRAPH_API = "https://graph.microsoft.com/v1.0";
const MAX_FILE_BYTES = 20 * 1024 * 1024; // 20 MB safety cap per non-markdown file
// See google-drive.ts for why this exists: a single HTTP request can't
// safely assume a large first sync finishes within one call.
const MAX_RUNTIME_MS = 45_000;
const PENDING_BATCH = 8;

const SELECT_FIELDS = [
  "id",
  "name",
  "webUrl",
  "lastModifiedDateTime",
  "size",
  "file",
  "folder",
  "deleted",
  "parentReference",
];

interface DriveItem {
  id: string;
  name: string;
  webUrl?: string;
  lastModifiedDateTime?: string;
  size?: number;
  file?: { mimeType?: string };
  folder?: unknown;
  deleted?: unknown;
  parentReference?: { path?: string; driveId?: string };
  "@microsoft.graph.downloadUrl"?: string;
}

/**
 * Graph's parentReference.path looks like "/drive/root:/Projekte/Sub" (or
 * "/drives/<id>/root:/..." for a different drive). Strip the "root:"
 * prefix to get the actual folder path, "" for items sitting at the drive
 * root.
 */
function parseOneDriveFolderPath(parentPath: string | undefined): string | null {
  if (!parentPath) return null;
  const marker = "root:";
  const idx = parentPath.indexOf(marker);
  const relative = idx === -1 ? "" : parentPath.slice(idx + marker.length).replace(/^\/+/, "");
  return relative ? `OneDrive/${relative}` : "OneDrive";
}

interface DeltaPage {
  value: DriveItem[];
  "@odata.nextLink"?: string;
  "@odata.deltaLink"?: string;
}

class GraphRequestError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string) {
    super(`Microsoft Graph request failed: ${status} ${body}`.slice(0, 500));
    this.name = "GraphRequestError";
    this.status = status;
    this.body = body;
  }
}

function isExpiredDeltaToken(err: unknown): err is GraphRequestError {
  if (!(err instanceof GraphRequestError)) return false;
  if (err.status === 410) return true;
  return err.status === 400 && /syncState|resync|delta.?token/i.test(err.body);
}

function isRejectedSelect(err: unknown): err is GraphRequestError {
  return err instanceof GraphRequestError && err.status === 400 && /select|downloadUrl/i.test(err.body);
}

function initialDeltaUrl(includeDownloadAnnotation: boolean): string {
  const fields = includeDownloadAnnotation
    ? [...SELECT_FIELDS, "@microsoft.graph.downloadUrl"]
    : SELECT_FIELDS;
  const params = new URLSearchParams({
    $select: fields.join(","),
    $top: "50",
  });
  // Delta on the drive root enumerates that folder and every descendant.
  return `${GRAPH_API}/me/drive/root/delta?${params.toString()}`;
}

async function graphFetch(accessToken: string, url: string) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) {
    throw new GraphRequestError(res.status, await res.text());
  }
  return res;
}

async function readDeltaPage(
  accessToken: string,
  url: string,
  allowSelectFallback: boolean
): Promise<{ page: DeltaPage; url: string; allowSelectFallback: boolean }> {
  try {
    const res = await graphFetch(accessToken, url);
    return { page: (await res.json()) as DeltaPage, url, allowSelectFallback };
  } catch (err) {
    if (allowSelectFallback && isRejectedSelect(err) && url.includes("downloadUrl")) {
      const fallback = initialDeltaUrl(false);
      const res = await graphFetch(accessToken, fallback);
      return { page: (await res.json()) as DeltaPage, url: fallback, allowSelectFallback: false };
    }
    throw err;
  }
}

async function downloadItem(
  accessToken: string,
  item: DriveItem
): Promise<{ buffer: Buffer; mimeType: string } | null> {
  if (!item.file || item.folder) return null;
  const mimeType = resolveIngestMimeType(item.name, item.file.mimeType);
  if (!isIngestableMime(mimeType) || !mimeType) return null;
  if (shouldSkipForSize(item.name, item.size, MAX_FILE_BYTES)) return null;

  const direct = item["@microsoft.graph.downloadUrl"];
  if (direct) {
    const directRes = await fetch(direct);
    if (directRes.ok) {
      return { buffer: Buffer.from(await directRes.arrayBuffer()), mimeType };
    }
  }

  // Delta responses omit @microsoft.graph.downloadUrl whenever $select is
  // used, and the annotation is not a reliable $select property. /content
  // redirects to a short-lived download URL and is the supported way to
  // read bytes for an item the delta feed already listed.
  const id = encodeURIComponent(item.id);
  const driveId = item.parentReference?.driveId;
  const contentUrl = driveId
    ? `${GRAPH_API}/drives/${encodeURIComponent(driveId)}/items/${id}/content`
    : `${GRAPH_API}/me/drive/items/${id}/content`;

  const res = await fetch(contentUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
    redirect: "manual",
  });

  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get("location");
    if (!location) throw new Error(`Download für ${item.name} ohne Weiterleitungsziel`);
    const fileRes = await fetch(location);
    if (!fileRes.ok) throw new Error(`Download failed for ${item.name}: ${fileRes.status}`);
    return { buffer: Buffer.from(await fileRes.arrayBuffer()), mimeType };
  }

  if (!res.ok) {
    const detail = (await res.text()).slice(0, 200);
    throw new Error(`Download failed for ${item.name}: ${res.status} ${detail}`);
  }
  return { buffer: Buffer.from(await res.arrayBuffer()), mimeType };
}

async function ingestDriveItem(
  userId: string,
  accessToken: string,
  item: DriveItem,
  summary: SyncSummary
): Promise<void> {
  if (item.deleted) {
    summary.removed += 1;
    return;
  }
  if (item.folder || !item.file) return;

  const folderPath = parseOneDriveFolderPath(item.parentReference?.path);
  if (isIgnoredVaultPath(folderPath, item.name)) {
    summary.skipped += 1;
    return;
  }

  const downloaded = await downloadItem(accessToken, item);
  if (!downloaded) {
    summary.skipped += 1;
    return;
  }

  const result = await ingestFile({
    userId,
    kind: "microsoft365",
    externalId: item.id,
    folderPath,
    title: item.name,
    mimeType: downloaded.mimeType,
    webUrl: item.webUrl ?? null,
    sourceUpdatedAt: item.lastModifiedDateTime ? new Date(item.lastModifiedDateTime) : null,
    buffer: downloaded.buffer,
  });
  if (result.skipped) summary.skipped += 1;
  else summary.processed += 1;
}

async function retryPendingOneDriveFiles(
  userId: string,
  accessToken: string,
  summary: SyncSummary,
  pendingDeadline: number,
  hardDeadline: number
): Promise<{ more: boolean }> {
  const pending = await listPendingDocuments(userId, "microsoft365", PENDING_BATCH, {
    excludeOnenote: true,
  });

  for (const doc of pending) {
    if (Date.now() > hardDeadline) {
      throw new SyncInterrupted("Zeitbudget erreicht, ausstehende Dateien werden fortgesetzt.");
    }
    if (Date.now() > pendingDeadline) return { more: true };

    try {
      const metaRes = await graphFetch(
        accessToken,
        `${GRAPH_API}/me/drive/items/${encodeURIComponent(doc.externalId)}?$select=${encodeURIComponent(SELECT_FIELDS.join(","))}`
      );
      const item = (await metaRes.json()) as DriveItem;
      if (item.deleted) {
        await settleUnindexed(doc.id, "Datei in OneDrive gelöscht");
        summary.removed += 1;
        continue;
      }
      const folderPath = parseOneDriveFolderPath(item.parentReference?.path);
      if (isIgnoredVaultPath(folderPath, item.name)) {
        await settleUnindexed(doc.id, "Ignorierter Ordner (.obsidian oder .git), nicht indexiert");
        summary.skipped += 1;
        continue;
      }
      const downloaded = await downloadItem(accessToken, item);
      if (!downloaded) {
        await settleUnindexed(doc.id, "unsupported file type, not indexed");
        summary.skipped += 1;
        continue;
      }
      const result = await ingestFile({
        userId,
        kind: "microsoft365",
        externalId: item.id,
        folderPath,
        title: item.name,
        mimeType: downloaded.mimeType,
        webUrl: item.webUrl ?? null,
        sourceUpdatedAt: item.lastModifiedDateTime ? new Date(item.lastModifiedDateTime) : null,
        buffer: downloaded.buffer,
      });
      if (result.skipped) summary.skipped += 1;
      else summary.processed += 1;
    } catch (err) {
      if (err instanceof GraphRequestError && (err.status === 404 || err.status === 403)) {
        await settleUnindexed(doc.id, "Datei in OneDrive nicht mehr verfügbar");
        summary.skipped += 1;
        continue;
      }
      if (err instanceof EmbeddingRateLimitError) {
        throw new SyncInterrupted(err.message, { retryAfterMs: err.retryAfterMs });
      }
      if (err instanceof SyncInterrupted) throw err;
      summary.errors.push(`${doc.title}: ${(err as Error).message}`.slice(0, 300));
    }
  }

  return { more: pending.length === PENDING_BATCH };
}

async function saveState(
  userId: string,
  set: { cursor?: string | null; status: "idle" | "error"; lastError: string | null }
) {
  await db
    .update(syncState)
    .set({ ...set, lastSyncedAt: new Date() })
    .where(and(eq(syncState.userId, userId), eq(syncState.provider, "microsoft365")));
}

/**
 * Incrementally syncs the user's entire OneDrive (root and every subfolder)
 * using Microsoft Graph's delta query. SharePoint site libraries are out of
 * scope (the Sites.Read.All scope is already requested so that's a follow-up,
 * not a new OAuth consent).
 */
export async function syncMicrosoft365(userId: string): Promise<SyncSummary> {
  const summary: SyncSummary = { processed: 0, skipped: 0, removed: 0, errors: [], done: true };
  const deadline = Date.now() + MAX_RUNTIME_MS;

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

    const pending = await retryPendingOneDriveFiles(
      userId,
      accessToken,
      summary,
      Date.now() + Math.floor(MAX_RUNTIME_MS / 2),
      deadline
    );

    const storedUrl = unwrapOneDriveCursor(state?.cursor ?? null);
    let url = storedUrl ?? initialDeltaUrl(true);
    let usingStoredCursor = Boolean(storedUrl);
    let allowSelectFallback = !storedUrl;
    let newCursor = state?.cursor ?? null;
    let timedOut = false;

    while (url) {
      let page: DeltaPage;
      try {
        const read = await readDeltaPage(accessToken, url, allowSelectFallback);
        page = read.page;
        allowSelectFallback = read.allowSelectFallback;
        if (read.url !== url) url = read.url;
      } catch (err) {
        if (usingStoredCursor && isExpiredDeltaToken(err)) {
          summary.done = false;
          summary.errors.push(
            "Der OneDrive-Delta-Cursor war abgelaufen und wurde verworfen. Der nächste Lauf liest alle Dateien neu ein."
          );
          await saveState(userId, {
            cursor: null,
            status: "idle",
            lastError:
              "Der OneDrive-Delta-Cursor war abgelaufen und wurde verworfen. Der nächste Lauf liest alle Dateien neu ein.",
          });
          return summary;
        }
        throw err;
      }

      for (const item of page.value) {
        try {
          await ingestDriveItem(userId, accessToken, item, summary);
        } catch (err) {
          if (err instanceof EmbeddingRateLimitError) {
            throw new SyncInterrupted(err.message, {
              retryAfterMs: err.retryAfterMs,
              resumeCursor: wrapOneDriveCursor(url) ?? undefined,
            });
          }
          if (err instanceof SyncInterrupted) throw err;
          summary.errors.push(`${item.name}: ${(err as Error).message}`.slice(0, 300));
        }

        if (Date.now() > deadline) {
          timedOut = true;
          newCursor = wrapOneDriveCursor(url);
          break;
        }
      }

      if (timedOut) {
        summary.done = false;
        break;
      }

      const next = page["@odata.nextLink"] ?? "";
      if (page["@odata.deltaLink"]) newCursor = wrapOneDriveCursor(page["@odata.deltaLink"]);
      url = next;
      usingStoredCursor = false;

      if (Date.now() > deadline && url) {
        newCursor = wrapOneDriveCursor(url);
        summary.done = false;
        break;
      }
    }

    if (pending.more) summary.done = false;

    await saveState(userId, { cursor: newCursor, status: "idle", lastError: null });
  } catch (err) {
    if (err instanceof SyncInterrupted) {
      summary.done = false;
      summary.retryAfterMs = err.retryAfterMs;
      summary.errors.push(err.message.slice(0, 300));
      await saveState(userId, {
        ...(err.resumeCursor !== undefined ? { cursor: err.resumeCursor } : {}),
        status: "idle",
        lastError: err.retryAfterMs
          ? "Embedding-Dienst hat ein Limit gemeldet. Der nächste Lauf macht weiter."
          : null,
      });
      return summary;
    }
    await saveState(userId, { status: "error", lastError: (err as Error).message.slice(0, 500) });
    throw err;
  }

  return summary;
}
