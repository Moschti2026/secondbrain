/** Bumped when OneDrive must be enumerated from scratch once (download
 * URLs were missing, so a finished delta cursor would never revisit files). */
export const ONEDRIVE_CURSOR_VERSION = "od2";

const PREFIX = `${ONEDRIVE_CURSOR_VERSION}:`;

export function wrapOneDriveCursor(url: string | null): string | null {
  if (!url) return null;
  return url.startsWith(PREFIX) ? url : `${PREFIX}${url}`;
}

/**
 * A versioned cursor resumes the Graph delta URL. Anything else (a legacy
 * deltaLink saved before files could be downloaded) returns null so the
 * next run walks the whole drive, including subfolders, exactly once.
 */
export function unwrapOneDriveCursor(cursor: string | null | undefined): string | null {
  if (!cursor?.startsWith(PREFIX)) return null;
  const url = cursor.slice(PREFIX.length);
  return url || null;
}
