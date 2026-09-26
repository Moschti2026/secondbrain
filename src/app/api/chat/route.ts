import { resolveUserId } from "@/lib/request-auth";
import { askSecondbrain } from "@/lib/ask";

export const runtime = "nodejs";

/**
 * Used by the browser chat UI (session cookie), and by external assistants
 * (ChatGPT Custom GPT Action, or any REST caller) via an API key — see
 * src/lib/request-auth.ts for the accepted auth methods.
 */
export async function POST(request: Request) {
  const userId = await resolveUserId(request);
  if (!userId) return Response.json({ error: "unauthorized" }, { status: 401 });

  const body = (await request.json().catch(() => ({}))) as { question?: string };
  const question = body.question?.trim();
  if (!question) return Response.json({ error: "missing question" }, { status: 400 });

  const result = await askSecondbrain(userId, question);
  return Response.json(result);
}
