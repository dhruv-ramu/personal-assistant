import type { AppContext } from "../context";
import { parseJson } from "../db/db";
import { newId, randomBytes, sha256Hex, shortCodeFromBytes } from "../security/crypto";
import { HOUR, MINUTE } from "./time";

export const CONFIRMATION_TTL_MS = 15 * MINUTE;
export const CLARIFICATION_TTL_MS = 15 * MINUTE;
export const CONTEXT_WINDOW_MS = 12 * HOUR;

// ---------- Conversation log / context ----------

export async function logInboundTurn(ctx: AppContext, inboundId: string, text: string): Promise<void> {
  await ctx.db.run(
    "INSERT OR IGNORE INTO conversation_log (id, direction, body_enc, inbound_id, created_at) VALUES (?, 'in', ?, ?, ?)",
    `cl_in_${inboundId}`,
    await ctx.crypto.encrypt(text, "convlog"),
    inboundId,
    ctx.clock.now(),
  );
}

export async function recentTurns(ctx: AppContext, limit = 6): Promise<Array<{ direction: "in" | "out"; text: string; at: number }>> {
  const since = ctx.clock.now() - CONTEXT_WINDOW_MS;
  const rows = await ctx.db.all<{ direction: "in" | "out"; body_enc: string | null; created_at: number }>(
    "SELECT direction, body_enc, created_at FROM conversation_log WHERE created_at >= ? AND body_enc IS NOT NULL ORDER BY created_at DESC LIMIT ?",
    since,
    limit,
  );
  const out = [];
  for (const r of rows.reverse()) out.push({ direction: r.direction, text: (await ctx.crypto.decrypt(r.body_enc!, "convlog")).slice(0, 300), at: r.created_at });
  return out;
}

export async function setLastReferenced(ctx: AppContext, taskIds: string[]): Promise<void> {
  if (taskIds.length === 0) return;
  const now = ctx.clock.now();
  await ctx.db.run(
    "UPDATE conversation_state SET last_task_ids_json = ?, last_referenced_at = ?, version = version + 1, updated_at = ? WHERE id = 1",
    JSON.stringify(taskIds.slice(0, 5)),
    now,
    now,
  );
}

/**
 * Candidate tasks for a bare "done": open tasks linked to recent proactive/outbound messages, plus
 * the last explicitly referenced tasks — all within a bounded window.
 */
export async function recentTaskCandidates(ctx: AppContext): Promise<string[]> {
  const since = ctx.clock.now() - CONTEXT_WINDOW_MS;
  const rows = await ctx.db.all<{ task_ids_json: string }>(
    "SELECT task_ids_json FROM conversation_log WHERE direction = 'out' AND created_at >= ? AND task_ids_json != '[]' ORDER BY created_at DESC LIMIT 10",
    since,
  );
  const ids = new Set<string>();
  for (const r of rows) for (const id of parseJson<string[]>(r.task_ids_json, [])) ids.add(id);
  const state = await ctx.db.first<{ last_task_ids_json: string; last_referenced_at: number | null }>(
    "SELECT last_task_ids_json, last_referenced_at FROM conversation_state WHERE id = 1",
  );
  if (state?.last_referenced_at && state.last_referenced_at >= since) for (const id of parseJson<string[]>(state.last_task_ids_json, [])) ids.add(id);
  if (ids.size === 0) return [];
  const list = [...ids];
  const placeholders = list.map(() => "?").join(",");
  const open = await ctx.db.all<{ id: string }>(`SELECT id FROM tasks WHERE status = 'open' AND id IN (${placeholders})`, ...list);
  return open.map((r) => r.id);
}

// ---------- Clarifications ----------

export type ClarificationType =
  "time" | "which_task" | "which_event" | "not_yet" | "followup" | "timezone_follow" | "event_scope" | "which_entity" | "post_meeting" | "waiting_check" | "acc_check";

export interface ClarificationOption {
  label: string;
  keywords: string[];
  /** Opaque resolution data interpreted by the resolver for this question type. */
  value: unknown;
}

export interface PendingClarification {
  id: string;
  question_type: ClarificationType;
  options: ClarificationOption[];
  freeform: "time" | "text" | null;
  /** The original proposed action (and path of the field being clarified), resumed on answer. */
  pending: { action: unknown; slot: string | null; anchorMs: number; sourceInboundId: string | null; extra?: Record<string, unknown> };
  prompt: string;
  created_at: number;
  expires_at: number;
  source_action_key: string | null;
}

interface ClarRow {
  id: string;
  question_type: ClarificationType;
  candidates_json: string;
  pending_enc: string;
  prompt_enc: string | null;
  status: string;
  created_at: number;
  expires_at: number;
  source_action_key: string | null;
}

export async function createClarification(
  ctx: AppContext,
  input: {
    type: ClarificationType;
    options: ClarificationOption[];
    freeform: "time" | "text" | null;
    pending: PendingClarification["pending"];
    prompt: string;
    sourceActionKey: string | null;
    ttlMs?: number;
  },
): Promise<string> {
  if (input.sourceActionKey) {
    const existing = await ctx.db.first<{ id: string }>("SELECT id FROM clarifications WHERE source_action_key = ?", input.sourceActionKey);
    if (existing) return existing.id;
  }
  const now = ctx.clock.now();
  const id = newId("clr");
  await ctx.db.batch([
    ctx.db.prepare("UPDATE clarifications SET status = 'superseded' WHERE status = 'pending'"),
    ctx.db.prepare(
      "INSERT INTO clarifications (id, question_type, candidates_json, pending_enc, prompt_enc, source_inbound_id, source_action_key, status, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)",
      id,
      input.type,
      JSON.stringify({ options: input.options, freeform: input.freeform }),
      await ctx.crypto.encrypt(JSON.stringify(input.pending), "clarification"),
      await ctx.crypto.encrypt(input.prompt, "clarification"),
      input.pending.sourceInboundId,
      input.sourceActionKey,
      now,
      now + (input.ttlMs ?? CLARIFICATION_TTL_MS),
    ),
  ]);
  return id;
}

export async function activeClarification(ctx: AppContext): Promise<PendingClarification | null> {
  const now = ctx.clock.now();
  await ctx.db.run("UPDATE clarifications SET status = 'expired' WHERE status = 'pending' AND expires_at <= ?", now);
  const row = await ctx.db.first<ClarRow>("SELECT * FROM clarifications WHERE status = 'pending' ORDER BY created_at DESC LIMIT 1");
  if (!row) return null;
  const meta = parseJson<{ options: ClarificationOption[]; freeform: "time" | "text" | null }>(row.candidates_json, { options: [], freeform: null });
  return {
    id: row.id,
    question_type: row.question_type,
    options: meta.options,
    freeform: meta.freeform,
    pending: JSON.parse(await ctx.crypto.decrypt(row.pending_enc, "clarification")),
    prompt: row.prompt_enc ? await ctx.crypto.decrypt(row.prompt_enc, "clarification") : "",
    created_at: row.created_at,
    expires_at: row.expires_at,
    source_action_key: row.source_action_key,
  };
}

/** Conditional: only one answer can resolve a clarification. */
export async function markClarificationAnswered(ctx: AppContext, id: string, inboundId: string | null): Promise<boolean> {
  return (
    (await ctx.db.run(
      "UPDATE clarifications SET status = 'answered', answered_at = ?, answer_inbound_id = ? WHERE id = ? AND status = 'pending'",
      ctx.clock.now(),
      inboundId,
      id,
    )) === 1
  );
}

export async function cancelClarification(ctx: AppContext, id: string): Promise<void> {
  await ctx.db.run("UPDATE clarifications SET status = 'canceled' WHERE id = ? AND status = 'pending'", id);
}

/** Matches an answer against options by number, keyword, or label. */
export function matchOption(options: ClarificationOption[], answer: string): ClarificationOption | null {
  const a = answer
    .trim()
    .toLowerCase()
    .replace(/[.!?]+$/, "");
  if (!a) return null;
  const n = /^\d+$/.test(a) ? Number(a) : null;
  if (n !== null && n >= 1 && n <= options.length) return options[n - 1]!;
  const exact = options.filter((o) => o.keywords.some((k) => k.toLowerCase() === a) || o.label.toLowerCase() === a);
  if (exact.length === 1) return exact[0]!;
  const partial = options.filter((o) => o.keywords.some((k) => k.length > 1 && new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(a)));
  return partial.length === 1 ? partial[0]! : null;
}

// ---------- Confirmations ----------

export interface ConfirmationTarget {
  kind: "task" | "event" | "alarm" | "settings";
  id: string;
  calendarId?: string;
  version?: number | string | null;
}

export interface ConfirmationRow {
  id: string;
  nonce: string;
  action_type: string;
  action_enc: string;
  action_hash: string;
  targets_json: string;
  prompt_enc: string | null;
  status: "pending" | "consumed" | "canceled" | "expired" | "superseded";
  source_inbound_id: string | null;
  source_action_key: string | null;
  created_at: number;
  expires_at: number;
  consumed_at: number | null;
  result_enc: string | null;
}

export interface Confirmation {
  row: ConfirmationRow;
  action: { type: string } & Record<string, unknown>;
  targets: ConfirmationTarget[];
  prompt: string;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export async function actionHash(action: unknown): Promise<string> {
  return sha256Hex(canonicalJson(action));
}

export async function createConfirmation(
  ctx: AppContext,
  input: {
    action: { type: string } & Record<string, unknown>;
    targets: ConfirmationTarget[];
    prompt: (nonce: string) => string;
    sourceInboundId: string | null;
    sourceActionKey: string;
  },
): Promise<{ id: string; nonce: string; prompt: string }> {
  const existing = await ctx.db.first<ConfirmationRow>("SELECT * FROM confirmations WHERE source_action_key = ?", input.sourceActionKey);
  if (existing) return { id: existing.id, nonce: existing.nonce, prompt: existing.prompt_enc ? await ctx.crypto.decrypt(existing.prompt_enc, "confirmation") : "" };
  const now = ctx.clock.now();
  const hash = await actionHash(input.action);
  for (let attempt = 0; attempt < 8; attempt++) {
    const nonce = shortCodeFromBytes("C", randomBytes(3));
    const id = newId("cnf");
    const prompt = input.prompt(nonce);
    try {
      await ctx.db.run(
        `INSERT INTO confirmations (id, nonce, action_type, action_enc, action_hash, targets_json, prompt_enc, status, source_inbound_id, source_action_key, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
        id,
        nonce,
        input.action.type,
        await ctx.crypto.encrypt(canonicalJson(input.action), "confirmation"),
        hash,
        JSON.stringify(input.targets),
        await ctx.crypto.encrypt(prompt, "confirmation"),
        input.sourceInboundId,
        input.sourceActionKey,
        now,
        now + CONFIRMATION_TTL_MS,
      );
      return { id, nonce, prompt };
    } catch (err) {
      if (!String(err).includes("UNIQUE")) throw err;
      const again = await ctx.db.first<ConfirmationRow>("SELECT * FROM confirmations WHERE source_action_key = ?", input.sourceActionKey);
      if (again) return { id: again.id, nonce: again.nonce, prompt: again.prompt_enc ? await ctx.crypto.decrypt(again.prompt_enc, "confirmation") : "" };
    }
  }
  throw new Error("Could not allocate a confirmation code");
}

async function hydrate(ctx: AppContext, row: ConfirmationRow): Promise<Confirmation> {
  const action = JSON.parse(await ctx.crypto.decrypt(row.action_enc, "confirmation"));
  const recomputed = await actionHash(action);
  if (recomputed !== row.action_hash) throw new Error("Confirmation action hash mismatch");
  return { row, action, targets: parseJson<ConfirmationTarget[]>(row.targets_json, []), prompt: row.prompt_enc ? await ctx.crypto.decrypt(row.prompt_enc, "confirmation") : "" };
}

export async function expireConfirmations(ctx: AppContext): Promise<void> {
  await ctx.db.run("UPDATE confirmations SET status = 'expired' WHERE status = 'pending' AND expires_at <= ?", ctx.clock.now());
}

export type ConfirmationLookup =
  { kind: "found"; confirmation: Confirmation } | { kind: "none" } | { kind: "expired_or_used"; nonce: string | null } | { kind: "ambiguous"; count: number };

/** Explicit nonce → that pending confirmation. Bare yes → only the single latest pending one. */
export async function findConfirmation(ctx: AppContext, nonce: string | null): Promise<ConfirmationLookup> {
  await expireConfirmations(ctx);
  if (nonce) {
    const row = await ctx.db.first<ConfirmationRow>("SELECT * FROM confirmations WHERE nonce = ? ORDER BY created_at DESC LIMIT 1", nonce.toUpperCase());
    if (!row) return { kind: "none" };
    if (row.status !== "pending") return { kind: "expired_or_used", nonce: row.nonce };
    return { kind: "found", confirmation: await hydrate(ctx, row) };
  }
  const rows = await ctx.db.all<ConfirmationRow>("SELECT * FROM confirmations WHERE status = 'pending' ORDER BY created_at DESC LIMIT 3");
  if (rows.length === 0) return { kind: "none" };
  if (rows.length > 1) return { kind: "ambiguous", count: rows.length };
  return { kind: "found", confirmation: await hydrate(ctx, rows[0]!) };
}

/** Single-use: the conditional UPDATE guarantees a confirmation is consumed at most once. */
export async function consumeConfirmation(ctx: AppContext, id: string): Promise<boolean> {
  const now = ctx.clock.now();
  return (await ctx.db.run("UPDATE confirmations SET status = 'consumed', consumed_at = ? WHERE id = ? AND status = 'pending' AND expires_at > ?", now, id, now)) === 1;
}

export async function cancelConfirmation(ctx: AppContext, id: string, status: "canceled" | "superseded" = "canceled"): Promise<boolean> {
  return (await ctx.db.run("UPDATE confirmations SET status = ? WHERE id = ? AND status = 'pending'", status, id)) === 1;
}

export async function storeConfirmationResult(ctx: AppContext, id: string, result: string): Promise<void> {
  await ctx.db.run("UPDATE confirmations SET result_enc = ? WHERE id = ?", await ctx.crypto.encrypt(result, "confirmation"), id);
}
