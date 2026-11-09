import type { AppContext } from "../context";
import { log } from "../observability/log";
import type { CallStatus, VerifiedVoiceRequest, VoiceScript } from "../providers/types";
import { newId, randomBytes, shortCodeFromBytes, stableId } from "../security/crypto";
import { audit, auditStatement } from "../services/audit";
import { getEffect, type EffectRow } from "../services/effects";
import { jobInsertStatement, type JobOutcome, type JobRow } from "../services/jobs";
import { voiceGate } from "../services/readiness";
import { getSettings } from "../services/settings";
import { commitUsage, recordUsage, releaseUsage, reserveUsage } from "../services/usage";
import { onAlarmAcknowledged } from "../accountability/sessions";
import { firstOccurrence, nextOccurrenceAfter, type SeriesRule } from "./recurrence";
import { MINUTE, formatMinuteOfDay, formatTime, localDayBounds, localParts } from "./time";

/**
 * Wake-up calls are BEST EFFORT: minute-scale cron, provider and carrier delays, and phone
 * settings all affect timing. A phone's native alarm is the dependable backup.
 *
 * Only an explicit keypad "1" (or an "I'm awake" SMS) acknowledges an occurrence. A completed,
 * answered, or voicemail call is not evidence the owner is awake.
 */

export const WAKE_CALL_EXPIRY_MS = 10 * MINUTE;
export const RING_TIMEOUT_SEC = 30;
export const MAX_CALL_SEC = 90;

export interface AlarmRow {
  id: string;
  short_id: string;
  label: string;
  local_time: string;
  timezone: string;
  series_id: string | null;
  one_time_at: number | null;
  enabled: number;
  retry_enabled: number;
  max_attempts: number;
  retry_delay_minutes: number;
  snooze_minutes: number;
  max_snoozes: number;
  read_agenda: number;
  source_action_key: string | null;
  generation: number;
  version: number;
  created_at: number;
  updated_at: number;
  canceled_at: number | null;
}

export type OccurrenceStatus = "scheduled" | "calling" | "snoozed" | "retry_scheduled" | "acknowledged" | "missed" | "canceled" | "expired" | "unknown";

export interface OccurrenceRow {
  id: string;
  alarm_id: string;
  occurrence_key: string;
  intended_at: number;
  target_at: number;
  status: OccurrenceStatus;
  generation: number;
  attempt_count: number;
  window_attempts: number;
  max_attempts: number;
  snooze_count: number;
  active_effect_id: string | null;
  acknowledged_at: number | null;
  acknowledged_via: string | null;
  status_reason: string | null;
  agenda_enc: string | null;
  created_at: number;
  updated_at: number;
}

const ACTIVE_STATUSES: OccurrenceStatus[] = ["scheduled", "calling", "snoozed", "retry_scheduled", "unknown"];

export async function getAlarm(ctx: AppContext, id: string): Promise<AlarmRow | null> {
  return ctx.db.first<AlarmRow>("SELECT * FROM alarm_schedules WHERE id = ?", id);
}

export async function getOccurrence(ctx: AppContext, id: string): Promise<OccurrenceRow | null> {
  return ctx.db.first<OccurrenceRow>("SELECT * FROM alarm_occurrences WHERE id = ?", id);
}

function callJobStatement(ctx: AppContext, occ: { id: string }, generation: number, attemptLabel: string, dueAt: number): D1PreparedStatement {
  return jobInsertStatement(ctx, {
    logicalKey: `alarm_call:${occ.id}:g${generation}:${attemptLabel}`,
    kind: "alarm_call",
    entityId: occ.id,
    entityGeneration: generation,
    dueAt,
    intendedAt: dueAt,
    expiresAt: dueAt + WAKE_CALL_EXPIRY_MS,
    maxAttempts: 3,
    payload: { attemptLabel },
  });
}

export async function materializeOccurrence(ctx: AppContext, alarm: AlarmRow, occKey: string, atMs: number): Promise<boolean> {
  const occId = await stableId("occ", `${alarm.id}:${occKey}`);
  const now = ctx.clock.now();
  const changes = await ctx.db.batch([
    ctx.db.prepare(
      `INSERT INTO alarm_occurrences (id, alarm_id, occurrence_key, intended_at, target_at, status, generation, max_attempts, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'scheduled', 1, ?, ?, ?) ON CONFLICT (alarm_id, occurrence_key) DO NOTHING`,
      occId,
      alarm.id,
      occKey,
      atMs,
      atMs,
      alarm.retry_enabled ? alarm.max_attempts : 1,
      now,
      now,
    ),
    // Deterministic job key: re-running this batch for an existing occurrence is a no-op.
    callJobStatement(ctx, { id: occId }, 1, "a1", atMs),
  ]);
  return changes[0] === 1;
}

export interface CreateAlarmInput {
  actionKey: string;
  hour: number;
  minute: number;
  timezone: string;
  rrule: string | null;
  startDate: string | null;
  oneTimeAt: number | null;
  retryEnabled: boolean;
  readAgenda: boolean;
  label?: string;
}

export async function createAlarm(ctx: AppContext, input: CreateAlarmInput): Promise<{ alarm: AlarmRow; created: boolean; nextAt: number | null }> {
  const id = await stableId("alm", input.actionKey);
  const existing = await getAlarm(ctx, id);
  if (existing) return { alarm: existing, created: false, nextAt: await nextOccurrenceTime(ctx, existing.id) };
  const now = ctx.clock.now();
  const localTime = `${String(input.hour).padStart(2, "0")}:${String(input.minute).padStart(2, "0")}`;
  let seriesId: string | null = null;
  const statements: D1PreparedStatement[] = [];
  if (input.rrule) {
    seriesId = await stableId("ser", `alarm:${input.actionKey}`);
    statements.push(
      ctx.db.prepare(
        `INSERT INTO series (id, kind, rrule, dtstart_local, timezone, local_time, status, created_at, updated_at) VALUES (?, 'alarm', ?, ?, ?, ?, 'active', ?, ?)
         ON CONFLICT (id) DO NOTHING`,
        seriesId,
        input.rrule,
        `${input.startDate}T${localTime}`,
        input.timezone,
        localTime,
        now,
        now,
      ),
    );
  }
  statements.push(
    ctx.db.prepare(
      `INSERT INTO alarm_schedules (id, short_id, label, local_time, timezone, series_id, one_time_at, enabled, retry_enabled, read_agenda, source_action_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
      id,
      shortCodeFromBytes("W", randomBytes(3)),
      input.label ?? "Wake-up call",
      localTime,
      input.timezone,
      seriesId,
      input.oneTimeAt,
      input.retryEnabled ? 1 : 0,
      input.readAgenda ? 1 : 0,
      input.actionKey,
      now,
      now,
    ),
    auditStatement(ctx, "sms", "alarm.create", "alarm", id, input.rrule ? `recurring ${input.rrule}` : "one-time"),
  );
  await ctx.db.batch(statements);
  const alarm = (await getAlarm(ctx, id))!;
  await materializeAlarm(ctx, alarm, now);
  return { alarm, created: true, nextAt: await nextOccurrenceTime(ctx, id) };
}

export async function nextOccurrenceTime(ctx: AppContext, alarmId: string): Promise<number | null> {
  const r = await ctx.db.first<{ t: number }>(
    "SELECT target_at AS t FROM alarm_occurrences WHERE alarm_id = ? AND status IN ('scheduled','snoozed','retry_scheduled') ORDER BY target_at LIMIT 1",
    alarmId,
  );
  if (r) return r.t;
  const alarm = await getAlarm(ctx, alarmId);
  if (alarm?.series_id) {
    const s = await ctx.db.first<{ next_occurrence_at: number | null }>("SELECT next_occurrence_at FROM series WHERE id = ?", alarm.series_id);
    return s?.next_occurrence_at ?? null;
  }
  return null;
}

/** Materializes the next occurrence (only one ahead; never a backlog). */
export async function materializeAlarm(ctx: AppContext, alarm: AlarmRow, now: number, horizonMs = 36 * 60 * MINUTE): Promise<void> {
  if (!alarm.enabled) return;
  if (!alarm.series_id) {
    if (alarm.one_time_at) await materializeOccurrence(ctx, alarm, `once:${alarm.one_time_at}`, alarm.one_time_at);
    return;
  }
  const series = await ctx.db.first<{
    id: string;
    rrule: string;
    dtstart_local: string;
    timezone: string;
    status: string;
    next_occurrence_at: number | null;
    next_occurrence_key: string | null;
  }>("SELECT * FROM series WHERE id = ?", alarm.series_id);
  if (!series || series.status !== "active") return;
  const rule: SeriesRule = { rrule: series.rrule, dtstartLocal: series.dtstart_local, timezone: series.timezone };
  let next = series.next_occurrence_at !== null && series.next_occurrence_key ? { ms: series.next_occurrence_at, key: series.next_occurrence_key } : null;
  if (!next) {
    const first = firstOccurrence(rule);
    const occ = first && first.ms > now ? first : nextOccurrenceAfter(rule, now);
    if (!occ) {
      await ctx.db.run("UPDATE series SET status = 'ended', updated_at = ? WHERE id = ?", now, series.id);
      return;
    }
    next = { ms: occ.ms, key: occ.key };
  }
  // Coalesce: an occurrence whose call window has passed is skipped, not called late.
  if (next.ms + WAKE_CALL_EXPIRY_MS < now) {
    const occ = nextOccurrenceAfter(rule, now);
    log("info", "alarm_occurrences_coalesced", { alarmId: alarm.id });
    next = occ ? { ms: occ.ms, key: occ.key } : null;
  }
  for (let i = 0; next && next.ms <= now + horizonMs && i < 3; i++) {
    await materializeOccurrence(ctx, alarm, next.key, next.ms);
    const after = nextOccurrenceAfter(rule, next.ms);
    next = after ? { ms: after.ms, key: after.key } : null;
  }
  await ctx.db.run(
    "UPDATE series SET next_occurrence_at = ?, next_occurrence_key = ?, status = CASE WHEN ? IS NULL THEN 'ended' ELSE status END, updated_at = ? WHERE id = ?",
    next?.ms ?? null,
    next?.key ?? null,
    next?.ms ?? null,
    now,
    series.id,
  );
}

function cancelOccurrenceJobs(ctx: AppContext, occId: string, reason: string): D1PreparedStatement {
  const now = ctx.clock.now();
  return ctx.db.prepare(
    "UPDATE jobs SET status = 'canceled', last_error = ?, finished_at = ?, updated_at = ? WHERE entity_id = ? AND kind = 'alarm_call' AND status = 'pending'",
    reason,
    now,
    now,
    occId,
  );
}

export async function cancelAlarm(ctx: AppContext, alarmId: string, actor: "sms" | "admin" = "sms"): Promise<boolean> {
  const alarm = await getAlarm(ctx, alarmId);
  if (!alarm || !alarm.enabled) return false;
  const now = ctx.clock.now();
  const won =
    (await ctx.db.run(
      "UPDATE alarm_schedules SET enabled = 0, canceled_at = ?, generation = generation + 1, version = version + 1, updated_at = ? WHERE id = ? AND version = ?",
      now,
      now,
      alarmId,
      alarm.version,
    )) === 1;
  if (!won) return false;
  const occs = await ctx.db.all<{ id: string }>(
    `SELECT id FROM alarm_occurrences WHERE alarm_id = ? AND status IN ('scheduled','calling','snoozed','retry_scheduled','unknown')`,
    alarmId,
  );
  const statements: D1PreparedStatement[] = [];
  for (const o of occs) {
    statements.push(
      cancelOccurrenceJobs(ctx, o.id, "alarm_canceled"),
      ctx.db.prepare("UPDATE alarm_occurrences SET status = 'canceled', status_reason = 'alarm_canceled', generation = generation + 1, updated_at = ? WHERE id = ?", now, o.id),
    );
  }
  if (alarm.series_id)
    statements.push(ctx.db.prepare("UPDATE series SET status = 'canceled', canceled_at = ?, next_occurrence_at = NULL, updated_at = ? WHERE id = ?", now, now, alarm.series_id));
  statements.push(auditStatement(ctx, actor, "alarm.cancel", "alarm", alarmId));
  await ctx.db.batch(statements);
  return true;
}

/** Cancels only the next pending occurrence of an alarm (the schedule continues). */
export async function cancelNextOccurrence(ctx: AppContext, alarmId: string): Promise<OccurrenceRow | null> {
  const occ = await ctx.db.first<OccurrenceRow>(
    "SELECT * FROM alarm_occurrences WHERE alarm_id = ? AND status IN ('scheduled','snoozed','retry_scheduled') ORDER BY target_at LIMIT 1",
    alarmId,
  );
  if (!occ) return null;
  const now = ctx.clock.now();
  const won =
    (await ctx.db.run(
      "UPDATE alarm_occurrences SET status = 'canceled', status_reason = 'skipped_by_owner', generation = generation + 1, updated_at = ? WHERE id = ? AND generation = ?",
      now,
      occ.id,
      occ.generation,
    )) === 1;
  if (!won) return null;
  await ctx.db.batch([cancelOccurrenceJobs(ctx, occ.id, "occurrence_canceled")]);
  return occ;
}

/** Acknowledgement (keypad 1 or "I'm awake"): conditional, generation bump cancels retries. */
export async function acknowledgeOccurrence(ctx: AppContext, occ: OccurrenceRow, via: "keypad" | "sms", requireEffectId?: string): Promise<boolean> {
  const now = ctx.clock.now();
  const effectClause = requireEffectId ? " AND active_effect_id = ?" : "";
  const params: Array<string | number> = [now, via, now, occ.id, occ.generation];
  if (requireEffectId) params.push(requireEffectId);
  const won =
    (await ctx.db.run(
      `UPDATE alarm_occurrences SET status = 'acknowledged', acknowledged_at = ?, acknowledged_via = ?, generation = generation + 1, updated_at = ?
       WHERE id = ? AND generation = ? AND status IN ('scheduled','calling','snoozed','retry_scheduled','unknown')${effectClause}`,
      ...params,
    )) === 1;
  if (!won) return false;
  await ctx.db.batch([
    cancelOccurrenceJobs(ctx, occ.id, "acknowledged"),
    auditStatement(ctx, via === "keypad" ? "provider" : "sms", "alarm.acknowledged", "alarm_occurrence", occ.id, via),
  ]);
  await onAlarmAcknowledged(ctx, occ.id);
  return true;
}

export async function snoozeOccurrence(
  ctx: AppContext,
  occ: OccurrenceRow,
  minutes: number,
  requireEffectId?: string,
): Promise<{ ok: boolean; targetAt?: number; reason?: string }> {
  const alarm = await getAlarm(ctx, occ.alarm_id);
  if (!alarm) return { ok: false, reason: "missing_alarm" };
  if (occ.snooze_count >= alarm.max_snoozes) return { ok: false, reason: "snooze_limit" };
  const now = ctx.clock.now();
  const targetAt = now + minutes * MINUTE;
  const effectClause = requireEffectId ? " AND active_effect_id = ?" : "";
  const params: Array<string | number> = [targetAt, now, occ.id, occ.generation];
  if (requireEffectId) params.push(requireEffectId);
  const won =
    (await ctx.db.run(
      `UPDATE alarm_occurrences SET status = 'snoozed', target_at = ?, snooze_count = snooze_count + 1, window_attempts = 0, generation = generation + 1, active_effect_id = NULL, updated_at = ?
       WHERE id = ? AND generation = ? AND status IN ('calling','scheduled','retry_scheduled')${effectClause}`,
      ...params,
    )) === 1;
  if (!won) return { ok: false, reason: "state_changed" };
  const gen = occ.generation + 1;
  await ctx.db.batch([cancelOccurrenceJobs(ctx, occ.id, "snoozed"), callJobStatement(ctx, occ, gen, `s${occ.snooze_count + 1}a1`, targetAt)]);
  return { ok: true, targetAt };
}

/** The occurrence an "I'm awake"/"snooze" SMS refers to: active now, or due within the next hour. */
export async function activeOccurrenceForSms(ctx: AppContext): Promise<OccurrenceRow | null> {
  const now = ctx.clock.now();
  return ctx.db.first<OccurrenceRow>(
    `SELECT * FROM alarm_occurrences WHERE (status IN ('calling','snoozed','retry_scheduled','unknown') AND target_at >= ?)
       OR (status = 'scheduled' AND target_at BETWEEN ? AND ?)
     ORDER BY target_at LIMIT 1`,
    now - 3 * 60 * MINUTE,
    now - WAKE_CALL_EXPIRY_MS,
    now + 60 * MINUTE,
  );
}

async function prepareAgenda(ctx: AppContext, tz: string): Promise<string | null> {
  const today = localParts(ctx.clock.now(), tz).date;
  const { start, end } = localDayBounds(today, tz);
  const rows = await ctx.db.all<{ summary_enc: string | null; start_at: number }>(
    "SELECT summary_enc, start_at FROM calendar_events WHERE all_day = 0 AND status != 'cancelled' AND start_at >= ? AND start_at < ? ORDER BY start_at LIMIT 3",
    Math.max(start, ctx.clock.now()),
    end,
  );
  if (rows.length === 0) return null;
  const parts: string[] = [];
  for (const r of rows) parts.push(`${(await ctx.crypto.decryptNullable(r.summary_enc, "calendar")) ?? "event"} at ${formatTime(r.start_at, tz)}`);
  return `Today: ${parts.join(", ")}.`.slice(0, 300);
}

/**
 * Accountability calls (a routine's wake call, its snoozes, and any escalation call) all draw on
 * the session's single per-occurrence cap.
 */
async function routineCapReached(ctx: AppContext, alarm: AlarmRow, occ: OccurrenceRow): Promise<boolean> {
  const escalation = /^acc-call:(ses_[0-9a-f]+):/.exec(alarm.source_action_key ?? "");
  const session = escalation
    ? await ctx.db.first<{ id: string; alarm_occurrence_id: string | null; call_cap: number }>(
        "SELECT id, alarm_occurrence_id, call_cap FROM acc_sessions WHERE id = ?",
        escalation[1]!,
      )
    : await ctx.db.first<{ id: string; alarm_occurrence_id: string | null; call_cap: number }>(
        "SELECT id, alarm_occurrence_id, call_cap FROM acc_sessions WHERE alarm_occurrence_id = ?",
        occ.id,
      );
  if (!session) return false;
  const wake = session.alarm_occurrence_id ? ((await getOccurrence(ctx, session.alarm_occurrence_id))?.attempt_count ?? 0) : 0;
  const esc = await ctx.db.first<{ n: number }>(
    "SELECT COALESCE(SUM(o.attempt_count), 0) AS n FROM alarm_occurrences o JOIN alarm_schedules a ON a.id = o.alarm_id WHERE a.source_action_key LIKE ?",
    `acc-call:${session.id}:%`,
  );
  return wake + (esc?.n ?? 0) >= session.call_cap;
}

/** Job handler: revalidate everything, reserve usage, persist the effect, then place one call. */
export async function handleAlarmCallJob(ctx: AppContext, job: JobRow): Promise<JobOutcome> {
  const occ = await getOccurrence(ctx, job.entity_id ?? "");
  if (!occ) return { status: "skipped", result: { reason: "missing_occurrence" } };
  const alarm = await getAlarm(ctx, occ.alarm_id);
  const now = ctx.clock.now();
  if (!alarm || !alarm.enabled) return { status: "canceled", result: { reason: "alarm_disabled" } };
  if (occ.generation !== job.entity_generation) return { status: "skipped", result: { reason: "stale_generation" } };
  if (!["scheduled", "snoozed", "retry_scheduled"].includes(occ.status)) return { status: "skipped", result: { reason: `occurrence_${occ.status}` } };
  if (now > job.intended_at + WAKE_CALL_EXPIRY_MS) {
    await ctx.db.run(
      "UPDATE alarm_occurrences SET status = 'expired', status_reason = 'past_call_window', updated_at = ? WHERE id = ? AND generation = ?",
      now,
      occ.id,
      occ.generation,
    );
    return { status: "skipped", result: { reason: "expired" } };
  }
  if (occ.window_attempts >= occ.max_attempts) {
    await ctx.db.run("UPDATE alarm_occurrences SET status = 'missed', status_reason = 'max_attempts', updated_at = ? WHERE id = ? AND generation = ?", now, occ.id, occ.generation);
    return { status: "skipped", result: { reason: "max_attempts" } };
  }
  const gate = await voiceGate(ctx);
  if (!gate.allowed) {
    await ctx.db.run(
      "UPDATE alarm_occurrences SET status = 'missed', status_reason = ?, updated_at = ? WHERE id = ? AND generation = ?",
      `blocked:${gate.reason}`,
      now,
      occ.id,
      occ.generation,
    );
    return { status: "skipped", result: { reason: gate.reason } };
  }
  if (await routineCapReached(ctx, alarm, occ)) {
    await ctx.db.run(
      "UPDATE alarm_occurrences SET status = 'missed', status_reason = 'routine_call_cap', updated_at = ? WHERE id = ? AND generation = ?",
      now,
      occ.id,
      occ.generation,
    );
    return { status: "skipped", result: { reason: "routine_call_cap" } };
  }
  const attempt = occ.attempt_count + 1;
  const effectKey = `call:${occ.id}:g${occ.generation}:${String((job.payload_json && JSON.parse(job.payload_json).attemptLabel) || `a${attempt}`)}`;
  const settings = await getSettings(ctx.db);
  const reservationKey = `callattempt:${effectKey}`;
  if (!(await reserveUsage(ctx, reservationKey, "call_attempts", 1, { tz: settings.timezone }))) {
    await ctx.db.run(
      "UPDATE alarm_occurrences SET status = 'missed', status_reason = 'budget:call_attempts', updated_at = ? WHERE id = ? AND generation = ?",
      now,
      occ.id,
      occ.generation,
    );
    return { status: "skipped", result: { reason: "budget" } };
  }
  const agenda = alarm.read_agenda ? await prepareAgenda(ctx, alarm.timezone) : null;
  const effectId = newId("eff");
  await ctx.db.run(
    `INSERT INTO outbound_effects (id, effect_key, channel, purpose, provider, state, related_alarm_occurrence_id, attempt_ordinal, job_id, created_at, updated_at)
     VALUES (?, ?, 'call', 'wake_call', ?, 'pending', ?, ?, ?, ?, ?) ON CONFLICT (effect_key) DO NOTHING`,
    effectId,
    effectKey,
    ctx.voice.name,
    occ.id,
    attempt,
    job.id,
    now,
    now,
  );
  const effect = (await ctx.db.first<EffectRow>("SELECT * FROM outbound_effects WHERE effect_key = ?", effectKey))!;
  if (effect.state === "sending") {
    // A previous worker crashed mid-request: outcome unknown, never auto-redial.
    await ctx.db.batch([
      ctx.db.prepare(
        "UPDATE outbound_effects SET state = 'unknown', error_detail = 'Worker stopped during call creation.', updated_at = ? WHERE id = ? AND state = 'sending'",
        now,
        effect.id,
      ),
      ctx.db.prepare("UPDATE alarm_occurrences SET status = 'unknown', status_reason = 'call_outcome_unknown', updated_at = ? WHERE id = ?", now, occ.id),
    ]);
    return { status: "skipped", result: { reason: "unknown_outcome" } };
  }
  if (effect.state !== "pending") return { status: "skipped", result: { reason: `effect_${effect.state}` } };

  const claimed = await ctx.db.batch([
    ctx.db.prepare(
      "UPDATE alarm_occurrences SET status = 'calling', active_effect_id = ?, attempt_count = attempt_count + 1, window_attempts = window_attempts + 1, agenda_enc = ?, updated_at = ? WHERE id = ? AND generation = ? AND status IN ('scheduled','snoozed','retry_scheduled')",
      effect.id,
      agenda ? await ctx.crypto.encrypt(agenda, "agenda") : null,
      now,
      occ.id,
      occ.generation,
    ),
    ctx.db.prepare("UPDATE outbound_effects SET state = 'sending', requested_at = ?, updated_at = ? WHERE id = ? AND state = 'pending' AND changes() = 1", now, now, effect.id),
  ]);
  if (claimed[0] !== 1 || claimed[1] !== 1) {
    await releaseUsage(ctx, reservationKey);
    return { status: "skipped", result: { reason: "state_changed" } };
  }
  const outcome = await ctx.voice.createCall({
    to: ctx.config.ownerPhone ?? "+15550100000",
    effectId: effect.id,
    instructionsUrl: `${ctx.baseUrl}/webhooks/voice/instructions?e=${encodeURIComponent(effect.id)}`,
    statusCallbackUrl: `${ctx.baseUrl}/webhooks/voice/status?e=${encodeURIComponent(effect.id)}`,
    ringTimeoutSec: RING_TIMEOUT_SEC,
    maxDurationSec: MAX_CALL_SEC,
  });
  const after = ctx.clock.now();
  if (outcome.kind === "accepted") {
    await ctx.db.run(
      "UPDATE outbound_effects SET state = 'accepted', provider_id = ?, provider_status = ?, accepted_at = ?, updated_at = ? WHERE id = ? AND state = 'sending'",
      outcome.providerId,
      outcome.providerStatus,
      after,
      after,
      effect.id,
    );
    await commitUsage(ctx, reservationKey, 1);
    return { status: "succeeded", result: { effectId: effect.id } };
  }
  if (outcome.kind === "unknown") {
    await ctx.db.batch([
      ctx.db.prepare("UPDATE outbound_effects SET state = 'unknown', error_detail = ?, updated_at = ? WHERE id = ? AND state = 'sending'", outcome.detail, after, effect.id),
      ctx.db.prepare(
        "UPDATE alarm_occurrences SET status = 'unknown', status_reason = 'call_outcome_unknown', updated_at = ? WHERE id = ? AND active_effect_id = ?",
        after,
        occ.id,
        effect.id,
      ),
    ]);
    log("warn", "effect_outcome_unknown", { effectId: effect.id, channel: "call" });
    return { status: "succeeded", result: { effectId: effect.id, outcome: "unknown" } };
  }
  await releaseUsage(ctx, reservationKey);
  if (outcome.retryable) {
    await ctx.db.batch([
      ctx.db.prepare(
        "UPDATE outbound_effects SET state = 'failed', error_code = ?, error_detail = ?, failed_at = ?, updated_at = ? WHERE id = ? AND state = 'sending'",
        outcome.code,
        outcome.detail,
        after,
        after,
        effect.id,
      ),
      ctx.db.prepare(
        "UPDATE alarm_occurrences SET status = ?, active_effect_id = NULL, attempt_count = attempt_count - 1, window_attempts = window_attempts - 1, generation = generation + 1, updated_at = ? WHERE id = ? AND active_effect_id = ?",
        occ.status,
        after,
        occ.id,
        effect.id,
      ),
      callJobStatement(ctx, occ, occ.generation + 1, `r${job.attempts}`, after + 30_000),
    ]);
    return { status: "succeeded", result: { reason: "provider_rate_limited_requeued" } };
  }
  await ctx.db.batch([
    ctx.db.prepare(
      "UPDATE outbound_effects SET state = 'failed', error_code = ?, error_detail = ?, failed_at = ?, updated_at = ? WHERE id = ? AND state = 'sending'",
      outcome.code,
      outcome.detail,
      after,
      after,
      effect.id,
    ),
    ctx.db.prepare(
      "UPDATE alarm_occurrences SET status = 'missed', status_reason = ?, updated_at = ? WHERE id = ? AND active_effect_id = ?",
      `provider_rejected:${outcome.code}`,
      after,
      occ.id,
      effect.id,
    ),
  ]);
  return { status: "blocked", error: `Call rejected by provider (${outcome.code})` };
}

async function effectAndOccurrence(ctx: AppContext, req: VerifiedVoiceRequest): Promise<{ effect: EffectRow | null; occ: OccurrenceRow | null; conflict: boolean }> {
  const effect = req.effectRef ? await getEffect(ctx, req.effectRef) : null;
  if (!effect || effect.channel !== "call") return { effect: null, occ: null, conflict: false };
  if (effect.provider_id && effect.provider_id !== req.callId) return { effect, occ: null, conflict: true };
  if (req.to && ctx.config.ownerPhone && req.to !== ctx.config.ownerPhone) return { effect, occ: null, conflict: true };
  if (!effect.provider_id) {
    // Late reconciliation of an effect whose creation response was lost.
    await ctx.db.run("UPDATE outbound_effects SET provider_id = ?, updated_at = ? WHERE id = ? AND provider_id IS NULL", req.callId, ctx.clock.now(), effect.id);
  }
  const occ = effect.related_alarm_occurrence_id ? await getOccurrence(ctx, effect.related_alarm_occurrence_id) : null;
  return { effect, occ, conflict: false };
}

/** Voice instructions: revalidate the alarm *at answer time*; a canceled alarm reads nothing old. */
export async function voiceInstructions(ctx: AppContext, req: VerifiedVoiceRequest): Promise<VoiceScript> {
  const { effect, occ, conflict } = await effectAndOccurrence(ctx, req);
  if (conflict || !effect || !occ) return { kind: "say_hangup", text: "Goodbye." };
  if (occ.status !== "calling" || occ.active_effect_id !== effect.id) {
    return { kind: "say_hangup", text: "This wake-up call is no longer needed. Goodbye." };
  }
  const alarm = await getAlarm(ctx, occ.alarm_id);
  const settings = await getSettings(ctx.db);
  if (!alarm || !alarm.enabled) return { kind: "say_hangup", text: "This wake-up call was canceled. Goodbye." };
  const [h, m] = alarm.local_time.split(":").map(Number) as [number, number];
  const agenda = alarm.read_agenda ? await ctx.crypto.decryptNullable(occ.agenda_enc, "agenda") : null;
  const snooze = alarm.snooze_minutes === 10 ? "ten minutes" : `${alarm.snooze_minutes} minutes`;
  const intro =
    alarm.label !== "Wake-up call"
      ? `This is your ${alarm.label} from Della.`
      : occ.snooze_count > 0
        ? "This is your snoozed wake-up call from Della."
        : `This is your requested ${formatMinuteOfDay(h * 60 + m)} wake-up call from Della.`;
  return {
    kind: "prompt",
    text: `Good morning, ${settings.display_name}. ${intro} ${agenda ? `${agenda} ` : ""}Press 1 to confirm you're awake, or 2 to snooze for ${snooze}.`,
    repeatText: `Press 1 to confirm you're awake, or 2 to snooze for ${snooze}.`,
    gatherActionUrl: `${ctx.baseUrl}/webhooks/voice/gather?e=${encodeURIComponent(effect.id)}`,
    inputTimeoutSec: 8,
  };
}

export async function voiceGather(ctx: AppContext, req: VerifiedVoiceRequest): Promise<VoiceScript> {
  const { effect, occ, conflict } = await effectAndOccurrence(ctx, req);
  const dedupeKey = `${req.provider}:${req.callId}:gather:${req.digits ?? ""}`;
  const inserted = await ctx.db.run(
    "INSERT OR IGNORE INTO provider_callbacks (id, dedupe_key, provider, kind, effect_id, provider_id, status, detail_json, outcome, received_at) VALUES (?, ?, ?, 'call_input', ?, ?, ?, '{}', ?, ?)",
    newId("cb"),
    dedupeKey,
    req.provider,
    effect?.id ?? null,
    req.callId,
    req.digits ?? "",
    conflict ? "conflict" : "applied",
    ctx.clock.now(),
  );
  if (conflict || !effect || !occ) return { kind: "say_hangup", text: "Goodbye." };
  if (inserted === 0) {
    // Duplicate keypad callback: never a second acknowledgement or snooze.
    return { kind: "say_hangup", text: req.digits === "2" ? "Already snoozed. Goodbye." : "Already confirmed. Goodbye." };
  }
  if (req.digits === "1") {
    const ok = await acknowledgeOccurrence(ctx, occ, "keypad", effect.id);
    if (ok) await ctx.db.run("UPDATE outbound_effects SET call_acknowledged = 1, updated_at = ? WHERE id = ?", ctx.clock.now(), effect.id);
    return { kind: "say_hangup", text: ok ? "Confirmed. Have a good day." : "This wake-up call is no longer active. Goodbye." };
  }
  if (req.digits === "2") {
    const alarm = await getAlarm(ctx, occ.alarm_id);
    const r = await snoozeOccurrence(ctx, occ, alarm?.snooze_minutes ?? 10, effect.id);
    if (r.ok) return { kind: "say_hangup", text: `Snoozed. I'll call again in ${alarm?.snooze_minutes ?? 10} minutes.` };
    return { kind: "say_hangup", text: r.reason === "snooze_limit" ? "Snooze limit reached. Goodbye." : "This wake-up call is no longer active. Goodbye." };
  }
  return { kind: "say_hangup", text: "No change made. Goodbye." };
}

const CALL_RANK: Record<string, number> = { queued: 1, initiated: 1, ringing: 2, "in-progress": 3, completed: 4, busy: 4, "no-answer": 4, failed: 4, canceled: 4 };
const TERMINAL: ReadonlySet<CallStatus> = new Set(["completed", "busy", "no-answer", "failed", "canceled"]);

/**
 * Call status callbacks. Facts are deduplicated; state only moves forward. A terminal status
 * without keypad acknowledgement leaves the occurrence unacknowledged and may schedule the single
 * permitted retry (if enabled). An effect whose creation outcome was unknown is reconciled but
 * never auto-retried.
 */
export async function voiceStatus(ctx: AppContext, req: VerifiedVoiceRequest): Promise<"applied" | "duplicate" | "conflict" | "unmatched"> {
  const { effect, occ, conflict } = await effectAndOccurrence(ctx, req);
  const now = ctx.clock.now();
  const status = req.callStatus ?? "queued";
  const outcome = conflict ? "conflict" : !effect ? "unmatched" : "applied";
  const inserted = await ctx.db.run(
    "INSERT OR IGNORE INTO provider_callbacks (id, dedupe_key, provider, kind, effect_id, provider_id, status, detail_json, outcome, received_at) VALUES (?, ?, ?, 'call_status', ?, ?, ?, ?, ?, ?)",
    newId("cb"),
    `${req.provider}:${req.callId}:status:${status}`,
    req.provider,
    effect?.id ?? null,
    req.callId,
    status,
    JSON.stringify({ durationSec: req.durationSec }),
    outcome,
    now,
  );
  if (inserted === 0) return "duplicate";
  if (outcome !== "applied" || !effect) {
    if (outcome === "conflict") log("error", "call_callback_conflict", { effectRef: req.effectRef ?? "" });
    return outcome;
  }
  const prevRank = CALL_RANK[effect.provider_status ?? ""] ?? 0;
  if ((CALL_RANK[status] ?? 0) <= prevRank && effect.state !== "unknown") return "applied";
  const wasUnknown = effect.state === "unknown";
  const terminal = TERMINAL.has(status);
  const newState = !terminal ? (wasUnknown ? "accepted" : effect.state) : status === "completed" ? "delivered" : "failed";
  await ctx.db.run(
    "UPDATE outbound_effects SET provider_status = ?, state = ?, call_duration_sec = COALESCE(?, call_duration_sec), delivered_at = CASE WHEN ? = 'delivered' THEN ? ELSE delivered_at END, failed_at = CASE WHEN ? = 'failed' THEN ? ELSE failed_at END, updated_at = ? WHERE id = ?",
    status,
    newState,
    req.durationSec,
    newState,
    now,
    newState,
    now,
    now,
    effect.id,
  );
  if (wasUnknown) {
    const key = `callattempt:${effect.effect_key}`;
    if (status === "failed" || status === "canceled") await releaseUsage(ctx, key);
    else await commitUsage(ctx, key, 1);
  }
  if (terminal && req.durationSec) {
    const settings = await getSettings(ctx.db);
    await recordUsage(ctx, "call_minutes", Math.ceil(req.durationSec / 60), settings.timezone);
  }
  if (!terminal || !occ) return "applied";

  // Only the attempt that is still the active one may change the occurrence.
  if (occ.active_effect_id !== effect.id) return "applied";
  if (occ.status === "unknown") {
    await ctx.db.run(
      "UPDATE alarm_occurrences SET status = 'missed', status_reason = 'reconciled_unknown_attempt', updated_at = ? WHERE id = ? AND status = 'unknown'",
      now,
      occ.id,
    );
    await audit(ctx, "provider", "alarm.unknown_reconciled", "alarm_occurrence", occ.id, status);
    return "applied";
  }
  if (occ.status !== "calling") return "applied";
  const alarm = await getAlarm(ctx, occ.alarm_id);
  const canRetry = alarm?.enabled === 1 && alarm.retry_enabled === 1 && occ.window_attempts < occ.max_attempts;
  if (canRetry) {
    const retryAt = now + (alarm!.retry_delay_minutes ?? 5) * MINUTE;
    const gen = occ.generation + 1;
    const won =
      (await ctx.db.run(
        "UPDATE alarm_occurrences SET status = 'retry_scheduled', status_reason = ?, target_at = ?, generation = ?, updated_at = ? WHERE id = ? AND generation = ? AND status = 'calling' AND active_effect_id = ?",
        `unacknowledged:${status}`,
        retryAt,
        gen,
        now,
        occ.id,
        occ.generation,
        effect.id,
      )) === 1;
    if (won) await ctx.db.batch([callJobStatement(ctx, occ, gen, `a${occ.window_attempts + 1}`, retryAt)]);
  } else {
    await ctx.db.run(
      "UPDATE alarm_occurrences SET status = 'missed', status_reason = ?, updated_at = ? WHERE id = ? AND generation = ? AND status = 'calling' AND active_effect_id = ?",
      `unacknowledged:${status}`,
      now,
      occ.id,
      occ.generation,
      effect.id,
    );
  }
  return "applied";
}

export async function listAlarms(ctx: AppContext): Promise<AlarmRow[]> {
  return ctx.db.all<AlarmRow>("SELECT * FROM alarm_schedules ORDER BY enabled DESC, created_at DESC LIMIT 20");
}

export const ACTIVE_OCCURRENCE_STATUSES = ACTIVE_STATUSES;
