import type { AppContext } from "../context";
import type { Action, Interpretation, StoredPlan } from "../domain/actions";
import {
  activeClarification,
  cancelConfirmation,
  consumeConfirmation,
  findConfirmation,
  logInboundTurn,
  markClarificationAnswered,
  recentTurns,
  storeConfirmationResult,
  type PendingClarification,
} from "../domain/conversations";
import { MINUTE, formatDateTime, localParts } from "../domain/time";
import { log } from "../observability/log";
import { SIM_DELLA_NUMBER } from "../providers/simulated/sms";
import type { VerifiedInboundSms } from "../providers/types";
import { newId, sha256Hex } from "../security/crypto";
import { redactPhone, safeErrorMessage } from "../security/redaction";
import { audit } from "./audit";
import { classifyKeyword, parseDeterministic } from "./commands";
import { smsEffectStatements } from "./effects";
import { executeConfirmed, loadExecEnv, resumeClarification, runAction, type ExecEnv, type StepResult } from "./executor";
import { dispatchJobs, jobInsertStatement, type JobOutcome, type JobRow } from "./jobs";
import { suppressionState } from "./readiness";
import { getSettings } from "./settings";
import { commitUsage, estimateAiCostUsd, releaseUsage, reserveUsage } from "./usage";
import { activeSession, cancelAllSessions } from "../accountability/sessions";
import { parseJson } from "../db/db";
import { getTask } from "../domain/tasks";
import { featureOn, getExtSettings } from "../ext/settings";
import { captureOffNotice, ingestKnowledge } from "../knowledge/ingest";
import { offRecord } from "../knowledge/sensitive";
import { statesSomething } from "../knowledge/gate";
import { recordUndo } from "../knowledge/undo";
import { ingestMmsEvidence } from "../media/uploads";

export const SIM_OWNER_NUMBER = "+15550100001";

/** The single trusted owner number (deployment config). The simulator uses a fixed fictional number. */
export function effectiveOwnerPhone(ctx: AppContext): string | null {
  if (ctx.config.ownerPhone) return ctx.config.ownerPhone;
  return ctx.sms.name === "simulated" ? SIM_OWNER_NUMBER : null;
}

export function dellaNumber(ctx: AppContext): string {
  return ctx.sms.name === "simulated" ? SIM_DELLA_NUMBER : (ctx.config.twilio.phoneNumber ?? "");
}

export type IngestResult =
  | { status: "stored"; inboundId: string; jobId: string | null; keyword: string }
  | { status: "duplicate"; inboundId: string }
  | { status: "unauthorized_sender" }
  | { status: "over_limit"; inboundId: string };

const PROACTIVE_SMS_JOBS = [
  "send_reminder",
  "calendar_headsup",
  "morning_brief",
  "missed_summary",
  "secretary_check",
  "suggestion_digest",
  "acc_checkpoint",
  "acc_session_end",
  "meeting_prep",
  "post_meeting",
  "evening_reset",
];

/**
 * Durable ingestion. Runs before acknowledging the webhook: the inbound row and its processing job
 * are written in ONE D1 batch (transaction), deduplicated by provider message ID. STOP/START are
 * applied here, deterministically, before any queued or AI processing.
 */
export async function ingestInbound(ctx: AppContext, msg: VerifiedInboundSms): Promise<IngestResult> {
  const owner = effectiveOwnerPhone(ctx);
  const now = ctx.clock.now();
  if (!owner || msg.from !== owner) {
    // Unauthorized senders cannot trigger AI, actions, or replies; their content is not stored.
    log("warn", "inbound_unauthorized_sender", { from: redactPhone(msg.from), provider: msg.provider });
    await audit(ctx, "provider", "inbound.unauthorized", "inbound", null, `from=${redactPhone(msg.from)}`);
    return { status: "unauthorized_sender" };
  }
  const existing = await ctx.db.first<{ id: string }>("SELECT id FROM inbound_messages WHERE provider = ? AND provider_message_id = ?", msg.provider, msg.providerMessageId);
  if (existing) return { status: "duplicate", inboundId: existing.id };
  const tombstone = await ctx.db.first<{ key_hash: string }>(
    "SELECT key_hash FROM dedupe_tombstones WHERE key_hash = ?",
    await sha256Hex(`${msg.provider}:${msg.providerMessageId}`),
  );
  if (tombstone) return { status: "duplicate", inboundId: "erased" };

  const optedOut = (await suppressionState(ctx, "sms")) === "opted_out";
  const keyword = msg.providerKeyword ?? classifyKeyword(msg.body, optedOut);
  const kw = keyword === "none" || keyword === null ? "none" : keyword;
  const inboundId = newId("in");
  const bodyEnc = await ctx.crypto.encrypt(msg.body, "inbound");
  const statements: D1PreparedStatement[] = [
    ctx.db.prepare(
      `INSERT INTO inbound_messages (id, seq, provider, provider_message_id, from_e164, to_e164, received_at, body_enc, num_media, keyword, status, metadata_json)
       SELECT ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM inbound_messages), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE NOT EXISTS (SELECT 1 FROM inbound_messages WHERE provider = ? AND provider_message_id = ?)`,
      inboundId,
      msg.provider,
      msg.providerMessageId,
      msg.from,
      msg.to,
      now,
      bodyEnc,
      msg.numMedia,
      kw,
      kw === "none" ? "received" : "processed",
      JSON.stringify({ ...msg.metadata, ...(msg.mediaUrls?.length ? { mediaUrls: msg.mediaUrls } : {}) }),
      msg.provider,
      msg.providerMessageId,
    ),
  ];
  let jobId: string | null = null;
  if (kw === "stop") {
    statements.push(
      ctx.db.prepare(
        "INSERT INTO suppressions (channel, state, source, updated_at) VALUES ('sms', 'opted_out', 'stop_keyword', ?) ON CONFLICT (channel) DO UPDATE SET state = 'opted_out', source = 'stop_keyword', updated_at = excluded.updated_at",
        now,
      ),
      // Conservative policy: STOP also pauses proactive calls until re-enabled by the administrator.
      ctx.db.prepare(
        "INSERT INTO suppressions (channel, state, source, updated_at) VALUES ('call', 'opted_out', 'stop_keyword', ?) ON CONFLICT (channel) DO UPDATE SET state = 'opted_out', source = 'stop_keyword', updated_at = excluded.updated_at",
        now,
      ),
      ctx.db.prepare(
        `UPDATE jobs SET status = 'canceled', last_error = 'opted_out', finished_at = ?, updated_at = ? WHERE status = 'pending' AND kind IN (${PROACTIVE_SMS_JOBS.map(() => "?").join(",")}, 'deliver_effect', 'alarm_call')`,
        now,
        now,
        ...PROACTIVE_SMS_JOBS,
      ),
      ctx.db.prepare("UPDATE outbound_effects SET state = 'suppressed', error_detail = 'opted_out', updated_at = ? WHERE state = 'pending'", now),
      ctx.db.prepare("INSERT INTO consent_events (id, channel, event, source, created_at) VALUES (?, 'sms', 'opted_out', 'stop_keyword', ?)", newId("ce"), now),
      ctx.db.prepare(
        "INSERT INTO consent_events (id, channel, event, source, detail, created_at) VALUES (?, 'call', 'paused', 'stop_keyword', 'conservative policy', ?)",
        newId("ce"),
        now,
      ),
    );
  } else if (kw === "start") {
    // START restores messaging consent only. Wake-up calls stay paused; nothing old is replayed.
    statements.push(
      ctx.db.prepare(
        "INSERT INTO suppressions (channel, state, source, updated_at) VALUES ('sms', 'active', 'start_keyword', ?) ON CONFLICT (channel) DO UPDATE SET state = 'active', source = 'start_keyword', updated_at = excluded.updated_at",
        now,
      ),
      ctx.db.prepare("INSERT INTO consent_events (id, channel, event, source, created_at) VALUES (?, 'sms', 'opted_in', 'start_keyword', ?)", newId("ce"), now),
    );
  } else if (kw === "help") {
    if (!ctx.sms.capabilities().providerManagedKeywords) {
      jobId = newId("job");
      statements.push(jobInsertStatement(ctx, { logicalKey: `inbound:${msg.provider}:${msg.providerMessageId}`, kind: "process_inbound", entityId: inboundId, dueAt: now }, jobId));
    }
  } else {
    jobId = newId("job");
    statements.push(
      ctx.db.prepare(
        "INSERT OR IGNORE INTO conversation_log (id, direction, body_enc, inbound_id, created_at) VALUES (?, 'in', ?, ?, ?)",
        `cl_in_${inboundId}`,
        await ctx.crypto.encrypt(msg.body, "convlog"),
        inboundId,
        now,
      ),
      jobInsertStatement(ctx, { logicalKey: `inbound:${msg.provider}:${msg.providerMessageId}`, kind: "process_inbound", entityId: inboundId, dueAt: now, maxAttempts: 5 }, jobId),
    );
  }
  const changes = await ctx.db.batch(statements);
  if (changes[0] !== 1) {
    const row = await ctx.db.first<{ id: string }>("SELECT id FROM inbound_messages WHERE provider = ? AND provider_message_id = ?", msg.provider, msg.providerMessageId);
    return { status: "duplicate", inboundId: row?.id ?? inboundId };
  }
  const seqRow = await ctx.db.first<{ seq: number }>("SELECT seq FROM inbound_messages WHERE id = ?", inboundId);
  if (jobId && seqRow) await ctx.db.run("UPDATE jobs SET seq = ? WHERE id = ?", seqRow.seq, jobId);
  if (kw !== "none") await audit(ctx, "sms", `keyword.${kw}`, "inbound", inboundId);
  // Opt-out dominates accountability: every open session and check ends now.
  if (kw === "stop") await cancelAllSessions(ctx, "opted_out");

  if (kw === "none") {
    const settings = await getSettings(ctx.db);
    const allowed = await reserveUsage(ctx, `inbound:${inboundId}`, "inbound", 1, { tz: settings.timezone });
    if (!allowed) {
      await ctx.db.batch([
        ctx.db.prepare("UPDATE inbound_messages SET status = 'ignored', status_detail = 'daily_inbound_limit' WHERE id = ?", inboundId),
        ctx.db.prepare("UPDATE jobs SET status = 'canceled', last_error = 'daily_inbound_limit' WHERE id = ?", jobId),
      ]);
      log("warn", "inbound_limit_reached", { inboundId });
      return { status: "over_limit", inboundId };
    }
    await commitUsage(ctx, `inbound:${inboundId}`, 1);
  }
  return { status: "stored", inboundId, jobId, keyword: kw };
}

interface InboundRow {
  id: string;
  seq: number;
  provider: string;
  received_at: number;
  body_enc: string | null;
  num_media: number;
  keyword: string;
  status: string;
  metadata_json: string | null;
}

const BLOCKING_WAIT_LIMIT_MS = 10 * MINUTE;

/**
 * Enforces conversational order by ingress sequence. A later message waits for earlier ones,
 * but a permanently failed or long-stuck earlier message is marked failed (bounded poison policy)
 * so it cannot block every later command.
 */
async function earlierBlocking(ctx: AppContext, row: InboundRow): Promise<boolean> {
  const earlier = await ctx.db.first<{ id: string; seq: number; received_at: number }>(
    "SELECT id, seq, received_at FROM inbound_messages WHERE seq < ? AND status IN ('received','processing') AND keyword IN ('none','help') ORDER BY seq LIMIT 1",
    row.seq,
  );
  if (!earlier) return false;
  const job = await ctx.db.first<{ status: string }>("SELECT status FROM jobs WHERE kind = 'process_inbound' AND entity_id = ?", earlier.id);
  const now = ctx.clock.now();
  if (!job || ["failed", "dead", "canceled", "blocked"].includes(job.status) || now - earlier.received_at > BLOCKING_WAIT_LIMIT_MS) {
    await ctx.db.run("UPDATE inbound_messages SET status = 'failed', status_detail = 'poison_or_stuck' WHERE id = ? AND status IN ('received','processing')", earlier.id);
    log("warn", "inbound_poison_skipped", { inboundId: earlier.id });
    return earlierBlocking(ctx, row);
  }
  return true;
}

const replyPlan = (row: InboundRow, intent: string, text: string): StoredPlan => ({
  source_message_id: row.id,
  source: "deterministic",
  interpretation: { intent, time_expressions: [], references: [], missing_fields: [], actions: [{ type: "general_reply", text: text.slice(0, 320) }], knowledge: [] },
});

async function buildPlan(ctx: AppContext, row: InboundRow, text: string, clar: PendingClarification | null, offRecordOnly: boolean): Promise<StoredPlan> {
  if (offRecordOnly) {
    return {
      source_message_id: row.id,
      source: "deterministic",
      interpretation: {
        intent: "forget_last",
        time_expressions: [],
        references: [],
        missing_fields: [],
        actions: [{ type: "memory_forget", scope: "last_message", target: null }],
        knowledge: [],
      },
    };
  }
  if (row.num_media > 0) {
    const urls = parseJson<{ mediaUrls?: string[] }>(row.metadata_json, {}).mediaUrls ?? [];
    const mms = await ingestMmsEvidence(ctx, row.id, urls);
    if (mms && (!text.trim() || mms.startsWith("Photo received"))) return replyPlan(row, "mms", mms);
  }
  if (row.keyword === "help")
    return {
      source_message_id: row.id,
      source: "deterministic",
      interpretation: { intent: "help", time_expressions: [], references: [], missing_fields: [], actions: [{ type: "help" }], knowledge: [] },
    };
  if (row.num_media > 0 && !text.trim()) {
    return {
      source_message_id: row.id,
      source: "deterministic",
      interpretation: { intent: "media", time_expressions: [], references: [], missing_fields: [], actions: [{ type: "unsupported", reason: "media" }], knowledge: [] },
    };
  }
  const pendingConfirmations = (await ctx.db.first<{ n: number }>("SELECT COUNT(*) AS n FROM confirmations WHERE status = 'pending' AND expires_at > ?", ctx.clock.now()))?.n ?? 0;
  const settings = await getSettings(ctx.db);
  const det = parseDeterministic(text, {
    clarification: clar,
    pendingConfirmations,
    anchorYear: Number(localParts(row.received_at, settings.timezone).date.slice(0, 4)),
    accountabilityActive: Boolean(await activeSession(ctx)),
  });
  if (det) return { source_message_id: row.id, source: "deterministic", interpretation: det };
  return aiPlan(ctx, row, text, clar);
}

const unsupportedPlan = (row: InboundRow, reason: string): StoredPlan => ({
  source_message_id: row.id,
  source: "ai_unavailable",
  interpretation: { intent: "unavailable", time_expressions: [], references: [], missing_fields: [], actions: [{ type: "unsupported", reason }], knowledge: [] },
});

async function aiPlan(ctx: AppContext, row: InboundRow, text: string, clar: PendingClarification | null): Promise<StoredPlan> {
  const settings = await getSettings(ctx.db);
  const tz = settings.timezone;
  const reservation = `ai:${row.id}`;
  if (!(await reserveUsage(ctx, reservation, "ai_requests", 1, { tz }))) return unsupportedPlan(row, "budget:ai_requests");
  const p = localParts(row.received_at, tz);
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long" }).format(row.received_at);
  const openTaskRows = await ctx.db.all<{ short_id: string; title_enc: string; due_at: number | null }>(
    "SELECT short_id, title_enc, due_at FROM tasks WHERE status = 'open' ORDER BY updated_at DESC LIMIT 10",
  );
  const openTasks = [];
  for (const t of openTaskRows)
    openTasks.push({ ref: t.short_id, title: (await ctx.crypto.decrypt(t.title_enc, "task")).slice(0, 60), due: t.due_at ? formatDateTime(t.due_at, tz) : null });
  const evRows = await ctx.db.all<{ summary_enc: string | null; start_at: number }>(
    "SELECT summary_enc, start_at FROM calendar_events WHERE all_day = 0 AND status != 'cancelled' AND start_at BETWEEN ? AND ? ORDER BY start_at LIMIT 5",
    ctx.clock.now(),
    ctx.clock.now() + 3 * 24 * 60 * MINUTE,
  );
  const upcomingEvents = [];
  for (const e of evRows) upcomingEvents.push({ title: ((await ctx.crypto.decryptNullable(e.summary_enc, "calendar")) ?? "").slice(0, 60), when: formatDateTime(e.start_at, tz) });
  const turns = (await recentTurns(ctx, 4)).map((t) => ({ direction: t.direction, text: t.text.slice(0, 200), at: new Date(t.at).toISOString() }));
  const ext = await getExtSettings(ctx.db);
  const memory = featureOn(ctx, ext, "capture");
  const features = { memory, knowledge: memory && statesSomething(text), accountability: featureOn(ctx, ext, "task_accountability") || featureOn(ctx, ext, "morning") };
  const started = Date.now();
  const result = await ctx.planner.interpret({
    messageText: text.slice(0, 1000),
    nowUtcIso: new Date(row.received_at).toISOString(),
    localNow: `${p.date}T${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")} ${weekday} (${tz}, UTC${p.offset})`,
    timezone: tz,
    ownerName: settings.display_name,
    recentTurns: turns,
    pendingQuestion: clar?.prompt ?? null,
    openTasks,
    upcomingEvents,
    features,
    capabilitiesNote:
      "tasks, reminders, follow-ups, Google Calendar read/create/move/cancel (no invitations), wake-up calls, settings (quiet hours, briefs, check-ins), pause/resume, memory (items, promises, waiting-for, decisions, notes), planning, owner-requested accountability sessions and morning routines",
  });
  const cost = estimateAiCostUsd(result.usage.inputTokens, result.usage.outputTokens);
  if (result.usage.inputTokens)
    log("info", "ai_usage", { input: result.usage.inputTokens, cached: result.usage.cachedInputTokens ?? 0, output: result.usage.outputTokens, knowledge: features.knowledge });
  await ctx.db.run(
    "INSERT INTO ai_requests (id, inbound_id, model, outcome, input_tokens, output_tokens, latency_ms, estimated_cost_usd, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    newId("ai"),
    row.id,
    result.model,
    result.kind,
    result.usage.inputTokens,
    result.usage.outputTokens,
    Date.now() - started,
    cost,
    ctx.clock.now(),
  );
  // Every attempted interpretation counts (simulated too, so caps behave identically); a disabled planner made no request.
  if (result.kind === "disabled") await releaseUsage(ctx, reservation);
  else await commitUsage(ctx, reservation, 1);
  if (result.kind !== "ok") {
    log("warn", "planner_unavailable", { kind: result.kind, detail: "detail" in result ? String(result.detail).slice(0, 300) : "", inboundId: row.id });
    return unsupportedPlan(row, `ai_unavailable:${result.kind}`);
  }
  return { source_message_id: row.id, source: "ai", interpretation: result.interpretation };
}

async function loadOrCreatePlan(
  ctx: AppContext,
  row: InboundRow,
  text: string,
  clar: PendingClarification | null,
  off: { offRecord: boolean; only: boolean },
): Promise<{ planId: string; plan: StoredPlan }> {
  const existing = await ctx.db.first<{ id: string; plan_enc: string }>("SELECT id, plan_enc FROM plans WHERE inbound_id = ?", row.id);
  if (existing) return { planId: existing.id, plan: JSON.parse(await ctx.crypto.decrypt(existing.plan_enc, "plan")) as StoredPlan };
  const plan = await buildPlan(ctx, row, text, clar, off.only);
  // "Don't store this: <statement>" — nothing to do, and nothing to misread as a failed request.
  if (off.offRecord && plan.interpretation.actions.every((a) => a.type === "unsupported" || a.type === "general_reply")) {
    Object.assign(plan, replyPlan(row, "off_record", "OK, I didn't store that."));
  }
  // Extraction output is never persisted when memory is off or the owner said "don't store this".
  const k = plan.interpretation.knowledge ?? [];
  if (k.length && (off.offRecord || !featureOn(ctx, await getExtSettings(ctx.db), "capture"))) {
    plan.knowledgeDropped = off.offRecord ? 0 : k.length;
    plan.interpretation = { ...plan.interpretation, knowledge: [] };
  }
  const planId = newId("pln");
  const now = ctx.clock.now();
  await ctx.db.run(
    "INSERT OR IGNORE INTO plans (id, inbound_id, source, plan_enc, action_count, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'planned', ?, ?)",
    planId,
    row.id,
    plan.source,
    await ctx.crypto.encrypt(JSON.stringify(plan), "plan"),
    plan.interpretation.actions.length,
    now,
    now,
  );
  const stored = (await ctx.db.first<{ id: string; plan_enc: string }>("SELECT id, plan_enc FROM plans WHERE inbound_id = ?", row.id))!;
  return { planId: stored.id, plan: JSON.parse(await ctx.crypto.decrypt(stored.plan_enc, "plan")) as StoredPlan };
}

async function runPipelineAction(env: ExecEnv, action: Action, row: InboundRow, clar: PendingClarification | null): Promise<StepResult> {
  const ctx = env.ctx;
  if (action.type === "answer_clarification") {
    let target = clar;
    if (!target) {
      // Retry after a crash: the clarification this message already claimed.
      const claimed = await ctx.db.first<{ id: string }>("SELECT id FROM clarifications WHERE answer_inbound_id = ?", row.id);
      if (claimed) {
        await ctx.db.run("UPDATE clarifications SET status = 'pending' WHERE id = ? AND answer_inbound_id = ?", claimed.id, row.id);
        target = await activeClarification(ctx);
      }
    }
    if (!target) return runAction(env, action);
    const won = await markClarificationAnswered(ctx, target.id, row.id);
    if (!won) return { text: "That question was already answered.", ok: true };
    return resumeClarification(env, target, action.answer);
  }
  if (action.type === "answer_confirmation") {
    const lookup = await findConfirmation(ctx, action.nonce);
    if (lookup.kind === "none")
      return { text: action.nonce ? `I don't have a pending request ${action.nonce}. Nothing changed.` : "There's nothing waiting for confirmation.", ok: false };
    if (lookup.kind === "ambiguous") return { text: "More than one request is waiting. Reply YES with its code (for example YES C8P2).", ok: false };
    if (lookup.kind === "expired_or_used") return { text: `${lookup.nonce ?? "That request"} expired or was already used. Nothing changed; ask again if needed.`, ok: false };
    const conf = lookup.confirmation;
    if (!action.accept) {
      await cancelConfirmation(ctx, conf.row.id);
      return { text: `Canceled (${conf.row.nonce}). Nothing changed.`, ok: true };
    }
    if (!(await consumeConfirmation(ctx, conf.row.id))) return { text: `${conf.row.nonce} expired or was already used. Nothing changed.`, ok: false };
    const execEnv = { ...env, actionKey: (conf.action.actionKey as string | undefined) ?? `confirm:${conf.row.id}` };
    const result = await executeConfirmed(execEnv, conf);
    await storeConfirmationResult(ctx, conf.row.id, result.text);
    return result;
  }
  return runAction(env, action);
}

function composeReply(results: StepResult[]): string {
  if (results.length === 1) return results[0]!.text;
  return results.map((r, i) => `${i + 1}) ${r.text}`).join("\n");
}

/** Job handler for one inbound message: ordered, plan-once, resume-per-action, single reply effect. */
export async function handleProcessInbound(ctx: AppContext, job: JobRow): Promise<JobOutcome> {
  const row = await ctx.db.first<InboundRow>(
    "SELECT id, seq, provider, received_at, body_enc, num_media, keyword, status, metadata_json FROM inbound_messages WHERE id = ?",
    job.entity_id ?? "",
  );
  if (!row) return { status: "skipped", result: { reason: "missing_inbound" } };
  if (["processed", "failed", "ignored"].includes(row.status)) return { status: "skipped", result: { reason: `inbound_${row.status}` } };
  if (await earlierBlocking(ctx, row)) return { status: "reschedule", dueAt: ctx.clock.now() + 5_000, reason: "waiting_for_earlier_message" };
  await ctx.db.run("UPDATE inbound_messages SET status = 'processing' WHERE id = ? AND status = 'received'", row.id);

  const rawText = row.body_enc ? await ctx.crypto.decrypt(row.body_enc, "inbound") : "";
  const off = offRecord(rawText);
  const text = off.offRecord ? off.rest : rawText;
  if (!off.offRecord) await logInboundTurn(ctx, row.id, rawText);
  const clar = await activeClarification(ctx);
  const { planId, plan } = await loadOrCreatePlan(ctx, row, text, clar, { offRecord: off.offRecord, only: off.offRecord && !text.trim() });
  const interpretation: Interpretation = plan.interpretation;

  const results: StepResult[] = [];
  const taskIds = new Set<string>();
  for (let i = 0; i < interpretation.actions.length; i++) {
    const action = interpretation.actions[i]!;
    const actionKey = `in:${row.id}:${i}`;
    const prior = await ctx.db.first<{ status: string; result_enc: string | null }>("SELECT status, result_enc FROM action_executions WHERE action_key = ?", actionKey);
    if (prior && prior.status !== "pending" && prior.result_enc) {
      const saved = JSON.parse(await ctx.crypto.decrypt(prior.result_enc, "action")) as StepResult;
      results.push(saved);
      for (const t of saved.taskIds ?? []) taskIds.add(t);
      continue;
    }
    const now = ctx.clock.now();
    await ctx.db.run(
      `INSERT INTO action_executions (id, action_key, plan_id, source_inbound_id, action_index, action_type, args_enc, status, attempts, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 1, ?, ?) ON CONFLICT (action_key) DO UPDATE SET attempts = attempts + 1, updated_at = excluded.updated_at`,
      newId("act"),
      actionKey,
      planId,
      row.id,
      i,
      action.type,
      await ctx.crypto.encrypt(JSON.stringify(action), "action"),
      now,
      now,
    );
    const env = await loadExecEnv(ctx, row.received_at, row.id, actionKey);
    let result: StepResult;
    try {
      result = await runPipelineAction(env, action, row, i === 0 ? clar : await activeClarification(ctx));
    } catch (err) {
      await ctx.db.run("UPDATE action_executions SET last_error = ?, updated_at = ? WHERE action_key = ?", safeErrorMessage(err), ctx.clock.now(), actionKey);
      throw err;
    }
    const status = result.awaiting === "clarification" ? "needs_clarification" : result.awaiting === "confirmation" ? "needs_confirmation" : result.ok ? "succeeded" : "failed";
    await ctx.db.run(
      "UPDATE action_executions SET status = ?, result_enc = ?, updated_at = ? WHERE action_key = ?",
      status,
      await ctx.crypto.encrypt(JSON.stringify(result), "action"),
      ctx.clock.now(),
      actionKey,
    );
    results.push(result);
    for (const t of result.taskIds ?? []) taskIds.add(t);
    if (result.ok && !result.awaiting) await recordActionUndo(ctx, action, actionKey, result);
  }

  const memory = await captureKnowledge(ctx, row, planId, plan, text, interpretation.actions.length);
  if (memory) {
    // A pure statement's placeholder acknowledgement is replaced by what was actually saved.
    if (results.every((r) => r.ok && interpretation.actions.every((a) => a.type === "general_reply"))) results.length = 0;
    results.push(memory);
  }
  const reply = composeReply(results.length ? results : [{ text: "Noted.", ok: true }]);
  const { statements } = await smsEffectStatements(ctx, { effectKey: `reply:${row.id}`, purpose: "reply", body: reply, taskIds: [...taskIds] });
  const now = ctx.clock.now();
  await ctx.db.batch([
    ...statements,
    ctx.db.prepare("UPDATE inbound_messages SET status = 'processed', processed_at = ? WHERE id = ?", now, row.id),
    ctx.db.prepare("UPDATE plans SET status = 'executed', updated_at = ? WHERE id = ?", now, planId),
    // "Don't store this": the raw text is dropped once the requested actions are done.
    ...(off.offRecord
      ? [
          ctx.db.prepare("UPDATE inbound_messages SET body_enc = NULL, status_detail = 'off_record' WHERE id = ?", row.id),
          ctx.db.prepare("DELETE FROM conversation_log WHERE inbound_id = ? AND direction = 'in'", row.id),
        ]
      : []),
  ]);
  const deliverJob = await ctx.db.first<{ id: string }>("SELECT id FROM jobs WHERE logical_key = ?", `deliver:reply:${row.id}`);
  if (deliverJob) await dispatchJobs(ctx, [deliverJob.id]);
  return { status: "succeeded", result: { actions: interpretation.actions.length, source: plan.source } };
}

async function recordActionUndo(ctx: AppContext, action: Action, actionKey: string, result: StepResult): Promise<void> {
  if (action.type !== "create_reminder" && action.type !== "create_task" && action.type !== "complete_task") return;
  for (const id of result.taskIds ?? []) {
    const t = await getTask(ctx, id);
    if (!t) continue;
    if (action.type === "complete_task") await recordUndo(ctx, `${actionKey}:${id}`, "task.completed", "task", id, `completed "${t.title}"`, { op: "reopen_task", taskId: id });
    else await recordUndo(ctx, `${actionKey}:${id}`, "task.created", "task", id, `created "${t.title}"`, { op: "cancel_task", taskId: id });
  }
}

/** Memory capture for one message: resumable like an action (stored result reused on retry). */
async function captureKnowledge(ctx: AppContext, row: InboundRow, planId: string, plan: StoredPlan, text: string, index: number): Promise<StepResult | null> {
  const candidates = plan.interpretation.knowledge ?? [];
  if (candidates.length === 0) {
    if (!plan.knowledgeDropped) return null;
    const notice = await captureOffNotice(ctx);
    return notice ? { text: notice, ok: true } : null;
  }
  const key = `in:${row.id}:k`;
  const prior = await ctx.db.first<{ status: string; result_enc: string | null }>("SELECT status, result_enc FROM action_executions WHERE action_key = ?", key);
  if (prior?.result_enc) return JSON.parse(await ctx.crypto.decrypt(prior.result_enc, "action")) as StepResult;
  const r = await ingestKnowledge(ctx, { candidates, sourceText: text, originId: row.id, anchorMs: row.received_at, model: plan.source });
  const lines = [...r.lines, r.question?.text].filter((x): x is string => Boolean(x));
  if (r.saved.length && r.sourceId)
    await recordUndo(ctx, key, "memory.saved", "source", r.sourceId, `saved ${r.saved.slice(0, 3).join("; ")}`, { op: "forget_source", sourceId: r.sourceId });
  const result: StepResult | null = lines.length ? { text: lines.join(" "), ok: true, awaiting: r.question ? "clarification" : undefined } : null;
  const now = ctx.clock.now();
  await ctx.db.run(
    `INSERT INTO action_executions (id, action_key, plan_id, source_inbound_id, action_index, action_type, status, result_enc, attempts, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'knowledge', ?, ?, 1, ?, ?) ON CONFLICT (action_key) DO NOTHING`,
    newId("act"),
    key,
    planId,
    row.id,
    index,
    r.question ? "needs_clarification" : "succeeded",
    await ctx.crypto.encrypt(JSON.stringify(result ?? { text: "", ok: true }), "action"),
    now,
    now,
  );
  return result && result.text ? result : null;
}

/** Called when a process_inbound job permanently fails: mark it and send one short notice. */
export async function onInboundJobFailed(ctx: AppContext, job: JobRow): Promise<void> {
  const changed = await ctx.db.run(
    "UPDATE inbound_messages SET status = 'failed', status_detail = 'processing_failed' WHERE id = ? AND status IN ('received','processing')",
    job.entity_id ?? "",
  );
  if (changed !== 1) return;
  const { statements } = await smsEffectStatements(ctx, {
    effectKey: `reply:${job.entity_id}`,
    purpose: "reply",
    body: "Sorry, I couldn't process your last message. Please try again.",
  });
  await ctx.db.batch(statements);
}
