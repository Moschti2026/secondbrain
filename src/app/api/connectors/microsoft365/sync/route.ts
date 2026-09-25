import { auth } from "@/auth";
import { syncMicrosoft365 } from "@/lib/connectors/microsoft365";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST() {
  const session = await auth();
  if (!session?.user?.id) return Response.json({ error: "unauthorized" }, { status: 401 });

  try {
    const summary = await syncMicrosoft365(session.user.id);
    return Response.json(summary);
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 500 });
  }
}
