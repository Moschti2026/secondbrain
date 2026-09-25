import { cosineDistance, desc, eq, sql } from "drizzle-orm";
import { auth } from "@/auth";
import { db } from "@/db";
import { chunks, documents } from "@/db/schema";
import { embedQuery } from "@/lib/embeddings";
import { answerWithCitations } from "@/lib/llm";

export const runtime = "nodejs";

const MIN_SIMILARITY = 0.3;
const TOP_K = 8;

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) return Response.json({ error: "unauthorized" }, { status: 401 });

  const body = (await request.json().catch(() => ({}))) as { question?: string };
  const question = body.question?.trim();
  if (!question) return Response.json({ error: "missing question" }, { status: 400 });

  const queryVector = await embedQuery(question);
  const similarity = sql<number>`1 - (${cosineDistance(chunks.embedding, queryVector)})`;

  const results = await db
    .select({
      content: chunks.content,
      documentId: documents.id,
      documentTitle: documents.title,
      documentWebUrl: documents.webUrl,
      similarity,
    })
    .from(chunks)
    .innerJoin(documents, eq(chunks.documentId, documents.id))
    .where(eq(chunks.userId, session.user.id))
    .orderBy(desc(similarity))
    .limit(TOP_K);

  const relevant = results.filter((r) => r.similarity >= MIN_SIMILARITY);

  const answer = await answerWithCitations(
    question,
    relevant.map((r) => ({
      documentTitle: r.documentTitle,
      documentWebUrl: r.documentWebUrl,
      content: r.content,
    }))
  );

  return Response.json({
    answer,
    sources: relevant.map((r) => ({
      documentId: r.documentId,
      title: r.documentTitle,
      url: r.documentWebUrl,
      similarity: r.similarity,
    })),
  });
}
