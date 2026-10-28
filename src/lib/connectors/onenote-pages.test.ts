import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  initialOneNoteResume,
  initialSectionsUrl,
  isAllowedOneNoteListUrl,
  ONENOTE_CURSOR_PREFIX,
  readOneNoteCursor,
  sectionPagesUrl,
  walkOneNote,
  writeOneNoteCursor,
  type OneNoteResume,
} from "./onenote-pages";
import { syncMicrosoftAccount } from "./sync-control";
import type { SyncSummary } from "./types";

const empty = (done: boolean): SyncSummary => ({
  processed: 0,
  skipped: 0,
  removed: 0,
  errors: [],
  done,
});

function silenceConsoleError() {
  const original = console.error;
  const lines: string[] = [];
  console.error = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  return {
    lines,
    restore() {
      console.error = original;
    },
  };
}

describe("OneNote section listing", () => {
  it("starts from the sections collection and refuses the global pages collection", () => {
    const fresh = readOneNoteCursor(
      "https://graph.microsoft.com/v1.0/me/onenote/pages?$top=100&$expand=parentSection"
    );
    assert.equal(fresh.sectionsUrl, initialSectionsUrl());
    assert.deepEqual(fresh.pending, []);
    assert.equal(fresh.pagesUrl, null);
    assert.equal(isAllowedOneNoteListUrl(initialSectionsUrl()), true);
    assert.equal(isAllowedOneNoteListUrl(sectionPagesUrl("1-abc!def")), true);
    assert.equal(
      isAllowedOneNoteListUrl("https://graph.microsoft.com/v1.0/me/onenote/pages?$top=100"),
      false
    );
    assert.equal(
      isAllowedOneNoteListUrl(
        "https://graph.microsoft.com/v1.0/users/user-1/onenote/sections/sec/pages?$skiptoken=2"
      ),
      true
    );
    assert.equal(
      isAllowedOneNoteListUrl("https://graph.microsoft.com/v1.0/users/user-1/onenote/pages"),
      false
    );
    assert.match(sectionPagesUrl("a/b"), /\/sections\/a%2Fb\/pages\?/);
  });

  it("discards a resume that would call the global pages collection again", () => {
    const poisoned =
      ONENOTE_CURSOR_PREFIX +
      JSON.stringify({
        sectionsUrl: null,
        pending: [{ id: "s", displayName: "S" }],
        pagesUrl: "https://graph.microsoft.com/v1.0/me/onenote/pages?$skiptoken=1",
      });
    const resumed = readOneNoteCursor(poisoned);
    assert.equal(resumed.sectionsUrl, initialSectionsUrl());
    assert.deepEqual(resumed.pending, []);
  });

  it("round-trips a section resume and ignores a broken cursor", () => {
    const resume: OneNoteResume = {
      sectionsUrl: "https://graph.microsoft.com/v1.0/me/onenote/sections?$skiptoken=2",
      pending: [{ id: "sec!1", displayName: "Notizen" }],
      pagesUrl: sectionPagesUrl("sec!1"),
    };
    assert.deepEqual(readOneNoteCursor(writeOneNoteCursor(resume)), resume);
    assert.deepEqual(readOneNoteCursor(`${ONENOTE_CURSOR_PREFIX}{`), initialOneNoteResume());
  });

  it("lists pages per section, follows nextLink, and keeps going after a section error", async () => {
    const logs = silenceConsoleError();
    const sectionsNext = "https://graph.microsoft.com/v1.0/me/onenote/sections?$skiptoken=2";
    const goodNext = "https://graph.microsoft.com/v1.0/me/onenote/sections/good/pages?$skiptoken=2";
    const urls: string[] = [];
    const pages: string[] = [];
    const errors: string[] = [];

    try {
      const outcome = await walkOneNote(
        readOneNoteCursor("https://graph.microsoft.com/v1.0/me/onenote/pages?$top=100"),
        {
          fetchJson: async (url) => {
            urls.push(url);
            if (url === initialSectionsUrl()) {
              return {
                value: [
                  { id: "bad!", displayName: "Kaputt" },
                  { id: "first", displayName: "Erster" },
                ],
                "@odata.nextLink": sectionsNext,
              };
            }
            if (url === sectionsNext) return { value: [{ id: "good", displayName: "Gut" }] };
            if (url === sectionPagesUrl("bad!")) {
              throw new Error(
                'Microsoft Graph (OneNote) request failed: 400 {"error":{"code":"20266","message":"The number of maximum sections is exceeded"}}'
              );
            }
            if (url === sectionPagesUrl("first")) return { value: [{ id: "p-first", title: "Erste" }] };
            if (url === sectionPagesUrl("good")) {
              return { value: [{ id: "p1", title: "Seite 1" }], "@odata.nextLink": goodNext };
            }
            if (url === goodNext) return { value: [{ id: "p2", title: "Seite 2" }] };
            throw new Error(`unexpected ${url}`);
          },
          onPage: async (page) => {
            pages.push(page.id);
            if (page.id === "p1") throw new Error("ingest failed");
          },
          onError: (message) => errors.push(message),
          outOfTime: () => false,
        }
      );

      assert.equal(outcome.resume, null);
      assert.equal(outcome.incomplete, false);
      assert.deepEqual(pages, ["p-first", "p1", "p2"]);
      assert.equal(urls[0], initialSectionsUrl());
      assert.equal(
        urls.some((url) => /\/me\/onenote\/pages(\?|$)/.test(url)),
        false
      );
      assert.equal(errors.some((message) => message.includes("20266")), true);
      assert.equal(errors.some((message) => message.includes("ingest failed")), true);
      assert.equal(logs.lines.some((line) => line.includes("20266")), true);
      assert.equal(logs.lines.some((line) => /bearer|access_token/i.test(line)), false);
    } finally {
      logs.restore();
    }
  });

  it("stops on the time budget and resumes the same section page without refetching finished sections", async () => {
    const seen: string[] = [];
    const urls: string[] = [];
    let hits = 0;
    const first = await walkOneNote(initialOneNoteResume(), {
      fetchJson: async (url) => {
        urls.push(url);
        if (url === initialSectionsUrl()) {
          return {
            value: [
              { id: "a", displayName: "A" },
              { id: "b", displayName: "B" },
            ],
          };
        }
        if (url === sectionPagesUrl("a")) return { value: [{ id: "a1" }, { id: "a2" }] };
        if (url === sectionPagesUrl("b")) return { value: [{ id: "b1" }] };
        throw new Error(url);
      },
      onPage: async (page) => {
        seen.push(page.id);
        hits += 1;
      },
      onError: () => {},
      outOfTime: () => hits >= 1,
    });

    assert.equal(first.incomplete, true);
    assert.equal(first.resume?.pending[0]?.id, "a");
    assert.equal(first.resume?.pending[1]?.id, "b");
    assert.equal(first.resume?.pagesUrl, sectionPagesUrl("a"));
    assert.deepEqual(seen, ["a1"]);

    urls.length = 0;
    const second = await walkOneNote(readOneNoteCursor(writeOneNoteCursor(first.resume!)), {
      fetchJson: async (url) => {
        urls.push(url);
        if (url === sectionPagesUrl("a")) return { value: [{ id: "a1" }, { id: "a2" }] };
        if (url === sectionPagesUrl("b")) return { value: [{ id: "b1" }] };
        throw new Error(url);
      },
      onPage: async (page) => {
        seen.push(page.id);
      },
      onError: () => {},
      outOfTime: () => false,
    });

    assert.equal(second.resume, null);
    assert.equal(urls.includes(initialSectionsUrl()), false);
    assert.deepEqual(seen, ["a1", "a1", "a2", "b1"]);
  });

  it("keeps the sections resume when the section list fails and does not throw", async () => {
    const logs = silenceConsoleError();
    const urls: string[] = [];
    try {
      const outcome = await walkOneNote(initialOneNoteResume(), {
        fetchJson: async (url) => {
          urls.push(url);
          throw new Error('400 {"error":{"code":"20266"}}');
        },
        onPage: async () => {
          throw new Error("should not ingest");
        },
        onError: () => {},
        outOfTime: () => false,
      });
      assert.equal(outcome.incomplete, false);
      assert.equal(outcome.resume?.sectionsUrl, initialSectionsUrl());
      assert.deepEqual(urls, [initialSectionsUrl()]);
      assert.match(logs.lines.join("\n"), /20266/);
    } finally {
      logs.restore();
    }
  });

  it("reads a section name from the legacy name property", async () => {
    let name = "";
    await walkOneNote(initialOneNoteResume(), {
      fetchJson: async (url) => {
        if (url === initialSectionsUrl()) return { value: [{ id: "s", name: "Alt" }] };
        return { value: [{ id: "p", title: "T" }] };
      },
      onPage: async (_page, section) => {
        name = section.displayName;
      },
      onError: () => {},
      outOfTime: () => false,
    });
    assert.equal(name, "Alt");
  });
});

describe("Microsoft source isolation", () => {
  it("keeps OneDrive progress when a later OneDrive slice and OneNote both fail", async () => {
    const logs = silenceConsoleError();
    const order: string[] = [];
    try {
      const summary = await syncMicrosoftAccount(
        {
          onedrive: async () => {
            order.push("drive");
            if (order.filter((step) => step === "drive").length === 1) {
              return { processed: 4, skipped: 2, removed: 1, errors: [], done: false };
            }
            throw new Error("drive stopped");
          },
          onenote: async () => {
            order.push("note");
            throw new Error("code 20266 maximum sections");
          },
        },
        Date.now() + 10_000
      );

      assert.deepEqual(order, ["drive", "drive", "note"]);
      assert.equal(summary.processed, 4);
      assert.equal(summary.skipped, 2);
      assert.equal(summary.removed, 1);
      // The first OneDrive slice was not finished, so the merged run stays open
      // even though the failing slice itself stopped the retry loop.
      assert.equal(summary.done, false);
      assert.deepEqual(summary.errors, [
        "OneDrive: drive stopped",
        "OneNote: code 20266 maximum sections",
      ]);
      assert.equal(logs.lines.some((line) => /bearer|access_token/i.test(line)), false);
    } finally {
      logs.restore();
    }
  });

  it("still syncs OneNote when OneDrive throws, and OneDrive when OneNote throws", async () => {
    const logs = silenceConsoleError();
    try {
      const notesSurvive = await syncMicrosoftAccount({
        onedrive: async () => {
          throw new Error("onedrive down");
        },
        onenote: async () => ({ ...empty(true), processed: 3 }),
      });
      assert.equal(notesSurvive.processed, 3);
      assert.deepEqual(notesSurvive.errors, ["OneDrive: onedrive down"]);

      const filesSurvive = await syncMicrosoftAccount({
        onedrive: async () => ({ ...empty(true), processed: 5 }),
        onenote: async () => {
          throw new Error("20266");
        },
      });
      assert.equal(filesSurvive.processed, 5);
      assert.deepEqual(filesSurvive.errors, ["OneNote: 20266"]);
    } finally {
      logs.restore();
    }
  });
});
