/**
 * Proves the Streamable HTTP endpoint speaks the dialect mcp-remote uses
 * with `--transport http-only`: initialize, tools/list, and tools/call,
 * with the API key in the URL path and no OAuth.
 *
 * Usage: npx tsx scripts/verify-mcp-remote.ts
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { handleMcpHttp } from "../src/lib/mcp-http";
import { buildSecondbrainMcpServer } from "../src/lib/mcp-server";

const KEY = "sb_verify_key_not_a_secret";

function stubServer() {
  return buildSecondbrainMcpServer({
    ask: async () => ({
      answer: "Die Notiz 179 steht im Export.",
      sources: [
        {
          documentId: "doc-179",
          title: "179.md",
          url: "https://drive.example/179",
          folderPath: "Google Drive/Exporte",
          similarity: 0.91,
        },
      ],
    }),
    search: async () => [
      {
        documentId: "doc-179",
        title: "179.md",
        url: "https://drive.example/179",
        folderPath: "Google Drive/Exporte",
        snippet: "Export aus Claude, Abschnitt zum Projekt.",
        similarity: 0.91,
      },
    ],
    list: async () => [
      { title: "179.md", folderPath: "Google Drive/Exporte", url: "https://drive.example/179" },
    ],
  });
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function send(res: ServerResponse, response: Response) {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => {
    if (key.toLowerCase() === "transfer-encoding") return;
    res.setHeader(key, value);
  });
  if (!response.body) {
    res.end();
    return;
  }
  await new Promise<void>((resolve, reject) => {
    Readable.fromWeb(response.body as import("node:stream/web").ReadableStream).pipe(res);
    res.on("finish", () => resolve());
    res.on("error", reject);
  });
}

async function main() {
  const server = createServer(async (req, res) => {
    try {
      const host = req.headers.host ?? "127.0.0.1";
      const url = `http://${host}${req.url ?? "/"}`;
      const body = await readBody(req);
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (value == null) continue;
        headers.set(key, Array.isArray(value) ? value.join(", ") : value);
      }
      const method = req.method ?? "GET";
      const request = new Request(url, {
        method,
        headers,
        body:
          method === "GET" || method === "HEAD" || method === "DELETE" ? undefined : new Uint8Array(body),
      });
      const key = new URL(url).pathname.split("/").filter(Boolean).pop() ?? "";
      const userId = key.startsWith("sb_") ? "user-verify" : null;
      const response = await handleMcpHttp(request, userId, stubServer);
      await send(res, response);
    } catch (err) {
      res.statusCode = 500;
      res.end((err as Error).stack ?? String(err));
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  const base = `http://127.0.0.1:${address.port}/api/mcp/${KEY}`;

  const report: Record<string, unknown> = {};
  try {
    const options = await fetch(base, { method: "OPTIONS" });
    report.options = {
      status: options.status,
      allowOrigin: options.headers.get("access-control-allow-origin"),
      allowMethods: options.headers.get("access-control-allow-methods"),
    };
    if (options.status !== 204) throw new Error(`OPTIONS expected 204, got ${options.status}`);

    const get = await fetch(base, { headers: { Accept: "text/event-stream" } });
    report.get = { status: get.status };
    if (get.status !== 405) throw new Error(`GET expected 405, got ${get.status}`);
    await get.body?.cancel();

    const initBody = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "verify-direct", version: "0.0.1" },
      },
    };
    const init = await fetch(base, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(initBody),
    });
    const initText = await init.text();
    report.initializeDirect = { status: init.status, contentType: init.headers.get("content-type"), body: initText.slice(0, 500) };
    if (!init.ok) throw new Error(`initialize failed: ${init.status} ${initText}`);
    if (!initText.includes("secondbrain")) throw new Error("initialize response missing server name");
    if (!initText.includes("protocolVersion")) throw new Error("initialize response missing protocolVersion");

    const client = new Client({ name: "secondbrain-mcp-remote-verify", version: "1.0.0" });
    const transport = new StdioClientTransport({
      command: "npx",
      args: ["-y", "mcp-remote", base, "--transport", "http-only"],
      stderr: "pipe",
    });
    await client.connect(transport);
    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name).sort();
    report.toolsList = names;
    for (const required of ["ask_secondbrain", "search_secondbrain", "list_documents"]) {
      if (!names.includes(required)) throw new Error(`tools/list missing ${required}`);
    }

    const called = await client.callTool({
      name: "search_secondbrain",
      arguments: { query: "179.md" },
    });
    const text = Array.isArray(called.content)
      ? called.content.map((block) => ("text" in block ? block.text : "")).join("\n")
      : "";
    report.toolsCall = {
      isError: called.isError ?? false,
      text: text.slice(0, 500),
      hasStructured: called.structuredContent != null,
    };
    if (called.isError) throw new Error(`tools/call failed: ${text}`);
    for (const part of ["Title: 179.md", "Link: https://drive.example/179", "Snippet:"]) {
      if (!text.includes(part)) throw new Error(`tools/call text missing ${part}: ${text}`);
    }

    await client.close();
    report.ok = true;
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
