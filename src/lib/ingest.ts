import crypto from "node:crypto";
import path from "node:path";
import { and, eq, isNotNull, isNull, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import { chunks, documents, type DocumentKind } from "@/db/schema";
import { extractText } from "@/lib/extract";
import { chunkText } from "@/lib/chunking";
import { EmbeddingBudgetError, EmbeddingRateLimitError, embedDocuments } from "@/lib/embeddings";
import { SyncInterrupted, syncOutOfTime } from "@/lib/connectors/sync-control";
import {
  EMPTY_CONTENT_HASH,
  MAX_INDEX_ATTEMPTS,
  decideIngest,
  failureAttempts,
  type IngestSnapshot,
} from "@/lib/ingest-plan";
import { sanitizeEmbeddingText } from "@/lib/text-sanitize";

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
  /** Absolute timestamp. Heavy work is not started once this is close. */
  deadline?: number;
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
  /** Set when this file was linked to an existing document instead of embedded. */
  aliasOf?: string;
  /** Set when this attempt failed and was recorded on the row. */
  error?: string;
}

function hashBuffer(buffer: Buffer): string {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

async function embedAllChunks(contents: string[], deadline?: number): Promise<number[][]> {
  const vectors: number[][] = [];
  for (let i = 0; i < contents.length; i += EMBED_BATCH_SIZE) {
    const batch = contents.slice(i, i + EMBED_BATCH_SIZE);
    vectors.push(...(await embedDocuments(batch, deadline)));
  }
  return vectors;
}

function clipError(message: string): string {
  return message.slice(0, 500);
}

async function findByIdentity(input: IngestFileInput) {
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
  return existing ?? null;
}

function snapshotOf(row: NonNullable<Awaited<ReturnType<typeof findByIdentity>>>): IngestSnapshot {
  return {
    id: row.id,
    contentHash: row.contentHash,
    indexedAt: row.indexedAt,
    indexError: row.indexError,
    aliasOf: row.aliasOf,
    indexAttempts: row.indexAttempts,
  };
}

async function findCanonicalId(userId: string, contentHash: string, exceptId?: string) {
  if (contentHash === EMPTY_CONTENT_HASH) return null;
  const filters = [
    eq(documents.userId, userId),
    eq(documents.contentHash, contentHash),
    isNull(documents.aliasOf),
    isNotNull(documents.indexedAt),
    isNull(documents.indexError),
  ];
  if (exceptId) filters.push(ne(documents.id, exceptId));
  const [row] = await db
    .select({ id: documents.id, title: documents.title })
    .from(documents)
    .where(and(...filters))
    .limit(1);
  return row ?? null;
}

async function aliasTargetValid(aliasOf: string, contentHash: string): Promise<boolean> {
  const [row] = await db
    .select({
      contentHash: documents.contentHash,
      indexedAt: documents.indexedAt,
      indexError: documents.indexError,
      aliasOf: documents.aliasOf,
    })
    .from(documents)
    .where(eq(documents.id, aliasOf));
  return Boolean(
    row &&
      row.contentHash === contentHash &&
      row.indexedAt &&
      !row.indexError &&
      !row.aliasOf
  );
}

/**
 * Points every extra copy of the same bytes at the oldest successful
 * document and drops the duplicate chunks. Also re-opens aliases whose
 * canonical was deleted or now has different bytes, so the next pass
 * indexes them for real. The empty-content hash is never collapsed.
 */
export async function consolidateDuplicates(userId: string): Promise<void> {
  await db.execute(sql`
    WITH canonical AS (
      SELECT DISTINCT ON ("contentHash") id, "contentHash"
      FROM documents
      WHERE "userId" = ${userId}
        AND "contentHash" IS NOT NULL
        AND "contentHash" <> ${EMPTY_CONTENT_HASH}
        AND "aliasOf" IS NULL
        AND "indexedAt" IS NOT NULL
        AND "indexError" IS NULL
      ORDER BY "contentHash", "createdAt" ASC
    )
    UPDATE documents AS dup
    SET "aliasOf" = canonical.id,
        "indexedAt" = COALESCE(dup."indexedAt", NOW()),
        "indexError" = NULL,
        "indexAttempts" = 0
    FROM canonical
    WHERE dup."userId" = ${userId}
      AND dup."contentHash" = canonical."contentHash"
      AND dup.id <> canonical.id
      AND dup."aliasOf" IS DISTINCT FROM canonical.id
  `);

  await db.execute(sql`
    UPDATE documents AS alias
    SET "aliasOf" = NULL,
        "indexedAt" = NULL,
        "indexAttempts" = 0
    WHERE alias."userId" = ${userId}
      AND alias."aliasOf" IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM documents AS canonical
        WHERE canonical.id = alias."aliasOf"
          AND canonical."contentHash" = alias."contentHash"
          AND canonical."indexedAt" IS NOT NULL
          AND canonical."indexError" IS NULL
          AND canonical."aliasOf" IS NULL
      )
  `);

  await db.execute(sql`
    DELETE FROM chunks
    WHERE "userId" = ${userId}
      AND "documentId" IN (
        SELECT id FROM documents
        WHERE "userId" = ${userId} AND "aliasOf" IS NOT NULL
      )
  `);
}

/** Records a failed index attempt. After MAX_INDEX_ATTEMPTS the row is
 * settled so the pending queue stops selecting it until the bytes change. */
export async function noteIndexFailure(
  documentId: string,
  message: string,
  priorAttempts?: number
): Promise<void> {
  let prior = priorAttempts;
  if (prior === undefined) {
    const [row] = await db
      .select({ indexAttempts: documents.indexAttempts })
      .from(documents)
      .where(eq(documents.id, documentId));
    prior = row?.indexAttempts ?? 0;
  }
  const { attempts, gaveUp } = failureAttempts(prior);
  await db
    .update(documents)
    .set({
      indexAttempts: attempts,
      indexedAt: gaveUp ? new Date() : null,
      indexError: clipError(gaveUp ? `aufgegeben nach ${attempts} Versuchen: ${message}` : message),
      aliasOf: null,
    })
    .where(eq(documents.id, documentId));
}

async function writeMetadata(
  documentId: string,
  input: IngestFileInput,
  folderPath: string | null,
  extra: Record<string, unknown>
) {
  await db
    .update(documents)
    .set({
      title: input.title,
      mimeType: input.mimeType,
      webUrl: input.webUrl ?? null,
      folderPath,
      sourceUpdatedAt: input.sourceUpdatedAt ?? null,
      ...extra,
    })
    .where(eq(documents.id, documentId));
}

/**
 * Upserts a document (Drive file / Graph file / local-sync file) and
 * (re-)indexes it for RAG. The same external id or local path updates the
 * existing row. A different file with the same bytes is stored as an alias
 * and is not chunked or embedded. The empty-content hash is exempt.
 */
export async function ingestFile(input: IngestFileInput): Promise<IngestResult> {
  const contentHash = hashBuffer(input.buffer);
  const existing = await findByIdentity(input);
  const folderPath = resolveFolderPath(input);
  const canonical = await findCanonicalId(input.userId, contentHash, existing?.id);
  const aliasTargetStillValid = existing?.aliasOf
    ? await aliasTargetValid(existing.aliasOf, contentHash)
    : false;

  const decision = decideIngest({
    contentHash,
    existing: existing ? snapshotOf(existing) : null,
    canonicalId: canonical?.id ?? null,
    aliasTargetValid: aliasTargetStillValid,
  });

  if (decision.type === "refresh" || decision.type === "give-up") {
    if (!existing) throw new Error("Index-Entscheidung ohne bestehendes Dokument.");
    await writeMetadata(existing.id, input, folderPath, {});
    return { documentId: existing.id, skipped: true, chunkCount: 0 };
  }

  const documentId = existing?.id ?? crypto.randomUUID();

  if (decision.type === "alias") {
    const aliasFields = {
      contentHash,
      indexedAt: new Date(),
      indexError: null,
      indexAttempts: 0,
      aliasOf: decision.canonicalId,
    };
    if (existing) {
      await writeMetadata(documentId, input, folderPath, aliasFields);
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
        sourceUpdatedAt: input.sourceUpdatedAt ?? null,
        ...aliasFields,
      });
    }
    await db.delete(chunks).where(eq(chunks.documentId, documentId));
    console.info(
      `[ingest] alias ${JSON.stringify(input.title)} -> ${decision.canonicalId}${
        canonical ? ` ${JSON.stringify(canonical.title)}` : ""
      }`
    );
    return { documentId, skipped: true, chunkCount: 0, aliasOf: decision.canonicalId };
  }

  if (input.deadline !== undefined && syncOutOfTime(input.deadline)) {
    throw new SyncInterrupted("Zeitbudget erreicht, die Datei wird beim nächsten Lauf indexiert.");
  }

  const priorAttempts = decision.priorAttempts;
  const startFields = {
    contentHash,
    indexedAt: null,
    indexError: null,
    indexAttempts: priorAttempts,
    aliasOf: null,
  };

  if (existing) {
    await writeMetadata(documentId, input, folderPath, startFields);
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
      sourceUpdatedAt: input.sourceUpdatedAt ?? null,
      ...startFields,
    });
  }

  let extracted: string | null;
  try {
    extracted = await extractText(input.buffer, input.mimeType, input.title);
  } catch (err) {
    const message = `extract failed: ${(err as Error).message}`;
    await noteIndexFailure(documentId, message, priorAttempts);
    return { documentId, skipped: false, chunkCount: 0, error: clipError(message) };
  }

  if (extracted === null) {
    const message = "unsupported file type, not indexed";
    await noteIndexFailure(documentId, message, priorAttempts);
    return { documentId, skipped: false, chunkCount: 0, error: message };
  }

  const text = sanitizeEmbeddingText(extracted);
  const pieces = chunkText(text).flatMap((piece) => {
    const content = sanitizeEmbeddingText(piece.content).trim();
    return content ? [{ ordinal: piece.ordinal, content }] : [];
  });

  if (pieces.length === 0) {
    await db.delete(chunks).where(eq(chunks.documentId, documentId));
    await db
      .update(documents)
      .set({ indexedAt: new Date(), indexError: null, indexAttempts: 0, aliasOf: null })
      .where(eq(documents.id, documentId));
    return { documentId, skipped: false, chunkCount: 0 };
  }

  let vectors: number[][];
  try {
    vectors = await embedAllChunks(
      pieces.map((piece) => piece.content),
      input.deadline
    );
  } catch (err) {
    if (err instanceof EmbeddingRateLimitError || err instanceof EmbeddingBudgetError) {
      await db
        .update(documents)
        .set({
          indexedAt: null,
          indexError: clipError(err.message),
          indexAttempts: priorAttempts,
          aliasOf: null,
        })
        .where(eq(documents.id, documentId));
      if (err instanceof EmbeddingRateLimitError) throw err;
      throw new SyncInterrupted(err.message);
    }
    const message = `embed failed: ${(err as Error).message}`;
    await noteIndexFailure(documentId, message, priorAttempts);
    return { documentId, skipped: false, chunkCount: 0, error: clipError(message) };
  }

  await db.delete(chunks).where(eq(chunks.documentId, documentId));
  await db.insert(chunks).values(
    pieces.map((piece, i) => ({
      documentId,
      userId: input.userId,
      ordinal: i,
      content: piece.content,
      embedding: vectors[i],
    }))
  );

  await db
    .update(documents)
    .set({ indexedAt: new Date(), indexError: null, indexAttempts: 0, aliasOf: null })
    .where(eq(documents.id, documentId));

  return { documentId, skipped: false, chunkCount: pieces.length };
}

export { EMPTY_CONTENT_HASH, MAX_INDEX_ATTEMPTS };
