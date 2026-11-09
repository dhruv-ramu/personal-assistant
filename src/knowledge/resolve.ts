import type { AppContext } from "../context";
import { PHYSICAL, activeEntities, blindIndex, createEntity, getEntity, labelTokens, normalizeLabel, type Entity, type EntityType } from "./store";

export type Resolution = { kind: "found"; entity: Entity } | { kind: "ambiguous"; candidates: Entity[] } | { kind: "none" };

function compatible(types: ReadonlySet<EntityType> | null, t: EntityType): boolean {
  return !types || types.has(t);
}

/**
 * Conservative resolution. 1) exact blind-index match on label/alias; 2) the query's tokens are
 * a subset of exactly one entity's label tokens ("the adapter" → "black USB-C adapter").
 * Several candidates → ambiguous (ask). Alias overlap never merges entities.
 */
export async function findEntity(ctx: AppContext, label: string, types: ReadonlySet<EntityType> | null = null): Promise<Resolution> {
  const norm = normalizeLabel(label);
  if (!norm) return { kind: "none" };
  const bidx = await blindIndex(ctx, norm);
  const hits = await ctx.db.all<{ entity_id: string }>("SELECT DISTINCT entity_id FROM entity_aliases WHERE bidx = ? AND status = 'active'", bidx);
  const exact = new Map<string, Entity>();
  for (const h of hits) {
    const e = await getEntity(ctx, h.entity_id);
    if (e && e.status === "active" && compatible(types, e.type)) exact.set(e.id, e);
  }
  if (exact.size === 1) return { kind: "found", entity: [...exact.values()][0]! };
  if (exact.size > 1) return { kind: "ambiguous", candidates: [...exact.values()] };
  const q = labelTokens(label);
  if (q.length === 0) return { kind: "none" };
  const candidates = (await activeEntities(ctx, types ?? undefined)).filter((e) => {
    const t = new Set(labelTokens(e.label));
    return q.every((w) => t.has(w));
  });
  if (candidates.length === 1) return { kind: "found", entity: candidates[0]! };
  if (candidates.length > 1) return { kind: "ambiguous", candidates: candidates.slice(0, 5) };
  return { kind: "none" };
}

export type ResolveOrCreate = { kind: "found" | "created"; entity: Entity } | { kind: "ambiguous"; candidates: Entity[] };

export async function resolveOrCreate(ctx: AppContext, label: string, type: EntityType, keyBase: string, sourceId: string | null): Promise<ResolveOrCreate> {
  const types = PHYSICAL.has(type) ? PHYSICAL : new Set<EntityType>([type]);
  const r = await findEntity(ctx, label, types);
  if (r.kind === "found") return r;
  if (r.kind === "ambiguous") return r;
  const entity = await createEntity(ctx, { key: `${keyBase}:${type}:${normalizeLabel(label)}`, type, label: cleanLabel(label), sourceId });
  return { kind: "created", entity };
}

export function cleanLabel(label: string): string {
  return label
    .replace(/^(my|the|a|an|our)\s+/i, "")
    .replace(/[.,;:!?]+$/, "")
    .trim()
    .slice(0, 120);
}
