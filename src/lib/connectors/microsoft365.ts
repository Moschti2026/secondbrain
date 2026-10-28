import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { syncState } from "@/db/schema";
import { getValidAccessToken } from "@/lib/oauth";
import { consolidateDuplicates, ingestFile, noteIndexFailure } from "@/lib/ingest";
import { EmbeddingRateLimitError } from "@/lib/embeddings";
import { listPendingDocuments, settleUnindexed } from "@/lib/index-queue";
import { unwrapOneDriveCursor, wrapOneDriveCursor } from "@/lib/graph-cursor";
import {
  isIgnoredVaultPath,
  isIngestableMime,
  resolveIngestMimeType,
  shouldSkipForSize,
} from "@/lib/sync-filters";
import { SyncInterrupted, resolveSyncDeadline, syncOutOfTime } from "./sync-control";
import { recordIngestOutcome, type SyncSummary } from "./types";

const GRAPH_API = "https://graph.microsoft.com/v1.0";
const MAX_FILE_BYTES = 20 * 1024 * 1024; // 20 MB safety cap per non-markdown file
const PENDING_BATCH = 20;

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

type DownloadedFile =
  | { kind: "ok"; buffer: Buffer; mimeType: string }
  | { kind: "skip"; cause: "not-file" | "unsupported" | "too-large" };

async function downloadItem(accessToken: string, item: DriveItem): Promise<DownloadedFile> {
  if (!item.file || item.folder) return { kind: "skip", cause: "not-file" };
  const mimeType = resolveIngestMimeType(item.name, item.file.mimeType);
  if (!isIngestableMime(mimeType) || !mimeType) return { kind: "skip", cause: "unsupported" };
  if (shouldSkipForSize(item.name, item.size, MAX_FILE_BYTES)) return { kind: "skip", cause: "too-large" };

  const direct = item["@microsoft.graph.downloadUrl"];
  if (direct) {
    const directRes = await fetch(direct);
    if (directRes.ok) {
      return { kind: "ok", buffer: Buffer.from(await directRes.arrayBuffer()), mimeType };
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
    return { kind: "ok", buffer: Buffer.from(await fileRes.arrayBuffer()), mimeType };
  }

  if (!res.ok) {
    const detail = (await res.text()).slice(0, 200);
    throw new Error(`Download failed for ${item.name}: ${res.status} ${detail}`);
  }
  return { kind: "ok", buffer: Buffer.from(await res.arrayBuffer()), mimeType };
}

async function ingestDriveItem(
  userId: string,
  accessToken: string,
  item: DriveItem,
  summary: SyncSummary,
  deadline: number
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

  if (syncOutOfTime(deadline)) {
    throw new SyncInterrupted("Zeitbudget erreicht, OneDrive wird fortgesetzt.");
  }

  const downloaded = await downloadItem(accessToken, item);
  if (downloaded.kind === "skip") {
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
    deadline,
  });
  recordIngestOutcome(summary, result, item.name);
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
    if (syncOutOfTime(hardDeadline)) {
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
      if (downloaded.kind === "skip") {
        if (downloaded.cause === "too-large") {
          await settleUnindexed(doc.id, "Datei ist größer als 20 MB, nicht indexiert");
        } else {
          await noteIndexFailure(
            doc.id,
            downloaded.cause === "not-file"
              ? "Kein herunterladbarer Dateiinhalt"
              : "unsupported file type, not indexed"
          );
        }
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
        deadline: hardDeadline,
      });
      recordIngestOutcome(summary, result, item.name);
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
      await noteIndexFailure(doc.id, (err as Error).message);
      summary.errors.push(`${doc.title}: ${(err as Error).message}`.slice(0, 300));
    }
  }

  return { more: pending.length === PENDING_BATCH };
}

async function saveCursor(userId: string, cursor: string | null) {
  await db
    .update(syncState)
    .set({ cursor, lastSyncedAt: new Date() })
    .where(and(eq(syncState.userId, userId), eq(syncState.provider, "microsoft365")));
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
export async function syncMicrosoft365(
  userId: string,
  options: { deadline?: number } = {}
): Promise<SyncSummary> {
  const summary: SyncSummary = { processed: 0, skipped: 0, removed: 0, errors: [], aliases: 0, done: true };
  const deadline = resolveSyncDeadline(options.deadline);
  if (syncOutOfTime(deadline)) return { ...summary, done: false };

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

    await consolidateDuplicates(userId);

    const [state] = await db
      .select()
      .from(syncState)
      .where(and(eq(syncState.userId, userId), eq(syncState.provider, "microsoft365")));

    const pendingBudget = Math.min(90_000, Math.floor(Math.max(0, deadline - Date.now()) * 0.4));
    const pending = await retryPendingOneDriveFiles(
      userId,
      accessToken,
      summary,
      Date.now() + pendingBudget,
      deadline
    );

    const storedUrl = unwrapOneDriveCursor(state?.cursor ?? null);
    let url = storedUrl ?? initialDeltaUrl(true);
    let usingStoredCursor = Boolean(storedUrl);
    let allowSelectFallback = !storedUrl;
    let newCursor = state?.cursor ?? null;
    let timedOut = false;

    while (url) {
      if (syncOutOfTime(deadline)) {
        newCursor = wrapOneDriveCursor(url);
        summary.done = false;
        break;
      }
      await saveCursor(userId, wrapOneDriveCursor(url));
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
        if (syncOutOfTime(deadline)) {
          timedOut = true;
          newCursor = wrapOneDriveCursor(url);
          break;
        }
        try {
          await ingestDriveItem(userId, accessToken, item, summary, deadline);
        } catch (err) {
          if (err instanceof EmbeddingRateLimitError || err instanceof SyncInterrupted) {
            const retryAfterMs = err instanceof EmbeddingRateLimitError ? err.retryAfterMs : err.retryAfterMs;
            throw new SyncInterrupted(err.message, {
              retryAfterMs,
              resumeCursor: wrapOneDriveCursor(url) ?? undefined,
            });
          }
          summary.errors.push(`${item.name}: ${(err as Error).message}`.slice(0, 300));
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

      if (syncOutOfTime(deadline) && url) {
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
