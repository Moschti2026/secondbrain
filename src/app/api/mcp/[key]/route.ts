import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { resolveApiKey } from "@/lib/apikey";
import { askSecondbrain, searchSecondbrain } from "@/lib/ask";
import { listDocuments } from "@/lib/documents";

export const runtime = "nodejs";

/**
 * Remote MCP server for Claude.ai / Langdock custom connectors. The API
 * key lives in the URL path (rather than a header) so this works without
 * relying on Claude's request-headers beta feature or setting up OAuth —
 * the connector URL itself, e.g. https://<domain>/api/mcp/sb_xxx, is the
 * credential. Treat that URL like a password.
 */
function buildServer(userId: string) {
  const server = new McpServer({ name: "secondbrain", version: "1.0.0" });

  server.registerTool(
    "ask_secondbrain",
    {
      title: "Ask Secondbrain",
      description:
        "Ask a question over the user's own indexed data (Google Drive, Microsoft 365/SharePoint, local files and Obsidian notes). Returns a synthesized answer with citations.",
      inputSchema: { question: z.string().describe("The question to ask") },
    },
    async ({ question }) => {
      const { answer, sources } = await askSecondbrain(userId, question);
      const citations = sources
        .map((s, i) => `[${i + 1}] ${s.title}${s.url ? ` — ${s.url}` : ""}`)
        .join("\n");
      return {
        content: [{ type: "text", text: citations ? `${answer}\n\nQuellen:\n${citations}` : answer }],
      };
    }
  );

  server.registerTool(
    "search_secondbrain",
    {
      title: "Search Secondbrain",
      description:
        "Full-text/semantic search over the user's own indexed data. Returns raw matching passages with their source, for the caller to reason over directly instead of using Secondbrain's own synthesized answer.",
      inputSchema: { query: z.string().describe("Search query") },
    },
    async ({ query }) => {
      const results = await searchSecondbrain(userId, query);
      if (results.length === 0) {
        return { content: [{ type: "text", text: "Keine passenden Ergebnisse gefunden." }] };
      }
      const text = results
        .map(
          (r, i) =>
            `[${i + 1}] ${r.title}${r.url ? ` — ${r.url}` : ""} (Relevanz: ${r.similarity.toFixed(2)})\n${r.content}`
        )
        .join("\n\n---\n\n");
      return { content: [{ type: "text", text }] };
    }
  );

  server.registerTool(
    "list_documents",
    {
      title: "List Secondbrain Documents",
      description:
        "Lists every indexed document with its folder path (e.g. 'Google Drive/Projekte/Vertrag.pdf'). Use this for structural questions about what folders or files exist — 'ask_secondbrain'/'search_secondbrain' only match on content, so they can't answer that.",
      inputSchema: {},
    },
    async () => {
      const docs = await listDocuments(userId);
      if (docs.length === 0) {
        return { content: [{ type: "text", text: "Keine Dokumente indexiert." }] };
      }
      const text = docs
        .map((d) => `${d.folderPath ?? "Unbekannt"}/${d.title}${d.webUrl ? ` — ${d.webUrl}` : ""}`)
        .join("\n");
      return { content: [{ type: "text", text }] };
    }
  );

  return server;
}

async function handle(request: Request, { params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  const userId = await resolveApiKey(key);
  if (!userId) {
    return Response.json(
      { jsonrpc: "2.0", error: { code: -32001, message: "invalid or revoked API key" }, id: null },
      { status: 401 }
    );
  }

  const server = buildServer(userId);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  return transport.handleRequest(request);
}

export const GET = handle;
export const POST = handle;
export const DELETE = handle;
