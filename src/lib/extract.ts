import path from "node:path";
import { extractText as extractPdfText, getDocumentProxy } from "unpdf";
import mammoth from "mammoth";

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const TEXT_MIME_TYPES = [
  "text/plain",
  "text/markdown",
  // Drive sometimes reports .md this way; octet-stream is handled by the
  // filename fallback in sync-filters.ts before extract runs.
  "text/x-markdown",
  "application/x-markdown",
  "text/csv",
  "application/json",
];

const GOOGLE_DOC_EXPORT_MIME = "application/vnd.google-apps.document";

const EXTENSION_MIME: Record<string, string> = {
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".json": "application/json",
  ".pdf": "application/pdf",
  ".docx": DOCX_MIME,
  ".html": "text/html",
  ".htm": "text/html",
};

const HTML_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  "#39": "'",
  apos: "'",
  nbsp: " ",
};

export function normalizeMimeType(mimeType: string | null | undefined): string {
  return (mimeType ?? "").split(";")[0].trim().toLowerCase();
}

/** Minimal HTML → plain text: enough to make OneNote page markup (and
 * similar simple HTML) readable and embeddable, without pulling in a full
 * HTML parser for what is otherwise a small, well-formed input. */
function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|div|h[1-6]|tr|li)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#39|amp|lt|gt|quot|apos|nbsp);/g, (_, entity: string) => HTML_ENTITIES[entity] ?? "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

type Magic = "pdf" | "zip" | "html" | "text" | "binary";

function sniff(buffer: Buffer): Magic {
  if (buffer.length >= 5 && buffer.subarray(0, 5).toString("latin1") === "%PDF-") return "pdf";
  if (
    buffer.length >= 4 &&
    buffer[0] === 0x50 &&
    buffer[1] === 0x4b &&
    (buffer[2] === 0x03 || buffer[2] === 0x05 || buffer[2] === 0x07 || buffer[2] === 0x08)
  ) {
    return "zip";
  }
  const head = buffer.subarray(0, Math.min(buffer.length, 512)).toString("utf8").trimStart().toLowerCase();
  if (
    head.startsWith("<!doctype html") ||
    head.startsWith("<html") ||
    head.startsWith("<head") ||
    head.startsWith("<body")
  ) {
    return "html";
  }
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  if (!sample.includes(0)) return "text";
  return "binary";
}

/** Google and Microsoft sometimes answer 200 with an HTML login or error
 * page instead of the file. Indexing that page would embed the error, not
 * the document. Real OneNote HTML is not passed through this check. */
export function looksLikeProviderErrorPage(buffer: Buffer): boolean {
  if (sniff(buffer) !== "html" || buffer.length > 200_000) return false;
  const head = buffer.subarray(0, 8_000).toString("utf8");
  return /accounts\.google\.com|ServiceLogin|login\.microsoftonline\.com|id="error"|<title>\s*Google Drive\s*<\/title>/i.test(
    head
  );
}

function extensionMime(fileName: string | null | undefined): string {
  return EXTENSION_MIME[path.extname(fileName ?? "").toLowerCase()] ?? "";
}

function isTextMime(type: string): boolean {
  return TEXT_MIME_TYPES.includes(type) || type.startsWith("text/");
}

async function readPdf(buffer: Buffer): Promise<string> {
  if (sniff(buffer) === "html") {
    throw new Error(
      "PDF-Download lieferte HTML statt einer PDF-Datei (Fehlerseite oder fehlgeschlagener Export)."
    );
  }
  if (sniff(buffer) !== "pdf") {
    throw new Error("Datei ist als PDF markiert, der Inhalt beginnt aber nicht mit %PDF-.");
  }
  try {
    // Copy the bytes. pdf.js may detach the underlying ArrayBuffer, and a
    // view into a Node pool must not be handed over in place.
    const copy = Uint8Array.from(buffer);
    const pdf = await getDocumentProxy(copy);
    const { text } = await extractPdfText(pdf, { mergePages: true });
    return text;
  } catch (err) {
    const message = (err as Error).message || "unbekannter PDF-Fehler";
    throw new Error(`PDF-Text ließ sich nicht lesen: ${message}`);
  }
}

async function readDocx(buffer: Buffer): Promise<string> {
  if (sniff(buffer) === "html" || looksLikeProviderErrorPage(buffer)) {
    throw new Error(
      "DOCX-Download lieferte HTML statt einer Word-Datei (Fehlerseite oder fehlgeschlagener Export)."
    );
  }
  if (sniff(buffer) !== "zip") {
    throw new Error("DOCX ist kein ZIP. Der Download ist beschädigt oder keine Word-Datei.");
  }
  try {
    const { value } = await mammoth.extractRawText({ buffer });
    return value ?? "";
  } catch (err) {
    const message = (err as Error).message || "";
    if (/central directory|zip file|end of central/i.test(message)) {
      throw new Error(
        "DOCX ließ sich nicht lesen (kein gültiges ZIP). Oft ist der Download eine HTML-Fehlerseite oder kein Word-Export."
      );
    }
    throw err;
  }
}

/**
 * Extracts plain text from a file buffer. Returns null only when the type
 * is one we deliberately do not index (images, audio, unknown binaries).
 * An empty string means the type is supported but there is no text — that
 * is not "unsupported", and callers must not settle it as a permanent type
 * error. Throws when the bytes contradict the declared type (HTML error
 * page saved as PDF/DOCX, truncated ZIP) so the sync can retry.
 */
export async function extractText(
  buffer: Buffer,
  mimeType: string | null | undefined,
  fileName?: string | null
): Promise<string | null> {
  const declared = normalizeMimeType(mimeType);
  const fromExt = extensionMime(fileName);
  const magic = sniff(buffer);

  const labeledPdf = declared === "application/pdf" || fromExt === "application/pdf";
  const labeledDocx = declared === DOCX_MIME || fromExt === DOCX_MIME;

  if (magic === "pdf" || labeledPdf) {
    return readPdf(buffer);
  }

  if (labeledDocx || (magic === "zip" && fromExt === DOCX_MIME)) {
    return readDocx(buffer);
  }

  const labeledHtml =
    declared === "text/html" ||
    declared === "application/xhtml+xml" ||
    fromExt === "text/html";
  if (labeledHtml || (magic === "html" && !isTextMime(declared) && declared !== GOOGLE_DOC_EXPORT_MIME)) {
    return htmlToText(buffer.toString("utf8"));
  }

  if (
    isTextMime(declared) ||
    declared === GOOGLE_DOC_EXPORT_MIME ||
    declared.startsWith("application/vnd.google-apps.") ||
    isTextMime(fromExt)
  ) {
    if (magic === "html" && looksLikeProviderErrorPage(buffer)) {
      throw new Error("Download lieferte eine HTML-Fehlerseite statt Dateiinhalt.");
    }
    return buffer.toString("utf8");
  }

  if (magic === "text" && (declared === "" || declared === "application/octet-stream" || declared === "application/binary")) {
    return buffer.toString("utf8");
  }

  return null;
}

export const SUPPORTED_MIME_TYPES = [
  "application/pdf",
  DOCX_MIME,
  "text/html",
  "application/xhtml+xml",
  ...TEXT_MIME_TYPES,
];
