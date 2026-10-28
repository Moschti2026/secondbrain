import { sanitizeEmbeddingText } from "@/lib/text-sanitize";

const VOYAGE_API_URL = "https://api.voyageai.com/v1/embeddings";
const MODEL = "voyage-3";
const MAX_ATTEMPTS = 5;
const MAX_BACKOFF_MS = 12_000;
const REQUEST_TIMEOUT_MS = 20_000;

interface VoyageResponse {
  data: { embedding: number[]; index: number }[];
}

/** The sync slice has no time left for another embedding request. Callers
 * should persist the cursor and continue on the next invocation. This is
 * not a Voyage failure and must not consume an index attempt. */
export class EmbeddingBudgetError extends Error {
  constructor() {
    super("Zeitbudget erreicht, Embedding wird beim nächsten Lauf fortgesetzt.");
    this.name = "EmbeddingBudgetError";
  }
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

function assertBudget(deadline?: number) {
  if (deadline !== undefined && Date.now() >= deadline - 5_000) {
    throw new EmbeddingBudgetError();
  }
}

async function embed(
  texts: string[],
  inputType: "document" | "query",
  deadline?: number
): Promise<number[][]> {
  const clean = texts.map((text) => sanitizeEmbeddingText(text));
  if (clean.length === 0) return [];
  if (!process.env.VOYAGE_API_KEY) {
    throw new Error("VOYAGE_API_KEY is not set. See .env.example.");
  }

  let lastDetail = "request failed";
  let lastWait = MAX_BACKOFF_MS;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    assertBudget(deadline);
    const remaining = deadline === undefined ? REQUEST_TIMEOUT_MS : deadline - Date.now() - 5_000;
    const timeout = Math.min(REQUEST_TIMEOUT_MS, Math.max(1_000, remaining));

    let res: Response;
    try {
      res = await fetch(VOYAGE_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.VOYAGE_API_KEY}`,
        },
        body: JSON.stringify({ input: clean, model: MODEL, input_type: inputType }),
        signal: AbortSignal.timeout(timeout),
      });
    } catch (err) {
      assertBudget(deadline);
      if (attempt === MAX_ATTEMPTS - 1) {
        throw new Error(`Voyage embeddings request failed: ${(err as Error).message}`);
      }
      lastWait = backoffMs(attempt, null);
      await sleep(lastWait);
      continue;
    }

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

/** Embed chunk text for storage/indexing. `deadline` is an absolute
 * timestamp; when it is close, the call stops instead of running into the
 * platform timeout. */
export function embedDocuments(texts: string[], deadline?: number): Promise<number[][]> {
  return embed(texts, "document", deadline);
}

/** Embed a user's search/chat question. Voyage tunes this differently from
 * document embeddings, which measurably improves retrieval quality. */
export async function embedQuery(text: string): Promise<number[]> {
  const [vector] = await embed([text], "query");
  return vector;
}
