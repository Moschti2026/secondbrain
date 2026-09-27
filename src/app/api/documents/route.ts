import { resolveUserId } from "@/lib/request-auth";
import { listDocuments } from "@/lib/documents";

export const runtime = "nodejs";

/**
 * Structural listing of every indexed document and its folder path — for
 * "what folders/files do I have" questions, which /api/chat's semantic
 * search can't answer (there's no content to match against). Used by the
 * "Dokumente" page and available to external tools (ChatGPT Action) via
 * the same x-api-key/Bearer auth as /api/chat.
 */
export async function GET(request: Request) {
  const userId = await resolveUserId(request);
  if (!userId) return Response.json({ error: "unauthorized" }, { status: 401 });

  const documents = await listDocuments(userId);
  return Response.json({ documents });
}
