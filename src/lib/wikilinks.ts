import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { noteLinks, notes } from "@/db/schema";

const WIKI_LINK_RE = /\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g;

/** Extracts unique [[Note Title]] references from markdown content. */
export function extractWikiLinks(content: string): string[] {
  const titles = new Set<string>();
  for (const match of content.matchAll(WIKI_LINK_RE)) {
    const title = match[1].trim();
    if (title) titles.add(title);
  }
  return [...titles];
}

/**
 * Recomputes the outgoing [[links]] for a note: replaces its note_links
 * rows with one per reference in `content`, resolved to an existing note
 * with a matching title (case-insensitive) when one exists.
 */
export async function syncOutgoingLinks(noteId: string, userId: string, content: string) {
  const titles = extractWikiLinks(content);

  await db.delete(noteLinks).where(eq(noteLinks.sourceNoteId, noteId));
  if (titles.length === 0) return;

  const targets = await db
    .select({ id: notes.id, title: notes.title })
    .from(notes)
    .where(eq(notes.userId, userId));

  const byTitle = new Map(targets.map((t) => [t.title.toLowerCase(), t.id]));

  await db.insert(noteLinks).values(
    titles.map((title) => ({
      sourceNoteId: noteId,
      targetNoteId: byTitle.get(title.toLowerCase()) ?? null,
      targetTitle: title,
    }))
  );
}

/**
 * When a note is created or renamed, other notes may have an unresolved
 * [[Title]] link waiting for it. Point those links at it now.
 */
export async function resolveIncomingLinks(noteId: string, userId: string, title: string) {
  await db
    .update(noteLinks)
    .set({ targetNoteId: noteId })
    .where(
      and(
        isNull(noteLinks.targetNoteId),
        sql`lower(${noteLinks.targetTitle}) = lower(${title})`,
        sql`${noteLinks.sourceNoteId} in (select id from notes where "userId" = ${userId})`
      )
    );
}
