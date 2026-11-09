import type { AppContext } from "../context";
import type { Db } from "../db/db";
import { parseJson } from "../db/db";
import type { Clock } from "../domain/time";
import { log } from "../observability/log";
import { refreshAccessToken, OAuthError, type GoogleOAuthConfig, type TokenResponse, type VerifiedGoogleIdentity, revokeToken } from "../providers/calendar/google-oauth";
import type { AccessTokenSource } from "../providers/calendar/google";
import type { Fetcher } from "../providers/http";
import { SIM_PRIMARY_CALENDAR, simEnsureCalendars } from "../providers/simulated/calendar";
import { CalendarAuthError, CalendarUnavailableError, type CalendarInfo } from "../providers/types";
import type { FieldCrypto } from "../security/crypto";
import { audit } from "./audit";

export type ConnectionStatus = "disconnected" | "pending_activation" | "connected" | "needs_reconnect" | "error";

export interface ConnectionRow {
  provider: string;
  status: ConnectionStatus;
  account_email: string | null;
  account_sub: string | null;
  scopes: string | null;
  access_token_enc: string | null;
  refresh_token_enc: string | null;
  access_expires_at: number | null;
  default_write_calendar_id: string | null;
  read_calendar_ids_json: string;
  calendars_json: string;
  last_sync_at: number | null;
  last_sync_error: string | null;
  last_error_at: number | null;
  connected_at: number | null;
  version: number;
}

export async function getConnection(db: Db): Promise<ConnectionRow> {
  return (await db.first<ConnectionRow>("SELECT * FROM calendar_connection WHERE id = 1"))!;
}

export function readCalendarIds(conn: ConnectionRow): string[] {
  const ids = parseJson<string[]>(conn.read_calendar_ids_json, []);
  if (ids.length > 0) return ids;
  return conn.default_write_calendar_id ? [conn.default_write_calendar_id] : [];
}

export function knownCalendars(conn: ConnectionRow): CalendarInfo[] {
  return parseJson<CalendarInfo[]>(conn.calendars_json, []);
}

/** Marks the connection as needing re-authorization. Task reminders are unaffected. */
export async function markNeedsReconnect(db: Db, clock: Clock, reason: string): Promise<void> {
  await db.run(
    "UPDATE calendar_connection SET status = 'needs_reconnect', last_sync_error = ?, last_error_at = ?, access_token_enc = NULL, version = version + 1, updated_at = ? WHERE id = 1 AND status IN ('connected','pending_activation')",
    reason.slice(0, 200),
    clock.now(),
    clock.now(),
  );
  log("warn", "calendar_needs_reconnect", { reason });
}

/**
 * Access tokens for Google, refreshed on demand. A refresh response without a new refresh token
 * keeps the existing one. `invalid_grant` (revoked consent, testing-mode 7-day expiry) moves the
 * connection to `needs_reconnect`.
 */
export class GoogleTokenSource implements AccessTokenSource {
  constructor(
    private readonly db: Db,
    private readonly crypto: FieldCrypto,
    private readonly clock: Clock,
    private readonly fetcher: Fetcher,
    private readonly cfg: GoogleOAuthConfig,
  ) {}

  async getAccessToken(forceRefresh = false): Promise<string> {
    const conn = await getConnection(this.db);
    if (conn.status !== "connected" && conn.status !== "pending_activation") throw new CalendarAuthError(`Calendar ${conn.status}`);
    const now = this.clock.now();
    if (!forceRefresh && conn.access_token_enc && conn.access_expires_at && conn.access_expires_at - 60_000 > now) {
      return this.crypto.decrypt(conn.access_token_enc, "oauth");
    }
    if (!conn.refresh_token_enc) {
      await markNeedsReconnect(this.db, this.clock, "missing_refresh_token");
      throw new CalendarAuthError("No refresh token");
    }
    const refreshToken = await this.crypto.decrypt(conn.refresh_token_enc, "oauth");
    let tokens: TokenResponse;
    try {
      tokens = await refreshAccessToken(this.fetcher, this.cfg, refreshToken);
    } catch (err) {
      if (err instanceof OAuthError && (err.code === "invalid_grant" || err.code === "unauthorized_client" || err.code === "invalid_client")) {
        await markNeedsReconnect(this.db, this.clock, err.code);
        throw new CalendarAuthError(err.code);
      }
      throw new CalendarUnavailableError("Token refresh failed");
    }
    await persistTokens(this.db, this.crypto, this.clock, tokens, null);
    return tokens.accessToken;
  }
}

/** Stores tokens encrypted. Preserves the existing refresh token when the response omits one. */
export async function persistTokens(
  db: Db,
  crypto: FieldCrypto,
  clock: Clock,
  tokens: TokenResponse,
  identity: VerifiedGoogleIdentity | null,
  status?: ConnectionStatus,
): Promise<void> {
  const now = clock.now();
  const accessEnc = await crypto.encrypt(tokens.accessToken, "oauth");
  const refreshEnc = tokens.refreshToken ? await crypto.encrypt(tokens.refreshToken, "oauth") : null;
  await db.run(
    `UPDATE calendar_connection SET provider = 'google', access_token_enc = ?, access_expires_at = ?, refresh_token_enc = COALESCE(?, refresh_token_enc),
       scopes = COALESCE(?, scopes), account_email = COALESCE(?, account_email), account_sub = COALESCE(?, account_sub), status = COALESCE(?, status),
       connected_at = CASE WHEN ? = 'connected' THEN ? ELSE connected_at END, version = version + 1, updated_at = ? WHERE id = 1`,
    accessEnc,
    now + tokens.expiresInSec * 1000,
    refreshEnc,
    tokens.scopes.length ? tokens.scopes.join(" ") : null,
    identity?.email ?? null,
    identity?.sub ?? null,
    status ?? null,
    status ?? "",
    now,
    now,
  );
}

export async function refreshCalendarList(ctx: AppContext): Promise<CalendarInfo[]> {
  const calendars = await ctx.calendar.listCalendars();
  const conn = await getConnection(ctx.db);
  const primary = calendars.find((c) => c.primary) ?? calendars[0];
  const writeId = conn.default_write_calendar_id ?? primary?.id ?? null;
  const readIds = parseJson<string[]>(conn.read_calendar_ids_json, []);
  await ctx.db.run(
    "UPDATE calendar_connection SET calendars_json = ?, default_write_calendar_id = ?, read_calendar_ids_json = ?, updated_at = ? WHERE id = 1",
    JSON.stringify(calendars.slice(0, 50)),
    writeId,
    JSON.stringify(readIds.length ? readIds : writeId ? [writeId] : []),
    ctx.clock.now(),
  );
  return calendars;
}

/** Simulated "OAuth": activates the simulated calendar account (clearly labelled in the UI). */
export async function connectSimulatedCalendar(ctx: AppContext): Promise<void> {
  await simEnsureCalendars(ctx.db);
  const now = ctx.clock.now();
  await ctx.db.run(
    `UPDATE calendar_connection SET provider = 'simulated', status = 'connected', account_email = 'simulated-owner (no real account)', account_sub = 'sim',
       scopes = 'simulated', default_write_calendar_id = COALESCE(default_write_calendar_id, ?), read_calendar_ids_json = CASE WHEN read_calendar_ids_json = '[]' THEN ? ELSE read_calendar_ids_json END,
       connected_at = ?, last_sync_error = NULL, version = version + 1, updated_at = ? WHERE id = 1`,
    SIM_PRIMARY_CALENDAR,
    JSON.stringify([SIM_PRIMARY_CALENDAR]),
    now,
    now,
  );
  await ctx.db.run("DELETE FROM system_state WHERE key = 'sim_calendar_revoked'");
  await refreshCalendarList(ctx);
  await audit(ctx, "admin", "calendar.connect", "calendar", "simulated");
}

export async function activateConnection(ctx: AppContext): Promise<boolean> {
  const changed = await ctx.db.run(
    "UPDATE calendar_connection SET status = 'connected', connected_at = ?, version = version + 1, updated_at = ? WHERE id = 1 AND status = 'pending_activation'",
    ctx.clock.now(),
    ctx.clock.now(),
  );
  if (changed === 1) {
    await audit(ctx, "admin", "calendar.activate", "calendar", "google");
    try {
      await refreshCalendarList(ctx);
    } catch (err) {
      log("warn", "calendar_list_failed", { error: String(err) });
    }
  }
  return changed === 1;
}

/** Disconnect: best-effort token revocation at Google, then delete encrypted tokens locally. */
export async function disconnectCalendar(ctx: AppContext): Promise<void> {
  const conn = await getConnection(ctx.db);
  if (conn.provider === "google" && conn.refresh_token_enc) {
    try {
      await revokeToken(ctx.fetcher, await ctx.crypto.decrypt(conn.refresh_token_enc, "oauth"));
    } catch (err) {
      log("warn", "calendar_revoke_failed", { error: String(err) });
    }
  }
  const now = ctx.clock.now();
  await ctx.db.batch([
    ctx.db.prepare(
      `UPDATE calendar_connection SET status = 'disconnected', access_token_enc = NULL, refresh_token_enc = NULL, access_expires_at = NULL, account_email = NULL, account_sub = NULL,
       scopes = NULL, calendars_json = '[]', read_calendar_ids_json = '[]', default_write_calendar_id = NULL, version = version + 1, updated_at = ? WHERE id = 1`,
      now,
    ),
    ctx.db.prepare("DELETE FROM calendar_events"),
    ctx.db.prepare("UPDATE calendar_headsups SET status = 'canceled', status_reason = 'calendar_disconnected', updated_at = ? WHERE status = 'scheduled'", now),
    ctx.db.prepare(
      "UPDATE jobs SET status = 'canceled', last_error = 'calendar_disconnected', updated_at = ? WHERE kind IN ('calendar_headsup','calendar_sync') AND status = 'pending'",
      now,
    ),
  ]);
  await audit(ctx, "admin", "calendar.disconnect", "calendar", conn.provider);
}

export async function selectCalendars(ctx: AppContext, writeId: string | null, readIds: string[]): Promise<boolean> {
  const conn = await getConnection(ctx.db);
  const known = new Set(knownCalendars(conn).map((c) => c.id));
  if (writeId && !known.has(writeId)) return false;
  if (readIds.some((id) => !known.has(id))) return false;
  await ctx.db.run(
    "UPDATE calendar_connection SET default_write_calendar_id = ?, read_calendar_ids_json = ?, version = version + 1, updated_at = ? WHERE id = 1",
    writeId,
    JSON.stringify(readIds.slice(0, 10)),
    ctx.clock.now(),
  );
  return true;
}
