import { eq, and } from "drizzle-orm";
import { db } from "@/db";
import { accounts } from "@/db/schema";

export type OAuthProvider = "google" | "microsoft-entra-id";

const TOKEN_ENDPOINTS: Record<OAuthProvider, string> = {
  google: "https://oauth2.googleapis.com/token",
  "microsoft-entra-id": `https://login.microsoftonline.com/${
    process.env.AUTH_MICROSOFT_ENTRA_ID_TENANT ?? "common"
  }/oauth2/v2.0/token`,
};

function credentialsFor(provider: OAuthProvider) {
  if (provider === "google") {
    return {
      clientId: process.env.AUTH_GOOGLE_ID!,
      clientSecret: process.env.AUTH_GOOGLE_SECRET!,
    };
  }
  return {
    clientId: process.env.AUTH_MICROSOFT_ENTRA_ID_ID!,
    clientSecret: process.env.AUTH_MICROSOFT_ENTRA_ID_SECRET!,
  };
}

/**
 * Returns a live access token for a user's connected Google / Microsoft
 * account, refreshing it via the provider's token endpoint when the stored
 * one has expired. Sync jobs run outside a browser session, so they can't
 * rely on Auth.js's own (session-bound) token rotation.
 */
export async function getValidAccessToken(
  userId: string,
  provider: OAuthProvider
): Promise<string | null> {
  const [account] = await db
    .select()
    .from(accounts)
    .where(and(eq(accounts.userId, userId), eq(accounts.provider, provider)));

  if (!account?.access_token) return null;

  const isExpired =
    typeof account.expires_at === "number" &&
    account.expires_at * 1000 < Date.now() + 60_000;

  if (!isExpired) return account.access_token;

  if (!account.refresh_token) {
    throw new Error(
      `${provider} access token expired and no refresh_token is stored for user ${userId}. The user needs to reconnect the account.`
    );
  }

  const { clientId, clientSecret } = credentialsFor(provider);
  const res = await fetch(TOKEN_ENDPOINTS[provider], {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
      refresh_token: account.refresh_token,
    }),
  });

  if (!res.ok) {
    throw new Error(
      `Failed to refresh ${provider} token for user ${userId}: ${res.status} ${await res.text()}`
    );
  }

  const refreshed = (await res.json()) as {
    access_token: string;
    expires_in: number;
    refresh_token?: string;
  };

  await db
    .update(accounts)
    .set({
      access_token: refreshed.access_token,
      expires_at: Math.floor(Date.now() / 1000) + refreshed.expires_in,
      // Google/Microsoft don't always return a new refresh_token; keep the
      // old one when they don't.
      refresh_token: refreshed.refresh_token ?? account.refresh_token,
    })
    .where(
      and(eq(accounts.userId, userId), eq(accounts.provider, provider))
    );

  return refreshed.access_token;
}
