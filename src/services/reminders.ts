import type { AppContext } from "../context";
import { agendaText } from "../domain/calendar";
import { createClarification, setLastReferenced } from "../domain/conversations";
import {
  HARD_MAX_FOLLOWUPS_PER_OCCURRENCE,
  LATE_LABEL_AFTER_MS,
  ROUTINE_LATENESS_MS,
  decryptTask,
  listTasks,
  reminderStatements,
  type ReminderRow,
  type TaskRow,
} from "../domain/tasks";
import { HOUR, MINUTE, formatDateTime, formatTime, isInQuietHours, localDayBounds, quietHoursEnd, todayLocal } from "../domain/time";
import { deliverSmsEffect, ensureSmsEffect } from "./effects";
import { parsePayload, type JobOutcome, type JobRow } from "./jobs";
import { getSettings, getSystemState, isPaused, setSystemState } from "./settings";

const MISSED_SUMMARY_MIN_GAP_MS = 6 * HOUR;

async function markReminder(ctx: AppContext, r: ReminderRow, status: ReminderRow["status"], reason: string, extra: { late?: boolean } = {}): Promise<void> {
  await ctx.db.run(
    "UPDATE reminders SET status = ?, status_reason = ?, late = ?, updated_at = ? WHERE id = ? AND status = 'scheduled'",
    status,
    reason,
    extra.late ? 1 : r.late,
    ctx.clock.now(),
    r.id,
  );
}

/**
 * Proactive reminder/follow-up delivery. Revalidates immediately before the send: reminder still
 * scheduled, task generation unchanged, task open, checks enabled, caps, lateness, pause, quiet
 * hours, then the SMS gate (opt-out, switches, readiness) and usage reservation inside delivery.
 * Messages are templates over saved data; no AI call is made.
 */
export async function handleSendReminder(ctx: AppContext, job: JobRow): Promise<JobOutcome> {
  const { reminderKey } = parsePayload<{ reminderKey: string }>(job);
  const r = await ctx.db.first<ReminderRow>("SELECT * FROM reminders WHERE logical_key = ?", reminderKey ?? "");
  if (!r) return { status: "skipped", result: { reason: "missing_reminder" } };
  if (r.status !== "scheduled") return { status: "skipped", result: { reason: `reminder_${r.status}` } };
  const row = await ctx.db.first<TaskRow>("SELECT * FROM tasks WHERE id = ?", r.task_id);
  if (!row) return { status: "skipped", result: { reason: "missing_task" } };
  const now = ctx.clock.now();
  if (row.generation !== r.task_generation || (job.entity_generation !== null && job.entity_generation !== row.generation)) {
    await markReminder(ctx, r, "canceled", "stale_generation");
    return { status: "skipped", result: { reason: "stale_generation" } };
  }
  if (row.status !== "open") {
    await markReminder(ctx, r, "canceled", `task_${row.status}`);
    return { status: "skipped", result: { reason: `task_${row.status}` } };
  }
  const s = await getSettings(ctx.db);
  if (r.kind === "followup") {
    if (row.checks_disabled === 1) {
      await markReminder(ctx, r, "canceled", "checks_disabled");
      return { status: "skipped", result: { reason: "checks_disabled" } };
    }
    const sent = await ctx.db.all<{ updated_at: number; explicit: number }>(
      "SELECT updated_at, explicit FROM reminders WHERE task_id = ? AND kind = 'followup' AND status = 'sent'",
      r.task_id,
    );
    const routineCap = r.explicit ? HARD_MAX_FOLLOWUPS_PER_OCCURRENCE : s.followup_max_per_occurrence;
    if (sent.length >= routineCap) {
      await markReminder(ctx, r, "canceled", "followup_cap");
      return { status: "skipped", result: { reason: "followup_cap" } };
    }
    if (!r.explicit && sent.some((x) => now - x.updated_at < s.followup_min_gap_minutes * MINUTE)) {
      await markReminder(ctx, r, "canceled", "followup_min_gap");
      return { status: "skipped", result: { reason: "followup_min_gap" } };
    }
  }
  if (now - r.planned_at > ROUTINE_LATENESS_MS) {
    await markReminder(ctx, r, "missed", "too_late");
    return { status: "skipped", result: { reason: "missed" } };
  }
  if (isPaused(s, now, "reminders")) {
    await markReminder(ctx, r, "skipped", "paused");
    return { status: "skipped", result: { reason: "paused" } };
  }
  if (r.quiet_policy === "defer" && isInQuietHours(now, s.timezone, s.quiet_start_minute, s.quiet_end_minute)) {
    const until = quietHoursEnd(now, s.timezone, s.quiet_start_minute, s.quiet_end_minute);
    await ctx.db.run("UPDATE reminders SET planned_at = ?, updated_at = ? WHERE id = ? AND status = 'scheduled'", until, now, r.id);
    return { status: "reschedule", dueAt: until, reason: "quiet_hours" };
  }

  const task = await decryptTask(ctx, row);
  const late = now - r.planned_at > LATE_LABEL_AFTER_MS;
  const lateLabel = late ? ` (late; was due ${formatTime(r.intended_at, s.timezone)})` : "";
  const body =
    r.kind === "reminder"
      ? `Reminder: ${task.title}${lateLabel}. Reply DONE when finished. [${task.short_id}]`
      : `Did you finish: ${task.title}?${lateLabel} Reply DONE or NOT YET. [${task.short_id}]`;
  const effect = await ensureSmsEffect(ctx, { effectKey: `reminder:${r.id}`, purpose: r.kind, body, relatedTaskId: task.id });
  const d = await deliverSmsEffect(ctx, effect.id, "proactive");
  if (d.state === "retry") return { status: "retry", error: d.reason, delayMs: 60_000 };
  if (d.state === "accepted" || d.state === "unknown" || d.state === "delivered") {
    await markReminder(ctx, r, "sent", d.state, { late });
    await setLastReferenced(ctx, [task.id]);
    if (r.kind === "followup") {
      await createClarification(ctx, {
        type: "followup",
        options: [
          { label: "done", keywords: ["done", "yes", "finished", "did it"], value: "done" },
          { label: "not yet", keywords: ["not yet", "no", "nope", "not done"], value: "not_yet" },
        ],
        freeform: null,
        pending: { action: { taskId: task.id }, slot: null, anchorMs: now, sourceInboundId: null },
        prompt: body,
        sourceActionKey: `followup-q:${r.id}`,
        ttlMs: 6 * HOUR,
      });
      await scheduleNextRoutineFollowup(ctx, row, s.followup_max_per_occurrence, s.followup_default_delay_minutes);
    }
    return { status: "succeeded", result: { delivery: d.state } };
  }
  await markReminder(ctx, r, "skipped", d.reason ?? d.state);
  if (d.state === "failed") return { status: "blocked", error: `delivery failed: ${d.reason ?? ""}` };
  return { status: "skipped", result: { reason: d.reason ?? d.state } };
}

/** Routine (global-default) follow-ups chain one at a time, within the per-occurrence cap. */
async function scheduleNextRoutineFollowup(ctx: AppContext, task: TaskRow, cap: number, delayMinutes: number): Promise<void> {
  if (task.followup_enabled !== 1 || task.checks_disabled === 1) return;
  const counts = await ctx.db.first<{ sent: number; scheduled: number; explicit: number }>(
    "SELECT SUM(status = 'sent') AS sent, SUM(status = 'scheduled') AS scheduled, SUM(explicit = 1) AS explicit FROM reminders WHERE task_id = ? AND kind = 'followup'",
    task.id,
  );
  if (!counts || (counts.explicit ?? 0) > 0 || (counts.scheduled ?? 0) > 0 || (counts.sent ?? 0) >= cap) return;
  const maxOrdinal = (await ctx.db.first<{ m: number }>("SELECT MAX(ordinal) AS m FROM reminders WHERE task_id = ?", task.id))?.m ?? 0;
  const at = ctx.clock.now() + Math.max(delayMinutes, 120) * MINUTE;
  await ctx.db.batch(reminderStatements(ctx, task.id, task.generation, maxOrdinal + 1, [{ kind: "followup", at, explicit: false, quietPolicy: "defer" }]).statements);
}

/** After an outage: one bounded summary of missed routine reminders, never a backlog burst. */
export async function maybeScheduleMissedSummary(ctx: AppContext, createJob: (key: string, dueAt: number) => Promise<void>): Promise<void> {
  const pending = await ctx.db.first<{ n: number }>("SELECT COUNT(*) AS n FROM reminders WHERE status = 'missed' AND missed_summarized = 0");
  if (!pending || pending.n === 0) return;
  const last = Number((await getSystemState(ctx.db, "last_missed_summary_at")) ?? "0");
  const now = ctx.clock.now();
  if (now - last < MISSED_SUMMARY_MIN_GAP_MS) return;
  await createJob(`missed_summary:${Math.floor(now / HOUR)}`, now);
}

export async function handleMissedSummary(ctx: AppContext): Promise<JobOutcome> {
  const rows = await ctx.db.all<{ id: string; task_id: string }>(
    "SELECT id, task_id FROM reminders WHERE status = 'missed' AND missed_summarized = 0 ORDER BY intended_at LIMIT 50",
  );
  if (rows.length === 0) return { status: "skipped", result: { reason: "nothing_missed" } };
  const now = ctx.clock.now();
  const s = await getSettings(ctx.db);
  const titles: string[] = [];
  for (const r of rows.slice(0, 3)) {
    const t = await ctx.db.first<TaskRow>("SELECT * FROM tasks WHERE id = ?", r.task_id);
    if (t) titles.push((await decryptTask(ctx, t)).title.slice(0, 40));
  }
  await ctx.db.run(`UPDATE reminders SET missed_summarized = 1 WHERE id IN (${rows.map(() => "?").join(",")})`, ...rows.map((r) => r.id));
  await setSystemState(ctx.db, "last_missed_summary_at", String(now), now);
  if (isPaused(s, now, "reminders")) return { status: "skipped", result: { reason: "paused", count: rows.length } };
  const more = rows.length > 3 ? ` and ${rows.length - 3} more` : "";
  const body = `I couldn't deliver ${rows.length} reminder${rows.length === 1 ? "" : "s"} on time: ${titles.join("; ")}${more}. They're still open. Reply LIST to see tasks.`;
  const effect = await ensureSmsEffect(ctx, { effectKey: `missed_summary:${rows[0]!.id}`, purpose: "summary", body });
  const d = await deliverSmsEffect(ctx, effect.id, "proactive");
  if (d.state === "retry") return { status: "retry", error: d.reason };
  return { status: "succeeded", result: { count: rows.length, delivery: d.state } };
}

/** Morning brief: actual calendar events (or an honest "not connected"), overdue and due-today tasks. */
export async function handleMorningBrief(ctx: AppContext, job: JobRow): Promise<JobOutcome> {
  const s = await getSettings(ctx.db);
  const now = ctx.clock.now();
  if (s.morning_brief_enabled !== 1) return { status: "skipped", result: { reason: "disabled" } };
  if (isPaused(s, now, "reminders")) return { status: "skipped", result: { reason: "paused" } };
  if (now - job.intended_at > 2 * HOUR) return { status: "skipped", result: { reason: "stale" } };
  const today = todayLocal(now, s.timezone);
  const bounds = localDayBounds(today, s.timezone);
  const agenda = await agendaText(ctx, today, s.timezone, "Today");
  const due = await listTasks(ctx, "today", { dayStart: bounds.start, dayEnd: bounds.end }, 5);
  const overdue = await listTasks(ctx, "overdue", { dayStart: bounds.start, dayEnd: bounds.end }, 5);
  const parts = [agenda];
  if (overdue.length) parts.push(`Overdue: ${overdue.map((t) => `${t.title.slice(0, 30)} [${t.short_id}]`).join("; ")}.`);
  if (due.length) parts.push(`Due today: ${due.map((t) => `${t.title.slice(0, 30)} [${t.short_id}]`).join("; ")}.`);
  if (!overdue.length && !due.length) parts.push("No tasks due today.");
  const effect = await ensureSmsEffect(ctx, { effectKey: `brief:${today}`, purpose: "brief", body: parts.join(" "), taskIds: [...overdue, ...due].map((t) => t.id) });
  const d = await deliverSmsEffect(ctx, effect.id, "proactive");
  if (d.state === "retry") return { status: "retry", error: d.reason };
  return { status: "succeeded", result: { delivery: d.state, at: formatDateTime(now, s.timezone) } };
}
