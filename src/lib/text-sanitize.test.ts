import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sanitizeEmbeddingText } from "./text-sanitize";

describe("embedding text sanitizer", () => {
  it("drops lone surrogates, NULs and control characters but keeps newlines and emoji", () => {
    const cleaned = sanitizeEmbeddingText("a\uD800b\u0000c\u0001d\n\uD83D\uDE00");
    assert.equal(cleaned, "abcd\n😀");
  });

  it("strips a leading BOM", () => {
    assert.equal(sanitizeEmbeddingText("\uFEFFhello"), "hello");
  });
});
