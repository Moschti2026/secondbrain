"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

interface Backlink {
  id: string;
  title: string;
}

export default function NoteEditor({
  id,
  initialTitle,
  initialContent,
  backlinks,
}: {
  id: string;
  initialTitle: string;
  initialContent: string;
  backlinks: Backlink[];
}) {
  const router = useRouter();
  const [title, setTitle] = useState(initialTitle);
  const [content, setContent] = useState(initialContent);
  const [status, setStatus] = useState<"idle" | "saving" | "saved">("idle");

  async function save() {
    setStatus("saving");
    await fetch(`/api/notes/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, content }),
    });
    setStatus("saved");
    router.refresh();
  }

  async function remove() {
    if (!confirm(`Notiz "${title}" wirklich löschen?`)) return;
    await fetch(`/api/notes/${id}`, { method: "DELETE" });
    router.push("/notes");
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="flex-1 border-b border-neutral-300 bg-transparent pb-1 text-xl font-semibold focus:outline-none dark:border-neutral-700"
        />
        <button
          onClick={save}
          className="rounded-md bg-neutral-900 px-4 py-2 text-sm text-white dark:bg-neutral-100 dark:text-neutral-900"
        >
          Speichern
        </button>
        <button
          onClick={remove}
          className="rounded-md border border-red-300 px-4 py-2 text-sm text-red-600 hover:bg-red-50 dark:border-red-800 dark:hover:bg-red-950"
        >
          Löschen
        </button>
      </div>

      <textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        placeholder="Schreib in Markdown. Verlinke andere Notizen mit [[Titel]]."
        className="h-[50vh] w-full resize-none rounded-md border border-neutral-300 bg-transparent p-3 font-mono text-sm focus:outline-none dark:border-neutral-700"
      />

      <div className="flex items-center justify-between text-xs text-neutral-400">
        <span>{status === "saving" ? "Speichert…" : status === "saved" ? "Gespeichert" : ""}</span>
        <span>Markdown · [[Titel]] verlinkt andere Notizen</span>
      </div>

      {backlinks.length > 0 && (
        <div className="border-t border-neutral-200 pt-4 dark:border-neutral-800">
          <h2 className="mb-2 text-sm font-medium text-neutral-500">Verweist hierher</h2>
          <ul className="space-y-1 text-sm">
            {backlinks.map((b) => (
              <li key={b.id}>
                <a href={`/notes/${b.id}`} className="underline">
                  {b.title}
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
