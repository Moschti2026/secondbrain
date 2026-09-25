import { PDFParse } from "pdf-parse";
import mammoth from "mammoth";

const TEXT_MIME_TYPES = [
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
];

const GOOGLE_DOC_EXPORT_MIME = "application/vnd.google-apps.document";

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
  ...TEXT_MIME_TYPES,
];
