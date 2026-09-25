import { and, eq } from "drizzle-orm";
import { auth } from "@/auth";
import { db } from "@/db";
import { syncKeys } from "@/db/schema";
import { generateKey, hashKey } from "@/lib/apikey";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) return Response.json({ error: "unauthorized" }, { status: 401 });

  const keys = await db
    .select({
      id: syncKeys.id,
      label: syncKeys.label,
      createdAt: syncKeys.createdAt,
      lastUsedAt: syncKeys.lastUsedAt,
    })
    .from(syncKeys)
    .where(eq(syncKeys.userId, session.user.id));

  return Response.json({ keys });
}

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) return Response.json({ error: "unauthorized" }, { status: 401 });

  const body = (await request.json().catch(() => ({}))) as { label?: string };
  const label = body.label?.trim() || "Lokaler Sync-Client";

  const rawKey = generateKey();
  const [row] = await db
    .insert(syncKeys)
    .values({ userId: session.user.id, label, hashedKey: hashKey(rawKey) })
    .returning({ id: syncKeys.id, label: syncKeys.label, createdAt: syncKeys.createdAt });

  // The raw key is shown exactly once — only its hash is stored.
  return Response.json({ ...row, key: rawKey });
}

export async function DELETE(request: Request) {
  const session = await auth();
  if (!session?.user?.id) return Response.json({ error: "unauthorized" }, { status: 401 });

  const { id } = (await request.json().catch(() => ({}))) as { id?: string };
  if (!id) return Response.json({ error: "missing id" }, { status: 400 });

  await db
    .delete(syncKeys)
    .where(and(eq(syncKeys.id, id), eq(syncKeys.userId, session.user.id)));

  return Response.json({ ok: true });
}
