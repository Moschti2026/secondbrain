import { resolveApiKey } from "@/lib/apikey";
import { askSecondbrain, searchSecondbrain } from "@/lib/ask";
import { listDocuments } from "@/lib/documents";
import { handleMcpHttp } from "@/lib/mcp-http";
import { buildSecondbrainMcpServer } from "@/lib/mcp-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Same ceiling as /api/chat: embedding + Claude can exceed the platform
// default. Hobby-plan functions are capped at 60s.
export const maxDuration = 60;

/**
 * Remote MCP server. The API key lives in the URL path
 * (`/api/mcp/<key>`) so existing clients keep working without OAuth —
 * including `npx mcp-remote <url> --transport http-only`. Treat that URL
 * like a password. The transport is stateless Streamable HTTP: one fresh
 * server per request, which is what a serverless host can actually run.
 */
async function handle(request: Request, { params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  const userId = await resolveApiKey(key);
  return handleMcpHttp(request, userId, () =>
    buildSecondbrainMcpServer({
      ask: async (question) => {
        const result = await askSecondbrain(userId!, question);
        return result;
      },
      search: async (query) => {
        const hits = await searchSecondbrain(userId!, query);
        return hits.map((hit) => ({
          documentId: hit.documentId,
          title: hit.title,
          url: hit.url,
          folderPath: hit.folderPath,
          snippet: hit.content,
          similarity: Number(hit.similarity),
        }));
      },
      list: async () => {
        const docs = await listDocuments(userId!);
        return docs.map((doc) => ({
          title: doc.title,
          folderPath: doc.folderPath,
          url: doc.webUrl,
        }));
      },
    })
  );
}

export const GET = handle;
export const POST = handle;
export const DELETE = handle;
export const OPTIONS = handle;
