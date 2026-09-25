"use client";

import { useRef, useState } from "react";

export default function UploadForm() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  async function upload() {
    const file = inputRef.current?.files?.[0];
    if (!file) return;

    setUploading(true);
    setStatus(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/ingest", { method: "POST", body: form });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Fehler");
      setStatus(body.skipped ? "Unverändert." : `Indexiert (${body.chunkCount} Abschnitte).`);
      if (inputRef.current) inputRef.current.value = "";
    } catch (err) {
      setStatus((err as Error).message);
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="flex items-center gap-3">
      <input
        ref={inputRef}
        type="file"
        accept=".pdf,.docx,.txt,.md,.csv,.json"
        className="text-sm"
      />
      <button
        onClick={upload}
        disabled={uploading}
        className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
      >
        {uploading ? "Lädt hoch…" : "Hochladen"}
      </button>
      {status && <span className="text-xs text-neutral-500">{status}</span>}
    </div>
  );
}
