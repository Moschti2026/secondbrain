import crypto from "node:crypto";
import { resolveUserId } from "@/lib/request-auth";
import { ingestFile } from "@/lib/ingest";

export const runtime = "nodejs";

/**
 * Shared upload endpoint for both the local-sync CLI (x-api-key header,
 * sends `localPath` so re-uploads of the same file update one document)
 * and the manual "upload a file" button in the settings UI (session
 * cookie, no localPath).
 */
export async function POST(request: Request) {
  const userId = await resolveUserId(request);
  if (!userId) return Response.json({ error: "unauthorized" }, { status: 401 });

  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    return Response.json({ error: "missing file field" }, { status: 400 });
  }

  const localPath = (form.get("localPath") as string | null) ?? `manual-upload/${crypto.randomUUID()}-${file.name}`;
  const title = (form.get("title") as string | null) ?? file.name;
  const buffer = Buffer.from(await file.arrayBuffer());

  try {
    const result = await ingestFile({
      userId,
      kind: "local",
      localPath,
      title,
      mimeType: file.type || null,
      sourceUpdatedAt: new Date(),
      buffer,
    });
    return Response.json(result);
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 500 });
  }
}
