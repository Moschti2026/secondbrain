import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { syncKeys } from "@/db/schema";

const PREFIX = "sb_";

export function hashKey(key: string): string {
  return crypto.createHash("sha256").update(key).digest("hex");
}

/** Generates a new local-sync API key. The raw value is only ever returned
 * here, at creation time — only its hash is persisted. */
export function generateKey(): string {
  return `${PREFIX}${crypto.randomBytes(32).toString("base64url")}`;
}

/** Resolves a raw API key (as sent by the local-sync CLI) to its owning
 * user id, or null if it's unknown/revoked. */
export async function resolveApiKey(rawKey: string): Promise<string | null> {
  if (!rawKey.startsWith(PREFIX)) return null;

  const [row] = await db
    .select()
    .from(syncKeys)
    .where(eq(syncKeys.hashedKey, hashKey(rawKey)));

  if (!row) return null;

  await db.update(syncKeys).set({ lastUsedAt: new Date() }).where(eq(syncKeys.id, row.id));
  return row.userId;
}
