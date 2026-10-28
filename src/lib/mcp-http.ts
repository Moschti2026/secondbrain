import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Accept, Authorization, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID, X-Api-Key",
  "Access-Control-Expose-Headers": "Mcp-Session-Id, MCP-Protocol-Version",
  "Access-Control-Max-Age": "86400",
};

function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(CORS_HEADERS)) headers.set(key, value);
  headers.set("Cache-Control", "no-store");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function jsonRpcError(status: number, code: number, message: string): Response {
  return withCors(
    Response.json(
      { jsonrpc: "2.0", error: { code, message }, id: null },
      { status, headers: status === 405 ? { Allow: "POST, DELETE, OPTIONS" } : undefined }
    )
  );
}

/**
 * Streamable HTTP clients must send Accept with both application/json and
 * text/event-stream. A few connectors send only one of them (or `* / *`).
 * Fill in the missing types so those clients are not rejected with 406,
 * without changing the body mcp-remote already sends.
 */
export function normalizeMcpRequest(request: Request): Request {
  if (request.method !== "POST") return request;

  const headers = new Headers(request.headers);
  const accept = headers.get("accept") ?? "";
  const acceptsJson = accept.includes("application/json") || accept.includes("*/*");
  const acceptsSse = accept.includes("text/event-stream") || accept.includes("*/*");
  if (!acceptsJson || !acceptsSse) {
    headers.set("accept", "application/json, text/event-stream");
  }
  if (!headers.get("content-type")) {
    headers.set("content-type", "application/json");
  }

  return new Request(request.url, {
    method: request.method,
    headers,
    body: request.body,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

/**
 * Stateless Streamable HTTP endpoint. GET returns 405 because this server
 * does not push a long-lived SSE stream (a serverless function cannot hold
 * one). The MCP spec and mcp-remote treat 405 on GET as "no server stream"
 * and continue with POST. DELETE ends a session; there is no session to
 * end, so 200 is enough for clients that send it on disconnect.
 */
export async function handleMcpHttp(
  request: Request,
  userId: string | null,
  createServer: () => McpServer
): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (!userId) {
    return jsonRpcError(401, -32001, "invalid or revoked API key");
  }

  if (request.method === "GET") {
    return jsonRpcError(405, -32000, "Method not allowed.");
  }

  if (request.method !== "POST" && request.method !== "DELETE") {
    return jsonRpcError(405, -32000, "Method not allowed.");
  }

  const server = createServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  await server.connect(transport);
  const response = await transport.handleRequest(normalizeMcpRequest(request));
  return withCors(response);
}
