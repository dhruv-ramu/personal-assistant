import type { AppContext } from "../context";
import { HOUR } from "../domain/time";
import { log } from "../observability/log";
import type { SmsDeliveryStatus, VerifiedSmsStatus } from "../providers/types";
import { newId } from "../security/crypto";
import { redactText } from "../security/redaction";
import { jobInsertStatement } from "./jobs";
import { smsGate, type SendPurpose } from "./readiness";
import { asciiFriendly, countSegments } from "./segments";
import { getSettings, getSystemState, setSystemState } from "./settings";
import { commitUsage, releaseUsage, reserveUsage } from "./usage";

export type EffectState = "pending" | "sending" | "accepted" | "delivered" | "failed" | "unknown" | "suppressed" | "canceled";

export interface EffectRow {
  id: string;
  effect_key: string;
  channel: "sms" | "call";
  purpose: string;
  body_enc: string | null;
  template: string | null;
  provider: string | null;
  provider_id: string | null;
  state: EffectState;
  provider_status: string | null;
  error_code: string | null;
  error_detail: string | null;
  segments: number | null;
  encoding: string | null;
  related_task_id: string | null;
  related_alarm_occurrence_id: string | null;
  attempt_ordinal: number;
  call_duration_sec: number | null;
  call_acknowledged: number;
  job_id: string | null;
  requested_at: number | null;
  accepted_at: number | null;
  delivered_at: number | null;
  failed_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface NewSmsEffect {
  effectKey: string;
  purpose: string;
  body: string;
  relatedTaskId?: string | null;
  taskIds?: string[];
}

/**
 * Prepared statements that persist an SMS effect, its conversation-log row, and a delivery job in
 * one batch. The effect exists *before* any provider contact, so a crash cannot lose or duplicate it.
 */
export async function smsEffectStatements(
  ctx: AppContext,
  e: NewSmsEffect,
  opts: { dueAt?: number; withJob?: boolean } = {},
): Promise<{ effectId: string; statements: D1PreparedStatement[] }> {
  const effectId = newId("eff");
  const now = ctx.clock.now();
  const body = asciiFriendly(e.body);
  const seg = countSegments(body);
  const bodyEnc = await ctx.crypto.encrypt(body, "effect");
  const statements: D1PreparedStatement[] = [
    ctx.db.prepare(
      `INSERT INTO outbound_effects (id, effect_key, channel, purpose, body_enc, provider, state, segments, encoding, related_task_id, created_at, updated_at)
       VALUES (?, ?, 'sms', ?, ?, ?, 'pending', ?, ?, ?, ?, ?) ON CONFLICT (effect_key) DO NOTHING`,
      effectId,
      e.effectKey,
      e.purpose,
      bodyEnc,
      ctx.sms.name,
      seg.segments,
      seg.encoding,
      e.relatedTaskId ?? null,
      now,
      now,
    ),
    ctx.db.prepare(
      "INSERT INTO conversation_log (id, direction, body_enc, effect_id, task_ids_json, created_at) SELECT ?, 'out', ?, ?, ?, ? WHERE changes() = 1",
      newId("cl"),
      await ctx.crypto.encrypt(body, "convlog"),
      effectId,
      JSON.stringify(e.taskIds ?? (e.relatedTaskId ? [e.relatedTaskId] : [])),
      now,
    ),
  ];
  if (opts.withJob !== false) {
    statements.push(
      jobInsertStatement(ctx, { logicalKey: `deliver:${e.effectKey}`, kind: "deliver_effect", entityId: effectId, dueAt: opts.dueAt ?? now, expiresAt: now + 2 * HOUR }),
    );
  }
  return { effectId, statements };
}

export async function getEffectByKey(ctx: AppContext, key: string): Promise<EffectRow | null> {
  return ctx.db.first<EffectRow>("SELECT * FROM outbound_effects WHERE effect_key = ?", key);
}

export async function getEffect(ctx: AppContext, id: string): Promise<EffectRow | null> {
  return ctx.db.first<EffectRow>("SELECT * FROM outbound_effects WHERE id = ?", id);
}

/** Creates (idempotently) an SMS effect without a delivery job; returns the row. */
export async function ensureSmsEffect(ctx: AppContext, e: NewSmsEffect): Promise<EffectRow> {
  const existing = await getEffectByKey(ctx, e.effectKey);
  if (existing) return existing;
  const { statements } = await smsEffectStatements(ctx, e, { withJob: false });
  await ctx.db.batch(statements);
  return (await getEffectByKey(ctx, e.effectKey))!;
}

export type DeliveryResult = { state: "accepted" | "delivered" | "failed" | "unknown" | "suppressed" | "canceled"; reason?: string } | { state: "retry"; reason: string };

const VALIDITY_SECONDS: Record<string, number> = {
  reminder: 2 * 3600,
  followup: 2 * 3600,
  headsup: 1800,
  brief: 3 * 3600,
  reply: 3600,
  summary: 6 * 3600,
  warning: 6 * 3600,
};

/**
 * Sends a persisted SMS effect at most once.
 *  - Effects already past `pending` are never re-sent automatically.
 *  - An effect found in `sending` means a previous worker crashed mid-request; its outcome is
 *    unknown and it is NOT re-sent (operator retry required, with duplicate risk shown).
 *  - Gates (opt-out, switches, readiness, pause for proactive sends) and usage reservations are
 *    checked immediately before contacting the provider.
 */
export async function deliverSmsEffect(ctx: AppContext, effectId: string, purpose: SendPurpose): Promise<DeliveryResult> {
  const effect = await getEffect(ctx, effectId);
  if (!effect || effect.channel !== "sms") return { state: "failed", reason: "missing_effect" };
  const now = ctx.clock.now();
  if (effect.state === "sending") {
    await ctx.db.run(
      "UPDATE outbound_effects SET state = 'unknown', error_detail = ?, updated_at = ? WHERE id = ? AND state = 'sending'",
      "Worker stopped during send; outcome unknown.",
      now,
      effectId,
    );
    return { state: "unknown", reason: "crashed_during_send" };
  }
  if (effect.state !== "pending") return { state: effect.state as Exclude<EffectState, "pending" | "sending">, reason: "already_processed" };

  const gate = await smsGate(ctx, purpose);
  if (!gate.allowed) {
    await ctx.db.run("UPDATE outbound_effects SET state = 'suppressed', error_detail = ?, updated_at = ? WHERE id = ? AND state = 'pending'", gate.reason, now, effectId);
    return { state: "suppressed", reason: gate.reason };
  }

  const settings = await getSettings(ctx.db);
  const segments = effect.segments ?? 1;
  const reservationKey = `sms:${effect.effect_key}`;
  const budgetOk = await reserveUsage(ctx, reservationKey, "sms_segments", segments, { tz: settings.timezone });
  if (!budgetOk) {
    await ctx.db.run("UPDATE outbound_effects SET state = 'suppressed', error_detail = 'budget:sms_segments', updated_at = ? WHERE id = ? AND state = 'pending'", now, effectId);
    await maybeSendBudgetWarning(ctx, "sms_segments");
    return { state: "suppressed", reason: "budget:sms_segments" };
  }

  const claimed = await ctx.db.run("UPDATE outbound_effects SET state = 'sending', requested_at = ?, updated_at = ? WHERE id = ? AND state = 'pending'", now, now, effectId);
  if (claimed !== 1) {
    await releaseUsage(ctx, reservationKey);
    return { state: "canceled", reason: "state_changed" };
  }

  const body = await ctx.crypto.decrypt(effect.body_enc!, "effect");
  const owner = ctx.config.ownerPhone ?? "+15550100000";
  const outcome = await ctx.sms.send({
    to: owner,
    body,
    effectId,
    statusCallbackUrl: `${ctx.baseUrl}/webhooks/sms/status?e=${encodeURIComponent(effectId)}`,
    validitySeconds: VALIDITY_SECONDS[effect.purpose] ?? 3600,
  });
  const after = ctx.clock.now();
  switch (outcome.kind) {
    case "accepted":
      await ctx.db.run(
        "UPDATE outbound_effects SET state = 'accepted', provider_id = ?, provider_status = ?, accepted_at = ?, segments = COALESCE(?, segments), updated_at = ? WHERE id = ? AND state = 'sending'",
        outcome.providerId,
        outcome.providerStatus,
        after,
        outcome.segments,
        after,
        effectId,
      );
      await commitUsage(ctx, reservationKey, outcome.segments ?? segments);
      return { state: "accepted" };
    case "rejected":
      if (outcome.retryable) {
        await ctx.db.run(
          "UPDATE outbound_effects SET state = 'pending', error_code = ?, error_detail = ?, updated_at = ? WHERE id = ? AND state = 'sending'",
          outcome.code,
          outcome.detail,
          after,
          effectId,
        );
        await releaseUsage(ctx, reservationKey, { forget: true });
        return { state: "retry", reason: `provider_retryable:${outcome.code}` };
      }
      await ctx.db.run(
        "UPDATE outbound_effects SET state = 'failed', error_code = ?, error_detail = ?, failed_at = ?, updated_at = ? WHERE id = ? AND state = 'sending'",
        outcome.code,
        outcome.detail,
        after,
        after,
        effectId,
      );
      await releaseUsage(ctx, reservationKey);
      if (outcome.code === "21610") await recordProviderOptOut(ctx, "sms");
      return { state: "failed", reason: `provider_rejected:${outcome.code}` };
    case "unknown":
      // Keep the usage reservation: the message may have been sent.
      await ctx.db.run(
        "UPDATE outbound_effects SET state = 'unknown', error_detail = ?, updated_at = ? WHERE id = ? AND state = 'sending'",
        redactText(outcome.detail),
        after,
        effectId,
      );
      log("warn", "effect_outcome_unknown", { effectId, channel: "sms" });
      return { state: "unknown", reason: "acceptance_unknown" };
  }
}

/** Provider says the destination opted out (e.g. Twilio 21610): reconcile local suppression. */
export async function recordProviderOptOut(ctx: AppContext, channel: "sms" | "call"): Promise<void> {
  const now = ctx.clock.now();
  await ctx.db.batch([
    ctx.db.prepare(
      "INSERT INTO suppressions (channel, state, source, updated_at) VALUES (?, 'opted_out', 'provider', ?) ON CONFLICT (channel) DO UPDATE SET state = 'opted_out', source = 'provider', updated_at = excluded.updated_at",
      channel,
      now,
    ),
    ctx.db.prepare("INSERT INTO consent_events (id, channel, event, source, created_at) VALUES (?, ?, 'opted_out', 'provider_reported', ?)", newId("ce"), channel, now),
  ]);
}

/** At most one budget warning per metric per day; it never recurses into another warning. */
async function maybeSendBudgetWarning(ctx: AppContext, metric: string): Promise<void> {
  const settings = await getSettings(ctx.db);
  const day = new Date(ctx.clock.now()).toISOString().slice(0, 10);
  const key = `budget_warning:${metric}:${day}`;
  if (await getSystemState(ctx.db, key)) return;
  await setSystemState(ctx.db, key, "sent", ctx.clock.now());
  log("warn", "budget_limit_reached", { metric });
  const effect = await ensureSmsEffect(ctx, {
    effectKey: key,
    purpose: "warning",
    body: `Daily ${metric === "sms_segments" ? "text" : metric} limit reached. Further messages are paused until tomorrow; see the admin dashboard.`,
  });
  const gate = await smsGate(ctx, "warning");
  if (!gate.allowed || settings.sms_enabled !== 1) {
    await ctx.db.run(
      "UPDATE outbound_effects SET state = 'suppressed', error_detail = ? WHERE id = ? AND state = 'pending'",
      gate.allowed ? "sms_disabled" : gate.reason,
      effect.id,
    );
    return;
  }
  // The single warning bypasses the exhausted segment budget by design (bounded to one per day).
  const claimed = await ctx.db.run("UPDATE outbound_effects SET state = 'sending', requested_at = ? WHERE id = ? AND state = 'pending'", ctx.clock.now(), effect.id);
  if (claimed !== 1) return;
  const outcome = await ctx.sms.send({
    to: ctx.config.ownerPhone ?? "+15550100000",
    body: await ctx.crypto.decrypt(effect.body_enc!, "effect"),
    effectId: effect.id,
    statusCallbackUrl: `${ctx.baseUrl}/webhooks/sms/status?e=${encodeURIComponent(effect.id)}`,
    validitySeconds: VALIDITY_SECONDS.warning!,
  });
  const state = outcome.kind === "accepted" ? "accepted" : outcome.kind === "unknown" ? "unknown" : "failed";
  await ctx.db.run(
    "UPDATE outbound_effects SET state = ?, provider_id = ?, updated_at = ? WHERE id = ? AND state = 'sending'",
    state,
    outcome.kind === "accepted" ? outcome.providerId : null,
    ctx.clock.now(),
    effect.id,
  );
}

const SMS_RANK: Record<string, number> = { pending: 0, sending: 1, unknown: 1, suppressed: 1, canceled: 1, accepted: 2, failed: 3, delivered: 4 };

function stateForStatus(status: SmsDeliveryStatus): EffectState | null {
  switch (status) {
    case "accepted":
    case "queued":
    case "sending":
    case "sent":
      return "accepted";
    case "delivered":
      return "delivered";
    case "undelivered":
    case "failed":
    case "canceled":
      return "failed";
    default:
      return null;
  }
}

/**
 * Applies a verified SMS status callback. Facts are stored immutably (deduplicated). State is
 * derived monotonically so duplicate or out-of-order callbacks never regress a delivered message.
 * A callback that conflicts with the effect's known provider ID is recorded as an error, not applied.
 */
export async function applySmsStatus(ctx: AppContext, status: VerifiedSmsStatus): Promise<"applied" | "duplicate" | "conflict" | "unmatched"> {
  const now = ctx.clock.now();
  let effect: EffectRow | null = status.effectRef ? await getEffect(ctx, status.effectRef) : null;
  if (!effect) effect = await ctx.db.first<EffectRow>("SELECT * FROM outbound_effects WHERE provider = ? AND provider_id = ?", status.provider, status.providerMessageId);
  const dedupeKey = `${status.provider}:${status.providerMessageId}:${status.status}:${status.errorCode ?? ""}`;
  const callbackId = newId("cb");
  let outcome: "applied" | "duplicate" | "conflict" | "unmatched" = "applied";
  if (!effect || effect.channel !== "sms") outcome = "unmatched";
  else if (effect.provider_id && effect.provider_id !== status.providerMessageId) outcome = "conflict";
  else if (status.to && ctx.config.ownerPhone && status.to !== ctx.config.ownerPhone) outcome = "conflict";

  const inserted = await ctx.db.run(
    "INSERT OR IGNORE INTO provider_callbacks (id, dedupe_key, provider, kind, effect_id, provider_id, status, detail_json, outcome, received_at) VALUES (?, ?, ?, 'sms_status', ?, ?, ?, ?, ?, ?)",
    callbackId,
    dedupeKey,
    status.provider,
    effect?.id ?? null,
    status.providerMessageId,
    status.status,
    JSON.stringify({ errorCode: status.errorCode }),
    outcome,
    now,
  );
  if (inserted === 0) return "duplicate";
  if (outcome !== "applied" || !effect) {
    log("error", "sms_callback_rejected", { outcome, effectRef: status.effectRef ?? "" });
    return outcome;
  }

  const target = stateForStatus(status.status);
  if (!target) return "applied";
  const wasUnknown = effect.state === "unknown";
  if ((SMS_RANK[target] ?? 0) <= (SMS_RANK[effect.state] ?? 0) && !(wasUnknown && target === "accepted")) return "applied";
  const changes = await ctx.db.run(
    `UPDATE outbound_effects SET state = ?, provider_id = COALESCE(provider_id, ?), provider_status = ?, error_code = COALESCE(?, error_code),
     accepted_at = COALESCE(accepted_at, ?), delivered_at = CASE WHEN ? = 'delivered' THEN ? ELSE delivered_at END,
     failed_at = CASE WHEN ? = 'failed' THEN ? ELSE failed_at END, updated_at = ?
     WHERE id = ? AND state = ?`,
    target,
    status.providerMessageId,
    status.status,
    status.errorCode,
    now,
    target,
    now,
    target,
    now,
    now,
    effect.id,
    effect.state,
  );
  if (changes === 1 && wasUnknown) {
    const key = `sms:${effect.effect_key}`;
    if (target === "failed") await releaseUsage(ctx, key);
    else await commitUsage(ctx, key);
    log("info", "unknown_effect_reconciled", { effectId: effect.id, state: target });
  }
  if (status.errorCode === "21610") await recordProviderOptOut(ctx, "sms");
  return "applied";
}

/** Operator-initiated resend of an unknown/failed SMS. Creates a *new* effect with a distinct key. */
export async function operatorRetrySms(ctx: AppContext, effectId: string): Promise<{ ok: boolean; message: string }> {
  const effect = await getEffect(ctx, effectId);
  if (!effect || effect.channel !== "sms") return { ok: false, message: "Effect not found." };
  if (effect.state !== "unknown" && effect.state !== "failed") return { ok: false, message: "Only unknown or failed messages can be retried." };
  const body = await ctx.crypto.decrypt(effect.body_enc!, "effect");
  const n = (await ctx.db.first<{ n: number }>("SELECT COUNT(*) AS n FROM outbound_effects WHERE effect_key LIKE ?", `${effect.effect_key}:operator-retry:%`))?.n ?? 0;
  const { statements } = await smsEffectStatements(ctx, {
    effectKey: `${effect.effect_key}:operator-retry:${n + 1}`,
    purpose: effect.purpose,
    body,
    relatedTaskId: effect.related_task_id,
  });
  await ctx.db.batch(statements);
  return { ok: true, message: effect.state === "unknown" ? "Retry queued. The original may also have been delivered (duplicate risk)." : "Retry queued." };
}
