import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { syncState } from "@/db/schema";
import { getValidAccessToken } from "@/lib/oauth";
import { ingestFile } from "@/lib/ingest";
import { SUPPORTED_MIME_TYPES } from "@/lib/extract";
import type { SyncSummary } from "./types";

const DRIVE_API = "https://www.googleapis.com/drive/v3";
const MAX_FILE_BYTES = 20 * 1024 * 1024; // 20 MB safety cap per file
const BACKFILL_PAGE_SIZE = 50;

// A single HTTP request has a limited lifetime end-to-end (the platform's
// gateway, not just our own function timeout). A first sync over a large
// Drive can't safely assume it will finish in one request, so it works in
// time-boxed slices and persists a resume point — repeated clicks (or the
// daily cron) pick up where the last one left off instead of failing.
const MAX_RUNTIME_MS = 45_000;
const BACKFILL_CURSOR_PREFIX = "backfill:";

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

async function driveFetch(accessToken: string, path: string) {
  const res = await fetch(`${DRIVE_API}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`Google Drive API ${path} failed: ${res.status} ${await res.text()}`);
  }
  return res;
}

async function getStartPageToken(accessToken: string): Promise<string> {
  const res = await driveFetch(accessToken, "/changes/startPageToken");
  const body = (await res.json()) as { startPageToken: string };
  return body.startPageToken;
}

async function downloadFile(accessToken: string, file: DriveFile): Promise<Buffer | null> {
  const exportMime = GOOGLE_EXPORT_MIME[file.mimeType];
  if (file.mimeType === "application/vnd.google-apps.folder") return null;
  if (file.mimeType.startsWith("application/vnd.google-apps.") && !exportMime) {
    return null; // forms, drawings, apps-script, ... — nothing text-like to extract
  }

  if (!exportMime && !SUPPORTED_MIME_TYPES.includes(file.mimeType)) return null;
  if (file.size && Number(file.size) > MAX_FILE_BYTES) return null;

  const path = exportMime
    ? `/files/${file.id}/export?mimeType=${encodeURIComponent(exportMime)}`
    : `/files/${file.id}?alt=media`;

  const res = await driveFetch(accessToken, path);
  return Buffer.from(await res.arrayBuffer());
}

interface BackfillResult {
  done: boolean;
  /** Cursor to persist: "" once done, otherwise a `backfill:<token>` value
   * for the next call to resume from. */
  resumeCursor: string;
}

/**
 * The Changes API only reports changes going forward from a start token —
 * it has no concept of "everything that already exists". A first-time sync
 * has to walk the full file list once via files.list before it can switch
 * to incremental Changes API polling. Runs in small pages and bails out
 * (with a resume token) if it's been running too long for one request.
 */
async function ingestExistingFiles(
  userId: string,
  accessToken: string,
  summary: SyncSummary,
  startToken: string,
  deadline: number
): Promise<BackfillResult> {
  let pageToken = startToken || undefined;

  for (;;) {
    const url =
      `/files?pageSize=${BACKFILL_PAGE_SIZE}&q=` +
      encodeURIComponent("trashed = false") +
      "&fields=" +
      encodeURIComponent("nextPageToken,files(id,name,mimeType,modifiedTime,webViewLink,trashed,size)") +
      (pageToken ? `&pageToken=${pageToken}` : "");

    const res = await driveFetch(accessToken, url);
    const page = (await res.json()) as FilesListPage;

    for (const file of page.files) {
      try {
        const buffer = await downloadFile(accessToken, file);
        if (!buffer) {
          summary.skipped += 1;
          continue;
        }

        const result = await ingestFile({
          userId,
          kind: "google_drive",
          externalId: file.id,
          title: file.name,
          mimeType: file.mimeType,
          webUrl: file.webViewLink ?? null,
          sourceUpdatedAt: file.modifiedTime ? new Date(file.modifiedTime) : null,
          buffer,
        });
        if (result.skipped) summary.skipped += 1;
        else summary.processed += 1;
      } catch (err) {
        summary.errors.push(`${file.name}: ${(err as Error).message}`);
      }

      if (Date.now() > deadline) {
        // Resume at the start of this same page next time. Files already
        // ingested above will just be skipped again via the content-hash
        // check, so re-fetching the page costs a little bandwidth, not
        // correctness.
        return { done: false, resumeCursor: `${BACKFILL_CURSOR_PREFIX}${pageToken ?? ""}` };
      }
    }

    if (!page.nextPageToken) return { done: true, resumeCursor: "" };

    pageToken = page.nextPageToken;
    if (Date.now() > deadline) {
      return { done: false, resumeCursor: `${BACKFILL_CURSOR_PREFIX}${pageToken}` };
    }
  }
}

/** Incrementally syncs a user's Google Drive using the Changes API, so a
 * re-run only touches files that actually changed since the last cursor. */
export async function syncGoogleDrive(userId: string): Promise<SyncSummary> {
  const summary: SyncSummary = { processed: 0, skipped: 0, removed: 0, errors: [] };
  const deadline = Date.now() + MAX_RUNTIME_MS;

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

    const [state] = await db
      .select()
      .from(syncState)
      .where(and(eq(syncState.userId, userId), eq(syncState.provider, "google_drive")));

    const cursor = state?.cursor ?? null;

    if (cursor === null || cursor.startsWith(BACKFILL_CURSOR_PREFIX)) {
      // First sync ever, or a first sync still in progress from an earlier
      // (time-boxed) call: back-fill existing files before switching to
      // incremental Changes API polling.
      const startToken = cursor?.slice(BACKFILL_CURSOR_PREFIX.length) ?? "";
      const backfill = await ingestExistingFiles(userId, accessToken, summary, startToken, deadline);

      if (!backfill.done) {
        await db
          .update(syncState)
          .set({ cursor: backfill.resumeCursor, status: "idle", lastSyncedAt: new Date(), lastError: null })
          .where(and(eq(syncState.userId, userId), eq(syncState.provider, "google_drive")));
        return summary;
      }
    }

    let pageToken =
      cursor && !cursor.startsWith(BACKFILL_CURSOR_PREFIX) ? cursor : await getStartPageToken(accessToken);
    let newCursor = pageToken;

    while (pageToken) {
      const res = await driveFetch(
        accessToken,
        `/changes?pageToken=${pageToken}&pageSize=100&includeRemoved=true&fields=nextPageToken,newStartPageToken,changes(fileId,removed,file(id,name,mimeType,modifiedTime,webViewLink,trashed,size))`
      );
      const page = (await res.json()) as ChangesPage;

      for (const change of page.changes) {
        try {
          if (change.removed || change.file?.trashed) {
            summary.removed += 1;
            continue;
          }
          if (!change.file) continue;

          const buffer = await downloadFile(accessToken, change.file);
          if (!buffer) {
            summary.skipped += 1;
            continue;
          }

          const result = await ingestFile({
            userId,
            kind: "google_drive",
            externalId: change.file.id,
            title: change.file.name,
            mimeType: change.file.mimeType,
            webUrl: change.file.webViewLink ?? null,
            sourceUpdatedAt: change.file.modifiedTime ? new Date(change.file.modifiedTime) : null,
            buffer,
          });
          if (result.skipped) summary.skipped += 1;
          else summary.processed += 1;
        } catch (err) {
          summary.errors.push(`${change.file?.name ?? change.fileId}: ${(err as Error).message}`);
        }
      }

      pageToken = page.nextPageToken ?? "";
      if (page.newStartPageToken) newCursor = page.newStartPageToken;

      if (Date.now() > deadline && pageToken) {
        // Large backlog of changes: persist progress and let the next call
        // (or the daily cron) continue from here instead of timing out.
        newCursor = pageToken;
        break;
      }
    }

    await db
      .update(syncState)
      .set({ cursor: newCursor, status: "idle", lastSyncedAt: new Date(), lastError: null })
      .where(and(eq(syncState.userId, userId), eq(syncState.provider, "google_drive")));
  } catch (err) {
    await db
      .update(syncState)
      .set({ status: "error", lastError: (err as Error).message })
      .where(and(eq(syncState.userId, userId), eq(syncState.provider, "google_drive")));
    throw err;
  }

  return summary;
}
