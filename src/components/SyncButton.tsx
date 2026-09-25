"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export default function SyncButton({ endpoint, label }: { endpoint: string; label: string }) {
  const router = useRouter();
  const [status, setStatus] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function trigger() {
    setLoading(true);
    setStatus(null);
    try {
      const res = await fetch(endpoint, { method: "POST" });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Fehler");
      setStatus(
        `${body.processed} verarbeitet, ${body.skipped} unverändert, ${body.removed} entfernt` +
          (body.errors?.length ? `, ${body.errors.length} Fehler` : "")
      );
      router.refresh();
    } catch (err) {
      setStatus((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex items-center gap-3">
      <button
        onClick={trigger}
        disabled={loading}
        className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
      >
        {loading ? "Synchronisiere…" : label}
      </button>
      {status && <span className="text-xs text-neutral-500">{status}</span>}
    </div>
  );
}
