import crypto from "node:crypto";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { chunks, documents, type DocumentKind } from "@/db/schema";
import { extractText } from "@/lib/extract";
import { chunkText } from "@/lib/chunking";
import { embedDocuments } from "@/lib/embeddings";

const EMBED_BATCH_SIZE = 64;

export interface IngestFileInput {
  userId: string;
  kind: Extract<DocumentKind, "google_drive" | "microsoft365" | "local">;
  externalId?: string | null;
  localPath?: string | null;
  /** Human-readable folder path, e.g. "Google Drive/Projekte". Connectors
   * resolve this themselves; for "local" it's derived from localPath below
   * if not given. */
  folderPath?: string | null;
  title: string;
  mimeType: string | null;
  webUrl?: string | null;
  sourceUpdatedAt?: Date | null;
  buffer: Buffer;
}

function resolveFolderPath(input: IngestFileInput): string | null {
  if (input.folderPath !== undefined) return input.folderPath;
  if (input.kind === "local" && input.localPath) {
    const dir = path.dirname(input.localPath);
    return dir === "." ? "Lokal" : `Lokal/${dir}`;
  }
  return null;
}

export interface IngestResult {
  documentId: string;
  skipped: boolean;
  chunkCount: number;
}

function hashBuffer(buffer: Buffer): string {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

async function embedAllChunks(contents: string[]): Promise<number[][]> {
  const vectors: number[][] = [];
  for (let i = 0; i < contents.length; i += EMBED_BATCH_SIZE) {
    const batch = contents.slice(i, i + EMBED_BATCH_SIZE);
    vectors.push(...(await embedDocuments(batch)));
  }
  return vectors;
}

function clipError(message: string): string {
  return message.slice(0, 500);
}

/**
 * Upserts a document (Drive file / Graph file / local-sync file) and
 * (re-)indexes it for RAG. Re-embedding is skipped only when the content
 * hash matches AND a previous run finished indexing (`indexedAt` is set).
 * A hash written before a failed embedding does not count as done, so the
 * next sync retries it.
 */
export async function ingestFile(input: IngestFileInput): Promise<IngestResult> {
  const contentHash = hashBuffer(input.buffer);

  const [existing] = await db
    .select()
    .from(documents)
    .where(
      input.kind === "local"
        ? and(eq(documents.userId, input.userId), eq(documents.localPath, input.localPath!))
        : and(
            eq(documents.userId, input.userId),
            eq(documents.kind, input.kind),
            eq(documents.externalId, input.externalId!)
          )
    );

  const folderPath = resolveFolderPath(input);

  if (existing && existing.contentHash === contentHash && existing.indexedAt) {
    // Content unchanged and already indexed: still refresh cheap metadata
    // (title, folder path, link — a file can be renamed or moved without
    // its content changing) so a listing stays accurate, but skip the
    // expensive extract/chunk/embed work below.
    await db
      .update(documents)
      .set({
        title: input.title,
        mimeType: input.mimeType,
        webUrl: input.webUrl ?? null,
        folderPath,
        sourceUpdatedAt: input.sourceUpdatedAt ?? null,
      })
      .where(eq(documents.id, existing.id));
    return { documentId: existing.id, skipped: true, chunkCount: 0 };
  }

  const documentId = existing?.id ?? crypto.randomUUID();

  if (existing) {
    await db
      .update(documents)
      .set({
        title: input.title,
        mimeType: input.mimeType,
        webUrl: input.webUrl ?? null,
        folderPath,
        contentHash,
        sourceUpdatedAt: input.sourceUpdatedAt ?? null,
        // Cleared until this attempt finishes. A crash or a 429 must not
        // leave the previous indexedAt in place next to the new hash.
        indexedAt: null,
        indexError: null,
      })
      .where(eq(documents.id, documentId));
  } else {
    await db.insert(documents).values({
      id: documentId,
      userId: input.userId,
      kind: input.kind,
      externalId: input.externalId ?? null,
      localPath: input.localPath ?? null,
      folderPath,
      title: input.title,
      mimeType: input.mimeType,
      webUrl: input.webUrl ?? null,
      contentHash,
      sourceUpdatedAt: input.sourceUpdatedAt ?? null,
    });
  }

  let text: string | null;
  try {
    text = await extractText(input.buffer, input.mimeType);
  } catch (err) {
    await db
      .update(documents)
      .set({
        indexedAt: null,
        indexError: clipError(`extract failed: ${(err as Error).message}`),
      })
      .where(eq(documents.id, documentId));
    return { documentId, skipped: false, chunkCount: 0 };
  }

  if (!text) {
    // Unsupported file type (image, binary, ...): keep the document row so
    // it shows up in file listings, just without searchable chunks.
    // indexedAt is set so the pending-index queue does not retry it.
    await db
      .update(documents)
      .set({ indexedAt: new Date(), indexError: "unsupported file type, not indexed" })
      .where(eq(documents.id, documentId));
    return { documentId, skipped: false, chunkCount: 0 };
  }

  const pieces = chunkText(text);
  let vectors: number[][];
  try {
    vectors = await embedAllChunks(pieces.map((p) => p.content));
  } catch (err) {
    await db
      .update(documents)
      .set({
        indexedAt: null,
        indexError: clipError(`embed failed: ${(err as Error).message}`),
      })
      .where(eq(documents.id, documentId));
    throw err;
  }

  await db.delete(chunks).where(eq(chunks.documentId, documentId));

  if (pieces.length > 0) {
    await db.insert(chunks).values(
      pieces.map((piece, i) => ({
        documentId,
        userId: input.userId,
        ordinal: piece.ordinal,
        content: piece.content,
        embedding: vectors[i],
      }))
    );
  }

  await db
    .update(documents)
    .set({ indexedAt: new Date(), indexError: null })
    .where(eq(documents.id, documentId));

  return { documentId, skipped: false, chunkCount: pieces.length };
}
