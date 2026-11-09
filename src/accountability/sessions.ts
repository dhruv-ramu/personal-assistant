import type { AppContext } from "../context";
import { parseJson } from "../db/db";
import { createAlarm, getOccurrence } from "../domain/alarms";
import { createClarification } from "../domain/conversations";
import { buildRRule, type RecurrenceSpec } from "../domain/recurrence";
import { findOpenTasksByText, getTaskByShortId, type Task } from "../domain/tasks";
import { MINUTE, formatMinuteOfDay, formatRange, formatTime, localParts, todayLocal, zoneLabel } from "../domain/time";
import { featureOn, getExtSettings } from "../ext/settings";
import { isShortCode, newId, randomBytes, stableId } from "../security/crypto";
import { audit } from "../services/audit";
import { deliverSmsEffect, ensureSmsEffect } from "../services/effects";
import { jobInsertStatement, parsePayload, type JobOutcome, type JobRow } from "../services/jobs";
import { getSettings, isPaused } from "../services/settings";
import { CHECKPOINT_OPEN, TERMINAL, transition, type CheckpointState, type SessionEvent, type SessionState } from "./machine";
import { issueUploadToken } from "../media/uploads";
import { issueDeviceChallenges, devicesOnline } from "./devices";

export type CheckpointKind = "call" | "device_checkin" | "evidence" | "text_check" | "later_check";
export type EvidenceKind = "photo" | "text" | "device" | "call";

export interface CheckpointSpec {
  kind: CheckpointKind;
  label: string;
  offsetMin: number;
  graceMin: number;
  expireMin: number;
  evidence: EvidenceKind[];
  criterion: string | null;
  escalateCall: boolean;
}

export interface SessionRow {
  id: string;
  policy_id: string;
  policy_version: number;
  occurrence_key: string;
  kind: string;
  state: SessionState;
  intended_start: number;
  intended_end: number;
  actual_start: number | null;
  actual_end: number | null;
  task_id: string | null;
  alarm_occurrence_id: string | null;
  call_attempts: number;
  call_cap: number;
  paused_until: number | null;
  photos_allowed: number;
  reason: string | null;
  summary_enc: string | null;
  generation: number;
  version: number;
  created_at: number;
  updated_at: number;
}

export interface CheckpointRow {
  id: string;
  session_id: string;
  ordinal: number;
  kind: CheckpointKind;
  label: string;
  intended_at: number;
  grace_until: number;
  expires_at: number;
  evidence_kinds_json: string;
  criterion_enc: string | null;
  nonce: string | null;
  state: CheckpointState;
  status_label: string | null;
  evidence_ids_json: string;
  escalate_call: number;
  generation: number;
  version: number;
  satisfied_at: number | null;
}

/** Owner-facing names for checkpoint outcomes: what was observed, never an inference. */
export const LABEL_TEXT: Record<string, string> = {
  call_acknowledged: "call acknowledged (keypad)",
  call_not_acknowledged: "call not acknowledged",
  registered_browser_checkin_received: "registered browser check-in received",
  text_checkin_received: "text check-in received",
  photo_consistent_assessed: "photo assessed as consistent",
  photo_received_unassessed: "photo received (not assessed)",
  photo_received_assessment_unavailable: "photo received; assessment unavailable",
  photo_unclear: "photo unclear",
  self_report_received: "self-report received",
  later_check_received: "later check answered",
  no_response_in_window: "no response in the window",
  browser_offline: "browser offline (unverifiable)",
  paused_or_opted_out: "waived (paused or opted out)",
  expired_before_request: "expired before it could be requested",
};

const WORDS = ["maple", "harbor", "copper", "lantern", "meadow", "falcon", "pebble", "cobalt", "willow", "ember", "quartz", "tundra"];

function cpJob(ctx: AppContext, cp: { id: string; generation: number }, phase: "request" | "grace" | "expire", dueAt: number): D1PreparedStatement {
  return jobInsertStatement(ctx, {
    logicalKey: `acc:${cp.id}:${phase}:g${cp.generation}`,
    kind: "acc_checkpoint",
    entityId: cp.id,
    entityGeneration: cp.generation,
    dueAt,
    maxAttempts: 3,
    payload: { phase },
  });
}

export async function getSession(ctx: AppContext, id: string): Promise<SessionRow | null> {
  return ctx.db.first<SessionRow>("SELECT * FROM acc_sessions WHERE id = ?", id);
}

async function moveSession(
  ctx: AppContext,
  s: SessionRow,
  event: SessionEvent,
  extra: { reason?: string; actualStart?: number; actualEnd?: number; pausedUntil?: number | null } = {},
): Promise<SessionRow | null> {
  const next = transition(s.state, event);
  if (!next) return null;
  const now = ctx.clock.now();
  const won = await ctx.db.run(
    `UPDATE acc_sessions SET state = ?, reason = COALESCE(?, reason), actual_start = COALESCE(actual_start, ?), actual_end = COALESCE(?, actual_end),
       paused_until = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ?`,
    next,
    extra.reason ?? null,
    extra.actualStart ?? null,
    extra.actualEnd ?? null,
    extra.pausedUntil !== undefined ? extra.pausedUntil : s.paused_until,
    now,
    s.id,
    s.version,
  );
  if (won !== 1) return null;
  return getSession(ctx, s.id);
}

export async function createSession(
  ctx: AppContext,
  input: {
    policyId: string;
    policyVersion: number;
    occurrenceKey: string;
    kind: string;
    start: number;
    end: number;
    taskId: string | null;
    alarmOccurrenceId?: string | null;
    callCap: number;
    checkpoints: CheckpointSpec[];
  },
): Promise<SessionRow> {
  const id = await stableId("ses", `${input.policyId}:${input.occurrenceKey}`);
  const existing = await getSession(ctx, id);
  if (existing) return existing;
  const now = ctx.clock.now();
  const stmts: D1PreparedStatement[] = [
    ctx.db.prepare(
      `INSERT OR IGNORE INTO acc_sessions (id, policy_id, policy_version, occurrence_key, kind, state, intended_start, intended_end, task_id, alarm_occurrence_id, call_cap, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'scheduled', ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.policyId,
      input.policyVersion,
      input.occurrenceKey,
      input.kind,
      input.start,
      input.end,
      input.taskId,
      input.alarmOccurrenceId ?? null,
      input.callCap,
      now,
      now,
    ),
  ];
  for (let i = 0; i < input.checkpoints.length; i++) {
    const c = input.checkpoints[i]!;
    const cpId = await stableId("acp", `${id}:${i}`);
    const at = input.start + c.offsetMin * MINUTE;
    stmts.push(
      ctx.db.prepare(
        `INSERT OR IGNORE INTO acc_checkpoints (id, session_id, ordinal, kind, label, intended_at, grace_until, expires_at, evidence_kinds_json, criterion_enc, nonce, escalate_call, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        cpId,
        id,
        i,
        c.kind,
        c.label,
        at,
        at + c.graceMin * MINUTE,
        at + c.expireMin * MINUTE,
        JSON.stringify(c.evidence),
        c.criterion ? await ctx.crypto.encrypt(c.criterion, "accountability") : null,
        WORDS[randomBytes(1)[0]! % WORDS.length]!,
        c.escalateCall ? 1 : 0,
        now,
        now,
      ),
    );
    if (c.kind === "call") stmts.push(cpJob(ctx, { id: cpId, generation: 1 }, "expire", at + c.expireMin * MINUTE));
    else stmts.push(cpJob(ctx, { id: cpId, generation: 1 }, "request", at));
  }
  stmts.push(jobInsertStatement(ctx, { logicalKey: `acc_end:${id}`, kind: "acc_session_end", entityId: id, dueAt: input.end, maxAttempts: 3 }));
  await ctx.db.batch(stmts);
  await audit(ctx, "sms", "accountability.session_created", "acc_session", id, `${input.kind} ${input.checkpoints.length} checks`);
  return (await getSession(ctx, id))!;
}

async function resolveTask(ctx: AppContext, ref: string | null): Promise<Task | null | "ambiguous"> {
  if (!ref) return null;
  if (isShortCode(ref.toUpperCase(), "T")) return getTaskByShortId(ctx, ref.toUpperCase());
  const t = await findOpenTasksByText(ctx, ref);
  if (t.length === 1) return t[0]!;
  return t.length > 1 ? "ambiguous" : null;
}

export interface StartInput {
  taskRef: string | null;
  start: number;
  end: number;
  checkpoints: Array<{ at: "start" | "halfway" | "end" | "offset"; offsetMinutes: number | null; evidence: "photo" | "text" | "device" | "any"; criterion: string | null }>;
  allowCall: boolean;
  actionKey: string;
}

/** Explicit owner-specified session: no redundant approval; scope is exactly this task and window. */
export async function startTaskSession(ctx: AppContext, input: StartInput): Promise<string> {
  const ext = await getExtSettings(ctx.db);
  if (!featureOn(ctx, ext, "task_accountability"))
    return "Task accountability is off. Reply ENABLE ACCOUNTABILITY to allow sessions you request (each one stays limited to the task and time you set).";
  const s = await getSettings(ctx.db);
  const task = await resolveTask(ctx, input.taskRef);
  if (task === "ambiguous") return `More than one task matches "${input.taskRef}". Reply with the task ID (e.g. T4K8).`;
  const title = task?.title ?? input.taskRef ?? "this session";
  const dur = Math.max(10, Math.round((input.end - input.start) / MINUTE));
  const specs: CheckpointSpec[] = (input.checkpoints.length ? input.checkpoints : [{ at: "halfway" as const, offsetMinutes: null, evidence: "any" as const, criterion: null }]).map(
    (c, i) => {
      const offset = c.at === "start" ? 0 : c.at === "halfway" ? Math.round(dur / 2) : c.at === "end" ? Math.max(0, dur - 5) : Math.min(dur, c.offsetMinutes ?? 0);
      const evidence: EvidenceKind[] = c.evidence === "any" ? ["photo", "text"] : c.evidence === "device" ? ["device", "text"] : [c.evidence];
      const criterion = c.criterion ?? (c.at === "start" ? `materials or setup for ${title} visible` : `visible progress on ${title}`);
      return {
        kind: c.evidence === "device" ? ("device_checkin" as const) : ("evidence" as const),
        label: c.at === "start" ? "start" : c.at === "halfway" ? "progress" : `check ${i + 1}`,
        offsetMin: offset,
        graceMin: 10,
        expireMin: 20,
        evidence,
        criterion,
        escalateCall: input.allowCall,
      };
    },
  );
  const policyId = await stableId("pol", input.actionKey);
  const now = ctx.clock.now();
  await ctx.db.run(
    "INSERT OR IGNORE INTO acc_policies (id, kind, task_id, status, timezone, config_json, source_action_key, created_at, updated_at) VALUES (?, 'task', ?, 'active', ?, ?, ?, ?, ?)",
    policyId,
    task?.id ?? null,
    s.timezone,
    JSON.stringify({ title, checkpoints: specs, callCap: input.allowCall ? 1 : 0 }),
    input.actionKey,
    now,
    now,
  );
  const session = await createSession(ctx, {
    policyId,
    policyVersion: 1,
    occurrenceKey: "once",
    kind: "task",
    start: input.start,
    end: input.end,
    taskId: task?.id ?? null,
    callCap: input.allowCall ? 1 : 0,
    checkpoints: specs,
  });
  const checks = specs.map(
    (c) =>
      `${formatTime(input.start + c.offsetMin * MINUTE, s.timezone)} ${c.evidence.includes("photo") ? (c.evidence.length > 1 ? "photo or note" : "photo") : c.evidence.includes("device") ? "browser check-in (or text)" : "short note"} (${c.label})`,
  );
  return `Accountability set: ${title}, ${formatRange(input.start, input.end, s.timezone)}. Checks: ${checks.join("; ")}. A check-in doesn't complete the task. Reply PAUSE 10, NO PHOTOS, or CANCEL ACCOUNTABILITY anytime. [${session.id.slice(4, 8).toUpperCase()}]`;
}

export async function startCheckOnce(ctx: AppContext, withinMinutes: number, actionKey: string): Promise<string> {
  const ext = await getExtSettings(ctx.db);
  if (!featureOn(ctx, ext, "task_accountability")) return "Accountability check-ins are off. Reply ENABLE ACCOUNTABILITY to allow ones you request.";
  const s = await getSettings(ctx.db);
  const now = ctx.clock.now();
  const policyId = await stableId("pol", actionKey);
  await ctx.db.run(
    "INSERT OR IGNORE INTO acc_policies (id, kind, status, timezone, config_json, source_action_key, created_at, updated_at) VALUES (?, 'check_once', 'active', ?, ?, ?, ?, ?)",
    policyId,
    s.timezone,
    JSON.stringify({ withinMinutes }),
    actionKey,
    now,
    now,
  );
  const half = Math.max(5, Math.round(withinMinutes / 2));
  await createSession(ctx, {
    policyId,
    policyVersion: 1,
    occurrenceKey: "once",
    kind: "check_once",
    start: now,
    end: now + withinMinutes * MINUTE,
    taskId: null,
    callCap: 0,
    checkpoints: [
      {
        kind: "text_check",
        label: "check-in",
        offsetMin: half,
        graceMin: Math.min(15, withinMinutes - half),
        expireMin: withinMinutes - half,
        evidence: ["text"],
        criterion: null,
        escalateCall: false,
      },
    ],
  });
  return `OK. I'll check on you once, around ${formatTime(now + half * MINUTE, s.timezone)}.`;
}

/**
 * Morning routine: a recurring wake call plus spaced checks, all relative to the wake time.
 * At most `callCap` (default 2) calls per morning occurrence across the wake call and any
 * escalation, shared. Nothing here measures "being awake" — only the checks the owner answered.
 */
export async function createMorningRoutine(
  ctx: AppContext,
  input: { hour: number; minute: number; recurrence: RecurrenceSpec | null; firstActivity: string | null; deviceCheck: boolean; actionKey: string },
): Promise<string> {
  const ext = await getExtSettings(ctx.db);
  if (!featureOn(ctx, ext, "morning")) return "Morning routines are off. Reply ENABLE MORNING ROUTINES to allow one.";
  const s = await getSettings(ctx.db);
  const rr = buildRRule(input.recurrence ?? { freq: "weekdays", weekdays: null, interval: null, count: null, until_date: null });
  if (!rr.ok) return rr.reason;
  const alarm = await createAlarm(ctx, {
    actionKey: `morning:${input.actionKey}`,
    hour: input.hour,
    minute: input.minute,
    timezone: s.timezone,
    rrule: rr.rrule,
    startDate: todayLocal(ctx.clock.now(), s.timezone),
    oneTimeAt: null,
    retryEnabled: false,
    readAgenda: false,
    label: "Wake-up call",
  });
  // One snooze at most: the snoozed call is the routine's second (last) call.
  await ctx.db.run("UPDATE alarm_schedules SET max_snoozes = 1 WHERE id = ?", alarm.alarm.id);
  const activity = input.firstActivity ?? "your first activity";
  const stages: CheckpointSpec[] = [
    { kind: "call", label: "wake call", offsetMin: 0, graceMin: 10, expireMin: 10, evidence: ["call"], criterion: null, escalateCall: false },
    input.deviceCheck
      ? { kind: "device_checkin", label: "laptop check-in", offsetMin: 5, graceMin: 5, expireMin: 10, evidence: ["device", "text"], criterion: null, escalateCall: true }
      : { kind: "text_check", label: "text check-in", offsetMin: 5, graceMin: 5, expireMin: 10, evidence: ["text"], criterion: null, escalateCall: true },
    {
      kind: "evidence",
      label: `${activity} started`,
      offsetMin: 15,
      graceMin: 10,
      expireMin: 15,
      evidence: ["photo", "text"],
      criterion: `${activity} visibly started`,
      escalateCall: false,
    },
    { kind: "later_check", label: "later check", offsetMin: 30, graceMin: 10, expireMin: 15, evidence: ["text", "device"], criterion: null, escalateCall: false },
  ];
  const config = { callCap: 2, stages };
  const policyId = await stableId("pol", input.actionKey);
  const now = ctx.clock.now();
  await ctx.db.run(
    "INSERT OR IGNORE INTO acc_policies (id, kind, alarm_id, status, timezone, config_json, source_action_key, created_at, updated_at) VALUES (?, 'morning', ?, 'active', ?, ?, ?, ?, ?)",
    policyId,
    alarm.alarm.id,
    s.timezone,
    JSON.stringify(config),
    input.actionKey,
    now,
    now,
  );
  await materializeMorningSessions(ctx);
  return `Morning routine set (${formatMinuteOfDay(input.hour * 60 + input.minute)} ${zoneLabel(now, s.timezone)}): wake call, ${input.deviceCheck ? "laptop check-in" : "text check-in"} at +5 min, ${activity} at +15, a later check at +30, then it stops. Max 2 calls per morning. A check-in shows you answered, not that you stayed up. Reply CANCEL ROUTINE anytime. [${alarm.alarm.short_id}]`;
}

/** One session per materialized wake-call occurrence of each active morning policy. */
export async function materializeMorningSessions(ctx: AppContext): Promise<number> {
  const policies = await ctx.db.all<{ id: string; alarm_id: string; version: number; config_json: string }>(
    "SELECT id, alarm_id, version, config_json FROM acc_policies WHERE kind = 'morning' AND status = 'active'",
  );
  let n = 0;
  for (const p of policies) {
    const cfg = parseJson<{ callCap: number; stages: CheckpointSpec[] }>(p.config_json, { callCap: 2, stages: [] });
    const occs = await ctx.db.all<{ id: string; occurrence_key: string; intended_at: number }>(
      "SELECT id, occurrence_key, intended_at FROM alarm_occurrences WHERE alarm_id = ? AND status = 'scheduled' AND intended_at > ?",
      p.alarm_id,
      ctx.clock.now(),
    );
    for (const o of occs) {
      const end = o.intended_at + (Math.max(...cfg.stages.map((x) => x.offsetMin + x.expireMin)) + 5) * MINUTE;
      await createSession(ctx, {
        policyId: p.id,
        policyVersion: p.version,
        occurrenceKey: o.occurrence_key,
        kind: "morning",
        start: o.intended_at,
        end,
        taskId: null,
        alarmOccurrenceId: o.id,
        callCap: cfg.callCap,
        checkpoints: cfg.stages,
      });
      n++;
    }
  }
  return n;
}

export async function activeSession(ctx: AppContext): Promise<SessionRow | null> {
  const now = ctx.clock.now();
  return ctx.db.first<SessionRow>(
    "SELECT * FROM acc_sessions WHERE state IN ('scheduled','awaiting_start','active','awaiting_checkpoint','paused') AND intended_start <= ? AND intended_end >= ? ORDER BY intended_start DESC LIMIT 1",
    now + 60 * MINUTE,
    now - 5 * MINUTE,
  );
}

async function openCheckpoints(ctx: AppContext, sessionId: string): Promise<CheckpointRow[]> {
  return ctx.db.all<CheckpointRow>("SELECT * FROM acc_checkpoints WHERE session_id = ? AND state IN ('pending','requested','needs_clarification') ORDER BY ordinal", sessionId);
}

async function cancelCheckpoints(ctx: AppContext, sessionId: string, label: string): Promise<void> {
  const now = ctx.clock.now();
  for (const c of await openCheckpoints(ctx, sessionId)) {
    await ctx.db.run(
      "UPDATE acc_checkpoints SET state = 'canceled', status_label = ?, generation = generation + 1, version = version + 1, updated_at = ? WHERE id = ?",
      label,
      now,
      c.id,
    );
    await ctx.db.run("UPDATE jobs SET status = 'canceled', last_error = ? WHERE entity_id = ? AND status = 'pending'", label, c.id);
    await ctx.db.run("UPDATE upload_tokens SET state = 'revoked' WHERE checkpoint_id = ? AND state = 'open'", c.id);
    await ctx.db.run("UPDATE device_challenges SET expires_at = ? WHERE checkpoint_id = ? AND consumed_at IS NULL", now, c.id);
  }
}

export async function cancelSession(ctx: AppContext, s: SessionRow, reason: string): Promise<boolean> {
  const moved = await moveSession(ctx, s, "cancel", { reason, actualEnd: ctx.clock.now() });
  if (!moved) return false;
  await cancelCheckpoints(ctx, s.id, reason);
  await ctx.db.run("UPDATE jobs SET status = 'canceled', last_error = ? WHERE entity_id = ? AND status = 'pending'", reason, s.id);
  return true;
}

/** STOP / erase: cancel every non-terminal session (accountability never outranks an opt-out). */
export async function cancelAllSessions(ctx: AppContext, reason: string): Promise<number> {
  const rows = await ctx.db.all<SessionRow>("SELECT * FROM acc_sessions WHERE state NOT IN ('completed','canceled','expired','needs_attention')");
  let n = 0;
  for (const r of rows) if (await cancelSession(ctx, r, reason)) n++;
  return n;
}

export async function controlSession(ctx: AppContext, op: "pause" | "resume" | "cancel" | "cancel_routine" | "no_photos" | "status", minutes: number | null): Promise<string> {
  if (op === "cancel_routine") {
    const routine = await ctx.db.first<{ id: string }>("SELECT id FROM acc_policies WHERE kind = 'morning' AND status = 'active' ORDER BY created_at DESC LIMIT 1");
    return routine ? cancelRoutine(ctx, routine.id) : "You don't have a morning routine set.";
  }
  const s = await activeSession(ctx);
  const st = await getSettings(ctx.db);
  if (!s) {
    if (op === "cancel") {
      const routine = await ctx.db.first<{ id: string }>("SELECT id FROM acc_policies WHERE kind = 'morning' AND status = 'active' ORDER BY created_at DESC LIMIT 1");
      if (routine) return cancelRoutine(ctx, routine.id);
    }
    return "No accountability session is active.";
  }
  const now = ctx.clock.now();
  switch (op) {
    case "status": {
      const cps = await ctx.db.all<CheckpointRow>("SELECT * FROM acc_checkpoints WHERE session_id = ? ORDER BY ordinal", s.id);
      return `Session ${s.state.replace("_", " ")}: ${cps.map((c) => `${c.label} ${c.state}${c.status_label ? ` (${c.status_label.replace(/_/g, " ")})` : ""}`).join("; ")}.`;
    }
    case "pause": {
      const m = minutes ?? 10;
      const moved = await moveSession(ctx, s, "pause", { pausedUntil: now + m * MINUTE });
      return moved
        ? `Paused for ${m} minutes (until ${formatTime(now + m * MINUTE, st.timezone)}). Checks due meanwhile wait until then.`
        : "That session can't be paused right now.";
    }
    case "resume": {
      const moved = await moveSession(ctx, s, "resume", { pausedUntil: null });
      return moved ? "Session resumed." : "That session isn't paused.";
    }
    case "cancel":
      if (!(await cancelSession(ctx, s, "owner_canceled"))) return "Couldn't cancel; the session already ended.";
      return s.kind === "morning"
        ? "This morning's routine is canceled. Future mornings are unchanged; reply CANCEL ROUTINE to stop them."
        : "Accountability canceled for this session. The task itself is unchanged.";
    case "no_photos": {
      await ctx.db.run("UPDATE acc_sessions SET photos_allowed = 0, version = version + 1, updated_at = ? WHERE id = ?", now, s.id);
      for (const c of await openCheckpoints(ctx, s.id)) {
        const ev = parseJson<EvidenceKind[]>(c.evidence_kinds_json, []).filter((e) => e !== "photo");
        await ctx.db.run(
          "UPDATE acc_checkpoints SET evidence_kinds_json = ?, version = version + 1, updated_at = ? WHERE id = ?",
          JSON.stringify(ev.length ? ev : ["text"]),
          now,
          c.id,
        );
        if (c.state !== "pending")
          await createClarification(ctx, {
            type: "acc_check",
            options: [],
            freeform: "text",
            pending: { action: { checkpointId: c.id }, slot: null, anchorMs: now, sourceInboundId: null },
            prompt: `Check "${c.label}": reply with a short note.`,
            sourceActionKey: `acc_q:${c.id}:nophotos`,
            ttlMs: Math.max(MINUTE, c.expires_at - now),
          });
      }
      await ctx.db.run("UPDATE upload_tokens SET state = 'revoked' WHERE session_id = ? AND state = 'open'", s.id);
      return "No more photos for this session; I'll ask for a short note instead. The task and its reminders are unchanged.";
    }
  }
}

export async function cancelRoutine(ctx: AppContext, policyId: string): Promise<string> {
  const p = await ctx.db.first<{ alarm_id: string | null }>("SELECT alarm_id FROM acc_policies WHERE id = ?", policyId);
  await ctx.db.run("UPDATE acc_policies SET status = 'canceled', canceled_at = ?, version = version + 1, updated_at = ? WHERE id = ?", ctx.clock.now(), ctx.clock.now(), policyId);
  for (const s of await ctx.db.all<SessionRow>("SELECT * FROM acc_sessions WHERE policy_id = ? AND state NOT IN ('completed','canceled','expired','needs_attention')", policyId))
    await cancelSession(ctx, s, "routine_canceled");
  if (p?.alarm_id) {
    const { cancelAlarm } = await import("../domain/alarms");
    await cancelAlarm(ctx, p.alarm_id);
  }
  return "Morning routine canceled, including its wake-up calls.";
}

async function sendText(ctx: AppContext, key: string, body: string): Promise<void> {
  const effect = await ensureSmsEffect(ctx, { effectKey: key, purpose: "reminder", body });
  await deliverSmsEffect(ctx, effect.id, "proactive");
}

async function settleCheckpoint(ctx: AppContext, cp: CheckpointRow, state: CheckpointState, label: string, evidenceId?: string): Promise<boolean> {
  const now = ctx.clock.now();
  const ev = parseJson<string[]>(cp.evidence_ids_json, []);
  if (evidenceId) ev.push(evidenceId);
  const won = await ctx.db.run(
    "UPDATE acc_checkpoints SET state = ?, status_label = ?, evidence_ids_json = ?, satisfied_at = CASE WHEN ? = 'satisfied' THEN ? ELSE satisfied_at END, generation = generation + 1, version = version + 1, updated_at = ? WHERE id = ? AND version = ? AND state IN ('pending','requested','needs_clarification')",
    state,
    label,
    JSON.stringify(ev),
    state,
    now,
    now,
    cp.id,
    cp.version,
  );
  if (won !== 1) return false;
  await ctx.db.run("UPDATE jobs SET status = 'canceled', last_error = 'checkpoint_settled' WHERE entity_id = ? AND kind = 'acc_checkpoint' AND status = 'pending'", cp.id);
  const s = await getSession(ctx, cp.session_id);
  if (s && s.state === "awaiting_checkpoint" && (await openCheckpoints(ctx, s.id)).every((c) => c.state === "pending")) await moveSession(ctx, s, "resolve");
  if (s && (s.state === "scheduled" || s.state === "awaiting_start")) await moveSession(ctx, s, "start", { actualStart: now });
  return true;
}

export async function getCheckpoint(ctx: AppContext, id: string): Promise<CheckpointRow | null> {
  return ctx.db.first<CheckpointRow>("SELECT * FROM acc_checkpoints WHERE id = ?", id);
}

/** Owner text answering a requested check: recorded as self-report, never as task completion. */
export async function submitTextEvidence(ctx: AppContext, checkpointId: string, text: string): Promise<string> {
  const cp = await getCheckpoint(ctx, checkpointId);
  if (!cp || !CHECKPOINT_OPEN.has(cp.state)) return "That check already closed.";
  const kinds = parseJson<EvidenceKind[]>(cp.evidence_kinds_json, []);
  if (!kinds.includes("text")) return "This check needs a photo or a browser check-in rather than a text.";
  const now = ctx.clock.now();
  const sub = newId("evs");
  const ext = await getExtSettings(ctx.db);
  await ctx.db.run(
    "INSERT OR IGNORE INTO evidence_submissions (id, dedupe_key, session_id, checkpoint_id, kind, text_enc, received_at, state, expires_at, created_at) VALUES (?, ?, ?, ?, 'text', ?, ?, 'not_assessable', ?, ?)",
    sub,
    `text:${checkpointId}:${now}`,
    cp.session_id,
    cp.id,
    await ctx.crypto.encrypt(text.slice(0, 300), "evidence"),
    now,
    now + ext.accountability_summary_days * 86_400_000,
    now,
  );
  const label = cp.kind === "device_checkin" ? "text_checkin_received" : cp.kind === "later_check" ? "later_check_received" : "self_report_received";
  await settleCheckpoint(ctx, cp, "satisfied", label, sub);
  return `Got it, check "${cp.label}" recorded as your note. That's a check-in, not task completion.`;
}

export async function satisfyByDevice(ctx: AppContext, checkpointId: string, evidenceId: string): Promise<boolean> {
  const cp = await getCheckpoint(ctx, checkpointId);
  if (!cp || !CHECKPOINT_OPEN.has(cp.state)) return false;
  return settleCheckpoint(ctx, cp, "satisfied", cp.kind === "later_check" ? "later_check_received" : "registered_browser_checkin_received", evidenceId);
}

export async function applyPhotoAssessment(
  ctx: AppContext,
  checkpointId: string,
  submissionId: string,
  verdict: "consistent" | "inconsistent" | "unclear" | "unavailable" | "not_assessed",
): Promise<void> {
  const cp = await getCheckpoint(ctx, checkpointId);
  if (!cp || !CHECKPOINT_OPEN.has(cp.state)) return;
  const st = await getSettings(ctx.db);
  if (verdict === "consistent") await settleCheckpoint(ctx, cp, "satisfied", "photo_consistent_assessed", submissionId);
  else if (verdict === "not_assessed") await settleCheckpoint(ctx, cp, "satisfied", "photo_received_unassessed", submissionId);
  else if (verdict === "unclear") {
    // The reply offers a note as an alternative, so the check must accept one.
    const kinds = [...new Set([...parseJson<EvidenceKind[]>(cp.evidence_kinds_json, []), "text" as const])];
    await ctx.db.run(
      "UPDATE acc_checkpoints SET state = 'needs_clarification', status_label = 'photo_unclear', evidence_kinds_json = ?, version = version + 1, updated_at = ? WHERE id = ? AND state IN ('requested','pending')",
      JSON.stringify(kinds),
      ctx.clock.now(),
      cp.id,
    );
    await createClarification(ctx, {
      type: "acc_check",
      options: [],
      freeform: "text",
      pending: { action: { checkpointId: cp.id }, slot: null, anchorMs: ctx.clock.now(), sourceInboundId: null },
      prompt: `Check "${cp.label}": send another photo or reply with a short note.`,
      sourceActionKey: `acc_q:${cp.id}:unclear:${submissionId}`,
      ttlMs: Math.max(MINUTE, cp.expires_at - ctx.clock.now()),
    });
    await sendText(
      ctx,
      `acc_unclear:${submissionId}`,
      `The photo for "${cp.label}" was unclear to me. Send another, or reply with a short note (until ${formatTime(cp.expires_at, st.timezone)}).`,
    );
  } else if (verdict === "inconsistent") {
    await sendText(ctx, `acc_inconsistent:${submissionId}`, `That photo didn't seem to show "${cp.label}". That's just my read of the image. Send another or reply with a note.`);
  }
  // "unavailable": evidence stays received_unassessed; the check closes as unverifiable at expiry.
}

/** Wake call keypad acknowledgement satisfies only the call stage of its routine. */
export async function onAlarmAcknowledged(ctx: AppContext, occurrenceId: string): Promise<void> {
  const s = await ctx.db.first<SessionRow>("SELECT * FROM acc_sessions WHERE alarm_occurrence_id = ?", occurrenceId);
  if (!s) return;
  const cp = await ctx.db.first<CheckpointRow>("SELECT * FROM acc_checkpoints WHERE session_id = ? AND kind = 'call' AND state IN ('pending','requested')", s.id);
  if (cp) await settleCheckpoint(ctx, cp, "satisfied", "call_acknowledged");
}

async function callsUsed(ctx: AppContext, s: SessionRow): Promise<number> {
  let n = s.call_attempts;
  if (s.alarm_occurrence_id) n += (await getOccurrence(ctx, s.alarm_occurrence_id))?.attempt_count ?? 0;
  return n;
}

async function escalateCall(ctx: AppContext, s: SessionRow, cp: CheckpointRow): Promise<boolean> {
  if (!cp.escalate_call || (await callsUsed(ctx, s)) >= s.call_cap) return false;
  const won = await ctx.db.run(
    "UPDATE acc_sessions SET call_attempts = call_attempts + 1, version = version + 1, updated_at = ? WHERE id = ? AND version = ?",
    ctx.clock.now(),
    s.id,
    s.version,
  );
  if (won !== 1) return false;
  const st = await getSettings(ctx.db);
  const at = ctx.clock.now() + MINUTE;
  const p = localParts(at, st.timezone);
  const { alarm } = await createAlarm(ctx, {
    actionKey: `acc-call:${s.id}:${cp.id}`,
    hour: p.hour,
    minute: p.minute,
    timezone: st.timezone,
    rrule: null,
    startDate: null,
    oneTimeAt: at,
    retryEnabled: false,
    readAgenda: false,
    label: "accountability check call",
  });
  await ctx.db.run("UPDATE alarm_schedules SET max_snoozes = 0 WHERE id = ?", alarm.id);
  return true;
}

export async function handleCheckpointJob(ctx: AppContext, job: JobRow): Promise<JobOutcome> {
  const cp = await getCheckpoint(ctx, job.entity_id ?? "");
  if (!cp) return { status: "skipped", result: { reason: "missing" } };
  if (cp.generation !== job.entity_generation) return { status: "skipped", result: { reason: "stale_generation" } };
  if (!CHECKPOINT_OPEN.has(cp.state)) return { status: "skipped", result: { reason: `checkpoint_${cp.state}` } };
  let s = await getSession(ctx, cp.session_id);
  if (!s || TERMINAL.has(s.state)) return { status: "skipped", result: { reason: "session_closed" } };
  const now = ctx.clock.now();
  if (s.state === "paused") {
    if (s.paused_until && s.paused_until > now) return { status: "reschedule", dueAt: s.paused_until, reason: "session_paused" };
    s = (await moveSession(ctx, s, "resume", { pausedUntil: null })) ?? s;
  }
  const st = await getSettings(ctx.db);
  const { phase } = parsePayload<{ phase: "request" | "grace" | "expire" }>(job);
  if (isPaused(st, now, "reminders") || (await ctx.db.first<{ state: string }>("SELECT state FROM suppressions WHERE channel = 'sms' AND state = 'opted_out'"))) {
    await settleCheckpoint(ctx, cp, "waived", "paused_or_opted_out");
    return { status: "skipped", result: { reason: "paused" } };
  }
  const kinds = parseJson<EvidenceKind[]>(cp.evidence_kinds_json, []);
  const criterion = (await ctx.crypto.decryptNullable(cp.criterion_enc, "accountability")) ?? cp.label;
  const total = (await ctx.db.first<{ n: number }>("SELECT COUNT(*) AS n FROM acc_checkpoints WHERE session_id = ? AND kind != 'call'", s.id))?.n ?? 1;
  const ext = await getExtSettings(ctx.db);

  if (phase === "request") {
    if (now > cp.expires_at) {
      await settleCheckpoint(ctx, cp, "missed", "expired_before_request");
      return { status: "skipped", result: { reason: "expired" } };
    }
    await ctx.db.run("UPDATE acc_checkpoints SET state = 'requested', version = version + 1, updated_at = ? WHERE id = ? AND state = 'pending'", now, cp.id);
    if (s.state === "scheduled") s = (await moveSession(ctx, s, cp.ordinal === 0 ? "arm" : "request", {})) ?? s;
    if (s.state === "active" || s.state === "awaiting_start") s = (await moveSession(ctx, s, "request")) ?? s;
    const parts: string[] = [];
    const n = cp.ordinal + (s.kind === "morning" ? 0 : 1);
    const head = `Check ${Math.min(n, total)}/${total} (${cp.label})`;
    if (cp.kind === "device_checkin") {
      const issued = featureOn(ctx, ext, "telemetry") ? await issueDeviceChallenges(ctx, s.id, cp.id, cp.grace_until) : 0;
      const alt = kinds.includes("text") ? ", or reply HERE" : "";
      parts.push(issued ? `click the Della check-in in your registered browser${alt}.` : `no registered browser is available${alt ? "; reply HERE instead" : ""}.`);
    } else if (cp.kind === "evidence") {
      parts.push(`show: ${criterion}.`);
      if (kinds.includes("photo") && s.photos_allowed && featureOn(ctx, ext, "uploads")) {
        const link = await issueUploadToken(ctx, { purpose: "accountability", sessionId: s.id, checkpointId: cp.id, expiresAt: cp.expires_at });
        parts.push(`Photo: ${link}${featureOn(ctx, ext, "mms") ? " (or MMS)" : ""}`);
      }
      if (kinds.includes("text")) parts.push("Or reply with a short note.");
      parts.push(`Code word: ${cp.nonce}.`);
    } else {
      parts.push("how's it going? Reply with a short note.");
    }
    if (kinds.includes("text")) {
      await createClarification(ctx, {
        type: "acc_check",
        options: [],
        freeform: "text",
        pending: { action: { checkpointId: cp.id }, slot: null, anchorMs: now, sourceInboundId: null },
        prompt: `${head}: ${parts.join(" ")}`,
        sourceActionKey: `acc_q:${cp.id}`,
        ttlMs: cp.expires_at - now,
      });
    }
    await sendText(ctx, `acc:${cp.id}:request`, `${head}: ${parts.join(" ")} Until ${formatTime(cp.expires_at, st.timezone)}.`);
    await ctx.db.batch([cpJob(ctx, cp, "grace", cp.grace_until)]);
    return { status: "succeeded", result: { requested: true } };
  }

  if (phase === "grace") {
    const called = await escalateCall(ctx, s, cp);
    await sendText(
      ctx,
      `acc:${cp.id}:grace`,
      `Still waiting on "${cp.label}" (until ${formatTime(cp.expires_at, st.timezone)}).${called ? " I'll also call once." : ""} Reply with a note${kinds.includes("photo") && s.photos_allowed ? " or send the photo" : ""}.`,
    );
    await ctx.db.batch([cpJob(ctx, cp, "expire", cp.expires_at)]);
    return { status: "succeeded", result: { escalatedCall: called } };
  }

  // expire
  let state: CheckpointState = "missed";
  let label = "no_response_in_window";
  if (cp.kind === "call") label = "call_not_acknowledged";
  // An offline browser is an observation gap, not a failure: never "missed".
  if (cp.kind === "device_checkin" && !(await devicesOnline(ctx))) {
    state = "unverifiable";
    label = "browser_offline";
  }
  const pendingPhoto = await ctx.db.first("SELECT id FROM evidence_submissions WHERE checkpoint_id = ? AND kind = 'photo' AND state IN ('received_unassessed')", cp.id);
  if (pendingPhoto || cp.state === "needs_clarification") {
    state = "unverifiable";
    label = pendingPhoto ? "photo_received_assessment_unavailable" : "photo_unclear";
  }
  await settleCheckpoint(ctx, cp, state, label);
  return { status: "succeeded", result: { state, label } };
}

export async function handleSessionEnd(ctx: AppContext, job: JobRow): Promise<JobOutcome> {
  const s = await getSession(ctx, job.entity_id ?? "");
  if (!s || TERMINAL.has(s.state)) return { status: "skipped", result: { reason: "closed" } };
  const now = ctx.clock.now();
  if (s.state === "paused" && s.paused_until && s.paused_until > now) return { status: "reschedule", dueAt: s.paused_until + MINUTE, reason: "paused" };
  // Close any still-open checks deterministically first.
  for (const c of await openCheckpoints(ctx, s.id)) if (c.expires_at > now) return { status: "reschedule", dueAt: c.expires_at + MINUTE, reason: "checks_open" };
  const cps = await ctx.db.all<CheckpointRow>("SELECT * FROM acc_checkpoints WHERE session_id = ? ORDER BY ordinal", s.id);
  const count = (st: string) => cps.filter((c) => c.state === st).length;
  const satisfied = count("satisfied");
  const missed = count("missed");
  const unverifiable = count("unverifiable");
  const waived = count("waived") + count("canceled");
  const event: SessionEvent = missed > 0 ? "attention" : "finish";
  let cur = s;
  if (cur.state === "paused") cur = (await moveSession(ctx, cur, "resume", { pausedUntil: null })) ?? cur;
  if (cur.state === "scheduled" || cur.state === "awaiting_start") cur = (await moveSession(ctx, cur, "start", { actualStart: cur.intended_start })) ?? cur;
  const moved = await moveSession(ctx, cur, event, { actualEnd: now, reason: missed ? "missed_checks" : "routine_checks_satisfied" });
  const detail = cps.map((c) => `${c.label}: ${c.status_label ? (LABEL_TEXT[c.status_label] ?? c.status_label.replace(/_/g, " ")) : c.state}`).join("; ");
  const summary = `${s.kind === "morning" ? "Morning routine" : "Session"} ended: ${satisfied} satisfied, ${missed} missed, ${unverifiable} unverifiable${waived ? `, ${waived} waived` : ""}. ${detail}. These are the checks you answered, not a measure of time worked or of being awake. No further monitoring.`;
  await ctx.db.run("UPDATE acc_sessions SET summary_enc = ? WHERE id = ?", await ctx.crypto.encrypt(summary, "accountability"), s.id);
  await sendText(ctx, `acc_end:${s.id}`, summary);
  return { status: "succeeded", result: { state: moved?.state ?? null, satisfied, missed, unverifiable } };
}
