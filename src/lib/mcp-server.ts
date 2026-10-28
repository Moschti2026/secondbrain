import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export interface McpSearchHit {
  documentId: string;
  title: string;
  url: string | null;
  folderPath: string | null;
  snippet: string;
  similarity: number;
}

export interface McpAskResult {
  answer: string;
  sources: {
    documentId: string;
    title: string;
    url: string | null;
    folderPath: string | null;
    similarity: number;
  }[];
}

export interface McpDocumentRow {
  title: string;
  folderPath: string | null;
  url: string | null;
}

export interface SecondbrainMcpDeps {
  ask: (question: string) => Promise<McpAskResult>;
  search: (query: string) => Promise<McpSearchHit[]>;
  list: () => Promise<McpDocumentRow[]>;
}

const searchHitSchema = z.object({
  documentId: z.string(),
  title: z.string(),
  url: z.string().nullable(),
  folderPath: z.string().nullable(),
  snippet: z.string(),
  similarity: z.number(),
});

function formatSourceLine(
  source: { title: string; url: string | null; folderPath: string | null },
  index: number
): string {
  const folder = source.folderPath ? `Folder: ${source.folderPath}\n` : "";
  const link = source.url ?? "(no link)";
  return `[${index}] Title: ${source.title}\n${folder}Link: ${link}`;
}

function formatHit(hit: McpSearchHit, index: number): string {
  return `${formatSourceLine(hit, index)}\nSnippet: ${hit.snippet}`;
}

/**
 * Stateless MCP tool surface. Tool names are part of the contract for
 * already-connected clients (mcp-remote, Claude, Cursor, Langdock).
 */
export function buildSecondbrainMcpServer(deps: SecondbrainMcpDeps): McpServer {
  const server = new McpServer({ name: "secondbrain", version: "1.1.0" });
  const readOnly = { readOnlyHint: true, openWorldHint: true } as const;

  server.registerTool(
    "ask_secondbrain",
    {
      title: "Ask Secondbrain",
      description:
        "Ask a question over the user's own indexed data (Google Drive, OneDrive, local files and Obsidian notes). Returns a synthesized answer plus citations. Each source includes the document title, source link, and the passage used.",
      inputSchema: { question: z.string().describe("The question to ask") },
      outputSchema: {
        answer: z.string(),
        sources: z.array(
          z.object({
            documentId: z.string(),
            title: z.string(),
            url: z.string().nullable(),
            folderPath: z.string().nullable(),
            similarity: z.number(),
          })
        ),
      },
      annotations: readOnly,
    },
    async ({ question }) => {
      const { answer, sources } = await deps.ask(question);
      const citations = sources.map((source, i) => formatSourceLine(source, i + 1)).join("\n");
      const text = citations ? `${answer}\n\nSources:\n${citations}` : answer;
      return {
        content: [{ type: "text", text }],
        structuredContent: { answer, sources },
      };
    }
  );

  server.registerTool(
    "search_secondbrain",
    {
      title: "Search Secondbrain",
      description:
        "Semantic search over the user's own indexed data. Each result includes the document title, source link, and a text snippet so the caller can cite the file directly. Does not synthesize an answer.",
      inputSchema: { query: z.string().describe("Search query") },
      outputSchema: { results: z.array(searchHitSchema) },
      annotations: readOnly,
    },
    async ({ query }) => {
      const results = await deps.search(query);
      if (results.length === 0) {
        return {
          content: [{ type: "text", text: "No matching documents." }],
          structuredContent: { results: [] },
        };
      }
      const text = results.map((hit, i) => formatHit(hit, i + 1)).join("\n\n---\n\n");
      return {
        content: [{ type: "text", text }],
        structuredContent: { results },
      };
    }
  );

  server.registerTool(
    "list_documents",
    {
      title: "List Secondbrain Documents",
      description:
        "Lists every indexed document with its title, folder path, and source link (for example 'Google Drive/Notizen/179.md'). Use this for structural questions about what folders or files exist. ask_secondbrain and search_secondbrain match on content only.",
      inputSchema: {},
      outputSchema: {
        documents: z.array(
          z.object({
            title: z.string(),
            folderPath: z.string().nullable(),
            url: z.string().nullable(),
          })
        ),
      },
      annotations: readOnly,
    },
    async () => {
      const docs = await deps.list();
      if (docs.length === 0) {
        return {
          content: [{ type: "text", text: "No documents indexed." }],
          structuredContent: { documents: [] },
        };
      }
      const text = docs
        .map((doc) => {
          const folder = doc.folderPath ?? "Unknown";
          const link = doc.url ? `\nLink: ${doc.url}` : "";
          return `Title: ${doc.title}\nFolder: ${folder}${link}`;
        })
        .join("\n\n");
      return {
        content: [{ type: "text", text }],
        structuredContent: { documents: docs },
      };
    }
  );

  return server;
}
