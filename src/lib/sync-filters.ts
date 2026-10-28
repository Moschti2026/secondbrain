import path from "node:path";
import { SUPPORTED_MIME_TYPES } from "@/lib/extract";

/** Folder names that are tool configuration or VCS internals, not notes. */
const IGNORED_SEGMENTS = new Set([".obsidian", ".git"]);

/**
 * True for files inside an Obsidian config directory or a git checkout
 * (including `.git/objects`). Matching is on path segments, so a vault
 * folder named "Obsidian" or a note called "git.md" is still ingested.
 */
export function isIgnoredVaultPath(
  folderPath: string | null | undefined,
  fileName?: string | null
): boolean {
  const segments: string[] = [];
  if (folderPath) {
    for (const part of folderPath.split(/[/\\]/)) {
      if (part && part !== "." && part !== "..") segments.push(part);
    }
  }
  if (fileName && (fileName === ".obsidian" || fileName === ".git")) return true;
  return segments.some((segment) => IGNORED_SEGMENTS.has(segment));
}

export function isMarkdownFileName(fileName: string | null | undefined): boolean {
  const ext = path.extname(fileName ?? "").toLowerCase();
  return ext === ".md" || ext === ".markdown";
}

const EXTENSION_MIME: Record<string, string> = {
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".json": "application/json",
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".html": "text/html",
  ".htm": "text/html",
};

export function normalizeMimeType(mimeType: string | null | undefined): string {
  return (mimeType ?? "").split(";")[0].trim().toLowerCase();
}

/**
 * Drive and OneDrive label the same Markdown file as text/markdown,
 * text/x-markdown, text/plain, or application/octet-stream. The extension
 * wins for .md/.markdown so none of those reports drop the file. Other
 * types still follow the reported MIME, with a filename fallback when the
 * provider sent a generic binary type.
 */
export function resolveIngestMimeType(
  fileName: string,
  reported: string | null | undefined
): string | null {
  if (isMarkdownFileName(fileName)) return "text/markdown";

  const reportedType = normalizeMimeType(reported);
  if (
    reportedType &&
    (SUPPORTED_MIME_TYPES.includes(reportedType) || reportedType.startsWith("text/"))
  ) {
    return reportedType;
  }

  const fromExt = EXTENSION_MIME[path.extname(fileName).toLowerCase()];
  if (
    fromExt &&
    (!reportedType ||
      reportedType === "application/octet-stream" ||
      reportedType === "application/binary" ||
      reportedType === "binary/octet-stream")
  ) {
    return fromExt;
  }

  return reportedType || fromExt || null;
}

export function isIngestableMime(mimeType: string | null | undefined): boolean {
  const type = normalizeMimeType(mimeType);
  if (!type) return false;
  if (SUPPORTED_MIME_TYPES.includes(type)) return true;
  return type.startsWith("text/");
}

/** Markdown notes are never skipped for size. Other binaries keep the cap. */
export function shouldSkipForSize(
  fileName: string,
  sizeBytes: number | null | undefined,
  maxBytes: number
): boolean {
  if (isMarkdownFileName(fileName)) return false;
  if (sizeBytes == null || !Number.isFinite(sizeBytes)) return false;
  return sizeBytes > maxBytes;
}
