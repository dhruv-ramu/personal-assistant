import type { AppContext } from "../context";
import { HOUR, MINUTE } from "../domain/time";
import { randomToken, secretsEqual, sha256Hex, timingSafeEqual } from "./crypto";

export const SESSION_COOKIE = "della_session";
export const SESSION_TTL_MS = 12 * HOUR;
const LOGIN_WINDOW_MS = 15 * MINUTE;
const MAX_LOGIN_ATTEMPTS = 5;

export interface SessionRow {
  token_hash: string;
  csrf_token: string;
  created_at: number;
  expires_at: number;
  last_seen_at: number;
  revoked_at: number | null;
}

export function clientKey(request: Request): string {
  return request.headers.get("cf-connecting-ip") ?? "local";
}

export type LoginResult = { ok: true; token: string; csrf: string } | { ok: false; reason: "throttled" | "invalid" | "disabled" };

/**
 * Admin login with the server-side bootstrap secret (POST body only). Attempts are throttled per
 * client before comparison; comparison hashes both sides first (no length short-circuit). Success
 * issues a random opaque session token; only its SHA-256 hash is stored.
 */
export async function login(ctx: AppContext, secret: string, client: string): Promise<LoginResult> {
  if (!ctx.config.adminSecret) return { ok: false, reason: "disabled" };
  const now = ctx.clock.now();
  const window = Math.floor(now / LOGIN_WINDOW_MS) * LOGIN_WINDOW_MS;
  const clientHash = await sha256Hex(`login:${client}`);
  await ctx.db.run(
    "INSERT INTO login_attempts (client_hash, window_start, count) VALUES (?, ?, 1) ON CONFLICT (client_hash, window_start) DO UPDATE SET count = count + 1",
    clientHash,
    window,
  );
  const attempts = (await ctx.db.first<{ count: number }>("SELECT count FROM login_attempts WHERE client_hash = ? AND window_start = ?", clientHash, window))?.count ?? 0;
  if (attempts > MAX_LOGIN_ATTEMPTS) return { ok: false, reason: "throttled" };
  if (!(await secretsEqual(secret, ctx.config.adminSecret))) return { ok: false, reason: "invalid" };
  await ctx.db.run("DELETE FROM login_attempts WHERE client_hash = ?", clientHash);
  const token = randomToken(32);
  const csrf = randomToken(24);
  await ctx.db.run(
    "INSERT INTO admin_sessions (token_hash, csrf_token, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?)",
    await sha256Hex(token),
    csrf,
    now,
    now + SESSION_TTL_MS,
    now,
  );
  return { ok: true, token, csrf };
}

export async function getSession(ctx: AppContext, token: string | undefined | null): Promise<SessionRow | null> {
  if (!token || token.length < 20 || token.length > 100) return null;
  const now = ctx.clock.now();
  const row = await ctx.db.first<SessionRow>("SELECT * FROM admin_sessions WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?", await sha256Hex(token), now);
  if (row && now - row.last_seen_at > MINUTE) await ctx.db.run("UPDATE admin_sessions SET last_seen_at = ? WHERE token_hash = ?", now, row.token_hash);
  return row;
}

export async function logout(ctx: AppContext, token: string | undefined | null): Promise<void> {
  if (!token) return;
  await ctx.db.run("UPDATE admin_sessions SET revoked_at = ? WHERE token_hash = ?", ctx.clock.now(), await sha256Hex(token));
}

export function sessionCookie(token: string, secure: boolean): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${secure ? "; Secure" : ""}`;
}

export function clearedSessionCookie(secure: boolean): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`;
}

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

/**
 * CSRF for state-changing admin requests: the per-session token must match AND the Origin (or
 * Referer) must be our own origin. SameSite=Lax cookies are the third layer.
 */
export function checkCsrf(request: Request, session: SessionRow, formToken: string | null, expectedOrigin: string): boolean {
  if (!formToken || !timingSafeEqual(formToken, session.csrf_token)) return false;
  const origin = request.headers.get("origin");
  if (origin) return origin === expectedOrigin;
  const referer = request.headers.get("referer");
  if (referer) {
    try {
      return new URL(referer).origin === expectedOrigin;
    } catch {
      return false;
    }
  }
  return false;
}
