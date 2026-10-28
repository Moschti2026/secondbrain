const VOYAGE_API_URL = "https://api.voyageai.com/v1/embeddings";
const MODEL = "voyage-3";
const MAX_ATTEMPTS = 5;
const MAX_BACKOFF_MS = 12_000;

interface VoyageResponse {
  data: { embedding: number[]; index: number }[];
}

/** Voyage answered 429 (or a transient 503) even after backoff. Callers
 * should pause the sync slice and retry the document later. */
export class EmbeddingRateLimitError extends Error {
  readonly retryAfterMs: number;

  constructor(retryAfterMs: number, detail: string) {
    super(`Voyage embeddings rate limited: ${detail}`.slice(0, 500));
    this.name = "EmbeddingRateLimitError";
    this.retryAfterMs = retryAfterMs;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffMs(attempt: number, retryAfterHeader: string | null): number {
  if (retryAfterHeader) {
    const seconds = Number(retryAfterHeader);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(Math.max(seconds * 1000, 500), MAX_BACKOFF_MS);
    }
    const when = Date.parse(retryAfterHeader);
    if (!Number.isNaN(when)) {
      return Math.min(Math.max(when - Date.now(), 500), MAX_BACKOFF_MS);
    }
  }
  return Math.min(1000 * 2 ** attempt, MAX_BACKOFF_MS);
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 503;
}

async function embed(
  texts: string[],
  inputType: "document" | "query"
): Promise<number[][]> {
  if (texts.length === 0) return [];
  if (!process.env.VOYAGE_API_KEY) {
    throw new Error("VOYAGE_API_KEY is not set. See .env.example.");
  }

  let lastDetail = "request failed";
  let lastWait = MAX_BACKOFF_MS;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const res = await fetch(VOYAGE_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.VOYAGE_API_KEY}`,
      },
      body: JSON.stringify({ input: texts, model: MODEL, input_type: inputType }),
    });

    if (res.ok) {
      const body = (await res.json()) as VoyageResponse;
      return body.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
    }

    const detail = `${res.status} ${(await res.text()).slice(0, 300)}`;
    lastDetail = detail;
    if (!isRetryableStatus(res.status) || attempt === MAX_ATTEMPTS - 1) {
      if (isRetryableStatus(res.status)) {
        throw new EmbeddingRateLimitError(lastWait, detail);
      }
      throw new Error(`Voyage embeddings request failed: ${detail}`);
    }

    lastWait = backoffMs(attempt, res.headers.get("retry-after"));
    await sleep(lastWait);
  }

  throw new EmbeddingRateLimitError(lastWait, lastDetail);
}

/** Embed chunk text for storage/indexing. */
export function embedDocuments(texts: string[]): Promise<number[][]> {
  return embed(texts, "document");
}

/** Embed a user's search/chat question. Voyage tunes this differently from
 * document embeddings, which measurably improves retrieval quality. */
export async function embedQuery(text: string): Promise<number[]> {
  const [vector] = await embed([text], "query");
  return vector;
}
