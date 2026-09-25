import { desc, eq } from "drizzle-orm";
import { auth } from "@/auth";
import { db } from "@/db";
import { documents, notes } from "@/db/schema";
import { ingestNote } from "@/lib/ingest";
import { resolveIncomingLinks, syncOutgoingLinks } from "@/lib/wikilinks";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) return Response.json({ error: "unauthorized" }, { status: 401 });

  const list = await db
    .select({ id: notes.id, title: notes.title, updatedAt: notes.updatedAt })
    .from(notes)
    .where(eq(notes.userId, session.user.id))
    .orderBy(desc(notes.updatedAt));

  return Response.json({ notes: list });
}

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) return Response.json({ error: "unauthorized" }, { status: 401 });

  const body = (await request.json().catch(() => ({}))) as { title?: string; content?: string };
  const title = body.title?.trim() || "Ohne Titel";
  const content = body.content ?? "";

  const [document] = await db
    .insert(documents)
    .values({ userId: session.user.id, kind: "note", title })
    .returning({ id: documents.id });

  await db.insert(notes).values({ id: document.id, userId: session.user.id, title, content });

  await ingestNote({ documentId: document.id, userId: session.user.id, title, content });
  await resolveIncomingLinks(document.id, session.user.id, title);
  await syncOutgoingLinks(document.id, session.user.id, content);

  return Response.json({ id: document.id, title, content });
}
