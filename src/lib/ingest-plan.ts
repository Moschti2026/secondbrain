import { createHash } from "node:crypto";

/** SHA-256 of a zero-length buffer. Empty files share this hash and must
 * stay separate rows — a failed download must not collapse every empty
 * file onto one canonical document. */
export const EMPTY_CONTENT_HASH = createHash("sha256").update(Buffer.alloc(0)).digest("hex");

/** Extraction/embedding tries for the same bytes before the row is settled. */
export const MAX_INDEX_ATTEMPTS = 3;

export interface IngestSnapshot {
  id: string;
  contentHash: string | null;
  indexedAt: Date | null;
  indexError: string | null;
  aliasOf: string | null;
  indexAttempts: number;
}

export type IngestDecision =
  | { type: "refresh" }
  | { type: "alias"; canonicalId: string }
  | { type: "give-up" }
  | { type: "index"; priorAttempts: number };

/**
 * Decides whether a file should be re-embedded. Same external id still
 * updates in place (`refresh` / `index`). A different file with the same
 * bytes becomes an alias of the already indexed document, except for the
 * empty-content hash.
 */
export function decideIngest(args: {
  contentHash: string;
  existing: IngestSnapshot | null;
  /** Other successfully indexed document with the same hash. Never this row. */
  canonicalId: string | null;
  /** True when `existing.aliasOf` still points at a canonical with these bytes. */
  aliasTargetValid: boolean;
}): IngestDecision {
  const sameBytes = Boolean(args.existing && args.existing.contentHash === args.contentHash);

  if (
    sameBytes &&
    args.existing?.indexedAt &&
    !args.existing.indexError &&
    (!args.existing.aliasOf || args.aliasTargetValid)
  ) {
    return { type: "refresh" };
  }

  if (args.contentHash !== EMPTY_CONTENT_HASH && args.canonicalId) {
    return { type: "alias", canonicalId: args.canonicalId };
  }

  if (sameBytes && args.existing?.indexError && args.existing.indexAttempts >= MAX_INDEX_ATTEMPTS) {
    return { type: "give-up" };
  }

  return {
    type: "index",
    priorAttempts: sameBytes ? (args.existing?.indexAttempts ?? 0) : 0,
  };
}

export function failureAttempts(priorAttempts: number): { attempts: number; gaveUp: boolean } {
  const attempts = priorAttempts + 1;
  return { attempts, gaveUp: attempts >= MAX_INDEX_ATTEMPTS };
}
