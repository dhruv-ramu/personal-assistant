import type { AppContext } from "../context";
import { DAY, MINUTE, localParts, resolveLocalForRecurrence, todayLocal } from "../domain/time";
import { featureOn, getExtSettings } from "../ext/settings";
import { deliverSmsEffect, ensureSmsEffect } from "../services/effects";
import { createJob, type JobOutcome } from "../services/jobs";
import { getSettings, isPaused } from "../services/settings";
import { eveningReset } from "./planning";

export async function handleEveningReset(ctx: AppContext): Promise<JobOutcome> {
  const ext = await getExtSettings(ctx.db);
  const s = await getSettings(ctx.db);
  const now = ctx.clock.now();
  if (!featureOn(ctx, ext, "evening_reset")) return { status: "skipped", result: { reason: "disabled" } };
  if (isPaused(s, now, "reminders")) return { status: "skipped", result: { reason: "paused" } };
  const effect = await ensureSmsEffect(ctx, { effectKey: `evening_reset:${todayLocal(now, s.timezone)}`, purpose: "brief", body: await eveningReset(ctx) });
  const d = await deliverSmsEffect(ctx, effect.id, "proactive");
  return { status: "succeeded", result: { delivery: d.state } };
}

async function ensureDaily(ctx: AppContext, kind: "suggestion_digest" | "evening_reset", minuteOfDay: number, tz: string): Promise<void> {
  const now = ctx.clock.now();
  let day = todayLocal(now, tz);
  let at = resolveLocalForRecurrence(day, Math.floor(minuteOfDay / 60), minuteOfDay % 60, tz);
  if (at + 60 * MINUTE <= now) {
    day = localParts(now + DAY, tz).date;
    at = resolveLocalForRecurrence(day, Math.floor(minuteOfDay / 60), minuteOfDay % 60, tz);
  }
  await createJob(ctx, { logicalKey: `${kind}:${day}`, kind, dueAt: at, expiresAt: at + 60 * MINUTE, maxAttempts: 3 });
}

/** Extension periodic work for the minute tick: daily digest/reset jobs and the index sync. */
export async function ensureExtensionJobs(ctx: AppContext): Promise<void> {
  const ext = await getExtSettings(ctx.db);
  const s = await getSettings(ctx.db);
  const now = ctx.clock.now();
  if (featureOn(ctx, ext, "suggestions")) await ensureDaily(ctx, "suggestion_digest", ext.digest_minute, s.timezone);
  if (featureOn(ctx, ext, "evening_reset")) await ensureDaily(ctx, "evening_reset", ext.evening_reset_minute, s.timezone);
  if (featureOn(ctx, ext, "semantic")) {
    const dirty = await ctx.db.first("SELECT object_id FROM index_state WHERE dirty = 1 AND retries < 5 LIMIT 1");
    if (dirty) await createJob(ctx, { logicalKey: `index_sync:${Math.floor(now / (5 * MINUTE))}`, kind: "index_sync", dueAt: now, expiresAt: now + 5 * MINUTE, maxAttempts: 2 });
  }
}
