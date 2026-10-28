import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import {
  EMPTY_CONTENT_HASH,
  MAX_INDEX_ATTEMPTS,
  decideIngest,
  failureAttempts,
  type IngestSnapshot,
} from "./ingest-plan";

function row(overrides: Partial<IngestSnapshot> = {}): IngestSnapshot {
  return {
    id: "doc-1",
    contentHash: "abc",
    indexedAt: new Date("2026-01-01T00:00:00Z"),
    indexError: null,
    aliasOf: null,
    indexAttempts: 0,
    ...overrides,
  };
}

describe("duplicate and retry decisions", () => {
  it("uses the sha256 of an empty buffer as the exempt hash", () => {
    assert.equal(EMPTY_CONTENT_HASH, createHash("sha256").update("").digest("hex"));
  });

  it("refreshes metadata when the same file is already indexed", () => {
    assert.deepEqual(
      decideIngest({
        contentHash: "abc",
        existing: row(),
        canonicalId: "other",
        aliasTargetValid: false,
      }),
      { type: "refresh" }
    );
  });

  it("aliases a different file with the same bytes and does not alias the empty hash", () => {
    assert.deepEqual(
      decideIngest({
        contentHash: "abc",
        existing: null,
        canonicalId: "canonical",
        aliasTargetValid: false,
      }),
      { type: "alias", canonicalId: "canonical" }
    );

    assert.deepEqual(
      decideIngest({
        contentHash: EMPTY_CONTENT_HASH,
        existing: null,
        canonicalId: "canonical",
        aliasTargetValid: false,
      }),
      { type: "index", priorAttempts: 0 }
    );
  });

  it("keeps updating the same external id when its bytes change", () => {
    assert.deepEqual(
      decideIngest({
        contentHash: "new",
        existing: row({ contentHash: "old", indexAttempts: MAX_INDEX_ATTEMPTS, indexError: "embed failed" }),
        canonicalId: null,
        aliasTargetValid: false,
      }),
      { type: "index", priorAttempts: 0 }
    );
  });

  it("stops retrying the same bytes after the attempt cap, unless a canonical copy exists", () => {
    const failed = row({
      indexError: "extract failed",
      indexAttempts: MAX_INDEX_ATTEMPTS,
      indexedAt: new Date(),
    });
    assert.deepEqual(
      decideIngest({
        contentHash: "abc",
        existing: failed,
        canonicalId: null,
        aliasTargetValid: false,
      }),
      { type: "give-up" }
    );
    assert.deepEqual(
      decideIngest({
        contentHash: "abc",
        existing: failed,
        canonicalId: "canonical",
        aliasTargetValid: false,
      }),
      { type: "alias", canonicalId: "canonical" }
    );
  });

  it("retries a settled unsupported row while attempts remain", () => {
    assert.deepEqual(
      decideIngest({
        contentHash: "abc",
        existing: row({ indexError: "unsupported file type, not indexed", indexAttempts: 0 }),
        canonicalId: null,
        aliasTargetValid: false,
      }),
      { type: "index", priorAttempts: 0 }
    );
  });

  it("refreshes a valid alias and reindexes a broken one", () => {
    assert.equal(
      decideIngest({
        contentHash: "abc",
        existing: row({ aliasOf: "canonical" }),
        canonicalId: null,
        aliasTargetValid: true,
      }).type,
      "refresh"
    );
    assert.deepEqual(
      decideIngest({
        contentHash: "abc",
        existing: row({ aliasOf: "gone", indexedAt: new Date(), indexError: null }),
        canonicalId: null,
        aliasTargetValid: false,
      }),
      { type: "index", priorAttempts: 0 }
    );
  });

  it("marks the third failure as given up", () => {
    assert.deepEqual(failureAttempts(0), { attempts: 1, gaveUp: false });
    assert.deepEqual(failureAttempts(MAX_INDEX_ATTEMPTS - 1), {
      attempts: MAX_INDEX_ATTEMPTS,
      gaveUp: true,
    });
  });
});
