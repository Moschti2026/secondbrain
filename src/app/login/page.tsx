import { signIn } from "@/auth";

export default function LoginPage() {
  return (
    <div className="mx-auto mt-24 max-w-sm text-center">
      <h1 className="mb-2 text-2xl font-semibold">🧠 Secondbrain</h1>
      <p className="mb-8 text-neutral-500">
        Dein persönlicher Assistent über Google Drive, Microsoft 365/SharePoint, lokale Dateien und Notizen.
      </p>
      <div className="flex flex-col gap-3">
        <form
          action={async () => {
            "use server";
            await signIn("google", { redirectTo: "/" });
          }}
        >
          <button
            type="submit"
            className="w-full rounded-md border border-neutral-300 px-4 py-2 hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
          >
            Mit Google anmelden
          </button>
        </form>
        <form
          action={async () => {
            "use server";
            await signIn("microsoft-entra-id", { redirectTo: "/" });
          }}
        >
          <button
            type="submit"
            className="w-full rounded-md border border-neutral-300 px-4 py-2 hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
          >
            Mit Microsoft anmelden
          </button>
        </form>
      </div>
    </div>
  );
}
