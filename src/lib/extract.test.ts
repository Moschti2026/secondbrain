import assert from "node:assert/strict";
import { describe, it } from "node:test";
import JSZip from "jszip";
import { extractText } from "./extract";

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

function minimalPdf(text: string): Buffer {
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Count 1 /Kids [3 0 R] >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n",
    "",
    "5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
  ];
  const stream = `BT /F1 24 Tf 40 80 Td (${text}) Tj ET`;
  objects[3] = `4 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\n`;

  let body = "%PDF-1.4\n";
  const offsets = [0];
  for (const object of objects) {
    offsets.push(Buffer.byteLength(body));
    body += object;
  }
  const xrefAt = Buffer.byteLength(body);
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i++) {
    xref += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  const trailer = `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.from(body + xref + trailer);
}

async function minimalDocx(text: string): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`
  );
  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body>
</w:document>`
  );
  return Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));
}

describe("extractText", () => {
  it("reads text, markdown and html, including charset parameters and empty files", async () => {
    assert.equal(await extractText(Buffer.from("hello"), "text/plain; charset=utf-8"), "hello");
    assert.equal(await extractText(Buffer.from("# Titel"), "text/markdown"), "# Titel");
    assert.equal(await extractText(Buffer.from("<p>Hallo</p><br><b>Welt</b>"), "text/html"), "Hallo\n\nWelt");
    assert.equal(await extractText(Buffer.alloc(0), "text/plain"), "");
    assert.equal(await extractText(Buffer.from("notizen"), "application/octet-stream", "notiz.md"), "notizen");
  });

  it("extracts a real PDF and a real DOCX", async () => {
    const pdf = await extractText(minimalPdf("HelloPDF"), "application/pdf", "scan.pdf");
    assert.match(pdf ?? "", /HelloPDF/);

    const docx = await extractText(await minimalDocx("Hallo Word"), DOCX, "brief.docx");
    assert.match(docx ?? "", /Hallo Word/);
  });

  it("does not treat an HTML error page or a non-zip as a Word file", async () => {
    await assert.rejects(
      () =>
        extractText(
          Buffer.from("<!DOCTYPE html><html><title>Google Drive</title><a href='https://accounts.google.com'>"),
          DOCX,
          "kaputt.docx"
        ),
      /HTML/
    );
    await assert.rejects(
      () => extractText(Buffer.from("das ist kein zip"), DOCX, "kaputt.docx"),
      /ZIP/
    );
  });

  it("rejects a PDF download that is actually HTML", async () => {
    await assert.rejects(
      () => extractText(Buffer.from("<html><body>error</body></html>"), "application/pdf", "a.pdf"),
      /HTML/
    );
  });

  it("returns null for images instead of indexing them", async () => {
    assert.equal(await extractText(Buffer.from([0xff, 0xd8, 0xff, 0]), "image/jpeg", "a.jpg"), null);
  });
});
