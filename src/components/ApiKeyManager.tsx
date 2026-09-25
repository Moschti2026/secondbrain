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

  async function generate() {
    const res = await fetch("/api/sync-keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "Lokaler Sync-Client" }),
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
      <button
        onClick={generate}
        className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
      >
        + Neuen API-Key erzeugen
      </button>

      {newKey && (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-800 dark:bg-amber-950">
          <p className="mb-1 font-medium">Neuer Key (nur jetzt sichtbar, sicher speichern):</p>
          <code className="break-all">{newKey}</code>
        </div>
      )}

      {keys.length > 0 && (
        <ul className="divide-y divide-neutral-200 text-sm dark:divide-neutral-800">
          {keys.map((k) => (
            <li key={k.id} className="flex items-center justify-between py-2">
              <span>
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
