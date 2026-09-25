import { auth } from "@/auth";
import { resolveApiKey } from "@/lib/apikey";

/** Resolves the acting user for API routes that accept either a browser
 * session (cookie) or a local-sync CLI request (x-api-key header). */
export async function resolveUserId(request: Request): Promise<string | null> {
  const apiKey = request.headers.get("x-api-key");
  if (apiKey) return resolveApiKey(apiKey);

  const session = await auth();
  return session?.user?.id ?? null;
}
