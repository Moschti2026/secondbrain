"use client";

import { useState } from "react";

interface Source {
  documentId: string;
  title: string;
  url: string | null;
  similarity: number;
}

interface Message {
  role: "user" | "assistant";
  content: string;
  sources?: Source[];
}

export default function ChatPanel() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [question, setQuestion] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function ask(e: React.FormEvent) {
    e.preventDefault();
    const q = question.trim();
    if (!q || loading) return;

    setMessages((prev) => [...prev, { role: "user", content: q }]);
    setQuestion("");
    setLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: q }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Unbekannter Fehler");

      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: body.answer, sources: body.sources },
      ]);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex h-[70vh] flex-col">
      <div className="flex-1 space-y-4 overflow-y-auto pb-4">
        {messages.length === 0 && (
          <p className="text-neutral-500">
            Stell eine Frage zu deinen Dateien und Notizen — z.B. &bdquo;Was stand in der letzten
            Rechnung von …?&ldquo;
          </p>
        )}
        {messages.map((m, i) => (
          <div key={i} className={m.role === "user" ? "text-right" : "text-left"}>
            <div
              className={`inline-block max-w-[85%] rounded-lg px-4 py-2 text-sm ${
                m.role === "user"
                  ? "bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900"
                  : "bg-neutral-100 dark:bg-neutral-900"
              }`}
            >
              <p className="whitespace-pre-wrap">{m.content}</p>
              {m.sources && m.sources.length > 0 && (
                <ol className="mt-2 space-y-0.5 border-t border-neutral-300 pt-2 text-xs text-neutral-500 dark:border-neutral-700">
                  {m.sources.map((s, j) => (
                    <li key={s.documentId}>
                      [{j + 1}]{" "}
                      {s.url ? (
                        <a href={s.url} target="_blank" rel="noreferrer" className="underline">
                          {s.title}
                        </a>
                      ) : (
                        s.title
                      )}
                    </li>
                  ))}
                </ol>
              )}
            </div>
          </div>
        ))}
        {loading && <p className="text-sm text-neutral-400">Denke nach…</p>}
        {error && <p className="text-sm text-red-500">{error}</p>}
      </div>

      <form onSubmit={ask} className="flex gap-2 border-t border-neutral-200 pt-4 dark:border-neutral-800">
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="Frag dein Secondbrain…"
          className="flex-1 rounded-md border border-neutral-300 bg-transparent px-3 py-2 text-sm dark:border-neutral-700"
        />
        <button
          type="submit"
          disabled={loading}
          className="rounded-md bg-neutral-900 px-4 py-2 text-sm text-white disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900"
        >
          Senden
        </button>
      </form>
    </div>
  );
}
