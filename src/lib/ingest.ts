import crypto from "node:crypto";
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
  title: string;
  mimeType: string | null;
  webUrl?: string | null;
  sourceUpdatedAt?: Date | null;
  buffer: Buffer;
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

/**
 * Upserts a document (Drive file / Graph file / local-sync file) and
 * (re-)indexes it for RAG. Skips re-embedding when the content hash hasn't
 * changed since the last sync, which keeps re-syncs of unchanged files
 * nearly free.
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

  if (existing && existing.contentHash === contentHash) {
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
        contentHash,
        sourceUpdatedAt: input.sourceUpdatedAt ?? null,
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
      .set({ indexError: `extract failed: ${(err as Error).message}` })
      .where(eq(documents.id, documentId));
    return { documentId, skipped: false, chunkCount: 0 };
  }

  if (!text) {
    // Unsupported file type (image, binary, ...): keep the document row so
    // it shows up in file listings, just without searchable chunks.
    await db
      .update(documents)
      .set({ indexedAt: new Date(), indexError: "unsupported file type, not indexed" })
      .where(eq(documents.id, documentId));
    return { documentId, skipped: false, chunkCount: 0 };
  }

  const pieces = chunkText(text);
  const vectors = await embedAllChunks(pieces.map((p) => p.content));

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

/**
 * (Re-)indexes a note's markdown content. Notes skip extractText/hash
 * comparison since the editor already has the exact current content and
 * calls this on every save.
 */
export async function ingestNote(params: {
  documentId: string;
  userId: string;
  title: string;
  content: string;
}): Promise<{ chunkCount: number }> {
  const pieces = chunkText(params.content);
  const vectors = await embedAllChunks(pieces.map((p) => p.content));

  await db.delete(chunks).where(eq(chunks.documentId, params.documentId));

  if (pieces.length > 0) {
    await db.insert(chunks).values(
      pieces.map((piece, i) => ({
        documentId: params.documentId,
        userId: params.userId,
        ordinal: piece.ordinal,
        content: piece.content,
        embedding: vectors[i],
      }))
    );
  }

  await db
    .update(documents)
    .set({ title: params.title, indexedAt: new Date(), indexError: null })
    .where(eq(documents.id, params.documentId));

  return { chunkCount: pieces.length };
}
