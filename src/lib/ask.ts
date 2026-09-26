import { cosineDistance, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { chunks, documents } from "@/db/schema";
import { embedQuery } from "@/lib/embeddings";
import { answerWithCitations } from "@/lib/llm";

const MIN_SIMILARITY = 0.3;
const TOP_K = 8;

export interface Source {
  documentId: string;
  title: string;
  url: string | null;
  similarity: number;
}

async function retrieve(userId: string, query: string): Promise<
  (Source & { content: string })[]
> {
  const queryVector = await embedQuery(query);
  const similarity = sql<number>`1 - (${cosineDistance(chunks.embedding, queryVector)})`;

  const results = await db
    .select({
      content: chunks.content,
      documentId: documents.id,
      title: documents.title,
      url: documents.webUrl,
      similarity,
    })
    .from(chunks)
    .innerJoin(documents, eq(chunks.documentId, documents.id))
    .where(eq(chunks.userId, userId))
    .orderBy(desc(similarity))
    .limit(TOP_K);

  return results.filter((r) => r.similarity >= MIN_SIMILARITY);
}

/**
 * Full RAG answer: retrieve relevant chunks, ask Claude to answer with
 * citations. Shared by the browser chat UI, the ChatGPT Action, and the
 * `ask_secondbrain` MCP tool so all three give the same answer.
 */
export async function askSecondbrain(
  userId: string,
  question: string
): Promise<{ answer: string; sources: Source[] }> {
  const relevant = await retrieve(userId, question);

  const answer = await answerWithCitations(
    question,
    relevant.map((r) => ({ documentTitle: r.title, documentWebUrl: r.url, content: r.content }))
  );

  return {
    answer,
    sources: relevant.map((r) => ({
      documentId: r.documentId,
      title: r.title,
      url: r.url,
      similarity: r.similarity,
    })),
  };
}

/**
 * Raw retrieval without LLM synthesis, for callers (e.g. the
 * `search_secondbrain` MCP tool) that want to do their own reasoning over
 * the source text instead of Secondbrain's own summary.
 */
export async function searchSecondbrain(
  userId: string,
  query: string
): Promise<(Source & { content: string })[]> {
  return retrieve(userId, query);
}
