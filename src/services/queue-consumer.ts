import type { AppContext } from "../context";
import { handleHeadsupJob, syncCalendar } from "../domain/calendar";
import { handleAlarmCallJob } from "../domain/alarms";
import { log } from "../observability/log";
import { newId } from "../security/crypto";
import { safeErrorMessage } from "../security/redaction";
import { deliverSmsEffect, getEffect } from "./effects";
import { handleProcessInbound, onInboundJobFailed } from "./inbound";
import { claimJob, finishJob, getJob, type JobOutcome, type JobRow } from "./jobs";
import { handleMissedSummary, handleMorningBrief, handleSendReminder } from "./reminders";
import { runRetention } from "./retention";
import { handleCheckpointJob, handleSessionEnd } from "../accountability/sessions";
import { handleSecretaryCheck } from "../knowledge/checks";
import { handleIndexSync } from "../knowledge/index-sync";
import { handleEveningReset } from "../knowledge/jobs";
import { handleMeetingPrep, handlePostMeeting, scheduleMeetingJobs, upcomingForMeetings } from "../knowledge/meetings";
import { handleDigest } from "../knowledge/suggestions";
import { handleEvidenceAssess } from "../media/uploads";

export interface QueueMessageBody {
  v: 1;
  jobId: string;
}

export function parseQueueBody(body: unknown): QueueMessageBody | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (b.v !== 1 || typeof b.jobId !== "string" || !/^job_[0-9a-f]{24}$/.test(b.jobId)) return null;
  return { v: 1, jobId: b.jobId };
}

async function handleDeliverEffect(ctx: AppContext, job: JobRow): Promise<JobOutcome> {
  const effect = await getEffect(ctx, job.entity_id ?? "");
  if (!effect) return { status: "skipped", result: { reason: "missing_effect" } };
  const d = await deliverSmsEffect(ctx, effect.id, effect.purpose === "reply" ? "reply" : "proactive");
  if (d.state === "retry") return { status: "retry", error: d.reason, delayMs: 30_000 };
  if (d.state === "failed") return { status: "blocked", error: d.reason ?? "failed" };
  return { status: d.state === "suppressed" || d.state === "canceled" ? "skipped" : "succeeded", result: { delivery: d.state, reason: d.reason ?? null } };
}

async function handleCalendarSync(ctx: AppContext): Promise<JobOutcome> {
  const r = await syncCalendar(ctx);
  if (!r.ok) return r.reason === "unavailable" ? { status: "retry", error: "calendar unavailable", delayMs: 60_000 } : { status: "skipped", result: { reason: r.reason } };
  await scheduleMeetingJobs(ctx, await upcomingForMeetings(ctx));
  return { status: "succeeded", result: r.value };
}

export async function runJobHandler(ctx: AppContext, job: JobRow): Promise<JobOutcome> {
  switch (job.kind) {
    case "process_inbound":
      return handleProcessInbound(ctx, job);
    case "deliver_effect":
      return handleDeliverEffect(ctx, job);
    case "send_reminder":
      return handleSendReminder(ctx, job);
    case "alarm_call":
      return handleAlarmCallJob(ctx, job);
    case "calendar_sync":
      return handleCalendarSync(ctx);
    case "calendar_headsup":
      return handleHeadsupJob(ctx, job);
    case "morning_brief":
      return handleMorningBrief(ctx, job);
    case "missed_summary":
      return handleMissedSummary(ctx);
    case "retention_sweep":
      return { status: "succeeded", result: await runRetention(ctx) };
    case "secretary_check":
      return handleSecretaryCheck(ctx, job);
    case "index_sync":
      return handleIndexSync(ctx);
    case "suggestion_digest":
      return handleDigest(ctx);
    case "acc_checkpoint":
      return handleCheckpointJob(ctx, job);
    case "acc_session_end":
      return handleSessionEnd(ctx, job);
    case "evidence_assess":
      return handleEvidenceAssess(ctx, job);
    case "meeting_prep":
      return handleMeetingPrep(ctx, job);
    case "post_meeting":
      return handlePostMeeting(ctx, job);
    case "evening_reset":
      return handleEveningReset(ctx);
    default:
      return { status: "failed", error: `Unknown job kind ${String(job.kind)}` };
  }
}

/**
 * Processes one job: conditional claim (fresh fencing token), run, fenced completion. Returns
 * whether the claim was won. Exceptions become retries; the queue message itself is always acked
 * by the caller because D1 holds the durable state and the minute tick re-dispatches.
 */
export async function processJob(ctx: AppContext, jobId: string, owner = newId("wkr")): Promise<{ claimed: boolean; outcome?: JobOutcome }> {
  const claim = await claimJob(ctx, jobId, owner);
  if (!claim) return { claimed: false };
  let outcome: JobOutcome;
  try {
    outcome = await runJobHandler(ctx, claim.job);
  } catch (err) {
    outcome = { status: "retry", error: safeErrorMessage(err) };
    log("error", "job_handler_error", { jobId, kind: claim.job.kind, error: safeErrorMessage(err) });
  }
  const finished = await finishJob(ctx, claim, outcome);
  if (finished && claim.job.kind === "process_inbound") {
    const after = await getJob(ctx, jobId);
    if (after?.status === "failed") await onInboundJobFailed(ctx, after);
  }
  log("info", "job_processed", { jobId, kind: claim.job.kind, outcome: outcome.status, recovered: claim.recovered });
  return { claimed: true, outcome };
}

/** Dead-letter consumer: makes the job visible as dead (if it wasn't otherwise finished). */
export async function markDeadLettered(ctx: AppContext, jobId: string): Promise<void> {
  await ctx.db.run(
    "UPDATE jobs SET status = 'dead', last_error = COALESCE(last_error, 'dead-lettered by queue'), updated_at = ? WHERE id = ? AND status IN ('pending','running')",
    ctx.clock.now(),
    jobId,
  );
  log("error", "job_dead_lettered", { jobId });
}
