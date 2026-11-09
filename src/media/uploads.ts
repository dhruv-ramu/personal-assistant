import type { AppContext } from "../context";
import { parseJson } from "../db/db";
import { MINUTE } from "../domain/time";
import { featureOn, getExtSettings } from "../ext/settings";
import { newId, randomToken, sha256Hex } from "../security/crypto";
import { audit } from "../services/audit";
import { jobInsertStatement, type JobOutcome, type JobRow } from "../services/jobs";
import { getSettings } from "../services/settings";
import { commitUsage, releaseUsage, reserveUsage } from "../services/usage";
import { applyPhotoAssessment, getCheckpoint, getSession } from "../accountability/sessions";
import { validateImage } from "./images";

/**
 * Private evidence uploads. A token is single-purpose (one checkpoint), short-lived, limited in
 * count/bytes/types, and stored only as a hash. Only the metadata-stripped derivative is kept,
 * in private storage with no public URL; raw accountability images expire after
 * `raw_media_hours` (24 h default). A photo is evidence of what it shows — never proof of work.
 */

export interface UploadTokenRow {
  token_hash: string;
  purpose: "accountability" | "knowledge";
  session_id: string | null;
  checkpoint_id: string | null;
  entity_id: string | null;
  max_objects: number;
  max_bytes: number;
  allowed_types: string;
  used_objects: number;
  state: "open" | "finalized" | "expired" | "revoked";
  created_at: number;
  expires_at: number;
  finalized_at: number | null;
}

export async function issueUploadToken(
  ctx: AppContext,
  input: { purpose: "accountability" | "knowledge"; sessionId?: string | null; checkpointId?: string | null; entityId?: string | null; expiresAt: number },
): Promise<string> {
  const ext = await getExtSettings(ctx.db);
  const token = randomToken(24);
  const now = ctx.clock.now();
  await ctx.db.run(
    "INSERT INTO upload_tokens (token_hash, purpose, session_id, checkpoint_id, entity_id, max_objects, max_bytes, allowed_types, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    await sha256Hex(`upload:${token}`),
    input.purpose,
    input.sessionId ?? null,
    input.checkpointId ?? null,
    input.entityId ?? null,
    ext.max_images_per_checkpoint,
    ext.max_image_bytes,
    "image/jpeg,image/png,image/webp",
    now,
    Math.min(input.expiresAt, now + 24 * 60 * MINUTE),
  );
  return `${ctx.baseUrl}/u/${token}`;
}

export async function lookupToken(ctx: AppContext, token: string): Promise<UploadTokenRow | null> {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
  const row = await ctx.db.first<UploadTokenRow>("SELECT * FROM upload_tokens WHERE token_hash = ?", await sha256Hex(`upload:${token}`));
  if (!row) return null;
  if (row.state === "open" && row.expires_at <= ctx.clock.now()) {
    await ctx.db.run("UPDATE upload_tokens SET state = 'expired' WHERE token_hash = ? AND state = 'open'", row.token_hash);
    return { ...row, state: "expired" };
  }
  return row;
}

export type StoreResult = { ok: true; mediaId: string } | { ok: false; message: string };

export async function storeImage(
  ctx: AppContext,
  input: {
    purpose: "accountability" | "knowledge";
    source: "upload" | "mms";
    sessionId: string | null;
    checkpointId: string | null;
    entityId: string | null;
    bytes: Uint8Array;
    dedupe: string;
  },
): Promise<StoreResult> {
  const ext = await getExtSettings(ctx.db);
  const st = await getSettings(ctx.db);
  const check = validateImage(input.bytes, ext.max_image_bytes);
  if (!check.ok) return { ok: false, message: check.message };
  const key = `media:${input.dedupe}`;
  if (!(await reserveUsage(ctx, key, "media_bytes", check.bytes.length, { tz: st.timezone, limit: ext.limit_media_bytes_per_day })))
    return { ok: false, message: "Today's media upload limit is reached." };
  const id = newId("med");
  const storageKey = `${input.purpose}/${input.sessionId ?? input.entityId ?? "misc"}/${id}.${check.kind === "jpeg" ? "jpg" : check.kind}`;
  try {
    await ctx.ext.media.put(storageKey, check.bytes, check.contentType);
  } catch {
    await releaseUsage(ctx, key, { forget: true });
    return { ok: false, message: "Storage is unavailable right now; please try again." };
  }
  const now = ctx.clock.now();
  const expires = input.purpose === "accountability" ? now + ext.raw_media_hours * 3_600_000 : now + ext.durable_memory_days * 86_400_000;
  await ctx.db.run(
    `INSERT INTO media_objects (id, storage_key, purpose, source, session_id, checkpoint_id, entity_id, sha256, content_type, bytes, width, height, metadata_stripped, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    id,
    storageKey,
    input.purpose,
    input.source,
    input.sessionId,
    input.checkpointId,
    input.entityId,
    await sha256Hex(check.bytes),
    check.contentType,
    check.bytes.length,
    check.width,
    check.height,
    expires,
    now,
  );
  await commitUsage(ctx, key, check.bytes.length);
  return { ok: true, mediaId: id };
}

/** Creates the photo evidence submission and enqueues assessment (or the receipt-only path). */
export async function submitPhotoEvidence(ctx: AppContext, checkpointId: string, sessionId: string, mediaIds: string[], dedupe: string): Promise<string> {
  const ext = await getExtSettings(ctx.db);
  const now = ctx.clock.now();
  const id = newId("evs");
  const inserted = await ctx.db.run(
    "INSERT OR IGNORE INTO evidence_submissions (id, dedupe_key, session_id, checkpoint_id, kind, media_ids_json, received_at, state, expires_at, created_at) VALUES (?, ?, ?, ?, 'photo', ?, ?, 'received_unassessed', ?, ?)",
    id,
    dedupe,
    sessionId,
    checkpointId,
    JSON.stringify(mediaIds),
    now,
    now + ext.accountability_summary_days * 86_400_000,
    now,
  );
  if (inserted !== 1) return (await ctx.db.first<{ id: string }>("SELECT id FROM evidence_submissions WHERE dedupe_key = ?", dedupe))!.id;
  await ctx.db.batch([jobInsertStatement(ctx, { logicalKey: `evidence_assess:${id}`, kind: "evidence_assess", entityId: id, dueAt: now, maxAttempts: 3 })]);
  return id;
}

export type UploadOutcome = { status: number; message: string };

export async function handleUpload(ctx: AppContext, token: string, files: File[]): Promise<UploadOutcome> {
  const ext = await getExtSettings(ctx.db);
  if (!featureOn(ctx, ext, "uploads")) return { status: 404, message: "Uploads are turned off." };
  const t = await lookupToken(ctx, token);
  if (!t || t.state !== "open") return { status: 410, message: "This upload link has expired or was already used." };
  if (t.checkpoint_id) {
    const cp = await getCheckpoint(ctx, t.checkpoint_id);
    const s = t.session_id ? await getSession(ctx, t.session_id) : null;
    if (!cp || !["pending", "requested", "needs_clarification"].includes(cp.state) || !s || !s.photos_allowed) {
      await ctx.db.run("UPDATE upload_tokens SET state = 'revoked' WHERE token_hash = ?", t.token_hash);
      return { status: 410, message: "That check is closed; no upload is needed." };
    }
  }
  const remaining = t.max_objects - t.used_objects;
  if (files.length === 0) return { status: 400, message: "Choose a photo first." };
  if (files.length > remaining) return { status: 400, message: `At most ${remaining} more image(s) for this check.` };
  const media: string[] = [];
  for (const f of files) {
    if (f.size > t.max_bytes) return { status: 413, message: `Each image must be under ${Math.round(t.max_bytes / 1048576)} MB.` };
    const bytes = new Uint8Array(await f.arrayBuffer());
    const r = await storeImage(ctx, {
      purpose: t.purpose,
      source: "upload",
      sessionId: t.session_id,
      checkpointId: t.checkpoint_id,
      entityId: t.entity_id,
      bytes,
      dedupe: `${t.token_hash}:${t.used_objects + media.length}`,
    });
    if (!r.ok) return { status: 415, message: r.message };
    media.push(r.mediaId);
  }
  const used = t.used_objects + media.length;
  await ctx.db.run(
    "UPDATE upload_tokens SET used_objects = ?, state = CASE WHEN ? >= max_objects THEN 'finalized' ELSE state END, finalized_at = CASE WHEN ? >= max_objects THEN ? ELSE finalized_at END WHERE token_hash = ? AND used_objects = ?",
    used,
    used,
    used,
    ctx.clock.now(),
    t.token_hash,
    t.used_objects,
  );
  if (t.checkpoint_id && t.session_id) await submitPhotoEvidence(ctx, t.checkpoint_id, t.session_id, media, `upload:${t.token_hash}:${t.used_objects}`);
  await audit(ctx, "system", "upload.received", "upload", t.checkpoint_id, `${media.length} image(s)`);
  return { status: 200, message: "Received. You can close this page." };
}

/** MMS photos: only for an open photo checkpoint and only when MMS ingestion is enabled. */
export async function ingestMmsEvidence(ctx: AppContext, inboundId: string, urls: string[]): Promise<string | null> {
  if (urls.length === 0) return null;
  const ext = await getExtSettings(ctx.db);
  if (!featureOn(ctx, ext, "mms")) return "I don't process MMS photos (that's off). Use the upload link from the check instead.";
  const cp = await ctx.db.first<{ id: string; session_id: string; evidence_kinds_json: string }>(
    "SELECT c.id, c.session_id, c.evidence_kinds_json FROM acc_checkpoints c JOIN acc_sessions s ON s.id = c.session_id WHERE c.state IN ('requested','needs_clarification') AND s.photos_allowed = 1 ORDER BY c.intended_at DESC LIMIT 1",
  );
  if (!cp || !parseJson<string[]>(cp.evidence_kinds_json, []).includes("photo")) return "Thanks, but no photo check is open, so I didn't keep that image.";
  const media: string[] = [];
  for (const [i, url] of urls.slice(0, ext.max_images_per_checkpoint).entries()) {
    const fetched = await ctx.ext.mms.fetch(url, ext.max_image_bytes);
    if ("error" in fetched) return fetched.error === "too_large" ? "That image is too large." : "I couldn't retrieve that image; try the upload link instead.";
    const r = await storeImage(ctx, {
      purpose: "accountability",
      source: "mms",
      sessionId: cp.session_id,
      checkpointId: cp.id,
      entityId: null,
      bytes: fetched.bytes,
      dedupe: `mms:${inboundId}:${i}`,
    });
    if (!r.ok) return r.message;
    media.push(r.mediaId);
  }
  await submitPhotoEvidence(ctx, cp.id, cp.session_id, media, `mms:${inboundId}`);
  return "Photo received for your check.";
}

/** Job: assess a photo submission (or record receipt-only), then update the checkpoint. */
export async function handleEvidenceAssess(ctx: AppContext, job: JobRow): Promise<JobOutcome> {
  const sub = await ctx.db.first<{ id: string; checkpoint_id: string | null; media_ids_json: string; state: string }>(
    "SELECT id, checkpoint_id, media_ids_json, state FROM evidence_submissions WHERE id = ?",
    job.entity_id ?? "",
  );
  if (!sub || !sub.checkpoint_id) return { status: "skipped", result: { reason: "missing" } };
  if (sub.state !== "received_unassessed") return { status: "skipped", result: { reason: sub.state } };
  const cp = await getCheckpoint(ctx, sub.checkpoint_id);
  if (!cp) return { status: "skipped", result: { reason: "missing_checkpoint" } };
  const ext = await getExtSettings(ctx.db);
  const st = await getSettings(ctx.db);
  if (!featureOn(ctx, ext, "assessment")) {
    await applyPhotoAssessment(ctx, cp.id, sub.id, "not_assessed");
    return { status: "succeeded", result: { verdict: "not_assessed" } };
  }
  const images: Array<{ bytes: Uint8Array; contentType: string }> = [];
  for (const mid of parseJson<string[]>(sub.media_ids_json, [])) {
    const m = await ctx.db.first<{ storage_key: string; deleted_at: number | null }>("SELECT storage_key, deleted_at FROM media_objects WHERE id = ?", mid);
    if (!m || m.deleted_at) continue;
    const o = await ctx.ext.media.get(m.storage_key);
    if (o) images.push(o);
  }
  if (images.length === 0) {
    await ctx.db.run("UPDATE evidence_submissions SET state = 'not_assessable' WHERE id = ?", sub.id);
    return { status: "skipped", result: { reason: "media_gone" } };
  }
  const key = `assess:${sub.id}`;
  if (!(await reserveUsage(ctx, key, "image_assessments", 1, { tz: st.timezone, limit: ext.limit_image_assessments_per_day }))) {
    await applyPhotoAssessment(ctx, cp.id, sub.id, "unavailable");
    return { status: "skipped", result: { reason: "budget" } };
  }
  const criterion = (await ctx.crypto.decryptNullable(cp.criterion_enc, "accountability")) ?? cp.label;
  const r = await ctx.ext.vision.assess({ images, criterion, context: cp.label });
  if (r.verdict === "unavailable") await releaseUsage(ctx, key);
  else await commitUsage(ctx, key, 1);
  await ctx.db.batch([
    ctx.db.prepare(
      "INSERT OR IGNORE INTO evidence_assessments (id, submission_id, verdict, detail_enc, model, assessor_version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      newId("eva"),
      sub.id,
      r.verdict,
      await ctx.crypto.encrypt(JSON.stringify({ observations: r.observations, criterionMatch: r.criterionMatch, missing: r.missing, limitations: r.limitations }), "assessment"),
      r.model,
      r.assessorVersion,
      ctx.clock.now(),
    ),
    ctx.db.prepare("UPDATE evidence_submissions SET state = ? WHERE id = ?", r.verdict === "unavailable" ? "received_unassessed" : "assessed", sub.id),
  ]);
  await applyPhotoAssessment(ctx, cp.id, sub.id, r.verdict);
  return { status: "succeeded", result: { verdict: r.verdict } };
}

/** Deletes expired media objects from storage, then marks rows deleted (storage first). */
export async function purgeExpiredMedia(ctx: AppContext, limit = 50): Promise<number> {
  const now = ctx.clock.now();
  const rows = await ctx.db.all<{ id: string; storage_key: string }>(
    "SELECT id, storage_key FROM media_objects WHERE deleted_at IS NULL AND expires_at IS NOT NULL AND expires_at <= ? LIMIT ?",
    now,
    limit,
  );
  for (const r of rows) {
    await ctx.ext.media.delete(r.storage_key);
    await ctx.db.run("UPDATE media_objects SET deleted_at = ? WHERE id = ?", now, r.id);
  }
  await ctx.db.run("UPDATE upload_tokens SET state = 'expired' WHERE state = 'open' AND expires_at <= ?", now);
  await ctx.db.run("DELETE FROM device_challenges WHERE expires_at <= ?", now - 86_400_000);
  await ctx.db.run("DELETE FROM device_pairing_codes WHERE expires_at <= ?", now - 86_400_000);
  await ctx.db.run("DELETE FROM device_events WHERE expires_at <= ?", now);
  await ctx.db.run("DELETE FROM evidence_submissions WHERE expires_at IS NOT NULL AND expires_at <= ?", now);
  return rows.length;
}

export async function deleteMediaWhere(ctx: AppContext, where: "session" | "all", id?: string): Promise<number> {
  const rows =
    where === "all"
      ? await ctx.db.all<{ id: string; storage_key: string }>("SELECT id, storage_key FROM media_objects WHERE deleted_at IS NULL")
      : await ctx.db.all<{ id: string; storage_key: string }>("SELECT id, storage_key FROM media_objects WHERE deleted_at IS NULL AND session_id = ?", id ?? "");
  const now = ctx.clock.now();
  for (const r of rows) {
    await ctx.ext.media.delete(r.storage_key);
    await ctx.db.run("UPDATE media_objects SET deleted_at = ? WHERE id = ?", now, r.id);
  }
  return rows.length;
}

export function uploadPage(message: string | null, open: boolean, maxImages: number): string {
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>Della upload</title>
<style>body{font:16px system-ui,sans-serif;max-width:28rem;margin:2rem auto;padding:0 1rem}button{font-size:1rem;padding:.6rem 1rem}p.note{color:#555;font-size:.9rem}</style></head>
<body><h1>Della check photo</h1>${message ? `<p role="status">${esc(message)}</p>` : ""}
${
  open
    ? `<form method="post" enctype="multipart/form-data"><p><input type="file" name="photo" accept="image/jpeg,image/png,image/webp" ${maxImages > 1 ? "multiple" : ""} required></p><p><button type="submit">Send</button></p></form>
<p class="note">Up to ${maxImages} image(s), JPEG/PNG/WebP. Location and camera metadata are removed before storage. The photo is deleted within 24 hours. It's evidence of what it shows, not proof of work.</p>`
    : ""
}
</body></html>`;
}
