import Link from "next/link";
import { redirect } from "next/navigation";
import { desc, eq } from "drizzle-orm";
import { auth } from "@/auth";
import { db } from "@/db";
import { notes } from "@/db/schema";
import NewNoteButton from "@/components/NewNoteButton";

export default async function NotesPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const list = await db
    .select({ id: notes.id, title: notes.title, updatedAt: notes.updatedAt })
    .from(notes)
    .where(eq(notes.userId, session.user.id))
    .orderBy(desc(notes.updatedAt));

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Notizen</h1>
        <NewNoteButton />
      </div>

      {list.length === 0 ? (
        <p className="text-neutral-500">Noch keine Notizen. Leg deine erste an.</p>
      ) : (
        <ul className="divide-y divide-neutral-200 dark:divide-neutral-800">
          {list.map((note) => (
            <li key={note.id}>
              <Link
                href={`/notes/${note.id}`}
                className="flex items-center justify-between py-3 hover:text-neutral-500"
              >
                <span>{note.title}</span>
                <span className="text-xs text-neutral-400">
                  {note.updatedAt.toLocaleDateString("de-DE")}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
