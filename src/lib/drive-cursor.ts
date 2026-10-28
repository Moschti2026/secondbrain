/**
 * Drive page tokens look like `~!!~…=` and may contain `+`, `/`, and `=`.
 * Sent raw, the files.list / changes.list APIs answer 400 Invalid Value
 * (location pageToken) and a stored bad token then fails every night.
 * Encode every character that is not an unreserved URL character.
 */
export function encodeDrivePageToken(token: string): string {
  return encodeURIComponent(token).replace(/[!'()*~]/g, (ch) =>
    `%${ch.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

export function isInvalidDrivePageToken(status: number, body: string): boolean {
  if (status === 410) return true;
  if (status !== 400) return false;
  return /"location"\s*:\s*"pageToken"/i.test(body);
}

/** Bumped when a full file walk is required so older changes cursors,
 * which never re-list unchanged files, are discarded once. */
export const DRIVE_CURSOR_VERSION = "gd2";

const BACKFILL_PREFIX = "backfill:";

export type DriveCursor =
  | { phase: "backfill"; pageToken: string }
  | { phase: "changes"; pageToken: string };

/**
 * null, a legacy raw changes token, or an in-progress `backfill:` value.
 * Legacy changes tokens (no version prefix) start a full walk so Markdown
 * files that were skipped before the MIME fix, and embeddings that never
 * finished, are picked up without a manual database edit.
 */
export function readDriveCursor(cursor: string | null | undefined): DriveCursor {
  if (!cursor) return { phase: "backfill", pageToken: "" };
  if (cursor.startsWith(BACKFILL_PREFIX)) {
    return { phase: "backfill", pageToken: cursor.slice(BACKFILL_PREFIX.length) };
  }
  const versioned = `${DRIVE_CURSOR_VERSION}:`;
  if (cursor.startsWith(versioned)) {
    return { phase: "changes", pageToken: cursor.slice(versioned.length) };
  }
  return { phase: "backfill", pageToken: "" };
}

export function writeDriveBackfillCursor(pageToken: string): string {
  return `${BACKFILL_PREFIX}${pageToken}`;
}

export function writeDriveChangesCursor(pageToken: string): string {
  return `${DRIVE_CURSOR_VERSION}:${pageToken}`;
}
