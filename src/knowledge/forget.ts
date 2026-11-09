import type { AppContext } from "../context";
import { parseJson } from "../db/db";
import { cleanLabel, findEntity } from "./resolve";
import { logMemoryEvent } from "./store";

/**
 * Deletion is canonical first: rows are marked deleted and tombstoned immediately (so any stale
 * asynchronous index or cached answer is filtered on hydration), then derived data — vectors,
 * retrieval evidence, media — is removed. Extraction keys stay reserved, so a retried or late
 * extraction job for the same source cannot resurrect a deleted fact.
 */
export interface ForgetResult {
  assertions: number;
  items: number;
  entities: number;
  media: number;
  description: string;
}

async function tombstone(ctx: AppContext, id: string, type: string): Promise<void> {
  await ctx.db.run("INSERT OR IGNORE INTO deletion_tombstones (object_id, object_type, deleted_at) VALUES (?, ?, ?)", id, type, ctx.clock.now());
}

async function purgeDerived(ctx: AppContext, ids: string[]): Promise<void> {
  if (!ids.length) return;
  await ctx.ext.semantic.delete(ids).catch(() => undefined);
  for (const id of ids) {
    await ctx.db.run("UPDATE index_state SET deleted = 1, dirty = 1, updated_at = ? WHERE object_id = ?", ctx.clock.now(), id);
    await ctx.db.run("DELETE FROM semantic_vectors WHERE object_id = ?", id);
  }
  // Cached evidence referencing deleted claims is dropped.
  const rows = await ctx.db.all<{ id: string; assertion_ids_json: string }>("SELECT id, assertion_ids_json FROM retrieval_evidence");
  const set = new Set(ids);
  for (const r of rows)
    if (parseJson<Array<{ id: string }>>(r.assertion_ids_json, []).some((c) => set.has(c.id))) await ctx.db.run("DELETE FROM retrieval_evidence WHERE id = ?", r.id);
}

async function deleteAssertions(ctx: AppContext, ids: string[], reason: string): Promise<number> {
  const now = ctx.clock.now();
  for (const id of ids) {
    await ctx.db.run("UPDATE assertions SET status = 'deleted', object_value_enc = NULL, excerpt_enc = NULL, version = version + 1, updated_at = ? WHERE id = ?", now, id);
    await tombstone(ctx, id, "assertion");
    await logMemoryEvent(ctx, "assertion.deleted", { assertionId: id }, reason);
  }
  await purgeDerived(ctx, ids);
  return ids.length;
}

async function deleteItems(ctx: AppContext, ids: string[], reason: string): Promise<number> {
  const now = ctx.clock.now();
  for (const id of ids) {
    await ctx.db.run(
      "UPDATE secretary_items SET deleted_at = ?, status = 'deleted', title_enc = ?, data_enc = '', version = version + 1, updated_at = ? WHERE id = ?",
      now,
      await ctx.crypto.encrypt("(deleted)", "secretary"),
      now,
      id,
    );
    await ctx.db.run("UPDATE jobs SET status = 'canceled', last_error = 'deleted' WHERE entity_id = ? AND status = 'pending'", id);
    await tombstone(ctx, id, "secretary");
    await logMemoryEvent(ctx, "secretary.deleted", {}, reason);
  }
  await purgeDerived(ctx, ids);
  return ids.length;
}

async function deleteSourceIfUnused(ctx: AppContext, sourceId: string): Promise<void> {
  const live = await ctx.db.first<{ n: number }>("SELECT COUNT(*) AS n FROM assertions WHERE source_id = ? AND status != 'deleted'", sourceId);
  const liveItems = await ctx.db.first<{ n: number }>("SELECT COUNT(*) AS n FROM secretary_items WHERE source_id = ? AND deleted_at IS NULL", sourceId);
  if ((live?.n ?? 0) === 0 && (liveItems?.n ?? 0) === 0) {
    await ctx.db.run("UPDATE source_records SET content_enc = NULL, deleted_at = ? WHERE id = ?", ctx.clock.now(), sourceId);
    await tombstone(ctx, sourceId, "source");
  } else {
    // Shared source: drop the raw text but keep other facts' own minimal excerpts.
    await ctx.db.run("UPDATE source_records SET content_enc = NULL WHERE id = ?", sourceId);
  }
}

async function deleteMediaFor(ctx: AppContext, entityId: string): Promise<number> {
  const rows = await ctx.db.all<{ id: string; storage_key: string }>("SELECT id, storage_key FROM media_objects WHERE entity_id = ? AND deleted_at IS NULL", entityId);
  for (const r of rows) {
    await ctx.ext.media.delete(r.storage_key);
    await ctx.db.run("UPDATE media_objects SET deleted_at = ? WHERE id = ?", ctx.clock.now(), r.id);
  }
  return rows.length;
}

/** "Forget that": everything learned from the most recent captured message. */
export async function forgetLastCapture(ctx: AppContext): Promise<ForgetResult> {
  const run = await ctx.db.first<{ source_id: string | null }>("SELECT source_id FROM extraction_runs WHERE source_id IS NOT NULL ORDER BY created_at DESC, rowid DESC LIMIT 1");
  if (!run?.source_id) return { assertions: 0, items: 0, entities: 0, media: 0, description: "Nothing recent to forget." };
  return forgetSource(ctx, run.source_id);
}

export async function forgetSource(ctx: AppContext, sourceId: string): Promise<ForgetResult> {
  const a = (await ctx.db.all<{ id: string }>("SELECT id FROM assertions WHERE source_id = ? AND status != 'deleted'", sourceId)).map((r) => r.id);
  const i = (await ctx.db.all<{ id: string }>("SELECT id FROM secretary_items WHERE source_id = ? AND deleted_at IS NULL", sourceId)).map((r) => r.id);
  const nA = await deleteAssertions(ctx, a, "forget_source");
  const nI = await deleteItems(ctx, i, "forget_source");
  // Entities created only by this source (no remaining facts) are deleted too.
  const ents = (await ctx.db.all<{ id: string }>("SELECT id FROM entities WHERE source_id = ? AND status = 'active'", sourceId)).map((r) => r.id);
  let nE = 0;
  for (const e of ents) {
    const used = await ctx.db.first<{ n: number }>("SELECT COUNT(*) AS n FROM assertions WHERE (subject_id = ? OR object_entity_id = ?) AND status != 'deleted'", e, e);
    if ((used?.n ?? 0) === 0) nE += await deleteEntityRow(ctx, e);
  }
  await ctx.db.run("UPDATE source_records SET content_enc = NULL, deleted_at = ? WHERE id = ?", ctx.clock.now(), sourceId);
  await tombstone(ctx, sourceId, "source");
  return { assertions: nA, items: nI, entities: nE, media: 0, description: "everything saved from that message" };
}

async function deleteEntityRow(ctx: AppContext, id: string): Promise<number> {
  const now = ctx.clock.now();
  await ctx.db.batch([
    ctx.db.prepare(
      "UPDATE entities SET status = 'deleted', label_enc = ?, description_enc = NULL, attributes_enc = NULL, deleted_at = ?, version = version + 1, updated_at = ? WHERE id = ?",
      await ctx.crypto.encrypt("(deleted)", "entity"),
      now,
      now,
      id,
    ),
    ctx.db.prepare("UPDATE entity_aliases SET status = 'removed', alias_enc = '' WHERE entity_id = ?", id),
  ]);
  await tombstone(ctx, id, "entity");
  await purgeDerived(ctx, [id]);
  return 1;
}

/** Forget an entity: its facts (as subject or object), linked secretary items, aliases, media. */
export async function forgetEntity(ctx: AppContext, label: string): Promise<ForgetResult | { ambiguous: string[] } | null> {
  const r = await findEntity(ctx, label);
  if (r.kind === "none") return null;
  if (r.kind === "ambiguous") return { ambiguous: r.candidates.map((c) => c.label) };
  const e = r.entity;
  const a = await ctx.db.all<{ id: string; source_id: string | null }>(
    "SELECT id, source_id FROM assertions WHERE (subject_id = ? OR object_entity_id = ?) AND status != 'deleted'",
    e.id,
    e.id,
  );
  const i = await ctx.db.all<{ id: string; source_id: string | null }>(
    "SELECT id, source_id FROM secretary_items WHERE (person_id = ? OR project_id = ?) AND deleted_at IS NULL",
    e.id,
    e.id,
  );
  const nA = await deleteAssertions(
    ctx,
    a.map((x) => x.id),
    "forget_entity",
  );
  const nI = await deleteItems(
    ctx,
    i.map((x) => x.id),
    "forget_entity",
  );
  const nM = await deleteMediaFor(ctx, e.id);
  await deleteEntityRow(ctx, e.id);
  for (const s of new Set([...a, ...i].map((x) => x.source_id).filter((x): x is string => Boolean(x)))) await deleteSourceIfUnused(ctx, s);
  return { assertions: nA, items: nI, entities: 1, media: nM, description: `everything about ${e.label}` };
}

export async function forgetText(ctx: AppContext, target: string | null): Promise<string> {
  if (!target) {
    const r = await forgetLastCapture(ctx);
    return r.assertions + r.items === 0
      ? r.description
      : `Forgot ${r.description} (${r.assertions + r.items} item${r.assertions + r.items === 1 ? "" : "s"}), including search entries. Provider and backup copies aren't affected.`;
  }
  const r = await forgetEntity(ctx, target);
  if (!r) return `I don't have anything recorded about ${cleanLabel(target)}.`;
  if ("ambiguous" in r) return `Which one should I forget: ${r.ambiguous.map((l, i) => `${i + 1}) ${l}`).join(" ")}? Reply FORGET with the full name.`;
  return `Forgot ${r.description}: ${r.assertions} fact${r.assertions === 1 ? "" : "s"}, ${r.items} related item${r.items === 1 ? "" : "s"}${r.media ? `, ${r.media} photo${r.media === 1 ? "" : "s"}` : ""}, and search entries. Provider and backup copies aren't affected.`;
}
