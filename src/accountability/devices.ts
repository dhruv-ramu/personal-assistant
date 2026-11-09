import type { AppContext } from "../context";
import { getExtSettings, featureOn } from "../ext/settings";
import { base64UrlToBytes, bytesToBase64Url, newId, randomBytes, randomToken, sha256, sha256Hex, utf8, SHORT_CODE_ALPHABET } from "../security/crypto";
import { audit } from "../services/audit";
import { satisfyByDevice } from "./sessions";

/**
 * Registered browser devices. The extension never receives admin cookies, provider secrets,
 * page URLs, titles, or content. It holds a non-extractable ECDSA P-256 key and signs every
 * event; the Worker checks signature, epoch, strictly increasing sequence, freshness, and (for
 * check-ins) a one-time nonce bound to the active checkpoint. A heartbeat is never a check-in,
 * and no event here means "awake" — only "the registered browser answered a challenge".
 */

export const PAIRING_TTL_MS = 10 * 60_000;
export const EVENT_SKEW_MS = 120_000;
export const ONLINE_WINDOW_MS = 3 * 60_000;

export interface DeviceRow {
  id: string;
  name: string;
  public_key_jwk: string;
  key_thumbprint: string;
  capabilities_json: string;
  browser: string | null;
  epoch: number;
  last_seq: number;
  enrolled_at: number;
  last_seen_at: number | null;
  last_state: string | null;
  revoked_at: number | null;
  revoked_reason: string | null;
}

export interface SignedEnvelope {
  payload: string;
  signature: string;
}

export interface DevicePayload {
  deviceId: string;
  epoch: number;
  seq: number;
  kind: "poll" | "heartbeat" | "checkin_response" | "idle_state";
  state?: "active" | "idle" | "locked" | null;
  sessionId?: string | null;
  checkpointId?: string | null;
  nonce?: string | null;
  reportedAt: number;
}

export async function createPairingCode(ctx: AppContext, deviceName: string): Promise<{ code: string; expiresAt: number }> {
  const bytes = randomBytes(10);
  const code = Array.from(bytes, (b) => SHORT_CODE_ALPHABET[b % SHORT_CODE_ALPHABET.length]).join("");
  const now = ctx.clock.now();
  await ctx.db.run(
    "INSERT INTO device_pairing_codes (code_hash, device_name, created_at, expires_at) VALUES (?, ?, ?, ?)",
    await sha256Hex(`pair:${code}`),
    deviceName.slice(0, 60) || "Browser",
    now,
    now + PAIRING_TTL_MS,
  );
  await audit(ctx, "admin", "device.pairing_code_created", "device", null, deviceName.slice(0, 60));
  return { code, expiresAt: now + PAIRING_TTL_MS };
}

async function thumbprint(jwk: JsonWebKey): Promise<string> {
  // RFC 7638 member ordering for EC keys.
  return bytesToBase64Url(await sha256(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y })));
}

function validPublicJwk(j: unknown): j is JsonWebKey {
  const k = j as JsonWebKey;
  return !!k && k.kty === "EC" && k.crv === "P-256" && typeof k.x === "string" && typeof k.y === "string" && k.d === undefined;
}

export async function pairDevice(
  ctx: AppContext,
  body: { code?: unknown; publicKeyJwk?: unknown; browser?: unknown; capabilities?: unknown },
): Promise<{ ok: true; deviceId: string; epoch: number } | { ok: false; error: string }> {
  if (typeof body.code !== "string" || !validPublicJwk(body.publicKeyJwk)) return { ok: false, error: "invalid_request" };
  const hash = await sha256Hex(`pair:${body.code.trim().toUpperCase()}`);
  const now = ctx.clock.now();
  const won = await ctx.db.run("UPDATE device_pairing_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?", now, hash, now);
  if (won !== 1) return { ok: false, error: "invalid_or_expired_code" };
  const row = await ctx.db.first<{ device_name: string }>("SELECT device_name FROM device_pairing_codes WHERE code_hash = ?", hash);
  const jwk = { kty: "EC", crv: "P-256", x: body.publicKeyJwk.x, y: body.publicKeyJwk.y } as JsonWebKey;
  try {
    await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  } catch {
    return { ok: false, error: "invalid_key" };
  }
  const tp = await thumbprint(jwk);
  const existing = await ctx.db.first<DeviceRow>("SELECT * FROM registered_devices WHERE key_thumbprint = ?", tp);
  if (existing) return { ok: false, error: "key_already_registered" };
  const id = newId("dev");
  const caps = typeof body.capabilities === "object" && body.capabilities ? JSON.stringify(body.capabilities).slice(0, 500) : "{}";
  await ctx.db.run(
    "INSERT INTO registered_devices (id, name, public_key_jwk, key_thumbprint, capabilities_json, browser, epoch, last_seq, enrolled_at) VALUES (?, ?, ?, ?, ?, ?, 1, 0, ?)",
    id,
    row?.device_name ?? "Browser",
    JSON.stringify(jwk),
    tp,
    caps,
    typeof body.browser === "string" ? body.browser.slice(0, 40) : null,
    now,
  );
  await audit(ctx, "system", "device.paired", "device", id, row?.device_name ?? "");
  return { ok: true, deviceId: id, epoch: 1 };
}

export async function revokeDevice(ctx: AppContext, id: string, reason: string): Promise<boolean> {
  const now = ctx.clock.now();
  const won = await ctx.db.run("UPDATE registered_devices SET revoked_at = ?, revoked_reason = ? WHERE id = ? AND revoked_at IS NULL", now, reason, id);
  if (won) {
    await ctx.db.run("UPDATE device_challenges SET expires_at = ? WHERE device_id = ? AND consumed_at IS NULL", now, id);
    await audit(ctx, "admin", "device.revoked", "device", id, reason);
  }
  return won === 1;
}

export async function listDevices(ctx: AppContext): Promise<DeviceRow[]> {
  return ctx.db.all<DeviceRow>("SELECT * FROM registered_devices ORDER BY revoked_at IS NOT NULL, enrolled_at DESC");
}

export async function devicesOnline(ctx: AppContext): Promise<boolean> {
  const r = await ctx.db.first("SELECT id FROM registered_devices WHERE revoked_at IS NULL AND last_seen_at > ?", ctx.clock.now() - ONLINE_WINDOW_MS);
  return !!r;
}

/** One single-use nonce per active device, bound to (session, checkpoint), expiring at grace end. */
export async function issueDeviceChallenges(ctx: AppContext, sessionId: string, checkpointId: string, expiresAt: number): Promise<number> {
  const devices = await ctx.db.all<{ id: string }>("SELECT id FROM registered_devices WHERE revoked_at IS NULL");
  const now = ctx.clock.now();
  for (const d of devices) {
    await ctx.db.run(
      "INSERT INTO device_challenges (id, device_id, session_id, checkpoint_id, nonce, issued_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      newId("chl"),
      d.id,
      sessionId,
      checkpointId,
      randomToken(18),
      now,
      expiresAt,
    );
  }
  return devices.length;
}

async function verifySignature(jwkJson: string, env: SignedEnvelope): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey("jwk", JSON.parse(jwkJson) as JsonWebKey, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, base64UrlToBytes(env.signature), utf8(env.payload));
  } catch {
    return false;
  }
}

async function recordEvent(ctx: AppContext, d: DeviceRow, p: Partial<DevicePayload>, accepted: boolean, reason: string): Promise<void> {
  const ext = await getExtSettings(ctx.db);
  const now = ctx.clock.now();
  await ctx.db.run(
    `INSERT OR IGNORE INTO device_events (id, device_id, epoch, seq, kind, state, session_id, checkpoint_id, reported_at, received_at, accepted, reason, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    newId("dve"),
    d.id,
    Number(p.epoch ?? 0),
    accepted ? Number(p.seq ?? 0) : -Math.floor(Math.random() * 1e12),
    String(p.kind ?? "unknown").slice(0, 30),
    p.state ?? null,
    p.sessionId ?? null,
    p.checkpointId ?? null,
    typeof p.reportedAt === "number" ? p.reportedAt : null,
    now,
    accepted ? 1 : 0,
    reason,
    now + ext.telemetry_hours * 3_600_000,
  );
}

export type DeviceVerdict = { ok: true; device: DeviceRow; payload: DevicePayload } | { ok: false; status: number; error: string };

/** Signature first (so unsigned noise can't advance seq), then epoch, seq (atomic), freshness. */
export async function verifyDeviceEvent(ctx: AppContext, env: SignedEnvelope): Promise<DeviceVerdict> {
  if (typeof env?.payload !== "string" || typeof env?.signature !== "string" || env.payload.length > 2000) return { ok: false, status: 400, error: "invalid_envelope" };
  let p: DevicePayload;
  try {
    p = JSON.parse(env.payload) as DevicePayload;
  } catch {
    return { ok: false, status: 400, error: "invalid_payload" };
  }
  const d = await ctx.db.first<DeviceRow>("SELECT * FROM registered_devices WHERE id = ?", String(p.deviceId ?? ""));
  if (!d) return { ok: false, status: 401, error: "unknown_device" };
  if (d.revoked_at) {
    await recordEvent(ctx, d, p, false, "revoked");
    return { ok: false, status: 401, error: "revoked" };
  }
  if (!(await verifySignature(d.public_key_jwk, env))) {
    await recordEvent(ctx, d, p, false, "bad_signature");
    return { ok: false, status: 401, error: "bad_signature" };
  }
  if (p.epoch !== d.epoch) {
    await recordEvent(ctx, d, p, false, "wrong_epoch");
    return { ok: false, status: 409, error: "wrong_epoch" };
  }
  const now = ctx.clock.now();
  if (typeof p.reportedAt !== "number" || Math.abs(p.reportedAt - now) > EVENT_SKEW_MS) {
    await recordEvent(ctx, d, p, false, "stale_or_future");
    return { ok: false, status: 409, error: "stale_event" };
  }
  if (!Number.isInteger(p.seq) || p.seq <= 0) return { ok: false, status: 400, error: "invalid_seq" };
  const advanced = await ctx.db.run(
    "UPDATE registered_devices SET last_seq = ?, last_seen_at = ?, last_state = COALESCE(?, last_state) WHERE id = ? AND epoch = ? AND last_seq < ? AND revoked_at IS NULL",
    p.seq,
    now,
    p.state ?? null,
    d.id,
    d.epoch,
    p.seq,
  );
  if (advanced !== 1) {
    await recordEvent(ctx, d, p, false, "replay");
    return { ok: false, status: 409, error: "replay" };
  }
  return { ok: true, device: d, payload: p };
}

export interface SyncResponse {
  active: boolean;
  label: string | null;
  sessionId: string | null;
  challenge: { nonce: string; checkpointId: string; expiresAt: number } | null;
  pollSeconds: number;
}

/** Poll/heartbeat: returns only the active-session flag and any pending challenge for this device. */
export async function deviceSync(ctx: AppContext, env: SignedEnvelope): Promise<{ status: number; body: SyncResponse | { error: string } }> {
  const v = await verifyDeviceEvent(ctx, env);
  if (!v.ok) return { status: v.status, body: { error: v.error } };
  const ext = await getExtSettings(ctx.db);
  const inactive: SyncResponse = { active: false, label: null, sessionId: null, challenge: null, pollSeconds: 300 };
  if (!featureOn(ctx, ext, "telemetry")) {
    await recordEvent(ctx, v.device, v.payload, true, "telemetry_off");
    return { status: 200, body: inactive };
  }
  const now = ctx.clock.now();
  const ch = await ctx.db.first<{ nonce: string; checkpoint_id: string; session_id: string; expires_at: number }>(
    "SELECT nonce, checkpoint_id, session_id, expires_at FROM device_challenges WHERE device_id = ? AND consumed_at IS NULL AND expires_at > ? ORDER BY issued_at DESC LIMIT 1",
    v.device.id,
    now,
  );
  const session = await ctx.db.first<{ id: string; kind: string }>(
    "SELECT id, kind FROM acc_sessions WHERE state IN ('awaiting_start','active','awaiting_checkpoint') AND intended_start <= ? AND intended_end >= ? ORDER BY intended_start DESC LIMIT 1",
    now,
    now,
  );
  await recordEvent(ctx, v.device, v.payload, true, "ok");
  if (!session && !ch) return { status: 200, body: inactive };
  return {
    status: 200,
    body: {
      active: true,
      label: session ? (session.kind === "morning" ? "Morning routine" : "Accountability session") : "Check-in",
      sessionId: session?.id ?? ch?.session_id ?? null,
      challenge: ch ? { nonce: ch.nonce, checkpointId: ch.checkpoint_id, expiresAt: ch.expires_at } : null,
      pollSeconds: 60,
    },
  };
}

/** Explicit owner click answering a challenge → "registered browser check-in received". */
export async function deviceCheckin(ctx: AppContext, env: SignedEnvelope): Promise<{ status: number; body: { ok: boolean; error?: string } }> {
  const v = await verifyDeviceEvent(ctx, env);
  if (!v.ok) return { status: v.status, body: { ok: false, error: v.error } };
  const p = v.payload;
  if (p.kind !== "checkin_response" || !p.nonce || !p.checkpointId) {
    await recordEvent(ctx, v.device, p, false, "not_a_checkin");
    return { status: 400, body: { ok: false, error: "not_a_checkin" } };
  }
  const now = ctx.clock.now();
  const ch = await ctx.db.first<{ id: string; checkpoint_id: string; session_id: string }>(
    "SELECT id, checkpoint_id, session_id FROM device_challenges WHERE nonce = ? AND device_id = ?",
    p.nonce,
    v.device.id,
  );
  if (!ch || ch.checkpoint_id !== p.checkpointId || (p.sessionId && p.sessionId !== ch.session_id)) {
    await recordEvent(ctx, v.device, p, false, "challenge_mismatch");
    return { status: 409, body: { ok: false, error: "challenge_mismatch" } };
  }
  const consumed = await ctx.db.run("UPDATE device_challenges SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL AND expires_at > ?", now, ch.id, now);
  if (consumed !== 1) {
    await recordEvent(ctx, v.device, p, false, "challenge_used_or_expired");
    return { status: 409, body: { ok: false, error: "challenge_used_or_expired" } };
  }
  const sub = newId("evs");
  const ext = await getExtSettings(ctx.db);
  await ctx.db.run(
    "INSERT INTO evidence_submissions (id, dedupe_key, session_id, checkpoint_id, kind, device_id, received_at, state, expires_at, created_at) VALUES (?, ?, ?, ?, 'device_checkin', ?, ?, 'not_assessable', ?, ?)",
    sub,
    `device:${ch.id}`,
    ch.session_id,
    ch.checkpoint_id,
    v.device.id,
    now,
    now + ext.accountability_summary_days * 86_400_000,
    now,
  );
  const ok = await satisfyByDevice(ctx, ch.checkpoint_id, sub);
  await recordEvent(ctx, v.device, p, ok, ok ? "checkin_accepted" : "checkpoint_closed");
  return { status: ok ? 200 : 409, body: ok ? { ok: true } : { ok: false, error: "checkpoint_closed" } };
}
