import type { AppContext } from "../context";
import { materializeAlarm, type AlarmRow } from "../domain/alarms";
import { countOccurrencesBetween, firstOccurrence, nextOccurrenceAfter, type Occurrence, type SeriesRule } from "../domain/recurrence";
import { ROUTINE_LATENESS_MS, createTask, getTask, type PlannedReminder, type Task } from "../domain/tasks";
import { HOUR, MINUTE } from "../domain/time";
import { log } from "../observability/log";
import { stableId } from "../security/crypto";
import { audit } from "./audit";

export interface TaskSeriesTemplate {
  kind: "task" | "reminder";
  priority: "low" | "normal" | "high";
  followupOffsetsMin: number[];
  followupEnabled: boolean;
}

interface SeriesRow {
  id: string;
  kind: "task" | "alarm";
  rrule: string;
  dtstart_local: string;
  timezone: string;
  local_time: string;
  status: string;
  template_enc: string | null;
  template_json: string;
  next_occurrence_at: number | null;
  next_occurrence_key: string | null;
  generated_count: number;
}

const TASK_HORIZON_MS = 12 * HOUR;

async function materializeTaskOccurrence(ctx: AppContext, series: SeriesRow, occ: Occurrence): Promise<Task> {
  const template = JSON.parse(series.template_json) as TaskSeriesTemplate;
  const text = JSON.parse(await ctx.crypto.decrypt(series.template_enc!, "series")) as { title: string; notes: string | null };
  const reminders: PlannedReminder[] = [
    { kind: "reminder", at: occ.ms, explicit: true, quietPolicy: "exact" },
    ...template.followupOffsetsMin.map((m) => ({ kind: "followup" as const, at: occ.ms + m * MINUTE, explicit: true, quietPolicy: "exact" as const })),
  ];
  const { task } = await createTask(ctx, {
    actionKey: `series:${series.id}:${occ.key}`,
    title: text.title,
    notes: text.notes,
    kind: template.kind,
    priority: template.priority,
    dueAt: occ.ms,
    timezone: series.timezone,
    reminders,
    followupEnabled: template.followupEnabled,
    seriesId: series.id,
    occurrenceKey: occ.key,
    sourceInboundId: null,
    actor: "system",
  });
  return task;
}

export async function createTaskSeries(
  ctx: AppContext,
  input: { actionKey: string; title: string; notes: string | null; rrule: string; startDate: string; hour: number; minute: number; timezone: string; template: TaskSeriesTemplate },
): Promise<{ seriesId: string; first: Task | null; firstAt: number | null }> {
  const seriesId = await stableId("ser", `task:${input.actionKey}`);
  const localTime = `${String(input.hour).padStart(2, "0")}:${String(input.minute).padStart(2, "0")}`;
  const now = ctx.clock.now();
  await ctx.db.run(
    `INSERT INTO series (id, kind, rrule, dtstart_local, timezone, local_time, template_enc, template_json, status, created_at, updated_at)
     VALUES (?, 'task', ?, ?, ?, ?, ?, ?, 'active', ?, ?) ON CONFLICT (id) DO NOTHING`,
    seriesId,
    input.rrule,
    `${input.startDate}T${localTime}`,
    input.timezone,
    localTime,
    await ctx.crypto.encrypt(JSON.stringify({ title: input.title, notes: input.notes }), "series"),
    JSON.stringify(input.template),
    now,
    now,
  );
  const series = (await ctx.db.first<SeriesRow>("SELECT * FROM series WHERE id = ?", seriesId))!;
  const rule: SeriesRule = { rrule: series.rrule, dtstartLocal: series.dtstart_local, timezone: series.timezone };
  if (series.next_occurrence_key) {
    const existing = await ctx.db.first<{ id: string }>("SELECT id FROM tasks WHERE series_id = ? ORDER BY due_at LIMIT 1", seriesId);
    return { seriesId, first: existing ? await getTask(ctx, existing.id) : null, firstAt: series.next_occurrence_at };
  }
  const f = firstOccurrence(rule);
  const first = f && f.ms > now ? f : nextOccurrenceAfter(rule, now);
  if (!first) {
    await ctx.db.run("UPDATE series SET status = 'ended', updated_at = ? WHERE id = ?", now, seriesId);
    return { seriesId, first: null, firstAt: null };
  }
  const task = await materializeTaskOccurrence(ctx, series, first);
  const next = nextOccurrenceAfter(rule, first.ms);
  await ctx.db.run(
    "UPDATE series SET last_materialized_key = ?, next_occurrence_at = ?, next_occurrence_key = ?, generated_count = generated_count + 1, status = CASE WHEN ? IS NULL THEN 'ended' ELSE status END, updated_at = ? WHERE id = ?",
    first.key,
    next?.ms ?? null,
    next?.key ?? null,
    next?.ms ?? null,
    now,
    seriesId,
  );
  return { seriesId, first: task, firstAt: first.ms };
}

/**
 * Materializes due occurrences one ahead. Recurrence advances from the intended schedule (not
 * completion time or queue delay). After an outage, occurrences older than the lateness window are
 * coalesced (counted and skipped), never generated as a backlog.
 */
export async function materializeSeries(ctx: AppContext, limit = 20): Promise<{ tasks: number; alarms: number; coalesced: number }> {
  const now = ctx.clock.now();
  let tasks = 0;
  let coalesced = 0;
  const due = await ctx.db.all<SeriesRow>(
    "SELECT * FROM series WHERE status = 'active' AND kind = 'task' AND next_occurrence_at IS NOT NULL AND next_occurrence_at <= ? ORDER BY next_occurrence_at LIMIT ?",
    now + TASK_HORIZON_MS,
    limit,
  );
  for (const series of due) {
    const rule: SeriesRule = { rrule: series.rrule, dtstartLocal: series.dtstart_local, timezone: series.timezone };
    let occ: Occurrence | null = { key: series.next_occurrence_key!, ms: series.next_occurrence_at!, localDate: "", hour: 0, minute: 0 };
    if (occ.ms < now - ROUTINE_LATENESS_MS) {
      const skipped = countOccurrencesBetween(rule, occ.ms - 1, now - ROUTINE_LATENESS_MS);
      coalesced += skipped;
      occ = nextOccurrenceAfter(rule, now - ROUTINE_LATENESS_MS);
      await audit(ctx, "system", "series.coalesced", "series", series.id, `skipped=${skipped}`);
      log("info", "series_coalesced", { seriesId: series.id, skipped });
    }
    if (occ && occ.ms <= now + TASK_HORIZON_MS) {
      await materializeTaskOccurrence(ctx, series, occ);
      tasks++;
      const next = nextOccurrenceAfter(rule, occ.ms);
      await ctx.db.run(
        "UPDATE series SET last_materialized_key = ?, next_occurrence_at = ?, next_occurrence_key = ?, generated_count = generated_count + 1, status = CASE WHEN ? IS NULL THEN 'ended' ELSE status END, updated_at = ? WHERE id = ? AND next_occurrence_key = ?",
        occ.key,
        next?.ms ?? null,
        next?.key ?? null,
        next?.ms ?? null,
        now,
        series.id,
        series.next_occurrence_key,
      );
    } else {
      await ctx.db.run(
        "UPDATE series SET next_occurrence_at = ?, next_occurrence_key = ?, status = CASE WHEN ? IS NULL THEN 'ended' ELSE status END, updated_at = ? WHERE id = ?",
        occ?.ms ?? null,
        occ?.key ?? null,
        occ?.ms ?? null,
        now,
        series.id,
      );
    }
  }
  const alarms = await ctx.db.all<AlarmRow>("SELECT * FROM alarm_schedules WHERE enabled = 1 AND series_id IS NOT NULL LIMIT ?", limit);
  for (const a of alarms) await materializeAlarm(ctx, a, now);
  return { tasks, alarms: alarms.length, coalesced };
}
