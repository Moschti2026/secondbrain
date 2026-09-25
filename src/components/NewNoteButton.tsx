"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export default function NewNoteButton() {
  const router = useRouter();
  const [creating, setCreating] = useState(false);

  async function createNote() {
    setCreating(true);
    try {
      const res = await fetch("/api/notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Ohne Titel", content: "" }),
      });
      const note = await res.json();
      router.push(`/notes/${note.id}`);
    } finally {
      setCreating(false);
    }
  }

  return (
    <button
      onClick={createNote}
      disabled={creating}
      className="rounded-md bg-neutral-900 px-4 py-2 text-sm text-white disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900"
    >
      + Neue Notiz
    </button>
  );
}
