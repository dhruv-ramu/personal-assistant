import type { AppContext } from "../context";
import { readEvents, isBusy } from "../domain/calendar";
import { decryptTask, type Task, type TaskRow } from "../domain/tasks";
import { DAY, MINUTE, formatDate, formatTime, localDayBounds, resolveLocalForRecurrence, todayLocal } from "../domain/time";
import { getExtSettings } from "../ext/settings";
import { getSettings } from "../services/settings";
import { createSuggestion } from "./suggestions";

/**
 * Planning over the same task records: explicit deadlines, owner-supplied estimates and context
 * tags, explicit `depends_on` edges, owner working windows, and the selected calendar. Plans are
 * proposals; calendar blocks need approval. Missing estimates are shown as assumptions.
 */
export const DEFAULT_ESTIMATE_MIN = 30;

export async function upsertTaskMeta(
  ctx: AppContext,
  taskId: string,
  m: { estimateMinutes?: number | null; estimateSource?: string; contextTags?: string[]; deadlineKind?: "external" | "self_imposed" | "none" },
): Promise<void> {
  const now = ctx.clock.now();
  await ctx.db.run(
    `INSERT INTO task_meta (task_id, estimate_minutes, estimate_source, context_tags_json, deadline_kind, updated_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (task_id) DO UPDATE SET estimate_minutes = COALESCE(excluded.estimate_minutes, task_meta.estimate_minutes), estimate_source = COALESCE(excluded.estimate_source, task_meta.estimate_source),
       context_tags_json = CASE WHEN excluded.context_tags_json = '[]' THEN task_meta.context_tags_json ELSE excluded.context_tags_json END,
       deadline_kind = CASE WHEN excluded.deadline_kind = 'none' THEN task_meta.deadline_kind ELSE excluded.deadline_kind END, updated_at = excluded.updated_at`,
    taskId,
    m.estimateMinutes ?? null,
    m.estimateSource ?? null,
    JSON.stringify((m.contextTags ?? []).map((t) => t.toLowerCase())),
    m.deadlineKind ?? "none",
    now,
  );
}

export async function bumpPostpone(ctx: AppContext, taskId: string, title: string, shortId: string): Promise<void> {
  await ctx.db.run(
    "INSERT INTO task_meta (task_id, postpone_count, updated_at) VALUES (?, 1, ?) ON CONFLICT (task_id) DO UPDATE SET postpone_count = task_meta.postpone_count + 1, updated_at = excluded.updated_at",
    taskId,
    ctx.clock.now(),
  );
  const n = (await ctx.db.first<{ postpone_count: number }>("SELECT postpone_count FROM task_meta WHERE task_id = ?", taskId))?.postpone_count ?? 0;
  if (n === 3) {
    // Objective count only; one optional offer per task.
    await createSuggestion(ctx, {
      kind: "first_step",
      dedupeKey: `first_step:${taskId}`,
      suppressionKey: `first_step:${taskId}`,
      text: `You've postponed "${title}" 3 times. Want to break it into a small first step? Reply with the step and I'll add it. [${shortId}]`,
      evidence: [taskId],
      action: null,
      delivery: "digest",
      ttlMs: 3 * DAY,
    });
  }
}

export async function addDependency(
  ctx: AppContext,
  taskId: string,
  dependsOn: string,
  status: "explicit" | "proposed",
  sourceId: string | null,
): Promise<"added" | "cycle" | "exists"> {
  if (taskId === dependsOn) return "cycle";
  // Reject if dependsOn (transitively) already depends on taskId.
  const seen = new Set<string>();
  const stack = [dependsOn];
  for (let i = 0; stack.length && i < 200; i++) {
    const cur = stack.pop()!;
    if (cur === taskId) return "cycle";
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const r of await ctx.db.all<{ depends_on_id: string }>("SELECT depends_on_id FROM task_dependencies WHERE task_id = ? AND status = 'explicit'", cur))
      stack.push(r.depends_on_id);
  }
  const ch = await ctx.db.run(
    "INSERT OR IGNORE INTO task_dependencies (task_id, depends_on_id, status, source_id, created_at) VALUES (?, ?, ?, ?, ?)",
    taskId,
    dependsOn,
    status,
    sourceId,
    ctx.clock.now(),
  );
  return ch === 1 ? "added" : "exists";
}

export async function openPrerequisites(ctx: AppContext, taskId: string): Promise<Task[]> {
  const rows = await ctx.db.all<TaskRow>(
    "SELECT t.* FROM task_dependencies d JOIN tasks t ON t.id = d.depends_on_id WHERE d.task_id = ? AND d.status = 'explicit' AND t.status = 'open'",
    taskId,
  );
  return Promise.all(rows.map((r) => decryptTask(ctx, r)));
}

/** Tasks unblocked by completing `taskId` (all of their explicit prerequisites are now done). */
export async function unblockedBy(ctx: AppContext, taskId: string): Promise<Task[]> {
  const dependents = await ctx.db.all<TaskRow>(
    "SELECT t.* FROM task_dependencies d JOIN tasks t ON t.id = d.task_id WHERE d.depends_on_id = ? AND d.status = 'explicit' AND t.status = 'open'",
    taskId,
  );
  const out: Task[] = [];
  for (const d of dependents) if ((await openPrerequisites(ctx, d.id)).length === 0) out.push(await decryptTask(ctx, d));
  return out;
}

interface PlannedTask {
  task: Task;
  estimate: number;
  estimated: boolean;
  tags: string[];
  blockedBy: Task[];
  postponed: number;
  deadlineKind: string;
}

async function openTasksWithMeta(ctx: AppContext, limit = 60): Promise<PlannedTask[]> {
  const rows = await ctx.db.all<TaskRow & { estimate_minutes: number | null; context_tags_json: string | null; postpone_count: number | null; deadline_kind: string | null }>(
    `SELECT t.*, m.estimate_minutes, m.context_tags_json, m.postpone_count, m.deadline_kind FROM tasks t LEFT JOIN task_meta m ON m.task_id = t.id
     WHERE t.status = 'open' ORDER BY COALESCE(t.due_at, 9e15), t.created_at LIMIT ?`,
    limit,
  );
  const out: PlannedTask[] = [];
  for (const r of rows) {
    const task = await decryptTask(ctx, r);
    out.push({
      task,
      estimate: r.estimate_minutes ?? DEFAULT_ESTIMATE_MIN,
      estimated: r.estimate_minutes === null,
      tags: r.context_tags_json ? (JSON.parse(r.context_tags_json) as string[]) : [],
      blockedBy: await openPrerequisites(ctx, task.id),
      postponed: r.postpone_count ?? 0,
      deadlineKind: r.deadline_kind ?? "none",
    });
  }
  return out;
}

async function freeSlots(ctx: AppContext, date: string, tz: string): Promise<{ slots: Array<{ start: number; end: number }>; calendar: "ok" | "unavailable" }> {
  const ext = await getExtSettings(ctx.db);
  const ws = resolveLocalForRecurrence(date, Math.floor(ext.work_window_start_minute / 60), ext.work_window_start_minute % 60, tz);
  const we = resolveLocalForRecurrence(date, Math.floor(ext.work_window_end_minute / 60), ext.work_window_end_minute % 60, tz);
  const start = Math.max(ws, Math.ceil(ctx.clock.now() / (15 * MINUTE)) * 15 * MINUTE);
  if (start >= we) return { slots: [], calendar: "ok" };
  const r = await readEvents(ctx, start, we, { maxPages: 2 });
  const busy = r.ok
    ? r.value
        .filter(isBusy)
        .map((e) => ({ s: e.startMs!, e: e.endMs! }))
        .sort((a, b) => a.s - b.s)
    : [];
  const slots: Array<{ start: number; end: number }> = [];
  let cursor = start;
  for (const b of busy) {
    if (b.s > cursor) slots.push({ start: cursor, end: Math.min(b.s, we) });
    cursor = Math.max(cursor, b.e);
  }
  if (cursor < we) slots.push({ start: cursor, end: we });
  return { slots: slots.filter((s) => s.end - s.start >= 15 * MINUTE), calendar: r.ok ? "ok" : "unavailable" };
}

function rank(a: PlannedTask, b: PlannedTask): number {
  const ad = a.task.due_at ?? Number.MAX_SAFE_INTEGER;
  const bd = b.task.due_at ?? Number.MAX_SAFE_INTEGER;
  if (ad !== bd) return ad - bd;
  const ae = a.deadlineKind === "external" ? 0 : 1;
  const be = b.deadlineKind === "external" ? 0 : 1;
  return ae - be;
}

export interface DayPlan {
  text: string;
  blocks: Array<{ taskId: string; title: string; startMs: number; endMs: number }>;
}

/** Proposes concrete blocks for today's free windows; unscheduled work is listed, never dropped. */
export async function planDay(ctx: AppContext, mode: "plan" | "minimum_viable"): Promise<DayPlan> {
  const s = await getSettings(ctx.db);
  const tz = s.timezone;
  const today = todayLocal(ctx.clock.now(), tz);
  const { slots, calendar } = await freeSlots(ctx, today, tz);
  const tasks = (await openTasksWithMeta(ctx)).filter((t) => t.blockedBy.length === 0).sort(rank);
  const blocked = (await openTasksWithMeta(ctx)).filter((t) => t.blockedBy.length > 0);
  const dayEnd = localDayBounds(today, tz).end;
  const pool = mode === "minimum_viable" ? tasks.filter((t) => t.task.due_at !== null && t.task.due_at < dayEnd + DAY) : tasks;
  const blocks: DayPlan["blocks"] = [];
  const free = slots.map((x) => ({ ...x }));
  const placed = new Set<string>();
  for (const t of pool) {
    const need = t.estimate * MINUTE;
    const slot = free.find((x) => x.end - x.start >= need);
    if (!slot) continue;
    blocks.push({ taskId: t.task.id, title: t.task.title, startMs: slot.start, endMs: slot.start + need });
    placed.add(t.task.id);
    slot.start += need;
    if (mode === "minimum_viable" && blocks.length >= 3) break;
  }
  const lines: string[] = [];
  if (calendar === "unavailable") lines.push("Calendar unavailable; plan assumes your whole work window is free.");
  if (blocks.length === 0) lines.push(mode === "minimum_viable" ? "Nothing due by tomorrow fits today's remaining free time." : "No open task fits today's remaining free time.");
  else lines.push(`${blocks.map((b) => `${formatTime(b.startMs, tz)}-${formatTime(b.endMs, tz)} ${b.title}`).join("; ")}.`);
  const assumed = pool.filter((t) => placed.has(t.task.id) && t.estimated).map((t) => t.task.title);
  if (assumed.length) lines.push(`Assumed ${DEFAULT_ESTIMATE_MIN} min for: ${assumed.slice(0, 3).join(", ")} (no estimate recorded).`);
  const deferred = tasks.filter((t) => !placed.has(t.task.id)).slice(0, 4);
  if (deferred.length) {
    lines.push(
      `Deferred: ${deferred
        .map(
          (t) => `${t.task.title}${t.task.due_at ? ` (due ${formatDate(t.task.due_at, tz)}${t.deadlineKind === "self_imposed" ? ", self-set" : ""})` : " (no deadline recorded)"}`,
        )
        .join("; ")}.`,
    );
  }
  if (blocked.length)
    lines.push(
      `Blocked: ${blocked
        .slice(0, 2)
        .map((t) => `${t.task.title} (needs ${t.blockedBy[0]!.title} first)`)
        .join("; ")}.`,
    );
  const head = mode === "minimum_viable" ? "Minimum viable day (only work due by tomorrow):" : "Proposed plan:";
  if (blocks.length) lines.push('Nothing is booked; say "block 90 minutes for <task>" to put one on your calendar.');
  return { text: `${head} ${lines.join(" ")}`.trim(), blocks };
}

export async function contextTasks(ctx: AppContext, minutes: number | null, tags: string[]): Promise<string> {
  const want = tags.map((t) => t.toLowerCase());
  const all = (await openTasksWithMeta(ctx)).filter((t) => t.blockedBy.length === 0);
  const fit = all.filter((t) => (minutes === null || (!t.estimated && t.estimate <= minutes)) && want.every((w) => t.tags.includes(w)));
  const s = await getSettings(ctx.db);
  if (fit.length === 0) {
    const unknown = all.filter((t) => t.estimated).length;
    return `No tasks recorded as fitting${minutes ? ` ${minutes} min` : ""}${want.length ? ` (${want.join(", ")})` : ""}.${unknown ? ` ${unknown} task${unknown === 1 ? " has" : "s have"} no estimate yet.` : ""}`;
  }
  return `Fits${minutes ? ` ${minutes} min` : ""}${want.length ? ` ${want.join("/")}` : ""}: ${fit
    .slice(0, 5)
    .map((t) => `${t.task.title} (~${t.estimate} min${t.task.due_at ? `, due ${formatDate(t.task.due_at, s.timezone)}` : ""}) [${t.task.short_id}]`)
    .join("; ")}. Estimates are yours, not measured.`;
}

/** Evening reset: unresolved priorities and proposed carryovers. Deadlines are never moved here. */
export async function eveningReset(ctx: AppContext): Promise<string> {
  const s = await getSettings(ctx.db);
  const tz = s.timezone;
  const today = todayLocal(ctx.clock.now(), tz);
  const end = localDayBounds(today, tz).end;
  const open = await openTasksWithMeta(ctx);
  const dueOrOver = open.filter((t) => t.task.due_at !== null && t.task.due_at < end);
  const soon = open.filter((t) => t.task.due_at !== null && t.task.due_at >= end && t.task.due_at < end + 2 * DAY);
  const lines: string[] = [];
  if (dueOrOver.length)
    lines.push(
      `Still open (due today or earlier): ${dueOrOver
        .slice(0, 4)
        .map((t) => `${t.task.title} [${t.task.short_id}]`)
        .join("; ")}. Their deadlines stay as recorded; reply with a new reminder time to carry any over.`,
    );
  if (soon.length)
    lines.push(
      `Coming up: ${soon
        .slice(0, 3)
        .map((t) => `${t.task.title} (due ${formatDate(t.task.due_at!, tz)})`)
        .join("; ")}.`,
    );
  const warn = soon.filter((t) => t.blockedBy.length);
  if (warn.length) lines.push(`Prerequisite first: ${warn.map((t) => `${t.blockedBy[0]!.title} before ${t.task.title}`).join("; ")}.`);
  return lines.length ? `Evening reset: ${lines.join(" ")}` : "Evening reset: nothing open with a deadline. Nice.";
}

/** Plan repair: a Della planning block now overlapping another event gets one deduplicated proposal. */
export async function detectPlanConflicts(
  ctx: AppContext,
  events: Array<{
    id: string;
    summary: string;
    startMs: number | null;
    endMs: number | null;
    dellaActionKey: string | null;
    selfResponse: string | null;
    transparency: string;
    allDay: boolean;
    status: string;
  }>,
): Promise<number> {
  const s = await getSettings(ctx.db);
  let n = 0;
  const planned = events.filter((e) => e.dellaActionKey?.startsWith("plan:") && e.startMs !== null);
  for (const p of planned) {
    const clash = events.find(
      (e) =>
        e.id !== p.id &&
        !e.dellaActionKey &&
        !e.allDay &&
        e.status !== "cancelled" &&
        e.selfResponse !== "declined" &&
        e.transparency !== "transparent" &&
        e.startMs! < p.endMs! &&
        e.endMs! > p.startMs!,
    );
    if (!clash) continue;
    n++;
    await createSuggestion(ctx, {
      kind: "plan_repair",
      dedupeKey: `plan_repair:${p.id}:${clash.id}:${clash.startMs}`,
      suppressionKey: `plan_repair:${p.id}`,
      text: `Your planned block "${p.summary}" (${formatTime(p.startMs!, s.timezone)}) now overlaps "${clash.summary}". Reply PLAN to get a revised day; nothing was moved.`,
      evidence: [p.id, clash.id],
      action: null,
      delivery: "standalone",
      ttlMs: Math.max(MINUTE, p.endMs! - ctx.clock.now()),
    });
  }
  return n;
}
