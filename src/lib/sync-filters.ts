import path from "node:path";
import { SUPPORTED_MIME_TYPES, normalizeMimeType } from "@/lib/extract";

/** Folder names that are tool configuration or VCS internals, not notes. */
const IGNORED_SEGMENTS = new Set([
  ".obsidian", ".git", ".trash", "node_modules", ".next", "dist", "build", "out",
  ".wrangler", ".cache", "__pycache__", ".venv", "venv", "coverage", "Codex-Backups",
]);

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

/**
 * Shown on an existing document row for a Word/Excel/PowerPoint lock or
 * temp file. The row and any chunks stay; the retry queue stops selecting it.
 */
export const OFFICE_TEMP_INDEX_NOTE = "Office-Sperrdatei, nicht indexiert";

/**
 * Owner lock files (`~$Bericht.docx`, also `.xlsx` / `.pptx`) and Office
 * scratch files (`~WRL0001.tmp`). They are not documents. Drive reports the
 * lock as a DOCX, and extraction then fails with "DOCX ist kein ZIP".
 * A real `Bericht.docx` or `Name (1).docx` does not match.
 */
export function isOfficeTempOrLockFile(fileName: string | null | undefined): boolean {
  const base = (fileName ?? "").split(/[/\\]/).pop() ?? "";
  if (!base) return false;
  if (base.toLowerCase().startsWith("~$")) return true;
  return base.startsWith("~") && base.toLowerCase().endsWith(".tmp");
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

/**
 * Drive and OneDrive label the same Markdown file as text/markdown,
 * text/x-markdown, text/plain, or application/octet-stream. The extension
 * wins for .md/.markdown so none of those reports drop the file. For every
 * other known extension (.pdf, .txt, .html, .docx) the extension also wins
 * when the reported type is missing or not one we can index
 * (`application/x-pdf`, a generic binary type, …). A reported type we
 * already support is kept.
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
  if (fromExt) return fromExt;
  return reportedType || null;
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
