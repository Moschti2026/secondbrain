import { and, asc, eq, isNotNull, isNull, like, lt, not, or } from "drizzle-orm";
import { db } from "@/db";
import { documents, type DocumentKind } from "@/db/schema";
import { MAX_INDEX_ATTEMPTS } from "@/lib/ingest-plan";

export interface PendingDocument {
  id: string;
  externalId: string;
  title: string;
}

/**
 * Documents that still need an index attempt: never finished, or finished
 * with an error and under the attempt cap. Ordered so rows that have never
 * recorded an error are tried before known failures, which keeps one poison
 * file from blocking the rest of the backlog. Aliases are excluded because
 * their indexError is null and indexedAt is set.
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
    isNotNull(documents.externalId),
    lt(documents.indexAttempts, MAX_INDEX_ATTEMPTS),
    or(isNull(documents.indexedAt), isNotNull(documents.indexError)),
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
    .orderBy(asc(documents.indexAttempts), asc(documents.indexError), asc(documents.createdAt))
    .limit(limit);

  return rows.flatMap((row) =>
    row.externalId ? [{ id: row.id, externalId: row.externalId, title: row.title }] : []
  );
}

/** Stops a row from being retried (deleted source, ignored path, over the
 * size cap). indexedAt is set and the attempt counter is exhausted so the
 * pending query skips it. */
export async function settleUnindexed(id: string, indexError: string): Promise<void> {
  await db
    .update(documents)
    .set({
      indexedAt: new Date(),
      indexError: indexError.slice(0, 500),
      indexAttempts: MAX_INDEX_ATTEMPTS,
    })
    .where(eq(documents.id, id));
}
