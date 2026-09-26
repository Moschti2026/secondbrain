import { auth } from "@/auth";
import { resolveApiKey } from "@/lib/apikey";

function extractApiKey(request: Request): string | null {
  const direct = request.headers.get("x-api-key");
  if (direct) return direct;

  // ChatGPT Custom GPT Actions and some MCP clients send the key as a
  // bearer token instead of a custom header.
  const authHeader = request.headers.get("authorization");
  if (authHeader?.startsWith("Bearer ")) return authHeader.slice("Bearer ".length).trim();

  return null;
}

/** Resolves the acting user for API routes that accept a browser session
 * (cookie), or an API key from the local-sync CLI, a ChatGPT Action, or
 * another external caller (x-api-key header, or Authorization: Bearer). */
export async function resolveUserId(request: Request): Promise<string | null> {
  const apiKey = extractApiKey(request);
  if (apiKey) return resolveApiKey(apiKey);

  const session = await auth();
  return session?.user?.id ?? null;
}
