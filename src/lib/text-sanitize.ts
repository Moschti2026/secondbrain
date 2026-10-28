/**
 * Makes extracted text safe to store in Postgres and to send to Voyage.
 * Voyage rejects a body when the JSON string contains lone surrogates
 * ("input is encoded in valid UTF-8"). Pdf.js and some Office extracts
 * emit those, plus NULs and other C0 controls.
 */
export function sanitizeEmbeddingText(input: string): string {
  let out = "";
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);

    if (code >= 0xd800 && code <= 0xdbff) {
      const next = input.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += input[i] + input[i + 1];
        i++;
      }
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) continue;

    if (code === 0xfeff) continue;
    if (code === 0x09 || code === 0x0a || code === 0x0d) {
      out += input[i];
      continue;
    }
    if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) continue;
    if (code === 0xfffe || code === 0xffff) continue;

    out += input[i];
  }

  return out.normalize("NFC");
}
