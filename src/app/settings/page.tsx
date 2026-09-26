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

  return (
    <div className="space-y-10">
      <h1 className="text-2xl font-semibold">Einstellungen</h1>

      <section className="space-y-3">
        <h2 className="font-medium">Verbundene Quellen</h2>

        <div className="flex items-center justify-between rounded-md border border-neutral-200 p-3 dark:border-neutral-800">
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

        <div className="flex items-center justify-between rounded-md border border-neutral-200 p-3 dark:border-neutral-800">
          <span>Microsoft 365 / OneDrive</span>
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
          Eine automatische Re-Synchronisierung läuft zusätzlich alle 6 Stunden im Hintergrund (Cron-Job).
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="font-medium">Datei manuell hochladen</h2>
        <UploadForm />
      </section>

      <section className="space-y-3">
        <h2 className="font-medium">Lokaler Sync-Client</h2>
        <p className="text-sm text-neutral-500">
          Mit einem API-Key kannst du den lokalen Sync-Client (<code>local-sync-cli</code>) auf deinem
          Rechner einrichten, um einen Ordner automatisch mit diesem Secondbrain zu synchronisieren.
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
