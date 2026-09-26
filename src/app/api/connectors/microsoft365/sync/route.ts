import { auth } from "@/auth";
import { syncMicrosoft365 } from "@/lib/connectors/microsoft365";
import { syncOneNote } from "@/lib/connectors/onenote";
import { mergeSyncSummaries } from "@/lib/connectors/types";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST() {
  const session = await auth();
  if (!session?.user?.id) return Response.json({ error: "unauthorized" }, { status: 401 });

  try {
    // Sequential, not Promise.all: both calls can trigger an OAuth token
    // refresh, and refreshing the same refresh_token concurrently is best
    // avoided.
    const files = await syncMicrosoft365(session.user.id);
    const notes = await syncOneNote(session.user.id);
    return Response.json(mergeSyncSummaries([files, notes]));
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 500 });
  }
}
