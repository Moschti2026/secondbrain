"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

interface SyncResponse {
  error?: string;
  processed?: number;
  skipped?: number;
  removed?: number;
  errors?: string[];
  /** false = this call hit its time budget with more work left; call again
   * to continue. Older deployments without this field behave as if done. */
  done?: boolean;
}

// A large first sync (thousands of Drive/OneDrive files) needs many
// time-boxed calls in a row. Rather than making the user click "Sync"
// dozens of times, this loops automatically until the server reports
// done. Capped so a stuck backend can't spin the browser forever — at
// that point something's wrong and needs a manual look, not more retries.
const MAX_ROUNDS = 300;

export default function SyncButton({ endpoint, label }: { endpoint: string; label: string }) {
  const router = useRouter();
  const [status, setStatus] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const stopRef = useRef(false);

  async function runOnce(): Promise<SyncResponse> {
    const res = await fetch(endpoint, { method: "POST" });
    const text = await res.text();
    let body: SyncResponse;
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(
        res.ok
          ? "Unerwartete Antwort vom Server."
          : `Serverfehler (${res.status}). Später erneut versuchen.`
      );
    }
    if (!res.ok) throw new Error(body.error ?? "Fehler");
    return body;
  }

  async function trigger() {
    setLoading(true);
    setStatus(null);
    stopRef.current = false;

    const totals = { processed: 0, skipped: 0, removed: 0, errors: [] as string[] };
    try {
      for (let round = 0; round < MAX_ROUNDS; round++) {
        const body = await runOnce();
        totals.processed += body.processed ?? 0;
        totals.skipped += body.skipped ?? 0;
        totals.removed += body.removed ?? 0;
        if (body.errors?.length) totals.errors.push(...body.errors);

        const done = body.done ?? true;
        setStatus(
          `${totals.processed} verarbeitet, ${totals.skipped} unverändert, ${totals.removed} entfernt` +
            (totals.errors.length ? `, ${totals.errors.length} Fehler` : "") +
            (done ? "" : " — läuft weiter…")
        );
        router.refresh();

        if (done || stopRef.current) break;
      }
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
      {loading && (
        <button
          onClick={() => {
            stopRef.current = true;
          }}
          className="text-xs text-neutral-400 hover:underline"
        >
          Stoppen
        </button>
      )}
      {status && <span className="text-xs text-neutral-500">{status}</span>}
    </div>
  );
}
