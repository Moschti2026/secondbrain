import Link from "next/link";
import { redirect } from "next/navigation";
import { count, eq } from "drizzle-orm";
import { auth } from "@/auth";
import { db } from "@/db";
import { documents, syncState } from "@/db/schema";

export default async function HomePage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const [{ value: documentCount }] = await db
    .select({ value: count() })
    .from(documents)
    .where(eq(documents.userId, session.user.id));

  const syncRows = await db
    .select()
    .from(syncState)
    .where(eq(syncState.userId, session.user.id));

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold">Willkommen zurück</h1>
        <p className="text-neutral-500">
          {documentCount} indexierte Dokumente aus Drive, Microsoft 365, lokalen Dateien und Notizen.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Link
          href="/chat"
          className="rounded-lg border border-neutral-200 p-5 hover:border-neutral-400 dark:border-neutral-800"
        >
          <div className="text-lg font-medium">💬 Chat</div>
          <div className="text-sm text-neutral-500">Über alle deine Daten fragen</div>
        </Link>
        <Link
          href="/notes"
          className="rounded-lg border border-neutral-200 p-5 hover:border-neutral-400 dark:border-neutral-800"
        >
          <div className="text-lg font-medium">📝 Notizen</div>
          <div className="text-sm text-neutral-500">Wissen festhalten und verlinken</div>
        </Link>
        <Link
          href="/settings"
          className="rounded-lg border border-neutral-200 p-5 hover:border-neutral-400 dark:border-neutral-800"
        >
          <div className="text-lg font-medium">⚙️ Einstellungen</div>
          <div className="text-sm text-neutral-500">Quellen verbinden & synchronisieren</div>
        </Link>
      </div>

      {syncRows.length > 0 && (
        <div>
          <h2 className="mb-2 font-medium">Sync-Status</h2>
          <ul className="space-y-1 text-sm text-neutral-500">
            {syncRows.map((row) => (
              <li key={row.id}>
                {row.provider === "google_drive" ? "Google Drive" : "Microsoft 365"}: {row.status}
                {row.lastSyncedAt ? ` · zuletzt ${row.lastSyncedAt.toLocaleString("de-DE")}` : ""}
                {row.lastError ? ` · Fehler: ${row.lastError}` : ""}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
