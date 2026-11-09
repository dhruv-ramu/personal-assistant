import type { AppContext } from "../context";
import { SYNC_INTERVAL_MS } from "../domain/calendar";
import { DAY, MINUTE, localParts, resolveLocalForRecurrence, todayLocal } from "../domain/time";
import { log } from "../observability/log";
import { getConnection } from "./calendar-connection";
import { createJob, dispatchJobs, findDispatchableJobs } from "./jobs";
import { maybeScheduleMissedSummary } from "./reminders";
import { materializeSeries } from "./series";
import { getSettings, getSystemState, setSystemState } from "./settings";
import { materializeMorningSessions } from "../accountability/sessions";
import { ensureExtensionJobs } from "../knowledge/jobs";
import { purgeExpiredMedia } from "../media/uploads";

export interface TickReport {
  at: number;
  lagMs: number;
  dispatched: number;
  materialized: { tasks: number; alarms: number; coalesced: number };
  publishError?: string;
}

/**
 * Minute Cron tick. Deterministic queries only — never an AI call. It records a heartbeat,
 * materializes the next occurrence of recurring schedules, ensures periodic jobs exist, and
 * publishes bounded batches of due job IDs (not records) to the queue.
 */
export async function runTick(ctx: AppContext, scheduledTime?: number): Promise<TickReport> {
  const now = ctx.clock.now();
  const lagMs = scheduledTime ? Math.max(0, now - scheduledTime) : 0;
  const previous = Number((await getSystemState(ctx.db, "last_tick_at")) ?? "0");
  await setSystemState(ctx.db, "last_tick_at", String(now), now);
  await setSystemState(ctx.db, "last_tick_lag_ms", String(lagMs), now);
  if (previous && now - previous > 10 * MINUTE) {
    log("warn", "scheduler_gap_detected", { gapMs: now - previous });
    await setSystemState(ctx.db, "last_scheduler_gap", JSON.stringify({ from: previous, to: now }), now);
  }

  const settings = await getSettings(ctx.db);
  const materialized = settings.restore_hold === 1 ? { tasks: 0, alarms: 0, coalesced: 0 } : await materializeSeries(ctx);

  const conn = await getConnection(ctx.db);
  if (conn.status === "connected") {
    const slot = Math.floor(now / SYNC_INTERVAL_MS);
    await createJob(ctx, { logicalKey: `calendar_sync:${slot}`, kind: "calendar_sync", dueAt: now, expiresAt: now + SYNC_INTERVAL_MS, maxAttempts: 2 });
  }
  const today = todayLocal(now, settings.timezone);
  await createJob(ctx, { logicalKey: `retention:${today}`, kind: "retention_sweep", dueAt: now, maxAttempts: 3 });
  if (settings.morning_brief_enabled === 1) {
    const briefAt = resolveLocalForRecurrence(today, Math.floor(settings.morning_brief_minute / 60), settings.morning_brief_minute % 60, settings.timezone);
    if (briefAt + 2 * 60 * MINUTE > now) {
      await createJob(ctx, { logicalKey: `brief:${today}`, kind: "morning_brief", dueAt: briefAt, expiresAt: briefAt + 2 * 60 * MINUTE, maxAttempts: 3 });
    } else {
      const tomorrow = localParts(now + DAY, settings.timezone).date;
      const tAt = resolveLocalForRecurrence(tomorrow, Math.floor(settings.morning_brief_minute / 60), settings.morning_brief_minute % 60, settings.timezone);
      await createJob(ctx, { logicalKey: `brief:${tomorrow}`, kind: "morning_brief", dueAt: tAt, expiresAt: tAt + 2 * 60 * MINUTE, maxAttempts: 3 });
    }
  }
  if (settings.restore_hold !== 1) {
    await maybeScheduleMissedSummary(ctx, async (key, dueAt) => {
      await createJob(ctx, { logicalKey: key, kind: "missed_summary", dueAt, maxAttempts: 3 });
    });
    await materializeMorningSessions(ctx);
    await ensureExtensionJobs(ctx);
  }
  // Raw accountability media must not outlive its 24 h window by a daily sweep's slack.
  await purgeExpiredMedia(ctx);

  let dispatched: number;
  let publishError: string | undefined;
  if (settings.restore_hold !== 1) {
    const ids = await findDispatchableJobs(ctx);
    const r = await dispatchJobs(ctx, ids);
    dispatched = r.published;
    publishError = r.error;
  } else {
    // Restored database: only inbound processing runs until the operator resumes after reconciliation.
    const ids = (await findDispatchableJobs(ctx)).filter(Boolean);
    const inboundOnly = [];
    for (const id of ids) {
      const j = await ctx.db.first<{ kind: string }>("SELECT kind FROM jobs WHERE id = ?", id);
      if (j?.kind === "process_inbound" || j?.kind === "deliver_effect") inboundOnly.push(id);
    }
    const r = await dispatchJobs(ctx, inboundOnly);
    dispatched = r.published;
    publishError = r.error;
  }
  return { at: now, lagMs, dispatched, materialized, publishError };
}
