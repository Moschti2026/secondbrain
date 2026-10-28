import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { syncState } from "@/db/schema";
import { getValidAccessToken } from "@/lib/oauth";
import { consolidateDuplicates, ingestFile, noteIndexFailure } from "@/lib/ingest";
import { EmbeddingRateLimitError } from "@/lib/embeddings";
import { listPendingDocuments, settleUnindexed } from "@/lib/index-queue";
import {
  DRIVE_CURSOR_VERSION,
  encodeDrivePageToken,
  isInvalidDrivePageToken,
  readDriveCursor,
  writeDriveBackfillCursor,
  writeDriveChangesCursor,
} from "@/lib/drive-cursor";
import {
  isIgnoredVaultPath,
  isIngestableMime,
  resolveIngestMimeType,
  shouldSkipForSize,
} from "@/lib/sync-filters";
import { SyncInterrupted, resolveSyncDeadline, syncOutOfTime } from "./sync-control";
import { recordIngestOutcome, type SyncSummary } from "./types";

const DRIVE_API = "https://www.googleapis.com/drive/v3";
const MAX_FILE_BYTES = 20 * 1024 * 1024; // 20 MB safety cap per non-markdown file
const BACKFILL_PAGE_SIZE = 50;
const PENDING_BATCH = 20;

// Google-native formats have no raw bytes; export them to a plain-text
// equivalent instead of downloading via alt=media.
const GOOGLE_EXPORT_MIME: Record<string, string> = {
  "application/vnd.google-apps.document": "text/plain",
  "application/vnd.google-apps.spreadsheet": "text/csv",
  "application/vnd.google-apps.presentation": "text/plain",
};

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
  webViewLink?: string;
  trashed?: boolean;
  size?: string;
  parents?: string[];
}

interface FolderInfo {
  name: string;
  parents?: string[];
}

const FOLDER_PATH_DEPTH_LIMIT = 8;

type PageTokenOrigin = "stored" | "fresh" | "none";

class DriveRequestError extends Error {
  readonly status: number;
  readonly body: string;
  readonly pageTokenOrigin: PageTokenOrigin;

  constructor(status: number, body: string, pageTokenOrigin: PageTokenOrigin) {
    super(`Google Drive API request failed: ${status} ${body}`.slice(0, 500));
    this.name = "DriveRequestError";
    this.status = status;
    this.body = body;
    this.pageTokenOrigin = pageTokenOrigin;
  }
}

function isStoredPageTokenRejected(err: unknown): err is DriveRequestError {
  return (
    err instanceof DriveRequestError &&
    err.pageTokenOrigin === "stored" &&
    isInvalidDrivePageToken(err.status, err.body)
  );
}

/**
 * Walks a Drive file's `parents` chain up to build a human-readable folder
 * path, e.g. ["<projekteId>"] -> "Projekte". Stops at the first ancestor
 * with no `parents` field, which is the actual Drive/shared-drive root —
 * its own name (the account name, or the shared drive's name) isn't a
 * meaningful "folder" to show, so it's excluded from the path. Results are
 * cached per sync run since many files share the same parent folders.
 */
async function resolveDriveFolderPath(
  accessToken: string,
  parents: string[] | undefined,
  cache: Map<string, FolderInfo | null>
): Promise<string | null> {
  if (!parents || parents.length === 0) return null;

  const segments: string[] = [];
  let currentId: string | undefined = parents[0];

  for (let depth = 0; currentId && depth < FOLDER_PATH_DEPTH_LIMIT; depth++) {
    let info = cache.get(currentId);
    if (info === undefined) {
      try {
        const res = await driveFetch(
          accessToken,
          `/files/${encodeURIComponent(currentId)}?fields=name,parents&supportsAllDrives=true`,
          "none"
        );
        const body = (await res.json()) as FolderInfo;
        info = { name: body.name, parents: body.parents };
      } catch {
        info = null; // inaccessible (e.g. a shared drive root) — stop here
      }
      cache.set(currentId, info);
    }
    if (!info) break;

    if (!info.parents || info.parents.length === 0) break; // reached the actual root
    segments.unshift(info.name);
    currentId = info.parents[0];
  }

  return segments.length > 0 ? `Google Drive/${segments.join("/")}` : "Google Drive";
}

interface ChangesPage {
  nextPageToken?: string;
  newStartPageToken?: string;
  changes: { fileId: string; removed?: boolean; file?: DriveFile }[];
}

interface FilesListPage {
  nextPageToken?: string;
  files: DriveFile[];
}

function driveListQuery(params: Record<string, string>, pageToken?: string): string {
  const search = new URLSearchParams(params);
  const base = search.toString();
  if (!pageToken) return base;
  const encoded = encodeDrivePageToken(pageToken);
  return base ? `${base}&pageToken=${encoded}` : `pageToken=${encoded}`;
}

async function driveFetch(accessToken: string, path: string, pageTokenOrigin: PageTokenOrigin) {
  const res = await fetch(`${DRIVE_API}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new DriveRequestError(res.status, await res.text(), pageTokenOrigin);
  }
  return res;
}

async function getStartPageToken(accessToken: string): Promise<string> {
  const res = await driveFetch(
    accessToken,
    `/changes/startPageToken?supportsAllDrives=true`,
    "none"
  );
  const body = (await res.json()) as { startPageToken: string };
  return body.startPageToken;
}

type DownloadedFile =
  | { kind: "ok"; buffer: Buffer; mimeType: string }
  | { kind: "skip"; cause: "not-file" | "unsupported" | "too-large" };

async function downloadFile(accessToken: string, file: DriveFile): Promise<DownloadedFile> {
  const exportMime = GOOGLE_EXPORT_MIME[file.mimeType];
  if (file.mimeType === "application/vnd.google-apps.folder") return { kind: "skip", cause: "not-file" };
  if (file.mimeType.startsWith("application/vnd.google-apps.") && !exportMime) {
    return { kind: "skip", cause: "unsupported" };
  }

  // Store the exported type (text/plain, text/csv), not the Google-native
  // mime. Otherwise spreadsheets and presentations reach extractText as
  // application/vnd.google-apps.* and are marked unsupported.
  const ingestMime = exportMime ?? resolveIngestMimeType(file.name, file.mimeType);
  if (!exportMime && !isIngestableMime(ingestMime)) return { kind: "skip", cause: "unsupported" };

  const size = file.size ? Number(file.size) : null;
  if (shouldSkipForSize(file.name, size, MAX_FILE_BYTES)) return { kind: "skip", cause: "too-large" };

  const path = exportMime
    ? `/files/${encodeURIComponent(file.id)}/export?mimeType=${encodeURIComponent(exportMime)}&supportsAllDrives=true`
    : `/files/${encodeURIComponent(file.id)}?alt=media&supportsAllDrives=true`;

  const res = await driveFetch(accessToken, path, "none");
  return {
    kind: "ok",
    buffer: Buffer.from(await res.arrayBuffer()),
    mimeType: ingestMime ?? exportMime ?? "application/octet-stream",
  };
}

async function ingestDriveFile(
  userId: string,
  accessToken: string,
  file: DriveFile,
  summary: SyncSummary,
  folderCache: Map<string, FolderInfo | null>,
  deadline: number
): Promise<void> {
  if (syncOutOfTime(deadline)) {
    throw new SyncInterrupted("Zeitbudget erreicht, Google Drive wird fortgesetzt.");
  }

  const folderPath = await resolveDriveFolderPath(accessToken, file.parents, folderCache);
  if (isIgnoredVaultPath(folderPath, file.name)) {
    summary.skipped += 1;
    return;
  }

  const downloaded = await downloadFile(accessToken, file);
  if (downloaded.kind === "skip") {
    summary.skipped += 1;
    return;
  }

  const result = await ingestFile({
    userId,
    kind: "google_drive",
    externalId: file.id,
    folderPath,
    title: file.name,
    mimeType: downloaded.mimeType,
    webUrl: file.webViewLink ?? null,
    sourceUpdatedAt: file.modifiedTime ? new Date(file.modifiedTime) : null,
    buffer: downloaded.buffer,
    deadline,
  });
  recordIngestOutcome(summary, result, file.name);
}

function noteFileError(summary: SyncSummary, label: string, err: unknown): void {
  if (err instanceof SyncInterrupted || err instanceof EmbeddingRateLimitError) throw err;
  summary.errors.push(`${label}: ${(err as Error).message}`.slice(0, 300));
}

interface BackfillResult {
  done: boolean;
  /** Cursor to persist: changes cursor once done, otherwise a backfill value. */
  resumeCursor: string;
}

/**
 * The Changes API only reports changes going forward from a start token —
 * it has no concept of "everything that already exists". A first-time sync
 * has to walk the full file list once via files.list (every folder, not
 * only the root) before it can switch to incremental Changes API polling.
 */
async function ingestExistingFiles(
  userId: string,
  accessToken: string,
  summary: SyncSummary,
  startToken: string,
  deadline: number,
  folderCache: Map<string, FolderInfo | null>
): Promise<BackfillResult> {
  let pageToken = startToken || undefined;
  let origin: PageTokenOrigin = startToken ? "stored" : "none";

  for (;;) {
    const query = driveListQuery(
      {
        pageSize: String(BACKFILL_PAGE_SIZE),
        q: "trashed = false",
        fields:
          "nextPageToken,files(id,name,mimeType,modifiedTime,webViewLink,trashed,size,parents)",
        supportsAllDrives: "true",
        includeItemsFromAllDrives: "true",
        corpora: "allDrives",
      },
      pageToken
    );
    const res = await driveFetch(accessToken, `/files?${query}`, pageToken ? origin : "none");
    const page = (await res.json()) as FilesListPage;

    const resumeCursor = writeDriveBackfillCursor(pageToken ?? "");
    await saveCursor(userId, resumeCursor);

    for (const file of page.files) {
      if (syncOutOfTime(deadline)) {
        return { done: false, resumeCursor };
      }
      try {
        await ingestDriveFile(userId, accessToken, file, summary, folderCache, deadline);
      } catch (err) {
        if (err instanceof EmbeddingRateLimitError || err instanceof SyncInterrupted) {
          const retryAfterMs = err instanceof EmbeddingRateLimitError ? err.retryAfterMs : err.retryAfterMs;
          throw new SyncInterrupted(err.message, { retryAfterMs, resumeCursor });
        }
        noteFileError(summary, file.name, err);
      }
    }

    if (!page.nextPageToken) {
      const start = await getStartPageToken(accessToken);
      return { done: true, resumeCursor: writeDriveChangesCursor(start) };
    }

    pageToken = page.nextPageToken;
    origin = "fresh";
    if (syncOutOfTime(deadline)) {
      return { done: false, resumeCursor: writeDriveBackfillCursor(pageToken) };
    }
  }
}

async function retryPendingDriveFiles(
  userId: string,
  accessToken: string,
  summary: SyncSummary,
  pendingDeadline: number,
  hardDeadline: number,
  folderCache: Map<string, FolderInfo | null>
): Promise<{ more: boolean }> {
  const pending = await listPendingDocuments(userId, "google_drive", PENDING_BATCH);
  for (const doc of pending) {
    if (syncOutOfTime(hardDeadline)) {
      throw new SyncInterrupted("Zeitbudget erreicht, ausstehende Dateien werden fortgesetzt.");
    }
    if (Date.now() > pendingDeadline) return { more: true };

    try {
      const res = await driveFetch(
        accessToken,
        `/files/${encodeURIComponent(doc.externalId)}?fields=id,name,mimeType,modifiedTime,webViewLink,trashed,size,parents&supportsAllDrives=true`,
        "none"
      );
      const file = (await res.json()) as DriveFile;
      if (file.trashed) {
        await settleUnindexed(doc.id, "Datei liegt im Papierkorb und wird nicht indexiert");
        summary.skipped += 1;
        continue;
      }
      const folderPath = await resolveDriveFolderPath(accessToken, file.parents, folderCache);
      if (isIgnoredVaultPath(folderPath, file.name)) {
        await settleUnindexed(doc.id, "Ignorierter Ordner (.obsidian oder .git), nicht indexiert");
        summary.skipped += 1;
        continue;
      }
      const downloaded = await downloadFile(accessToken, file);
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
        kind: "google_drive",
        externalId: file.id,
        folderPath,
        title: file.name,
        mimeType: downloaded.mimeType,
        webUrl: file.webViewLink ?? null,
        sourceUpdatedAt: file.modifiedTime ? new Date(file.modifiedTime) : null,
        buffer: downloaded.buffer,
        deadline: hardDeadline,
      });
      recordIngestOutcome(summary, result, file.name);
    } catch (err) {
      if (err instanceof DriveRequestError && (err.status === 404 || err.status === 403)) {
        await settleUnindexed(doc.id, "Datei in Google Drive nicht mehr verfügbar");
        summary.skipped += 1;
        continue;
      }
      if (err instanceof EmbeddingRateLimitError) {
        throw new SyncInterrupted(err.message, { retryAfterMs: err.retryAfterMs });
      }
      if (err instanceof SyncInterrupted) throw err;
      await noteIndexFailure(doc.id, (err as Error).message);
      noteFileError(summary, doc.title, err);
    }
  }
  return { more: pending.length === PENDING_BATCH };
}

async function saveCursor(userId: string, cursor: string) {
  await db
    .update(syncState)
    .set({ cursor, lastSyncedAt: new Date() })
    .where(and(eq(syncState.userId, userId), eq(syncState.provider, "google_drive")));
}

async function saveState(
  userId: string,
  set: { cursor?: string | null; status: "idle" | "error"; lastError: string | null }
) {
  await db
    .update(syncState)
    .set({ ...set, lastSyncedAt: new Date() })
    .where(and(eq(syncState.userId, userId), eq(syncState.provider, "google_drive")));
}

/** Incrementally syncs a user's Google Drive. The first run (and any run
 * whose cursor predates the current cursor version) walks every file via
 * files.list, then switches to the Changes API. */
export async function syncGoogleDrive(
  userId: string,
  options: { deadline?: number } = {}
): Promise<SyncSummary> {
  const summary: SyncSummary = { processed: 0, skipped: 0, removed: 0, errors: [], aliases: 0, done: true };
  const deadline = resolveSyncDeadline(options.deadline);
  if (syncOutOfTime(deadline)) return { ...summary, done: false };
  const folderCache = new Map<string, FolderInfo | null>();

  await db
    .insert(syncState)
    .values({ userId, provider: "google_drive", status: "syncing" })
    .onConflictDoUpdate({
      target: [syncState.userId, syncState.provider],
      set: { status: "syncing", lastError: null },
    });

  try {
    const accessToken = await getValidAccessToken(userId, "google");
    if (!accessToken) throw new Error("Google Drive is not connected for this user.");

    await consolidateDuplicates(userId);

    const [state] = await db
      .select()
      .from(syncState)
      .where(and(eq(syncState.userId, userId), eq(syncState.provider, "google_drive")));

    const pendingBudget = Math.min(90_000, Math.floor(Math.max(0, deadline - Date.now()) * 0.4));
    const pending = await retryPendingDriveFiles(
      userId,
      accessToken,
      summary,
      Date.now() + pendingBudget,
      deadline,
      folderCache
    );

    const parsed = readDriveCursor(state?.cursor ?? null);
    let changesCursor: string | null = null;

    if (parsed.phase === "backfill") {
      const backfill = await ingestExistingFiles(
        userId,
        accessToken,
        summary,
        parsed.pageToken,
        deadline,
        folderCache
      );
      if (!backfill.done) {
        await saveState(userId, { cursor: backfill.resumeCursor, status: "idle", lastError: null });
        summary.done = false;
        return summary;
      }
      changesCursor = backfill.resumeCursor;
      // Persist the new changes cursor before polling, so a later failure
      // does not repeat the whole file walk.
      await saveState(userId, { cursor: changesCursor, status: "idle", lastError: null });
    }

    const changesPrefix = `${DRIVE_CURSOR_VERSION}:`;
    let pageToken =
      parsed.phase === "changes"
        ? parsed.pageToken
        : changesCursor?.startsWith(changesPrefix)
          ? changesCursor.slice(changesPrefix.length)
          : await getStartPageToken(accessToken);
    let origin: PageTokenOrigin = parsed.phase === "changes" ? "stored" : "fresh";
    let newCursor = writeDriveChangesCursor(pageToken);

    while (pageToken) {
      if (syncOutOfTime(deadline)) {
        newCursor = writeDriveChangesCursor(pageToken);
        summary.done = false;
        break;
      }
      await saveCursor(userId, writeDriveChangesCursor(pageToken));
      const query = driveListQuery(
        {
          pageSize: "100",
          includeRemoved: "true",
          supportsAllDrives: "true",
          includeItemsFromAllDrives: "true",
          fields:
            "nextPageToken,newStartPageToken,changes(fileId,removed,file(id,name,mimeType,modifiedTime,webViewLink,trashed,size,parents))",
        },
        pageToken
      );
      const res = await driveFetch(accessToken, `/changes?${query}`, origin);
      const page = (await res.json()) as ChangesPage;

      for (const change of page.changes) {
        try {
          if (change.removed || change.file?.trashed) {
            summary.removed += 1;
            continue;
          }
          if (!change.file) continue;
          await ingestDriveFile(userId, accessToken, change.file, summary, folderCache, deadline);
        } catch (err) {
          if (err instanceof EmbeddingRateLimitError || err instanceof SyncInterrupted) {
            const retryAfterMs = err instanceof EmbeddingRateLimitError ? err.retryAfterMs : err.retryAfterMs;
            throw new SyncInterrupted(err.message, {
              retryAfterMs,
              resumeCursor: writeDriveChangesCursor(pageToken),
            });
          }
          noteFileError(summary, change.file?.name ?? change.fileId, err);
        }
      }

      pageToken = page.nextPageToken ?? "";
      origin = "fresh";
      if (page.newStartPageToken) newCursor = writeDriveChangesCursor(page.newStartPageToken);

      if (syncOutOfTime(deadline) && pageToken) {
        newCursor = writeDriveChangesCursor(pageToken);
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
    if (isStoredPageTokenRejected(err)) {
      summary.done = false;
      summary.errors.push(
        "Der gespeicherte Google-Drive-Cursor war ungültig und wurde verworfen. Der nächste Lauf liest alle Dateien neu ein."
      );
      await saveState(userId, {
        cursor: null,
        status: "idle",
        lastError:
          "Der gespeicherte Google-Drive-Cursor war ungültig und wurde verworfen. Der nächste Lauf liest alle Dateien neu ein.",
      });
      return summary;
    }
    await saveState(userId, { status: "error", lastError: (err as Error).message.slice(0, 500) });
    throw err;
  }

  return summary;
}
