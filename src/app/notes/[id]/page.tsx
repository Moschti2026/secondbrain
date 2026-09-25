import { notFound, redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { auth } from "@/auth";
import { db } from "@/db";
import { noteLinks, notes } from "@/db/schema";
import NoteEditor from "@/components/NoteEditor";

export default async function NotePage({ params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  const { id } = await params;

  const [note] = await db
    .select()
    .from(notes)
    .where(and(eq(notes.id, id), eq(notes.userId, session.user.id)));
  if (!note) notFound();

  const backlinks = await db
    .select({ id: notes.id, title: notes.title })
    .from(noteLinks)
    .innerJoin(notes, eq(noteLinks.sourceNoteId, notes.id))
    .where(eq(noteLinks.targetNoteId, id));

  return (
    <NoteEditor
      id={note.id}
      initialTitle={note.title}
      initialContent={note.content}
      backlinks={backlinks}
    />
  );
}
