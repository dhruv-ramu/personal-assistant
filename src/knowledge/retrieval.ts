import type { AppContext } from "../context";
import { parseJson } from "../db/db";
import { DAY, formatDate } from "../domain/time";
import { featureOn, getExtSettings } from "../ext/settings";
import { newId, sha256Hex } from "../security/crypto";
import { getSettings } from "../services/settings";
import { reserveUsage } from "../services/usage";
import { containerContents, locationHistory, locationView, renderLocation } from "./locations";
import { cleanLabel, findEntity } from "./resolve";
import { getItem, listItems, type SecretaryItem, type SecretaryKind } from "./secretary";
import { PHYSICAL, activeEntities, assertionsFor, decryptExcerpt, decryptValue, getEntity, labelTokens, type AssertionRow, type Entity } from "./store";

export interface Claim {
  id: string;
  kind: "assertion" | "secretary" | "entity";
  text: string;
  date: number;
  evidence: string;
  sourceId: string | null;
}

export interface EvidencePacket {
  query: string;
  claims: Claim[];
  gaps: string[];
}

export interface Answer {
  text: string;
  packet: EvidencePacket;
  question?: boolean;
}

async function remember(ctx: AppContext, query: string, packet: EvidencePacket): Promise<void> {
  const now = ctx.clock.now();
  await ctx.db.run(
    "INSERT INTO retrieval_evidence (id, query_hash, assertion_ids_json, source_ids_json, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
    newId("rev"),
    await sha256Hex(query),
    JSON.stringify(packet.claims.map((c) => ({ id: c.id, kind: c.kind }))),
    JSON.stringify([...new Set(packet.claims.map((c) => c.sourceId).filter(Boolean))]),
    now,
    now + 7 * DAY,
  );
}

async function tombstoned(ctx: AppContext, id: string): Promise<boolean> {
  return Boolean(await ctx.db.first("SELECT object_id FROM deletion_tombstones WHERE object_id = ?", id));
}

function claimText(subject: string, type: string, a: AssertionRow, obj: string): string {
  const not = a.polarity === "negated";
  const words = a.predicate.replace(/^(attr|pref):/, "").replace(/_/g, " ");
  const who = type === "owner" ? "you" : subject;
  if (a.predicate.startsWith("pref:")) return `${who} ${obj || "prefer"} ${words}`;
  if (a.predicate.startsWith("attr:")) return `${type === "owner" ? "your" : `${subject}'s`} ${words}${not ? " is not" : ":"} ${obj}`;
  if (a.predicate === "located_in") return `${subject} ${not ? "not in" : "in"} ${obj}`;
  return `${subject} ${words}${not ? " (not)" : ""} ${obj}`.trim();
}

/** Canonical hydration of any index hit; deleted, retracted, or tombstoned records never come back. */
export async function hydrate(ctx: AppContext, id: string): Promise<Claim | null> {
  if (await tombstoned(ctx, id)) return null;
  if (id.startsWith("asr_")) {
    const a = await ctx.db.first<AssertionRow>("SELECT * FROM assertions WHERE id = ? AND status IN ('current','tentative','disputed')", id);
    if (!a) return null;
    const subj = await getEntity(ctx, a.subject_id);
    if (!subj) return null;
    const obj = a.object_entity_id ? (await getEntity(ctx, a.object_entity_id))?.label : await decryptValue(ctx, a);
    return { id, kind: "assertion", text: claimText(subj.label, subj.type, a, obj ?? ""), date: a.effective_from, evidence: a.evidence_type, sourceId: a.source_id };
  }
  if (id.startsWith("sec_")) {
    const r = await ctx.db.first<{ deleted_at: number | null }>("SELECT deleted_at FROM secretary_items WHERE id = ?", id);
    if (!r || r.deleted_at) return null;
    const item = (await listItemsById(ctx, id))!;
    return { id, kind: "secretary", text: `${item.kind.replace("_", " ")}: ${item.title}`, date: item.created_at, evidence: item.evidence_type, sourceId: item.source_id };
  }
  if (id.startsWith("ent_")) {
    const e = await getEntity(ctx, id);
    return e && e.status === "active" ? { id, kind: "entity", text: e.label, date: e.created_at, evidence: "explicit_report", sourceId: e.source_id } : null;
  }
  return null;
}

async function listItemsById(ctx: AppContext, id: string): Promise<SecretaryItem | null> {
  return getItem(ctx, id);
}

function evidenceLabel(e: string): string {
  return e === "explicit_report"
    ? "you said"
    : e === "tentative"
      ? "unconfirmed"
      : e === "confirmed_external_record"
        ? "from a connected record"
        : e === "assistant_proposal"
          ? "my suggestion"
          : e.replace("_", " ");
}

async function itemAnswer(ctx: AppContext, subject: string | null, kind: "item_location" | "container_contents" | "item_history"): Promise<Answer> {
  const s = await getSettings(ctx.db);
  const tz = s.timezone;
  const q = subject ?? "";
  const packet: EvidencePacket = { query: `${kind}:${q}`, claims: [], gaps: [] };
  const r = await findEntity(ctx, q, PHYSICAL);
  if (r.kind === "none") {
    packet.gaps.push("no matching item");
    return { text: `I don't have anything recorded about ${cleanLabel(q) || "that"}. (I only know locations you've told me.)`, packet };
  }
  if (r.kind === "ambiguous") return { text: `Which one: ${r.candidates.map((e, i) => `${i + 1}) ${e.label}`).join(" ")}?`, packet, question: true };
  const e = r.entity;
  if (kind === "container_contents") {
    const items = await containerContents(ctx, e.id);
    for (const it of items)
      packet.claims.push({
        id: it.assertion.id,
        kind: "assertion",
        text: `${it.entity.label} in ${e.label}`,
        date: it.assertion.effective_from,
        evidence: it.assertion.evidence_type,
        sourceId: it.assertion.source_id,
      });
    await remember(ctx, packet.query, packet);
    if (items.length === 0) return { text: `Nothing is recorded as currently in the ${e.label}.`, packet };
    return { text: `In the ${e.label}: ${items.map((it) => `${it.entity.label} (since ${formatDate(it.assertion.effective_from, tz)})`).join("; ")}.`, packet };
  }
  if (kind === "item_history") {
    const h = await locationHistory(ctx, e.id, tz);
    for (const a of await assertionsFor(ctx, e.id, "located_in", ["current", "historical", "retracted"]))
      packet.claims.push({ id: a.id, kind: "assertion", text: a.predicate, date: a.effective_from, evidence: a.evidence_type, sourceId: a.source_id });
    await remember(ctx, packet.query, packet);
    const label = e.label.charAt(0).toUpperCase() + e.label.slice(1);
    return { text: h.length ? `${label} history: ${h.join("; ")}.` : `No location history for ${e.label}.`, packet };
  }
  const v = await locationView(ctx, e);
  for (const id of v.evidenceIds) {
    const a = await ctx.db.first<AssertionRow>("SELECT * FROM assertions WHERE id = ?", id);
    if (a) packet.claims.push({ id, kind: "assertion", text: a.predicate, date: a.effective_from, evidence: a.evidence_type, sourceId: a.source_id });
  }
  await remember(ctx, packet.query, packet);
  return { text: await renderLocation(ctx, v, tz), packet };
}

function itemLine(i: SecretaryItem, tz: string, people: Map<string, string>): string {
  const who = i.person_id ? people.get(i.person_id) : null;
  const due = i.due_at ? ` (by ${formatDate(i.due_at, tz)})` : "";
  switch (i.kind) {
    case "promise":
      return `${i.title} for ${who ?? "someone"}${due}${i.evidence_type === "assistant_proposal" ? " [my suggestion]" : ""}`;
    case "waiting_for":
      return `${who ?? "someone"}: ${i.title}${i.check_at ? ` (check ${formatDate(i.check_at, tz)})` : ""}`;
    case "question":
      return `${i.title}${who ? ` (for ${who})` : ""}`;
    case "decision":
      return `${i.title}${i.data.rationale ? ` because ${String(i.data.rationale)}` : ""} (${formatDate(i.created_at, tz)})`;
    case "prediction":
      return i.data.actual !== undefined
        ? `${i.title}: estimated ${i.data.value} ${i.data.unit}, actual ${i.data.actual} ${i.data.actualUnit} (${i.data.measure === "active" ? "active time" : i.data.measure === "elapsed" ? "elapsed time" : "measure unspecified"})`
        : `${i.title}: estimated ${i.data.value} ${i.data.unit} (no actual yet)`;
    case "admin_item": {
      const paid = ((i.data.payments as Array<{ amount: number }>) ?? []).reduce((n, p) => n + p.amount, 0);
      return `${i.title}${i.data.amount !== null && i.data.amount !== undefined ? ` (${paid} of ${i.data.amount} received)` : ""}${due}`;
    }
    case "recruiting":
      return `${i.title}: ${String(i.data.stage).replace("_", " ")}${i.due_at ? ` (${i.data.deadlineKind === "self_imposed" ? "your target" : "deadline"} ${formatDate(i.due_at, tz)})` : ""}`;
    default:
      return i.title;
  }
}

const LIST_KINDS: Record<string, { kind: SecretaryKind; label: string; status: string[] }> = {
  promises: { kind: "promise", label: "Promises", status: ["open"] },
  waiting_for: { kind: "waiting_for", label: "Waiting on", status: ["open"] },
  questions: { kind: "question", label: "Open questions", status: ["open"] },
  decisions: { kind: "decision", label: "Decisions", status: ["open"] },
  predictions: { kind: "prediction", label: "Estimates", status: ["open", "observed"] },
  ideas: { kind: "idea", label: "Parked ideas", status: ["open"] },
  admin: { kind: "admin_item", label: "Admin", status: ["open"] },
  recruiting: { kind: "recruiting", label: "Recruiting", status: ["interested", "applied", "referral_requested", "interviewing", "offer"] },
  accomplishments: { kind: "accomplishment", label: "Accomplishments", status: ["open"] },
};

async function peopleMap(ctx: AppContext, items: SecretaryItem[]): Promise<Map<string, string>> {
  const m = new Map<string, string>();
  for (const i of items) if (i.person_id && !m.has(i.person_id)) m.set(i.person_id, (await getEntity(ctx, i.person_id))?.label ?? "someone");
  return m;
}

/** Resume bullets only from recorded fields; team results are labelled, never claimed personally. */
export function resumeBullet(i: SecretaryItem): string {
  const metric =
    typeof i.data.metric === "number"
      ? ` (${i.data.metric}${i.data.unit ? `${i.data.unit === "%" ? "" : " "}${i.data.unit}` : ""}${i.data.baseline ? ` vs. ${i.data.baseline}` : ""})`
      : "";
  const role = i.data.role ? `${String(i.data.role)}: ` : "";
  const team = i.data.team ? " [team result]" : "";
  return `${role}${i.title}${metric}${team}${i.data.confidential ? " [confidential]" : ""}`;
}

export async function answerQuery(ctx: AppContext, kind: string, subject: string | null): Promise<Answer> {
  const s = await getSettings(ctx.db);
  const tz = s.timezone;
  if (kind === "item_location" || kind === "container_contents" || kind === "item_history") return itemAnswer(ctx, subject, kind);
  if (kind === "why") return explainLast(ctx);
  if (kind === "last_capture") {
    const r = await ctx.db.first<{ summary_enc: string | null }>("SELECT summary_enc FROM extraction_runs ORDER BY created_at DESC, rowid DESC LIMIT 1");
    const d = parseJson<{ saved: string[]; rejected: Array<{ kind: string; reason: string }> }>(r?.summary_enc ? await ctx.crypto.decrypt(r.summary_enc, "extraction") : null, {
      saved: [],
      rejected: [],
    });
    return {
      text: d.saved.length
        ? `From your last note I saved: ${d.saved.join("; ")}.${d.rejected.length ? ` Skipped ${d.rejected.length} unsupported item(s).` : ""}`
        : "I didn't save anything from your last message.",
      packet: { query: kind, claims: [], gaps: [] },
    };
  }
  if (kind === "resume_bullets") {
    const items = (await listItems(ctx, "accomplishment", { status: ["open"] })).filter((i) => !i.data.confidential);
    return {
      text: items.length
        ? `From your evidence locker: ${items
            .slice(0, 4)
            .map((i) => `• ${resumeBullet(i)}`)
            .join(" ")} (Only what you recorded; edit before using.)`
        : "No accomplishments recorded yet.",
      packet: {
        query: kind,
        claims: items.map((i) => ({ id: i.id, kind: "secretary", text: i.title, date: i.created_at, evidence: i.evidence_type, sourceId: i.source_id })),
        gaps: [],
      },
    };
  }
  const list = LIST_KINDS[kind];
  if (list) {
    let personId: string | undefined;
    let shown = subject ? cleanLabel(subject) : null;
    if (subject) {
      const p = await findEntity(ctx, subject, new Set(["person", "organization", "topic", "project"]));
      if (p.kind === "found") {
        personId = p.entity.id;
        shown = p.entity.label;
      } else if (p.kind === "none")
        return { text: `I don't have anyone or anything called ${cleanLabel(subject)} recorded.`, packet: { query: kind, claims: [], gaps: ["unknown subject"] } };
    }
    const items = await listItems(ctx, list.kind, { status: list.status, personId, limit: 8 });
    const people = await peopleMap(ctx, items);
    const packet: EvidencePacket = {
      query: `${kind}:${subject ?? ""}`,
      claims: items.map((i) => ({ id: i.id, kind: "secretary", text: i.title, date: i.created_at, evidence: i.evidence_type, sourceId: i.source_id })),
      gaps: [],
    };
    await remember(ctx, packet.query, packet);
    if (items.length === 0) return { text: `${list.label}${shown ? ` (${shown})` : ""}: none recorded.`, packet };
    return { text: `${list.label}${shown ? ` (${shown})` : ""}: ${items.map((i, k) => `${k + 1}) ${itemLine(i, tz, people)}`).join(" ")}`, packet };
  }
  if (kind === "about" || kind === "learned_about_me") return aboutAnswer(ctx, kind === "learned_about_me" ? null : subject);
  return search(ctx, subject ?? "");
}

async function aboutAnswer(ctx: AppContext, subject: string | null): Promise<Answer> {
  const s = await getSettings(ctx.db);
  const tz = s.timezone;
  let entity: Entity | null = null;
  if (subject) {
    const r = await findEntity(ctx, subject);
    if (r.kind === "ambiguous")
      return { text: `Which one: ${r.candidates.map((e, i) => `${i + 1}) ${e.label}`).join(" ")}?`, packet: { query: subject, claims: [], gaps: [] }, question: true };
    if (r.kind === "none") return { text: `I have nothing recorded about ${cleanLabel(subject)}.`, packet: { query: subject, claims: [], gaps: ["not found"] } };
    entity = r.entity;
  }
  const rows: AssertionRow[] = entity
    ? await assertionsFor(ctx, entity.id, null, ["current", "tentative", "disputed"])
    : await ctx.db.all<AssertionRow>(
        "SELECT * FROM assertions WHERE status IN ('current','tentative','disputed') AND (predicate LIKE 'pref:%' OR predicate LIKE 'attr:%') ORDER BY recorded_at DESC LIMIT 8",
      );
  const packet: EvidencePacket = { query: `about:${subject ?? "me"}`, claims: [], gaps: [] };
  const lines: string[] = [];
  for (const a of rows.slice(0, 8)) {
    const c = await hydrate(ctx, a.id);
    if (!c) continue;
    packet.claims.push(c);
    lines.push(
      `${c.text} (${evidenceLabel(a.evidence_type)}${a.attributed_to ? `, per ${a.attributed_to}` : ""}${a.status === "disputed" ? ", conflicting reports" : ""}, ${formatDate(a.effective_from, tz)})`,
    );
  }
  if (entity) {
    for (const i of (await listItems(ctx, ["promise", "waiting_for", "question", "interaction"], { status: ["open"], personId: entity.id, limit: 5 })).slice(0, 4)) {
      packet.claims.push({ id: i.id, kind: "secretary", text: i.title, date: i.created_at, evidence: i.evidence_type, sourceId: i.source_id });
      lines.push(`${i.kind.replace("_", " ")}: ${i.title}`);
    }
  }
  await remember(ctx, packet.query, packet);
  if (lines.length === 0)
    return { text: subject ? `I know the name ${entity?.label ?? subject} but have no facts recorded.` : "I haven't saved any facts or preferences about you yet.", packet };
  return { text: `${subject ? `About ${entity!.label}` : "What I've saved about you"}: ${lines.join("; ")}. Ask "why" for sources.`, packet };
}

/** "Why do you think that?": the sources behind the last answer, with dates and labels. */
export async function explainLast(ctx: AppContext): Promise<Answer> {
  const s = await getSettings(ctx.db);
  const last = await ctx.db.first<{ assertion_ids_json: string }>("SELECT assertion_ids_json FROM retrieval_evidence ORDER BY created_at DESC, rowid DESC LIMIT 1");
  const refs = parseJson<Array<{ id: string; kind: string }>>(last?.assertion_ids_json, []);
  const packet: EvidencePacket = { query: "why", claims: [], gaps: [] };
  const lines: string[] = [];
  for (const r of refs.slice(0, 4)) {
    const c = await hydrate(ctx, r.id);
    if (!c) {
      packet.gaps.push(`${r.id} deleted`);
      continue;
    }
    packet.claims.push(c);
    let excerpt: string | null = null;
    if (r.id.startsWith("asr_"))
      excerpt = await decryptExcerpt(ctx, (await ctx.db.first<{ excerpt_enc: string | null }>("SELECT excerpt_enc FROM assertions WHERE id = ?", r.id)) ?? { excerpt_enc: null });
    else if (r.id.startsWith("sec_")) {
      const it = await listItemsById(ctx, r.id);
      excerpt = typeof it?.data.excerpt === "string" ? it.data.excerpt : null;
    }
    const line = excerpt
      ? `${formatDate(c.date, s.timezone)} you said: "${excerpt.slice(0, 120)}"`
      : `${formatDate(c.date, s.timezone)}: ${c.text} (source text no longer retained)`;
    if (!lines.includes(line)) lines.push(line);
  }
  if (lines.length === 0) return { text: "I don't have a recent answer with sources to explain.", packet };
  return { text: `Based on: ${lines.join("; ")}.`, packet };
}

/**
 * Vague recall: bounded keyword matching over decrypted canonical records plus optional semantic
 * candidates; every hit is re-hydrated from D1 so stale/deleted vectors cannot surface.
 */
export async function search(ctx: AppContext, query: string): Promise<Answer> {
  const s = await getSettings(ctx.db);
  const ext = await getExtSettings(ctx.db);
  const q = labelTokens(query).filter((t) => t.length > 2);
  const packet: EvidencePacket = { query: `search:${query}`, claims: [], gaps: [] };
  const scores = new Map<string, number>();
  for (const e of await activeEntities(ctx, undefined, 500)) {
    const t = labelTokens(e.label);
    const hit = q.filter((w) => t.includes(w)).length;
    if (hit) scores.set(e.id, hit);
  }
  const items = await ctx.db.all<{ id: string; title_enc: string }>("SELECT id, title_enc FROM secretary_items WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 500");
  for (const it of items) {
    const t = labelTokens(await ctx.crypto.decrypt(it.title_enc, "secretary"));
    const hit = q.filter((w) => t.includes(w)).length;
    if (hit) scores.set(it.id, (scores.get(it.id) ?? 0) + hit);
  }
  let semantic = "off";
  if (featureOn(ctx, ext, "semantic") && q.length) {
    if (await reserveUsage(ctx, `semq:${packet.query}:${ctx.clock.now()}`, "semantic_queries", 1, { limit: ext.limit_semantic_queries_per_day })) {
      try {
        const { vectors } = await ctx.ext.embeddings.embed([query]);
        for (const h of await ctx.ext.semantic.query(vectors[0]!, 10)) if (h.score > 0.2) scores.set(h.id, (scores.get(h.id) ?? 0) + h.score);
        semantic = "on";
      } catch {
        semantic = "unavailable";
      }
    } else semantic = "budget";
  }
  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  for (const [id] of ranked) {
    const c = await hydrate(ctx, id);
    if (c) packet.claims.push(c);
  }
  await remember(ctx, packet.query, packet);
  const top = packet.claims.slice(0, 3);
  const scope = semantic === "on" ? "keyword + semantic search" : semantic === "unavailable" ? "keyword search only (semantic index unavailable)" : "keyword search";
  if (top.length === 0) return { text: `Nothing matched "${query.slice(0, 60)}" (checked saved items and notes with ${scope}).`, packet };
  return { text: `Closest matches (${scope}): ${top.map((c, i) => `${i + 1}) ${c.text} (${formatDate(c.date, s.timezone)})`).join(" ")}`, packet };
}

/** Validator for any model-written summary: every cited claim must be in the evidence packet. */
export function validateCitations(packet: EvidencePacket, citedIds: string[]): { ok: boolean; unknown: string[] } {
  const allowed = new Set(packet.claims.map((c) => c.id));
  const unknown = citedIds.filter((id) => !allowed.has(id));
  return { ok: citedIds.length > 0 && unknown.length === 0, unknown };
}

export interface EvidenceSummarizer {
  summarize(question: string, packet: EvidencePacket): Promise<{ text: string; citedIds: string[] } | null>;
}

/** Uses a summarizer only when its citations validate; otherwise falls back to the deterministic answer. */
export async function groundedNarrative(summarizer: EvidenceSummarizer | null, question: string, fallback: Answer): Promise<Answer> {
  if (!summarizer || fallback.packet.claims.length === 0) return fallback;
  const r = await summarizer.summarize(question, fallback.packet);
  if (!r) return fallback;
  const v = validateCitations(fallback.packet, r.citedIds);
  return v.ok ? { text: r.text, packet: fallback.packet } : fallback;
}

/** Resume a project: last valid checkpoint plus anything newer about it. */
export async function resumeProject(ctx: AppContext, project: string): Promise<string> {
  const s = await getSettings(ctx.db);
  const r = await findEntity(ctx, project, new Set(["project", "topic", "activity"]));
  if (r.kind === "ambiguous") return `Which project: ${r.candidates.map((e, i) => `${i + 1}) ${e.label}`).join(" ")}?`;
  if (r.kind === "none") return `I don't have a checkpoint for ${cleanLabel(project)}.`;
  const cps = (await listItems(ctx, "checkpoint", { status: ["open"], limit: 50 })).filter((c) => c.project_id === r.entity.id).sort((a, b) => b.created_at - a.created_at);
  const cp = cps[0];
  if (!cp) return `No checkpoint saved for ${r.entity.label}. Say "stopping here: …" next time and I'll save one.`;
  const newer = (await listItems(ctx, ["note", "decision", "question"], { status: ["open"], limit: 50 })).filter(
    (n) => n.created_at > cp.created_at && (n.project_id === r.entity.id || String(n.data.project ?? "").toLowerCase() === r.entity.label.toLowerCase()),
  );
  const d = cp.data;
  const parts = [
    d.completed ? `done: ${d.completed}` : null,
    d.attempted ? `tried: ${d.attempted}` : null,
    d.remaining ? `open issue: ${d.remaining}` : null,
    d.next ? `next: ${d.next}` : null,
  ].filter(Boolean);
  return `${r.entity.label} (checkpoint ${formatDate(cp.created_at, s.timezone)}): ${parts.join("; ") || "no details recorded"}.${
    newer.length
      ? ` Since then: ${newer
          .map((n) => n.title)
          .slice(0, 3)
          .join("; ")}.`
      : ""
  } (I can't see your files; this is what you told me.)`;
}
