"use client";

import { useState } from "react";

interface SyncKey {
  id: string;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export default function ApiKeyManager({ initialKeys }: { initialKeys: SyncKey[] }) {
  const [keys, setKeys] = useState(initialKeys);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [label, setLabel] = useState("Claude");

  async function generate() {
    const res = await fetch("/api/sync-keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: label.trim() || "API-Key" }),
    });
    const body = await res.json();
    setNewKey(body.key);
    setKeys((prev) => [{ id: body.id, label: body.label, createdAt: body.createdAt, lastUsedAt: null }, ...prev]);
  }

  async function revoke(id: string) {
    if (!confirm("Diesen API-Key wirklich widerrufen?")) return;
    await fetch("/api/sync-keys", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    setKeys((prev) => prev.filter((k) => k.id !== id));
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Name, z.B. Claude oder Cursor"
          aria-label="Name des API-Keys"
          className="min-w-0 flex-1 rounded-md border border-neutral-300 bg-transparent px-3 py-2 text-base sm:text-sm dark:border-neutral-700"
        />
        <button
          onClick={generate}
          className="shrink-0 rounded-md border border-neutral-300 px-3 py-2 text-sm hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
        >
          + Neuen API-Key erzeugen
        </button>
      </div>

      {newKey && (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-800 dark:bg-amber-950">
          <p className="mb-1 font-medium">Neuer Key (nur jetzt sichtbar, sicher speichern):</p>
          <code className="break-all">{newKey}</code>
        </div>
      )}

      {keys.length > 0 && (
        <ul className="divide-y divide-neutral-200 text-sm dark:divide-neutral-800">
          {keys.map((k) => (
            <li key={k.id} className="flex flex-col gap-1 py-2 sm:flex-row sm:items-center sm:justify-between">
              <span className="min-w-0 break-words">
                {k.label} · erstellt {new Date(k.createdAt).toLocaleDateString("de-DE")}
                {k.lastUsedAt ? ` · zuletzt genutzt ${new Date(k.lastUsedAt).toLocaleDateString("de-DE")}` : " · noch nicht genutzt"}
              </span>
              <button onClick={() => revoke(k.id)} className="text-red-600 hover:underline">
                Widerrufen
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
