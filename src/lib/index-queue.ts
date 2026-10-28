import { and, asc, eq, isNotNull, isNull, like, not } from "drizzle-orm";
import { db } from "@/db";
import { documents, type DocumentKind } from "@/db/schema";

export interface PendingDocument {
  id: string;
  externalId: string;
  title: string;
}

/**
 * Documents that were saved but never finished indexing. Ordered so rows
 * that have never recorded an error are tried before known failures, which
 * keeps one poison file from blocking the rest of the backlog.
 */
export async function listPendingDocuments(
  userId: string,
  kind: Extract<DocumentKind, "google_drive" | "microsoft365">,
  limit: number,
  options: { excludeOnenote?: boolean } = {}
): Promise<PendingDocument[]> {
  const filters = [
    eq(documents.userId, userId),
    eq(documents.kind, kind),
    isNull(documents.indexedAt),
    isNotNull(documents.externalId),
  ];
  if (options.excludeOnenote) {
    filters.push(not(like(documents.externalId, "onenote:%")));
  }

  const rows = await db
    .select({
      id: documents.id,
      externalId: documents.externalId,
      title: documents.title,
    })
    .from(documents)
    .where(and(...filters))
    .orderBy(asc(documents.indexError), asc(documents.createdAt))
    .limit(limit);

  return rows.flatMap((row) =>
    row.externalId ? [{ id: row.id, externalId: row.externalId, title: row.title }] : []
  );
}

/** Stops a row from being retried forever (deleted source, ignored path,
 * or a type we cannot read). indexedAt is set so the pending query skips it. */
export async function settleUnindexed(id: string, indexError: string): Promise<void> {
  await db
    .update(documents)
    .set({ indexedAt: new Date(), indexError: indexError.slice(0, 500) })
    .where(eq(documents.id, id));
}
