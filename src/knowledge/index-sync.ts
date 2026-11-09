import type { AppContext } from "../context";
import { featureOn, getExtSettings } from "../ext/settings";
import { sha256Hex } from "../security/crypto";
import type { JobOutcome } from "../services/jobs";
import { reserveUsage } from "../services/usage";
import { hydrate } from "./retrieval";

/**
 * Derived semantic index maintenance. Canonical D1 rows mark themselves dirty; this job embeds a
 * bounded batch, skips unchanged content (hash), and propagates deletions. An index or embedding
 * outage only delays semantic recall — canonical memory and reminders are unaffected.
 */
export async function handleIndexSync(ctx: AppContext): Promise<JobOutcome> {
  const ext = await getExtSettings(ctx.db);
  if (!featureOn(ctx, ext, "semantic")) return { status: "skipped", result: { reason: "semantic_off" } };
  const rows = await ctx.db.all<{ object_id: string; object_type: string; canonical_version: number; deleted: number }>(
    "SELECT object_id, object_type, canonical_version, deleted FROM index_state WHERE dirty = 1 AND retries < 5 ORDER BY updated_at LIMIT 40",
  );
  const now = ctx.clock.now();
  const toEmbed: Array<{ id: string; type: string; text: string; hash: string; version: number }> = [];
  const toDelete: string[] = [];
  for (const r of rows) {
    const claim = r.deleted ? null : await hydrate(ctx, r.object_id);
    if (!claim) {
      toDelete.push(r.object_id);
      continue;
    }
    const hash = await sha256Hex(claim.text);
    const existing = await ctx.db.first<{ content_hash: string }>("SELECT content_hash FROM semantic_vectors WHERE object_id = ?", r.object_id);
    if (existing?.content_hash === hash && ctx.ext.semantic.name === "d1") {
      await ctx.db.run("UPDATE index_state SET dirty = 0, indexed_version = ?, updated_at = ? WHERE object_id = ?", r.canonical_version, now, r.object_id);
      continue;
    }
    toEmbed.push({ id: r.object_id, type: r.object_type, text: claim.text, hash, version: r.canonical_version });
  }
  try {
    if (toDelete.length) await ctx.ext.semantic.delete(toDelete);
    for (const id of toDelete) await ctx.db.run("UPDATE index_state SET dirty = 0, updated_at = ? WHERE object_id = ?", now, id);
    if (toEmbed.length) {
      if (!(await reserveUsage(ctx, `emb:${now}:${toEmbed[0]!.id}`, "embeddings", toEmbed.length, { limit: ext.limit_embeddings_per_day })))
        return { status: "skipped", result: { reason: "embedding_budget" } };
      const { vectors } = await ctx.ext.embeddings.embed(toEmbed.map((t) => t.text));
      await ctx.ext.semantic.upsert(toEmbed.map((t, i) => ({ id: t.id, type: t.type, vector: vectors[i]!, model: ctx.ext.embeddings.model, contentHash: t.hash })));
      for (const t of toEmbed) {
        // Only mark clean if no newer canonical change happened meanwhile.
        await ctx.db.run(
          "UPDATE index_state SET dirty = 0, indexed_version = ?, index_kind = ?, updated_at = ? WHERE object_id = ? AND canonical_version = ?",
          t.version,
          ctx.ext.semantic.name,
          now,
          t.id,
          t.version,
        );
      }
    }
  } catch (err) {
    for (const t of [...toEmbed.map((x) => x.id), ...toDelete])
      await ctx.db.run("UPDATE index_state SET retries = retries + 1, last_error = ?, updated_at = ? WHERE object_id = ?", String(err).slice(0, 120), now, t);
    return { status: "retry", error: "index sync failed", delayMs: 5 * 60_000 };
  }
  return { status: "succeeded", result: { embedded: toEmbed.length, deleted: toDelete.length } };
}
