import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runSyncJobs } from "./sync-control";
import type { SyncSummary } from "./types";

function summary(overrides: Partial<SyncSummary> = {}): SyncSummary {
  return { processed: 0, skipped: 0, removed: 0, errors: [], aliases: 0, done: true, ...overrides };
}

describe("cron sync budget", () => {
  it("gives every source a slice before spending leftover time on unfinished ones", async () => {
    let clock = 1_000;
    const seen: string[] = [];
    const result = await runSyncJobs(
      [
        {
          key: "onedrive:user",
          run: async (deadline) => {
            seen.push(`drive@${deadline}`);
            clock += 100;
            return summary({ processed: 1, done: false });
          },
        },
        {
          key: "onenote:user",
          run: async (deadline) => {
            seen.push(`note@${deadline}`);
            clock += 100;
            return summary({ processed: 2, done: true });
          },
        },
      ],
      { budgetMs: 1_000, now: () => clock, marginMs: 50 }
    );

    assert.equal(seen[0].startsWith("drive@"), true);
    assert.equal(seen[1].startsWith("note@"), true);
    assert.equal(seen.filter((line) => line.startsWith("drive@")).length, 2);
    assert.equal(seen.filter((line) => line.startsWith("note@")).length, 1);
    assert.equal(result.results["onedrive:user"].processed, 2);
    assert.equal(result.results["onenote:user"].processed, 2);
    assert.equal(result.results["onedrive:user"].done, false);
    assert.equal(result.hasMore, true);
  });

  it("keeps going when one source throws", async () => {
    const result = await runSyncJobs(
      [
        {
          key: "google_drive:user",
          run: async () => {
            throw new Error("token refresh failed");
          },
        },
        {
          key: "onedrive:user",
          run: async () => summary({ processed: 4, done: true }),
        },
      ],
      { budgetMs: 5_000, now: () => 0, marginMs: 10 }
    );

    assert.equal(result.results["google_drive:user"].done, true);
    assert.match(result.results["google_drive:user"].errors[0], /token refresh failed/);
    assert.equal(result.results["onedrive:user"].processed, 4);
    assert.equal(result.hasMore, false);
  });

  it("reports work still open when the budget runs out before a later source", async () => {
    let clock = 0;
    const seen: string[] = [];
    const result = await runSyncJobs(
      [
        {
          key: "a",
          run: async () => {
            seen.push("a");
            clock = 1_000;
            return summary({ done: false, processed: 1 });
          },
        },
        {
          key: "b",
          run: async () => {
            seen.push("b");
            return summary({ done: true });
          },
        },
      ],
      { budgetMs: 1_000, now: () => clock, marginMs: 50 }
    );

    assert.deepEqual(seen, ["a"]);
    assert.equal(result.results.b.done, false);
    assert.equal(result.results.b.processed, 0);
    assert.equal(result.hasMore, true);
  });
});
