import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { auth, signIn } from "@/auth";
import { db } from "@/db";
import { accounts, syncKeys } from "@/db/schema";
import SyncButton from "@/components/SyncButton";
import ApiKeyManager from "@/components/ApiKeyManager";
import UploadForm from "@/components/UploadForm";

export default async function SettingsPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const connected = await db
    .select({ provider: accounts.provider })
    .from(accounts)
    .where(eq(accounts.userId, session.user.id));
  const providers = new Set(connected.map((a) => a.provider));

  const keys = await db
    .select({
      id: syncKeys.id,
      label: syncKeys.label,
      createdAt: syncKeys.createdAt,
      lastUsedAt: syncKeys.lastUsedAt,
    })
    .from(syncKeys)
    .where(eq(syncKeys.userId, session.user.id));

  const headerList = await headers();
  const host = headerList.get("x-forwarded-host") ?? headerList.get("host") ?? "secondbrain-navy-pi.vercel.app";
  const proto = headerList.get("x-forwarded-proto") ?? "https";
  const mcpUrl = `${proto}://${host}/api/mcp/<API-KEY>`;

  return (
    <div className="space-y-10">
      <h1 className="text-2xl font-semibold">Einstellungen</h1>

      <section className="space-y-3">
        <h2 className="font-medium">Verbundene Quellen</h2>

        <div className="flex flex-col gap-3 rounded-md border border-neutral-200 p-3 sm:flex-row sm:items-center sm:justify-between dark:border-neutral-800">
          <span>Google Drive</span>
          {providers.has("google") ? (
            <SyncButton endpoint="/api/connectors/google-drive/sync" label="Jetzt synchronisieren" />
          ) : (
            <form
              action={async () => {
                "use server";
                await signIn("google", { redirectTo: "/settings" });
              }}
            >
              <button type="submit" className="text-sm underline">
                Verbinden
              </button>
            </form>
          )}
        </div>

        <div className="flex flex-col gap-3 rounded-md border border-neutral-200 p-3 sm:flex-row sm:items-center sm:justify-between dark:border-neutral-800">
          <span>Microsoft 365 / OneDrive / OneNote</span>
          {providers.has("microsoft-entra-id") ? (
            <SyncButton endpoint="/api/connectors/microsoft365/sync" label="Jetzt synchronisieren" />
          ) : (
            <form
              action={async () => {
                "use server";
                await signIn("microsoft-entra-id", { redirectTo: "/settings" });
              }}
            >
              <button type="submit" className="text-sm underline">
                Verbinden
              </button>
            </form>
          )}
        </div>

        <p className="text-xs text-neutral-400">
          Eine automatische Re-Synchronisierung läuft zusätzlich einmal täglich im Hintergrund (Cron-Job).
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="font-medium">Datei manuell hochladen</h2>
        <UploadForm />
      </section>

      <section className="space-y-3">
        <h2 className="font-medium">API-Keys für Sync und KI-Assistenten</h2>
        <p className="text-sm text-neutral-500">
          Erzeuge pro Programm einen eigenen Key und gib ihm einen Namen (zum Beispiel „Claude“,
          „Cursor“, „Grok“, „Lokaler Sync“). So kannst du einen Zugang später einzeln widerrufen.
          Dieselbe Adresse gilt für alle MCP-Clients — der Key steckt in der URL, es ist kein extra
          Login nötig:
        </p>
        <p className="break-all rounded-md border border-neutral-200 bg-neutral-50 p-3 font-mono text-xs dark:border-neutral-800 dark:bg-neutral-900">
          {mcpUrl}
        </p>
        <ul className="list-disc space-y-2 pl-5 text-sm text-neutral-600 dark:text-neutral-300">
          <li>
            <strong>Grok / mcp-remote</strong> (so ist der Assistent bereits verbunden):{" "}
            <code className="break-all">npx -y mcp-remote &quot;{mcpUrl}&quot; --transport http-only</code>
          </li>
          <li>
            <strong>Claude Desktop:</strong> denselben Befehl unter <code>mcpServers</code> in die
            Claude-Konfiguration eintragen (Befehl <code>npx</code>, Argumente <code>-y</code>,{" "}
            <code>mcp-remote</code>, die URL, <code>--transport</code>, <code>http-only</code>).
          </li>
          <li>
            <strong>claude.ai:</strong> Einstellungen → Connectors → eigenen Connector hinzufügen, die
            URL eintragen, Authentifizierung „ohne Anmeldung“. Werkzeuge: ask_secondbrain,
            search_secondbrain, list_documents.
          </li>
          <li>
            <strong>Cursor:</strong> Settings → MCP → Server hinzufügen, Typ URL / HTTP, dieselbe
            Adresse. Kein zusätzlicher Header.
          </li>
          <li>
            <strong>Langdock:</strong> Integration vom Typ MCP, Transport Streamable HTTP, dieselbe
            URL, Authentifizierung keine.
          </li>
          <li>
            <strong>ChatGPT:</strong> die Custom-GPT-Action (Datei <code>openapi/secondbrain-chatgpt-action.yaml</code>,
            Header <code>x-api-key</code>) funktioniert wie bisher. Der offizielle ChatGPT-MCP-Connector
            verlangt oft OAuth — das ist hier noch nicht eingebaut. Wenn ein Client die URL ohne
            Anmeldung akzeptiert, reicht die Adresse oben.
          </li>
        </ul>
        <p className="text-sm text-neutral-500">
          Dieselben Keys funktionieren auch für den lokalen Sync-Client (<code>local-sync-cli</code>),
          der einen Ordner auf dem Rechner hochlädt.
        </p>
        <p className="rounded-md border border-neutral-200 bg-neutral-50 p-3 text-sm text-neutral-600 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-300">
          <strong>Notizen mit Obsidian:</strong> Zeig den Sync-Client einfach auf deinen Obsidian-Vault-Ordner.
          Du schreibst Notizen wie gewohnt in Obsidian, jede Änderung wird automatisch hier durchsuchbar.
          Schritt-für-Schritt-Anleitung: <a href="https://github.com/moschti2026/secondbrain/blob/main/OBSIDIAN_SETUP.md" target="_blank" rel="noreferrer" className="underline">OBSIDIAN_SETUP.md</a>.
        </p>
        <ApiKeyManager
          initialKeys={keys.map((k) => ({
            ...k,
            createdAt: k.createdAt.toISOString(),
            lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
          }))}
        />
      </section>
    </div>
  );
}
