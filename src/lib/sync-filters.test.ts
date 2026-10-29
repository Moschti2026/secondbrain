import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  encodeDrivePageToken,
  isInvalidDrivePageToken,
  readDriveCursor,
  writeDriveChangesCursor,
} from "./drive-cursor";
import { unwrapOneDriveCursor, wrapOneDriveCursor } from "./graph-cursor";
import {
  isIgnoredVaultPath,
  isIngestableMime,
  isOfficeTempOrLockFile,
  resolveIngestMimeType,
  shouldSkipForSize,
} from "./sync-filters";

describe("drive page tokens", () => {
  it("encodes the characters that make Drive return 400 Invalid Value", () => {
    const token = "~!!~abc+def/ghi=";
    const encoded = encodeDrivePageToken(token);
    assert.equal(encoded.includes("="), false);
    assert.equal(encoded.includes("+"), false);
    assert.equal(encoded.includes("/"), false);
    assert.equal(encoded.includes("!"), false);
    assert.match(encoded, /%7E%21%21%7Eabc%2Bdef%2Fghi%3D/);
  });

  it("detects an invalid pageToken response and ignores unrelated 400s", () => {
    const body = JSON.stringify({
      error: { errors: [{ message: "Invalid Value", location: "pageToken" }] },
    });
    assert.equal(isInvalidDrivePageToken(400, body), true);
    assert.equal(isInvalidDrivePageToken(410, "gone"), true);
    assert.equal(isInvalidDrivePageToken(400, JSON.stringify({ error: { message: "nope" } })), false);
  });

  it("treats a legacy changes cursor as a full walk and keeps versioned cursors", () => {
    assert.deepEqual(readDriveCursor(null), { phase: "backfill", pageToken: "" });
    assert.deepEqual(readDriveCursor("~!!~legacy="), { phase: "backfill", pageToken: "" });
    assert.deepEqual(readDriveCursor("backfill:page-1"), { phase: "backfill", pageToken: "page-1" });
    assert.deepEqual(readDriveCursor(writeDriveChangesCursor("tok")), {
      phase: "changes",
      pageToken: "tok",
    });
  });
});

describe("onedrive cursor", () => {
  it("discards a legacy delta link and round-trips a versioned one", () => {
    assert.equal(
      unwrapOneDriveCursor("https://graph.microsoft.com/v1.0/me/drive/root/delta?token=old"),
      null
    );
    const wrapped = wrapOneDriveCursor("https://graph.microsoft.com/v1.0/me/drive/root/delta?token=new");
    assert.equal(unwrapOneDriveCursor(wrapped), "https://graph.microsoft.com/v1.0/me/drive/root/delta?token=new");
  });
});

describe("markdown and vault filters", () => {
  it("ingests .md files whatever MIME Drive or OneDrive reports", () => {
    for (const mime of ["text/markdown", "text/x-markdown", "text/plain", "application/octet-stream", ""]) {
      assert.equal(resolveIngestMimeType("179.md", mime), "text/markdown");
      assert.equal(isIngestableMime(resolveIngestMimeType("452.markdown", mime)), true);
    }
  });

  it("trusts a known extension when the reported type is not indexable", () => {
    assert.equal(resolveIngestMimeType("scan.pdf", "application/x-pdf"), "application/pdf");
    assert.equal(resolveIngestMimeType("notiz.txt", "application/octet-stream"), "text/plain");
    assert.equal(resolveIngestMimeType("seite.html", ""), "text/html");
    assert.equal(
      resolveIngestMimeType("brief.docx", "application/octet-stream"),
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    );
    assert.equal(isIngestableMime("text/plain; charset=utf-8"), true);
    assert.equal(isIngestableMime("text/markdown"), true);
  });

  it("does not drop markdown because of the binary size cap", () => {
    assert.equal(shouldSkipForSize("179.md", 50 * 1024 * 1024, 20 * 1024 * 1024), false);
    assert.equal(shouldSkipForSize("scan.pdf", 50 * 1024 * 1024, 20 * 1024 * 1024), true);
  });

  it("skips Office lock and temp files and keeps real documents", () => {
    assert.equal(isOfficeTempOrLockFile("~$Interessenswecker_Unternehmer.docx"), true);
    assert.equal(isOfficeTempOrLockFile("~$budget.xlsx"), true);
    assert.equal(isOfficeTempOrLockFile("~$folie.pptx"), true);
    assert.equal(isOfficeTempOrLockFile("~WRL0001.tmp"), true);
    assert.equal(isOfficeTempOrLockFile("~wrld.TMP"), true);
    assert.equal(isOfficeTempOrLockFile("Google Drive/~$lock.docx"), true);
    assert.equal(isOfficeTempOrLockFile("Interessenswecker_Unternehmer.docx"), false);
    assert.equal(isOfficeTempOrLockFile("Interessenswecker_Unternehmer (1).docx"), false);
    assert.equal(isOfficeTempOrLockFile("notiz.md"), false);
    assert.equal(isOfficeTempOrLockFile("~notiz.md"), false);
    assert.equal(isOfficeTempOrLockFile("bericht.tmp"), false);
  });

  it("skips Obsidian config and git internals but keeps notes in every other folder", () => {
    assert.equal(isIgnoredVaultPath("Google Drive/Vault/.obsidian", "workspace.json"), true);
    assert.equal(isIgnoredVaultPath("OneDrive/Vault/.git/objects", "ab"), true);
    assert.equal(isIgnoredVaultPath("Google Drive/Exporte", "179.md"), false);
    assert.equal(isIgnoredVaultPath("OneDrive/Notizen/Unterordner", "452.md"), false);
    assert.equal(isIgnoredVaultPath("Google Drive", "179.md"), false);
  });
});
