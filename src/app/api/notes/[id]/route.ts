import { and, eq } from "drizzle-orm";
import { auth } from "@/auth";
import { db } from "@/db";
import { documents, noteLinks, notes } from "@/db/schema";
import { ingestNote } from "@/lib/ingest";
import { resolveIncomingLinks, syncOutgoingLinks } from "@/lib/wikilinks";

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) return Response.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;

  const [note] = await db
    .select()
    .from(notes)
    .where(and(eq(notes.id, id), eq(notes.userId, session.user.id)));
  if (!note) return Response.json({ error: "not found" }, { status: 404 });

  const backlinks = await db
    .select({ id: notes.id, title: notes.title })
    .from(noteLinks)
    .innerJoin(notes, eq(noteLinks.sourceNoteId, notes.id))
    .where(eq(noteLinks.targetNoteId, id));

  return Response.json({ ...note, backlinks });
}

export async function PUT(request: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) return Response.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;

  const [existing] = await db
    .select()
    .from(notes)
    .where(and(eq(notes.id, id), eq(notes.userId, session.user.id)));
  if (!existing) return Response.json({ error: "not found" }, { status: 404 });

  const body = (await request.json().catch(() => ({}))) as { title?: string; content?: string };
  const title = body.title?.trim() || existing.title;
  const content = body.content ?? existing.content;

  await db
    .update(notes)
    .set({ title, content, updatedAt: new Date() })
    .where(eq(notes.id, id));
  await db.update(documents).set({ title }).where(eq(documents.id, id));

  await ingestNote({ documentId: id, userId: session.user.id, title, content });
  if (title !== existing.title) {
    await resolveIncomingLinks(id, session.user.id, title);
  }
  await syncOutgoingLinks(id, session.user.id, content);

  return Response.json({ id, title, content });
}

export async function DELETE(_request: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) return Response.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;

  // Deleting the document cascades to notes, chunks and note_links.
  await db
    .delete(documents)
    .where(and(eq(documents.id, id), eq(documents.userId, session.user.id)));

  return Response.json({ ok: true });
}
