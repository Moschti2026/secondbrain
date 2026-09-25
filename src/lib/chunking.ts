export interface Chunk {
  ordinal: number;
  content: string;
}

const DEFAULT_CHUNK_SIZE = 1800; // characters, ~ 400-500 tokens
const DEFAULT_OVERLAP = 200;

/**
 * Splits text into overlapping chunks along paragraph boundaries where
 * possible, falling back to a hard character cut for paragraphs longer than
 * the chunk size. Overlap keeps context from being lost right at a chunk
 * boundary, which matters for retrieval quality more than exact token
 * budgeting does at this scale.
 */
export function chunkText(
  text: string,
  options: { chunkSize?: number; overlap?: number } = {}
): Chunk[] {
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const overlap = options.overlap ?? DEFAULT_OVERLAP;

  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) return [];

  const paragraphs = normalized.split(/\n{2,}/).filter((p) => p.trim());

  const chunks: string[] = [];
  let current = "";

  for (const paragraph of paragraphs) {
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;

    if (candidate.length <= chunkSize) {
      current = candidate;
      continue;
    }

    if (current) {
      chunks.push(current);
      current = current.slice(Math.max(0, current.length - overlap));
      current = current ? `${current}\n\n${paragraph}` : paragraph;
    } else {
      current = paragraph;
    }

    // A single paragraph longer than chunkSize: hard-split it.
    while (current.length > chunkSize) {
      chunks.push(current.slice(0, chunkSize));
      current = current.slice(chunkSize - overlap);
    }
  }

  if (current.trim()) chunks.push(current);

  return chunks.map((content, ordinal) => ({ ordinal, content: content.trim() }));
}
