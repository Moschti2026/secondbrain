import { PDFParse } from "pdf-parse";
import mammoth from "mammoth";

const TEXT_MIME_TYPES = [
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
];

const GOOGLE_DOC_EXPORT_MIME = "application/vnd.google-apps.document";

const HTML_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  "#39": "'",
  apos: "'",
  nbsp: " ",
};

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
    .replace(/&(#39|amp|lt|gt|quot|apos|nbsp);/g, (_, entity) => HTML_ENTITIES[entity])
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Extracts plain text from a file buffer based on its mime type. Returns
 * null for types we don't know how to read (images, audio, unknown
 * binaries, ...) so the ingestion pipeline can skip them cleanly instead of
 * storing garbage chunks.
 */
export async function extractText(
  buffer: Buffer,
  mimeType: string | null | undefined
): Promise<string | null> {
  const type = mimeType ?? "";

  if (type === "application/pdf") {
    const parser = new PDFParse({ data: buffer });
    try {
      const result = await parser.getText();
      return result.text;
    } finally {
      await parser.destroy();
    }
  }

  if (
    type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  ) {
    const { value } = await mammoth.extractRawText({ buffer });
    return value;
  }

  if (type === "text/html") {
    return htmlToText(buffer.toString("utf-8"));
  }

  if (TEXT_MIME_TYPES.includes(type) || type.startsWith("text/")) {
    return buffer.toString("utf-8");
  }

  if (type === GOOGLE_DOC_EXPORT_MIME) {
    // Callers should export Google Docs to text/plain via the Drive API
    // before calling extractText; this mime type should never reach here
    // with binary content.
    return buffer.toString("utf-8");
  }

  return null;
}

export const SUPPORTED_MIME_TYPES = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/html",
  ...TEXT_MIME_TYPES,
];
