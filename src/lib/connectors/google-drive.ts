import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { syncState } from "@/db/schema";
import { getValidAccessToken } from "@/lib/oauth";
import { ingestFile } from "@/lib/ingest";
import { SUPPORTED_MIME_TYPES } from "@/lib/extract";
import type { SyncSummary } from "./types";

const DRIVE_API = "https://www.googleapis.com/drive/v3";
const MAX_FILE_BYTES = 20 * 1024 * 1024; // 20 MB safety cap per file

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

interface FilesListPage {
  nextPageToken?: string;
  files: DriveFile[];
}

/**
 * The Changes API only reports changes going forward from a start token —
 * it has no concept of "everything that already exists". A first-time sync
 * has to walk the full file list once via files.list before it can switch
 * to incremental Changes API polling.
 */
async function ingestExistingFiles(
  userId: string,
  accessToken: string,
  summary: SyncSummary
): Promise<void> {
  let pageToken: string | undefined;

  do {
    const url =
      "/files?pageSize=1000&q=" +
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
    }

    pageToken = page.nextPageToken;
  } while (pageToken);
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

/** Incrementally syncs a user's Google Drive using the Changes API, so a
 * re-run only touches files that actually changed since the last cursor. */
export async function syncGoogleDrive(userId: string): Promise<SyncSummary> {
  const summary: SyncSummary = { processed: 0, skipped: 0, removed: 0, errors: [] };

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

    let pageToken: string;
    let newCursor: string;

    if (state?.cursor) {
      pageToken = state.cursor;
      newCursor = pageToken;
    } else {
      // First sync ever: back-fill everything that already exists before
      // switching to incremental Changes API polling.
      await ingestExistingFiles(userId, accessToken, summary);
      pageToken = await getStartPageToken(accessToken);
      newCursor = pageToken;
    }

    do {
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
    } while (pageToken);

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
