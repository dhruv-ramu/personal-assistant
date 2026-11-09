import type { Db } from "../db/db";
import type { Clock } from "../domain/time";
import { OAuthError, refreshAccessToken, type GoogleOAuthConfig, type TokenResponse } from "../providers/calendar/google-oauth";
import type { Fetcher } from "../providers/http";
import type { FieldCrypto } from "../security/crypto";

/**
 * Optional read-only Gmail connection, separate from the Calendar connection (incremental consent:
 * connecting email never widens Calendar's grant, and vice versa). `gmail.readonly` is a
 * restricted scope: Google requires app verification/security assessment for broad distribution;
 * for a single owner's own account it can run in Testing mode (7-day refresh tokens).
 * Della only lists recent message metadata and snippets; it has no send/archive/delete code.
 */
export const GMAIL_SCOPES = ["openid", "email", "https://www.googleapis.com/auth/gmail.readonly"] as const;

export function gmailAuthorizationUrl(cfg: GoogleOAuthConfig, state: string, challenge: string): string {
  const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  u.searchParams.set("client_id", cfg.clientId);
  u.searchParams.set("redirect_uri", cfg.redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", GMAIL_SCOPES.join(" "));
  u.searchParams.set("access_type", "offline");
  u.searchParams.set("prompt", "consent");
  u.searchParams.set("include_granted_scopes", "false");
  u.searchParams.set("state", state);
  u.searchParams.set("code_challenge", challenge);
  u.searchParams.set("code_challenge_method", "S256");
  return u.toString();
}

export async function persistEmailTokens(db: Db, crypto: FieldCrypto, clock: Clock, tokens: TokenResponse, email: string | null): Promise<void> {
  const now = clock.now();
  await db.run(
    `UPDATE email_connection SET provider = 'gmail', status = 'connected', access_token_enc = ?, access_expires_at = ?, refresh_token_enc = COALESCE(?, refresh_token_enc),
       scopes = ?, account_email = COALESCE(?, account_email), last_error = NULL, version = version + 1, updated_at = ? WHERE id = 1`,
    await crypto.encrypt(tokens.accessToken, "email_oauth"),
    now + tokens.expiresInSec * 1000,
    tokens.refreshToken ? await crypto.encrypt(tokens.refreshToken, "email_oauth") : null,
    tokens.scopes.join(" "),
    email,
    now,
  );
}

export async function emailAccessToken(db: Db, crypto: FieldCrypto, clock: Clock, fetcher: Fetcher, cfg: GoogleOAuthConfig): Promise<string> {
  const row = await db.first<{ status: string; access_token_enc: string | null; refresh_token_enc: string | null; access_expires_at: number | null }>(
    "SELECT * FROM email_connection WHERE id = 1",
  );
  if (!row || row.status !== "connected") throw new Error("email not connected");
  if (row.access_token_enc && row.access_expires_at && row.access_expires_at - 60_000 > clock.now()) return crypto.decrypt(row.access_token_enc, "email_oauth");
  if (!row.refresh_token_enc) throw new Error("email refresh token missing");
  try {
    const t = await refreshAccessToken(fetcher, cfg, await crypto.decrypt(row.refresh_token_enc, "email_oauth"));
    await persistEmailTokens(db, crypto, clock, t, null);
    return t.accessToken;
  } catch (err) {
    if (err instanceof OAuthError && err.code === "invalid_grant") {
      await db.run("UPDATE email_connection SET status = 'needs_reconnect', access_token_enc = NULL, last_error = 'invalid_grant', updated_at = ? WHERE id = 1", clock.now());
    }
    throw err;
  }
}

export async function emailStatus(db: Db): Promise<{ status: string; provider: string; account: string | null }> {
  const r = await db.first<{ status: string; provider: string; account_email: string | null }>("SELECT status, provider, account_email FROM email_connection WHERE id = 1");
  return { status: r?.status ?? "disconnected", provider: r?.provider ?? "none", account: r?.account_email ?? null };
}

export async function disconnectEmail(db: Db, clock: Clock): Promise<void> {
  await db.run(
    "UPDATE email_connection SET status = 'disconnected', access_token_enc = NULL, refresh_token_enc = NULL, account_email = NULL, scopes = NULL, version = version + 1, updated_at = ? WHERE id = 1",
    clock.now(),
  );
}
