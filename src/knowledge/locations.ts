import type { AppContext } from "../context";
import { formatDateTime, formatDate } from "../domain/time";
import { assertionsFor, closeAssertion, decryptExcerpt, decryptValue, getEntity, insertAssertion, type AssertionRow, type Entity } from "./store";

/**
 * Physical location model. `located_in` edges (item → container entity, or a free-text phrase)
 * carry effective_from/effective_to. Current location is derived by following current edges
 * upward, so moving a container moves its contents; an item removed from a container (edge
 * closed) no longer follows it. Historical queries use the edges valid at that time.
 *
 * Epistemic rules:
 *  - "maybe it's in the bag" → `tentative` edge; never overwrites a confirmed current edge.
 *  - "not in the drawer" → retracts a matching current edge; does not invent a replacement.
 *  - a late report about an earlier time is stored as historical if a newer edge exists.
 *  - lending closes the containment edge and opens `lent_to`; a return closes `lent_to` only.
 */

const MAX_DEPTH = 8;

export interface PlaceInput {
  itemId: string;
  containerId: string | null;
  phrase: string | null;
  modality: "actual" | "possible";
  effectiveFrom: number;
  sourceId: string;
  excerpt: string;
  extractionKey: string;
  temporary?: boolean;
}

export type PlaceResult = { kind: "current" | "tentative" | "historical" | "unchanged"; assertionId?: string } | { kind: "rejected"; reason: "cycle" | "self" };

function validAt(a: AssertionRow, t: number): boolean {
  return a.effective_from <= t && (a.effective_to === null || a.effective_to > t) && (a.status === "current" || a.status === "historical");
}

async function currentEdges(ctx: AppContext, itemId: string): Promise<AssertionRow[]> {
  return assertionsFor(ctx, itemId, "located_in", ["current"]);
}

/** Containers above `entityId` by current edges (bounded, cycle-safe). */
export async function ancestors(ctx: AppContext, entityId: string, at?: number): Promise<string[]> {
  const out: string[] = [];
  let cursor: string | null = entityId;
  const seen = new Set<string>([entityId]);
  for (let i = 0; cursor && i < MAX_DEPTH; i++) {
    const edges: AssertionRow[] =
      at === undefined ? await currentEdges(ctx, cursor) : (await assertionsFor(ctx, cursor, "located_in", ["current", "historical"])).filter((a) => validAt(a, at));
    const next: string | null = edges[0]?.object_entity_id ?? null;
    if (!next || seen.has(next)) break;
    out.push(next);
    seen.add(next);
    cursor = next;
  }
  return out;
}

export async function placeItem(ctx: AppContext, p: PlaceInput): Promise<PlaceResult> {
  if (p.containerId === p.itemId) return { kind: "rejected", reason: "self" };
  if (p.containerId && (await ancestors(ctx, p.containerId)).includes(p.itemId)) return { kind: "rejected", reason: "cycle" };
  const base = {
    extractionKey: p.extractionKey,
    subjectId: p.itemId,
    predicate: "located_in",
    objectEntityId: p.containerId,
    value: p.containerId ? null : p.phrase,
    valueType: p.containerId ? "entity" : "phrase",
    sourceId: p.sourceId,
    excerpt: p.excerpt,
    effectiveFrom: p.effectiveFrom,
    scopeKey: p.temporary ? "temporary" : null,
  };
  if (p.modality === "possible") {
    const r = await insertAssertion(ctx, { ...base, evidenceType: "tentative", modality: "possible", status: "tentative" });
    return { kind: "tentative", assertionId: r.id };
  }
  const current = (await currentEdges(ctx, p.itemId))[0] ?? null;
  if (current && current.effective_from > p.effectiveFrom) {
    // Late report about an earlier time: keep as history, do not displace the newer report.
    const r = await insertAssertion(ctx, { ...base, evidenceType: "explicit_report", status: "historical", effectiveTo: current.effective_from });
    return { kind: "historical", assertionId: r.id };
  }
  if (current && current.object_entity_id === p.containerId && p.containerId !== null) {
    const r = await insertAssertion(ctx, { ...base, evidenceType: "explicit_report", status: "historical", effectiveTo: p.effectiveFrom });
    return { kind: "unchanged", assertionId: r.id };
  }
  const inserted = await insertAssertion(ctx, { ...base, evidenceType: "explicit_report", status: "current", supersedesId: current?.id ?? null });
  if (inserted.created) {
    if (current) await closeAssertion(ctx, current, p.effectiveFrom, "historical", "moved");
    for (const t of await assertionsFor(ctx, p.itemId, "located_in", ["tentative"])) await closeAssertion(ctx, t, p.effectiveFrom, "historical", "superseded_by_report");
    for (const l of await assertionsFor(ctx, p.itemId, "lent_to", ["current"])) await closeAssertion(ctx, l, p.effectiveFrom, "historical", "placed");
  }
  return { kind: "current", assertionId: inserted.id };
}

export async function removeItem(
  ctx: AppContext,
  itemId: string,
  fromId: string | null,
  at: number,
  sourceId: string,
  excerpt: string,
  key: string,
): Promise<"removed" | "not_there"> {
  const current = (await currentEdges(ctx, itemId))[0];
  if (!current || (fromId && current.object_entity_id !== fromId && !(await ancestors(ctx, current.object_entity_id ?? "")).includes(fromId))) return "not_there";
  await insertAssertion(ctx, {
    extractionKey: key,
    subjectId: itemId,
    predicate: "removed_from",
    objectEntityId: current.object_entity_id,
    evidenceType: "explicit_report",
    sourceId,
    excerpt,
    effectiveFrom: at,
    status: "current",
  });
  await closeAssertion(ctx, current, at, "historical", "removed");
  return "removed";
}

/** "Not in the drawer": retract a matching current or tentative edge; record the negation. */
export async function reportAbsent(
  ctx: AppContext,
  itemId: string,
  locationId: string | null,
  phrase: string,
  at: number,
  sourceId: string,
  excerpt: string,
  key: string,
): Promise<"retracted" | "recorded"> {
  let retracted = false;
  for (const a of [...(await currentEdges(ctx, itemId)), ...(await assertionsFor(ctx, itemId, "located_in", ["tentative"]))]) {
    const chain = a.object_entity_id ? [a.object_entity_id, ...(await ancestors(ctx, a.object_entity_id))] : [];
    if (locationId && chain.includes(locationId)) {
      await closeAssertion(ctx, a, at, "retracted", "reported_absent");
      retracted = true;
    }
  }
  await insertAssertion(ctx, {
    extractionKey: key,
    subjectId: itemId,
    predicate: "not_located_in",
    objectEntityId: locationId,
    value: locationId ? null : phrase,
    polarity: "negated",
    evidenceType: "explicit_report",
    sourceId,
    excerpt,
    effectiveFrom: at,
    status: "current",
  });
  return retracted ? "retracted" : "recorded";
}

export async function lendItem(ctx: AppContext, itemId: string, personId: string, at: number, sourceId: string, excerpt: string, key: string): Promise<void> {
  const r = await insertAssertion(ctx, {
    extractionKey: key,
    subjectId: itemId,
    predicate: "lent_to",
    objectEntityId: personId,
    evidenceType: "explicit_report",
    sourceId,
    excerpt,
    effectiveFrom: at,
    status: "current",
  });
  if (r.created) for (const c of await currentEdges(ctx, itemId)) await closeAssertion(ctx, c, at, "historical", "lent");
}

export async function returnItem(ctx: AppContext, itemId: string, at: number, sourceId: string, excerpt: string, key: string): Promise<"returned" | "not_lent"> {
  const lent = await assertionsFor(ctx, itemId, "lent_to", ["current"]);
  if (lent.length === 0) return "not_lent";
  await insertAssertion(ctx, {
    extractionKey: key,
    subjectId: itemId,
    predicate: "returned_by",
    objectEntityId: lent[0]!.object_entity_id,
    evidenceType: "explicit_report",
    sourceId,
    excerpt,
    effectiveFrom: at,
    status: "current",
  });
  for (const l of lent) await closeAssertion(ctx, l, at, "historical", "returned");
  return "returned";
}

export interface PathStep {
  label: string;
  entityId: string | null;
  assertion: AssertionRow;
}

export interface LocationView {
  item: Entity;
  path: PathStep[];
  tentative: Array<{ label: string; assertion: AssertionRow }>;
  lentTo: { label: string; assertion: AssertionRow } | null;
  returned: AssertionRow | null;
  absent: Array<{ label: string; assertion: AssertionRow }>;
  lastKnown: { label: string; assertion: AssertionRow } | null;
  evidenceIds: string[];
  sourceIds: string[];
}

async function edgeLabel(ctx: AppContext, a: AssertionRow): Promise<string> {
  if (a.object_entity_id) return (await getEntity(ctx, a.object_entity_id))?.label ?? "(deleted)";
  return (await decryptValue(ctx, a)) ?? "(unknown)";
}

export async function locationView(ctx: AppContext, item: Entity, at?: number): Promise<LocationView> {
  const path: PathStep[] = [];
  let cursor: string | null = item.id;
  const seen = new Set<string>();
  for (let i = 0; cursor && i < MAX_DEPTH && !seen.has(cursor); i++) {
    seen.add(cursor);
    const edges: AssertionRow[] =
      at === undefined ? await currentEdges(ctx, cursor) : (await assertionsFor(ctx, cursor, "located_in", ["current", "historical"])).filter((a) => validAt(a, at));
    const e = edges[0];
    if (!e) break;
    path.push({ label: await edgeLabel(ctx, e), entityId: e.object_entity_id, assertion: e });
    cursor = e.object_entity_id;
  }
  const tentative = [];
  for (const t of at === undefined ? await assertionsFor(ctx, item.id, "located_in", ["tentative"]) : []) tentative.push({ label: await edgeLabel(ctx, t), assertion: t });
  const lent = at === undefined ? (await assertionsFor(ctx, item.id, "lent_to", ["current"]))[0] : undefined;
  const returned = at === undefined ? ((await assertionsFor(ctx, item.id, "returned_by", ["current"]))[0] ?? null) : null;
  const absent = [];
  for (const n of at === undefined ? await assertionsFor(ctx, item.id, "not_located_in", ["current"]) : []) absent.push({ label: await edgeLabel(ctx, n), assertion: n });
  let lastKnown = null;
  if (path.length === 0 && at === undefined) {
    const hist = (await assertionsFor(ctx, item.id, "located_in", ["historical", "retracted"]))[0];
    if (hist) lastKnown = { label: await edgeLabel(ctx, hist), assertion: hist };
  }
  const all = [
    ...path.map((p) => p.assertion),
    ...tentative.map((t) => t.assertion),
    ...(lent ? [lent] : []),
    ...absent.map((a) => a.assertion),
    ...(lastKnown ? [lastKnown.assertion] : []),
  ];
  return {
    item,
    path,
    tentative,
    lentTo: lent ? { label: (await getEntity(ctx, lent.object_entity_id ?? ""))?.label ?? "someone", assertion: lent } : null,
    returned,
    absent,
    lastKnown,
    evidenceIds: all.map((a) => a.id),
    sourceIds: [...new Set(all.map((a) => a.source_id).filter((s): s is string => Boolean(s)))],
  };
}

/** Deterministic, freshness-qualified location answer. Della reports what it was told; it cannot see. */
export async function renderLocation(_ctx: AppContext, v: LocationView, tz: string, at?: number): Promise<string> {
  const name = v.item.label;
  if (at !== undefined) {
    if (v.path.length === 0) return `No location recorded for ${name} on ${formatDate(at, tz)}.`;
    return `On ${formatDate(at, tz)}, ${name} was reported in the ${v.path.map((p) => p.label).join(", in the ")}.`;
  }
  if (v.lentTo) return `${cap(name)}: lent to ${v.lentTo.label} (reported ${formatDate(v.lentTo.assertion.effective_from, tz)}).`;
  const parts: string[] = [];
  if (v.path.length > 0) {
    const first = v.path[0]!;
    const chain = v.path.map((p) => p.label);
    const temp = first.assertion.scope_key === "temporary" ? " (temporarily)" : "";
    const support = first.assertion.excerpt_enc ? "" : " Supporting text has expired; this is from an older record.";
    parts.push(`${cap(name)}: last reported in the ${chain.join(", in the ")}${temp} (updated ${formatDate(first.assertion.recorded_at, tz)}).${support}`);
  } else if (v.returned) {
    parts.push(`${cap(name)}: returned (reported ${formatDate(v.returned.effective_from, tz)}); where it was put back hasn't been reported.`);
  } else if (v.absent.length > 0) {
    parts.push(
      `${cap(name)}: not in the ${v.absent.map((a) => a.label).join(" or the ")} (reported ${formatDate(v.absent[0]!.assertion.effective_from, tz)}). No current location recorded.`,
    );
  } else if (v.lastKnown) {
    parts.push(`${cap(name)}: no current location recorded. Previously in the ${v.lastKnown.label}.`);
  } else if (v.tentative.length === 0) {
    parts.push(`${cap(name)}: no location recorded yet.`);
  }
  if (v.tentative.length > 0) {
    const t = v.tentative[0]!;
    parts.push(`${v.path.length ? "Also, unconfirmed" : `${cap(name)}: unconfirmed`}: you said it might be in the ${t.label} (${formatDate(t.assertion.effective_from, tz)}).`);
  }
  return parts.join(" ");
}

export async function containerContents(ctx: AppContext, containerId: string, at?: number): Promise<Array<{ entity: Entity; assertion: AssertionRow }>> {
  const rows = await ctx.db.all<AssertionRow>(
    "SELECT * FROM assertions WHERE object_entity_id = ? AND predicate = 'located_in' AND status IN ('current','historical') ORDER BY effective_from DESC",
    containerId,
  );
  const out = [];
  for (const a of rows) {
    if (at === undefined ? a.status !== "current" : !validAt(a, at)) continue;
    const e = await getEntity(ctx, a.subject_id);
    if (e) out.push({ entity: e, assertion: a });
  }
  return out;
}

export async function locationHistory(ctx: AppContext, itemId: string, tz: string): Promise<string[]> {
  const rows = (await assertionsFor(ctx, itemId, "located_in", ["current", "historical", "retracted"])).sort((a, b) => a.effective_from - b.effective_from);
  const out = [];
  for (const a of rows) {
    const label = await edgeLabel(ctx, a);
    const end = a.effective_to ? formatDateTime(a.effective_to, tz) : "now";
    out.push(`${label} (${formatDateTime(a.effective_from, tz)} to ${end}${a.status === "retracted" ? ", reported absent" : ""})`);
  }
  return out;
}

export async function excerptsFor(ctx: AppContext, assertions: AssertionRow[]): Promise<string[]> {
  const out = [];
  for (const a of assertions) {
    const x = await decryptExcerpt(ctx, a);
    if (x) out.push(x);
  }
  return out;
}

function cap(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}
