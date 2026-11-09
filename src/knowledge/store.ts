import type { AppContext } from "../context";
import { parseJson } from "../db/db";
import { bytesToHex, hmac, newId, sha256Hex, stableId } from "../security/crypto";

/**
 * Canonical knowledge store (D1). Sensitive text (labels, values, excerpts, source content) is
 * encrypted; exact lookup uses an HMAC "blind index" of the normalized label so no plaintext
 * search index exists. Derived views (current location, summaries) are computed from these rows.
 */

export type EntityType = "item" | "container" | "place" | "person" | "project" | "organization" | "document" | "activity" | "topic" | "owner";
export const PHYSICAL: ReadonlySet<EntityType> = new Set(["item", "container", "place"]);

export interface EntityRow {
  id: string;
  type: EntityType;
  label_enc: string;
  bidx: string;
  description_enc: string | null;
  attributes_enc: string | null;
  status: "active" | "merged" | "deleted";
  merged_into: string | null;
  source_id: string | null;
  version: number;
  created_at: number;
  updated_at: number;
}

export interface Entity extends EntityRow {
  label: string;
}

export type EvidenceType =
  "explicit_report" | "observed_event" | "confirmed_external_record" | "tentative" | "assistant_proposal" | "inference" | "disputed" | "superseded" | "retracted";

export interface AssertionRow {
  id: string;
  extraction_key: string;
  subject_id: string;
  predicate: string;
  object_entity_id: string | null;
  object_value_enc: string | null;
  value_type: string;
  evidence_type: EvidenceType;
  speaker: string;
  attributed_to: string | null;
  polarity: "affirmative" | "negated";
  modality: "actual" | "intended" | "possible" | "hypothetical" | "obligation";
  source_id: string | null;
  excerpt_enc: string | null;
  effective_from: number;
  effective_to: number | null;
  recorded_at: number;
  status: "current" | "historical" | "tentative" | "disputed" | "retracted" | "deleted";
  supersedes_id: string | null;
  scope_key: string | null;
  model: string | null;
  version: number;
  created_at: number;
  updated_at: number;
}

/** "My passport" → "passport"; lowercases, strips articles/possessive determiners and punctuation. */
export function normalizeLabel(label: string): string {
  return label
    .toLowerCase()
    .replace(/[’']s\b/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .replace(/\b(my|the|a|an|our|your|his|her|their|this|that)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function labelTokens(label: string): string[] {
  return normalizeLabel(label)
    .split(/[\s-]+/)
    .filter((t) => t.length > 0)
    .map((t) => t.replace(/s$/, ""));
}

let bidxKeyCache: { id: string; key: Promise<Uint8Array> } | null = null;

/** HMAC blind index keyed from the data key (domain-separated); stable across restarts. */
export async function blindIndex(ctx: AppContext, normalized: string): Promise<string> {
  const k = ctx.config.encryptionKey;
  if (!bidxKeyCache || bidxKeyCache.id !== k.id) bidxKeyCache = { id: k.id, key: hmac("SHA-256", k.raw, "della-blind-index-v1") };
  return bytesToHex(await hmac("SHA-256", await bidxKeyCache.key, normalized)).slice(0, 40);
}

export async function decryptEntity(ctx: AppContext, r: EntityRow): Promise<Entity> {
  return { ...r, label: await ctx.crypto.decrypt(r.label_enc, "entity") };
}

export async function getEntity(ctx: AppContext, id: string): Promise<Entity | null> {
  let r = await ctx.db.first<EntityRow>("SELECT * FROM entities WHERE id = ?", id);
  for (let i = 0; r && r.status === "merged" && r.merged_into && i < 5; i++) r = await ctx.db.first<EntityRow>("SELECT * FROM entities WHERE id = ?", r.merged_into);
  return r && r.status !== "deleted" ? decryptEntity(ctx, r) : null;
}

export async function createEntity(ctx: AppContext, input: { key: string; type: EntityType; label: string; sourceId: string | null }): Promise<Entity> {
  const id = await stableId("ent", input.key);
  const existing = await ctx.db.first<EntityRow>("SELECT * FROM entities WHERE id = ?", id);
  if (existing) return decryptEntity(ctx, existing);
  const now = ctx.clock.now();
  const norm = normalizeLabel(input.label);
  const bidx = await blindIndex(ctx, norm);
  await ctx.db.batch([
    ctx.db.prepare(
      "INSERT OR IGNORE INTO entities (id, type, label_enc, bidx, status, source_id, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', ?, ?, ?)",
      id,
      input.type,
      await ctx.crypto.encrypt(input.label.trim().slice(0, 120), "entity"),
      bidx,
      input.sourceId,
      now,
      now,
    ),
    ctx.db.prepare(
      "INSERT OR IGNORE INTO entity_aliases (id, entity_id, alias_enc, bidx, source_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      newId("als"),
      id,
      await ctx.crypto.encrypt(norm, "alias"),
      bidx,
      input.sourceId,
      now,
    ),
    ctx.db.prepare("INSERT OR IGNORE INTO index_state (object_id, object_type, canonical_version, dirty, updated_at) VALUES (?, 'entity', 1, 1, ?)", id, now),
  ]);
  await logMemoryEvent(ctx, "entity.created", { entityId: id, sourceId: input.sourceId });
  return (await getEntity(ctx, id))!;
}

export async function addAlias(ctx: AppContext, entityId: string, alias: string, sourceId: string | null): Promise<void> {
  const norm = normalizeLabel(alias);
  if (!norm) return;
  await ctx.db.run(
    "INSERT OR IGNORE INTO entity_aliases (id, entity_id, alias_enc, bidx, source_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    newId("als"),
    entityId,
    await ctx.crypto.encrypt(norm, "alias"),
    await blindIndex(ctx, norm),
    sourceId,
    ctx.clock.now(),
  );
}

export async function activeEntities(ctx: AppContext, types?: ReadonlySet<EntityType>, limit = 2000): Promise<Entity[]> {
  const rows = await ctx.db.all<EntityRow>("SELECT * FROM entities WHERE status = 'active' ORDER BY updated_at DESC LIMIT ?", limit);
  const out: Entity[] = [];
  for (const r of rows) if (!types || types.has(r.type)) out.push(await decryptEntity(ctx, r));
  return out;
}

export interface SourceInput {
  kind: "sms" | "note" | "upload" | "calendar" | "email" | "device" | "admin" | "meeting";
  originId: string;
  content: string;
  eventAt: number;
  speaker?: "owner" | "assistant" | "third_party" | "system";
  rawRetentionDays: number;
}

/** Records the provenance source once (idempotent per kind + origin). Raw content follows chat retention. */
export async function recordSource(ctx: AppContext, s: SourceInput): Promise<string> {
  const id = await stableId("src", `${s.kind}:${s.originId}`);
  const now = ctx.clock.now();
  await ctx.db.run(
    `INSERT OR IGNORE INTO source_records (id, kind, origin_id, speaker, content_enc, content_hash, retention_class, event_at, received_at, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'raw', ?, ?, ?, ?)`,
    id,
    s.kind,
    s.originId,
    s.speaker ?? "owner",
    await ctx.crypto.encrypt(s.content, "source"),
    await sha256Hex(s.content),
    s.eventAt,
    now,
    now + s.rawRetentionDays * 86_400_000,
    now,
  );
  return id;
}

export async function isSourceDeleted(ctx: AppContext, sourceId: string): Promise<boolean> {
  const r = await ctx.db.first<{ deleted_at: number | null }>("SELECT deleted_at FROM source_records WHERE id = ?", sourceId);
  return Boolean(r?.deleted_at) || Boolean(await ctx.db.first("SELECT object_id FROM deletion_tombstones WHERE object_id = ?", sourceId));
}

export interface NewAssertion {
  extractionKey: string;
  subjectId: string;
  predicate: string;
  objectEntityId?: string | null;
  value?: string | null;
  valueType?: string;
  evidenceType: EvidenceType;
  speaker?: string;
  attributedTo?: string | null;
  polarity?: "affirmative" | "negated";
  modality?: AssertionRow["modality"];
  sourceId: string | null;
  excerpt: string | null;
  effectiveFrom: number;
  effectiveTo?: number | null;
  status: AssertionRow["status"];
  supersedesId?: string | null;
  scopeKey?: string | null;
  model?: string | null;
}

/** Idempotent per extraction key: a retried extraction (or one for a deleted fact) inserts nothing. */
export async function insertAssertion(ctx: AppContext, a: NewAssertion): Promise<{ id: string; created: boolean }> {
  const id = await stableId("asr", a.extractionKey);
  const now = ctx.clock.now();
  const changes = await ctx.db.run(
    `INSERT OR IGNORE INTO assertions (id, extraction_key, subject_id, predicate, object_entity_id, object_value_enc, value_type, evidence_type, speaker, attributed_to, polarity, modality,
       source_id, excerpt_enc, effective_from, effective_to, recorded_at, status, supersedes_id, scope_key, model, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    a.extractionKey,
    a.subjectId,
    a.predicate,
    a.objectEntityId ?? null,
    a.value !== undefined && a.value !== null ? await ctx.crypto.encrypt(a.value, "assertion") : null,
    a.valueType ?? "text",
    a.evidenceType,
    a.speaker ?? "owner",
    a.attributedTo ?? null,
    a.polarity ?? "affirmative",
    a.modality ?? "actual",
    a.sourceId,
    a.excerpt ? await ctx.crypto.encrypt(a.excerpt, "excerpt") : null,
    a.effectiveFrom,
    a.effectiveTo ?? null,
    now,
    a.status,
    a.supersedesId ?? null,
    a.scopeKey ?? null,
    a.model ?? null,
    now,
    now,
  );
  if (changes === 1) {
    await ctx.db.run("INSERT OR IGNORE INTO index_state (object_id, object_type, canonical_version, dirty, updated_at) VALUES (?, 'assertion', 1, 1, ?)", id, now);
    await logMemoryEvent(ctx, "assertion.created", { assertionId: id, entityId: a.subjectId, sourceId: a.sourceId });
  }
  return { id, created: changes === 1 };
}

/** Closes an assertion's validity (fenced on version). */
export async function closeAssertion(ctx: AppContext, a: AssertionRow, effectiveTo: number, status: "historical" | "retracted", reason: string): Promise<boolean> {
  const now = ctx.clock.now();
  const won = await ctx.db.run(
    "UPDATE assertions SET effective_to = ?, status = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ? AND status IN ('current','tentative')",
    effectiveTo,
    status,
    now,
    a.id,
    a.version,
  );
  if (won === 1) {
    await ctx.db.run("UPDATE index_state SET canonical_version = canonical_version + 1, dirty = 1, updated_at = ? WHERE object_id = ?", now, a.id);
    await logMemoryEvent(ctx, `assertion.${status}`, { assertionId: a.id, entityId: a.subject_id }, reason);
  }
  return won === 1;
}

export async function assertionsFor(ctx: AppContext, subjectId: string, predicate: string | null, statuses: AssertionRow["status"][]): Promise<AssertionRow[]> {
  const ph = statuses.map(() => "?").join(",");
  if (predicate) {
    return ctx.db.all<AssertionRow>(
      `SELECT * FROM assertions WHERE subject_id = ? AND predicate = ? AND status IN (${ph}) ORDER BY effective_from DESC, recorded_at DESC`,
      subjectId,
      predicate,
      ...statuses,
    );
  }
  return ctx.db.all<AssertionRow>(`SELECT * FROM assertions WHERE subject_id = ? AND status IN (${ph}) ORDER BY effective_from DESC, recorded_at DESC`, subjectId, ...statuses);
}

export async function decryptValue(ctx: AppContext, a: AssertionRow): Promise<string | null> {
  return ctx.crypto.decryptNullable(a.object_value_enc, "assertion");
}

export async function decryptExcerpt(ctx: AppContext, a: { excerpt_enc: string | null }): Promise<string | null> {
  return ctx.crypto.decryptNullable(a.excerpt_enc, "excerpt");
}

export async function logMemoryEvent(
  ctx: AppContext,
  kind: string,
  refs: { entityId?: string | null; assertionId?: string | null; sourceId?: string | null },
  reason = "",
  detail: unknown = null,
): Promise<void> {
  await ctx.db.run(
    "INSERT INTO memory_events (id, kind, entity_id, assertion_id, source_id, detail_enc, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    newId("mev"),
    kind,
    refs.entityId ?? null,
    refs.assertionId ?? null,
    refs.sourceId ?? null,
    detail === null ? null : await ctx.crypto.encrypt(JSON.stringify(detail), "memory_event"),
    reason.slice(0, 200),
    ctx.clock.now(),
  );
}

/** Merges `fromId` into `intoId`, recording an exact snapshot so `splitEntity` can reverse it. */
export async function mergeEntities(ctx: AppContext, intoId: string, fromId: string, reason: string): Promise<{ ok: boolean; eventId?: string; error?: string }> {
  if (intoId === fromId) return { ok: false, error: "same entity" };
  const a = await ctx.db.first<EntityRow>("SELECT * FROM entities WHERE id = ? AND status = 'active'", intoId);
  const b = await ctx.db.first<EntityRow>("SELECT * FROM entities WHERE id = ? AND status = 'active'", fromId);
  if (!a || !b) return { ok: false, error: "entity not active" };
  const aliasIds = (await ctx.db.all<{ id: string }>("SELECT id FROM entity_aliases WHERE entity_id = ?", fromId)).map((r) => r.id);
  const subjIds = (await ctx.db.all<{ id: string }>("SELECT id FROM assertions WHERE subject_id = ?", fromId)).map((r) => r.id);
  const objIds = (await ctx.db.all<{ id: string }>("SELECT id FROM assertions WHERE object_entity_id = ?", fromId)).map((r) => r.id);
  const now = ctx.clock.now();
  const eventId = newId("mev");
  await ctx.db.batch([
    ctx.db.prepare("UPDATE entity_aliases SET entity_id = ? WHERE entity_id = ? AND bidx NOT IN (SELECT bidx FROM entity_aliases WHERE entity_id = ?)", intoId, fromId, intoId),
    ctx.db.prepare("UPDATE assertions SET subject_id = ?, version = version + 1, updated_at = ? WHERE subject_id = ?", intoId, now, fromId),
    ctx.db.prepare("UPDATE assertions SET object_entity_id = ?, version = version + 1, updated_at = ? WHERE object_entity_id = ?", intoId, now, fromId),
    ctx.db.prepare("UPDATE entities SET status = 'merged', merged_into = ?, version = version + 1, updated_at = ? WHERE id = ?", intoId, now, fromId),
    ctx.db.prepare(
      "INSERT INTO memory_events (id, kind, entity_id, detail_enc, reason, created_at) VALUES (?, 'entity.merged', ?, ?, ?, ?)",
      eventId,
      intoId,
      await ctx.crypto.encrypt(JSON.stringify({ intoId, fromId, aliasIds, subjIds, objIds }), "memory_event"),
      reason.slice(0, 200),
      now,
    ),
  ]);
  return { ok: true, eventId };
}

export async function splitEntity(ctx: AppContext, mergeEventId: string): Promise<{ ok: boolean; error?: string }> {
  const ev = await ctx.db.first<{ detail_enc: string; kind: string }>("SELECT detail_enc, kind FROM memory_events WHERE id = ?", mergeEventId);
  if (!ev || ev.kind !== "entity.merged") return { ok: false, error: "not a merge event" };
  const d = parseJson<{ intoId: string; fromId: string; aliasIds: string[]; subjIds: string[]; objIds: string[] }>(await ctx.crypto.decrypt(ev.detail_enc, "memory_event"), {
    intoId: "",
    fromId: "",
    aliasIds: [],
    subjIds: [],
    objIds: [],
  });
  const undone = await ctx.db.first("SELECT id FROM memory_events WHERE kind = 'entity.split' AND reason = ?", mergeEventId);
  if (undone) return { ok: false, error: "already split" };
  const now = ctx.clock.now();
  const stmts: D1PreparedStatement[] = [
    ctx.db.prepare("UPDATE entities SET status = 'active', merged_into = NULL, version = version + 1, updated_at = ? WHERE id = ? AND status = 'merged'", now, d.fromId),
  ];
  for (const id of d.aliasIds) stmts.push(ctx.db.prepare("UPDATE entity_aliases SET entity_id = ? WHERE id = ?", d.fromId, id));
  for (const id of d.subjIds) stmts.push(ctx.db.prepare("UPDATE assertions SET subject_id = ?, version = version + 1 WHERE id = ?", d.fromId, id));
  for (const id of d.objIds) stmts.push(ctx.db.prepare("UPDATE assertions SET object_entity_id = ?, version = version + 1 WHERE id = ?", d.fromId, id));
  stmts.push(ctx.db.prepare("INSERT INTO memory_events (id, kind, entity_id, reason, created_at) VALUES (?, 'entity.split', ?, ?, ?)", newId("mev"), d.fromId, mergeEventId, now));
  await ctx.db.batch(stmts);
  return { ok: true };
}
