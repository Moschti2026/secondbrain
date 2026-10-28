import { auth } from "@/auth";
import { syncMicrosoft365 } from "@/lib/connectors/microsoft365";
import { syncOneNote } from "@/lib/connectors/onenote";
import { syncMicrosoftAccount } from "@/lib/connectors/sync-control";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST() {
  const session = await auth();
  if (!session?.user?.id) return Response.json({ error: "unauthorized" }, { status: 401 });

  try {
    // Sequential, not Promise.all: both calls can trigger an OAuth token
    // refresh, and refreshing the same refresh_token concurrently is best
    // avoided. A failure in one source stays in `errors` and the other
    // source still runs.
    const summary = await syncMicrosoftAccount({
      onedrive: () => syncMicrosoft365(session.user.id),
      onenote: () => syncOneNote(session.user.id),
    });
    return Response.json(summary);
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 500 });
  }
}
