import type { AppContext } from "../context";
import { sha256, shortCodeFromBytes, stableId } from "../security/crypto";
import { auditStatement } from "../services/audit";
import { jobInsertStatement } from "../services/jobs";
import { HOUR, MINUTE } from "./time";

export type TaskStatus = "open" | "completed" | "canceled";

export interface TaskRow {
  id: string;
  short_id: string;
  kind: "task" | "reminder";
  title_enc: string;
  notes_enc: string | null;
  status: TaskStatus;
  priority: "low" | "normal" | "high";
  due_at: number | null;
  timezone: string;
  series_id: string | null;
  occurrence_key: string | null;
  followup_enabled: number;
  checks_disabled: number;
  generation: number;
  source_inbound_id: string | null;
  source_action_key: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
  canceled_at: number | null;
  version: number;
}

export interface Task extends TaskRow {
  title: string;
  notes: string | null;
}

export interface ReminderRow {
  id: string;
  task_id: string;
  kind: "reminder" | "followup";
  ordinal: number;
  planned_at: number;
  intended_at: number;
  quiet_policy: "exact" | "defer";
  explicit: number;
  status: "scheduled" | "sent" | "skipped" | "canceled" | "missed";
  task_generation: number;
  status_reason: string | null;
  late: number;
  missed_summarized: number;
  logical_key: string;
  created_at: number;
  updated_at: number;
}

export interface PlannedReminder {
  kind: "reminder" | "followup";
  at: number;
  explicit: boolean;
  quietPolicy: "exact" | "defer";
}

/** Hard ceiling regardless of explicit schedules. */
export const HARD_MAX_FOLLOWUPS_PER_OCCURRENCE = 5;
export const ROUTINE_LATENESS_MS = 2 * HOUR;
export const LATE_LABEL_AFTER_MS = 5 * MINUTE;

export async function decryptTask(ctx: AppContext, row: TaskRow): Promise<Task> {
  return {
    ...row,
    title: await ctx.crypto.decrypt(row.title_enc, "task"),
    notes: await ctx.crypto.decryptNullable(row.notes_enc, "task"),
  };
}

export async function getTask(ctx: AppContext, id: string): Promise<Task | null> {
  const row = await ctx.db.first<TaskRow>("SELECT * FROM tasks WHERE id = ?", id);
  return row ? decryptTask(ctx, row) : null;
}

export async function getTaskByShortId(ctx: AppContext, shortId: string): Promise<Task | null> {
  const row = await ctx.db.first<TaskRow>("SELECT * FROM tasks WHERE short_id = ?", shortId.toUpperCase());
  return row ? decryptTask(ctx, row) : null;
}

/** Deterministic short ID from the action key, probing past collisions. */
async function allocateShortId(ctx: AppContext, seedKey: string): Promise<string> {
  const h = await sha256(`short:${seedKey}`);
  for (let i = 0; i < h.length - 3; i++) {
    const candidate = shortCodeFromBytes("T", h, i);
    const taken = await ctx.db.first<{ id: string }>("SELECT id FROM tasks WHERE short_id = ?", candidate);
    if (!taken) return candidate;
  }
  const extra = await sha256(`short2:${seedKey}:${ctx.clock.now()}`);
  return shortCodeFromBytes("T", extra, 0);
}

export function reminderStatements(
  ctx: AppContext,
  taskId: string,
  generation: number,
  ordinalBase: number,
  planned: PlannedReminder[],
  intendedDefault?: number,
): { statements: D1PreparedStatement[]; reminderKeys: string[] } {
  const now = ctx.clock.now();
  const statements: D1PreparedStatement[] = [];
  const reminderKeys: string[] = [];
  planned.forEach((p, i) => {
    const ordinal = ordinalBase + i;
    const key = `rem:${taskId}:${p.kind}:${ordinal}:g${generation}`;
    reminderKeys.push(key);
    const reminderId = key;
    statements.push(
      ctx.db.prepare(
        `INSERT INTO reminders (id, task_id, kind, ordinal, planned_at, intended_at, quiet_policy, explicit, status, task_generation, logical_key, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', ?, ?, ?, ?) ON CONFLICT (logical_key) DO NOTHING`,
        reminderId,
        taskId,
        p.kind,
        ordinal,
        p.at,
        intendedDefault ?? p.at,
        p.quietPolicy,
        p.explicit ? 1 : 0,
        generation,
        key,
        now,
        now,
      ),
      jobInsertStatement(ctx, {
        logicalKey: `job:${key}`,
        kind: "send_reminder",
        entityId: taskId,
        entityGeneration: generation,
        dueAt: p.at,
        intendedAt: p.at,
        maxAttempts: 4,
        payload: { reminderKey: key },
      }),
    );
  });
  return { statements, reminderKeys };
}

export interface CreateTaskInput {
  actionKey: string;
  title: string;
  notes: string | null;
  kind: "task" | "reminder";
  priority: "low" | "normal" | "high";
  dueAt: number | null;
  timezone: string;
  reminders: PlannedReminder[];
  followupEnabled: boolean;
  seriesId?: string | null;
  occurrenceKey?: string | null;
  sourceInboundId: string | null;
  actor?: "sms" | "admin" | "system";
}

/** Idempotent: a retried action with the same key returns the existing task without new effects. */
export async function createTask(ctx: AppContext, input: CreateTaskInput): Promise<{ task: Task; created: boolean }> {
  const id = await stableId("tsk", input.actionKey);
  const existing = await getTask(ctx, id);
  if (existing) return { task: existing, created: false };
  if (input.seriesId && input.occurrenceKey) {
    const occ = await ctx.db.first<TaskRow>("SELECT * FROM tasks WHERE series_id = ? AND occurrence_key = ?", input.seriesId, input.occurrenceKey);
    if (occ) return { task: await decryptTask(ctx, occ), created: false };
  }
  const now = ctx.clock.now();
  const shortId = await allocateShortId(ctx, input.actionKey);
  const statements: D1PreparedStatement[] = [
    ctx.db.prepare(
      `INSERT INTO tasks (id, short_id, kind, title_enc, notes_enc, status, priority, due_at, timezone, series_id, occurrence_key, followup_enabled, generation, source_inbound_id, source_action_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
      id,
      shortId,
      input.kind,
      await ctx.crypto.encrypt(input.title, "task"),
      await ctx.crypto.encryptNullable(input.notes, "task"),
      input.priority,
      input.dueAt,
      input.timezone,
      input.seriesId ?? null,
      input.occurrenceKey ?? null,
      input.followupEnabled ? 1 : 0,
      input.sourceInboundId,
      input.actionKey,
      now,
      now,
    ),
  ];
  const reminders = [...input.reminders.filter((r) => r.kind === "reminder"), ...input.reminders.filter((r) => r.kind === "followup")];
  let ordinal = 1;
  for (const r of reminders) {
    statements.push(...reminderStatements(ctx, id, 1, ordinal++, [r]).statements);
  }
  statements.push(auditStatement(ctx, input.actor ?? "sms", "task.create", "task", id, `short=${shortId} reminders=${reminders.length}`));
  try {
    await ctx.db.batch(statements);
  } catch (err) {
    const again = await getTask(ctx, id);
    if (again) return { task: again, created: false };
    throw err;
  }
  return { task: (await getTask(ctx, id))!, created: true };
}

export async function scheduledReminders(ctx: AppContext, taskId: string): Promise<ReminderRow[]> {
  return ctx.db.all<ReminderRow>("SELECT * FROM reminders WHERE task_id = ? AND status = 'scheduled' ORDER BY planned_at", taskId);
}

function invalidateStatements(ctx: AppContext, taskId: string, reason: string, kinds: Array<"reminder" | "followup"> = ["reminder", "followup"]): D1PreparedStatement[] {
  const now = ctx.clock.now();
  const kindList = kinds.map(() => "?").join(",");
  return [
    // Jobs first (selected via the reminders about to be canceled), then the reminders themselves.
    ctx.db.prepare(
      `UPDATE jobs SET status = 'canceled', last_error = ?, finished_at = ?, updated_at = ?
       WHERE status = 'pending' AND kind = 'send_reminder' AND logical_key IN (SELECT 'job:' || logical_key FROM reminders WHERE task_id = ? AND status = 'scheduled' AND kind IN (${kindList}))`,
      reason,
      now,
      now,
      taskId,
      ...kinds,
    ),
    ctx.db.prepare(
      `UPDATE reminders SET status = 'canceled', status_reason = ?, updated_at = ? WHERE task_id = ? AND status = 'scheduled' AND kind IN (${kindList})`,
      reason,
      now,
      taskId,
      ...kinds,
    ),
  ];
}

export type TransitionResult = { ok: true; task: Task; canceledChecks: number } | { ok: false; reason: "not_found" | "invalid_state" | "version_conflict"; task: Task | null };

/**
 * Two-phase transitions. Phase 1 is a single fenced UPDATE (status + version + generation bump);
 * only if it wins does phase 2 cancel dependent reminders/jobs. D1 batches do not abort when a
 * conditional UPDATE matches zero rows, so dependent writes are never bundled with the fence.
 * A crash between phases is safe: send-time revalidation skips reminders of a non-open task or a
 * stale generation, and an action retry re-runs phase 2.
 */
async function fencedTransition(ctx: AppContext, sql: string, params: Array<string | number | null>): Promise<boolean> {
  return (await ctx.db.run(sql, ...params)) === 1;
}

/** Completing an occurrence: open -> completed, generation bump, cancel remaining checks. Never touches the series. */
export async function completeTask(ctx: AppContext, taskId: string, actor: "sms" | "admin" = "sms"): Promise<TransitionResult> {
  const before = await getTask(ctx, taskId);
  if (!before) return { ok: false, reason: "not_found", task: null };
  if (before.status !== "open") return { ok: false, reason: "invalid_state", task: before };
  const pending = (await scheduledReminders(ctx, taskId)).length;
  const now = ctx.clock.now();
  const won = await fencedTransition(
    ctx,
    "UPDATE tasks SET status = 'completed', completed_at = ?, generation = generation + 1, version = version + 1, updated_at = ? WHERE id = ? AND status = 'open' AND version = ?",
    [now, now, taskId, before.version],
  );
  if (!won) return { ok: false, reason: "version_conflict", task: await getTask(ctx, taskId) };
  await ctx.db.batch([...invalidateStatements(ctx, taskId, "completed"), auditStatement(ctx, actor, "task.complete", "task", taskId)]);
  return { ok: true, task: (await getTask(ctx, taskId))!, canceledChecks: pending };
}

export async function reopenTask(ctx: AppContext, taskId: string, actor: "sms" | "admin" = "sms"): Promise<TransitionResult> {
  const before = await getTask(ctx, taskId);
  if (!before) return { ok: false, reason: "not_found", task: null };
  if (before.status === "open") return { ok: false, reason: "invalid_state", task: before };
  const now = ctx.clock.now();
  const won = await fencedTransition(
    ctx,
    "UPDATE tasks SET status = 'open', completed_at = NULL, canceled_at = NULL, generation = generation + 1, version = version + 1, updated_at = ? WHERE id = ? AND version = ?",
    [now, taskId, before.version],
  );
  if (!won) return { ok: false, reason: "version_conflict", task: await getTask(ctx, taskId) };
  await ctx.db.batch([auditStatement(ctx, actor, "task.reopen", "task", taskId)]);
  return { ok: true, task: (await getTask(ctx, taskId))!, canceledChecks: 0 };
}

export async function cancelTask(ctx: AppContext, taskId: string, actor: "sms" | "admin" = "sms"): Promise<TransitionResult> {
  const before = await getTask(ctx, taskId);
  if (!before) return { ok: false, reason: "not_found", task: null };
  if (before.status === "canceled") return { ok: false, reason: "invalid_state", task: before };
  const pending = (await scheduledReminders(ctx, taskId)).length;
  const now = ctx.clock.now();
  const won = await fencedTransition(
    ctx,
    "UPDATE tasks SET status = 'canceled', canceled_at = ?, generation = generation + 1, version = version + 1, updated_at = ? WHERE id = ? AND version = ?",
    [now, now, taskId, before.version],
  );
  if (!won) return { ok: false, reason: "version_conflict", task: await getTask(ctx, taskId) };
  await ctx.db.batch([...invalidateStatements(ctx, taskId, "canceled"), auditStatement(ctx, actor, "task.cancel", "task", taskId)]);
  return { ok: true, task: (await getTask(ctx, taskId))!, canceledChecks: pending };
}

/** Cancels a recurring series (future occurrences stop) and its current open occurrence. */
export async function cancelSeries(ctx: AppContext, seriesId: string, actor: "sms" | "admin" = "sms"): Promise<number> {
  const now = ctx.clock.now();
  const open = await ctx.db.all<{ id: string }>("SELECT id FROM tasks WHERE series_id = ? AND status = 'open'", seriesId);
  await ctx.db.batch([
    ctx.db.prepare(
      "UPDATE series SET status = 'canceled', canceled_at = ?, cancel_reason = 'owner_request', next_occurrence_at = NULL, version = version + 1, updated_at = ? WHERE id = ? AND status = 'active'",
      now,
      now,
      seriesId,
    ),
    auditStatement(ctx, actor, "series.cancel", "series", seriesId),
  ]);
  for (const t of open) await cancelTask(ctx, t.id, actor);
  return open.length;
}

/**
 * Snooze/reschedule: bump generation (old jobs become stale), cancel scheduled reminders of the
 * given kinds, and schedule one new explicit reminder at `at`.
 */
export async function rescheduleReminder(
  ctx: AppContext,
  taskId: string,
  at: number,
  opts: { reason: string; kind?: "reminder" | "followup"; cancelKinds?: Array<"reminder" | "followup"> } = { reason: "snoozed" },
): Promise<TransitionResult> {
  const before = await getTask(ctx, taskId);
  if (!before) return { ok: false, reason: "not_found", task: null };
  if (before.status !== "open") return { ok: false, reason: "invalid_state", task: before };
  const now = ctx.clock.now();
  const newGen = before.generation + 1;
  const won = await fencedTransition(ctx, "UPDATE tasks SET generation = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ? AND status = 'open'", [
    newGen,
    now,
    taskId,
    before.version,
  ]);
  if (!won) return { ok: false, reason: "version_conflict", task: await getTask(ctx, taskId) };
  const maxOrdinal = (await ctx.db.first<{ m: number | null }>("SELECT MAX(ordinal) AS m FROM reminders WHERE task_id = ?", taskId))?.m ?? 0;
  const kind = opts.kind ?? "reminder";
  const { statements } = reminderStatements(ctx, taskId, newGen, maxOrdinal + 1, [{ kind, at, explicit: true, quietPolicy: "exact" }]);
  await ctx.db.batch([
    ...invalidateStatements(ctx, taskId, opts.reason, opts.cancelKinds ?? ["reminder", "followup"]),
    // Kept reminders (other kinds) follow the new generation so they stay valid.
    ctx.db.prepare("UPDATE reminders SET task_generation = ? WHERE task_id = ? AND status = 'scheduled'", newGen, taskId),
    ctx.db.prepare("UPDATE jobs SET entity_generation = ? WHERE entity_id = ? AND kind = 'send_reminder' AND status = 'pending'", newGen, taskId),
    ...statements,
    auditStatement(ctx, "sms", `task.${opts.reason}`, "task", taskId),
  ]);
  return { ok: true, task: (await getTask(ctx, taskId))!, canceledChecks: 0 };
}

/** Cancels scheduled reminders and follow-ups but keeps the task open. */
export async function cancelScheduledChecks(ctx: AppContext, taskId: string, reason: string): Promise<number> {
  const pending = (await scheduledReminders(ctx, taskId)).length;
  await ctx.db.batch([...invalidateStatements(ctx, taskId, reason), auditStatement(ctx, "sms", "task.reminders_canceled", "task", taskId)]);
  return pending;
}

export async function updateTaskFields(ctx: AppContext, taskId: string, patch: { title?: string; dueAt?: number | null }): Promise<TransitionResult> {
  const before = await getTask(ctx, taskId);
  if (!before) return { ok: false, reason: "not_found", task: null };
  const now = ctx.clock.now();
  const title = patch.title !== undefined ? await ctx.crypto.encrypt(patch.title, "task") : before.title_enc;
  const dueAt = patch.dueAt !== undefined ? patch.dueAt : before.due_at;
  const changes = await ctx.db.run(
    "UPDATE tasks SET title_enc = ?, due_at = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ?",
    title,
    dueAt,
    now,
    taskId,
    before.version,
  );
  if (changes !== 1) return { ok: false, reason: "version_conflict", task: await getTask(ctx, taskId) };
  return { ok: true, task: (await getTask(ctx, taskId))!, canceledChecks: 0 };
}

/** "Don't ask again about this": stops follow-ups for this task only; reminders stay. */
export async function disableChecks(ctx: AppContext, taskId: string): Promise<TransitionResult> {
  const before = await getTask(ctx, taskId);
  if (!before) return { ok: false, reason: "not_found", task: null };
  const pending = (await ctx.db.all("SELECT id FROM reminders WHERE task_id = ? AND status = 'scheduled' AND kind = 'followup'", taskId)).length;
  const now = ctx.clock.now();
  await ctx.db.batch([
    ctx.db.prepare("UPDATE tasks SET checks_disabled = 1, followup_enabled = 0, version = version + 1, updated_at = ? WHERE id = ?", now, taskId),
    ctx.db.prepare(
      "UPDATE reminders SET status = 'canceled', status_reason = 'checks_disabled', updated_at = ? WHERE task_id = ? AND status = 'scheduled' AND kind = 'followup'",
      now,
      taskId,
    ),
    auditStatement(ctx, "sms", "task.checks_disabled", "task", taskId),
  ]);
  return { ok: true, task: (await getTask(ctx, taskId))!, canceledChecks: pending };
}

export async function addFollowup(ctx: AppContext, taskId: string, at: number, explicit: boolean): Promise<TransitionResult> {
  const before = await getTask(ctx, taskId);
  if (!before) return { ok: false, reason: "not_found", task: null };
  if (before.status !== "open") return { ok: false, reason: "invalid_state", task: before };
  const maxOrdinal = (await ctx.db.first<{ m: number | null }>("SELECT MAX(ordinal) AS m FROM reminders WHERE task_id = ?", taskId))?.m ?? 0;
  const { statements } = reminderStatements(ctx, taskId, before.generation, maxOrdinal + 1, [{ kind: "followup", at, explicit, quietPolicy: explicit ? "exact" : "defer" }]);
  await ctx.db.batch([ctx.db.prepare("UPDATE tasks SET checks_disabled = 0, followup_enabled = 1, updated_at = ? WHERE id = ?", ctx.clock.now(), taskId), ...statements]);
  return { ok: true, task: (await getTask(ctx, taskId))!, canceledChecks: 0 };
}

export type TaskFilter = "open" | "today" | "overdue" | "upcoming" | "completed" | "scheduled";

export async function listTasks(ctx: AppContext, filter: TaskFilter, range: { dayStart: number; dayEnd: number }, limit = 10): Promise<Task[]> {
  const now = ctx.clock.now();
  let rows: TaskRow[];
  switch (filter) {
    case "completed":
      rows = await ctx.db.all<TaskRow>("SELECT * FROM tasks WHERE status = 'completed' ORDER BY completed_at DESC LIMIT ?", limit);
      break;
    case "today":
      rows = await ctx.db.all<TaskRow>("SELECT * FROM tasks WHERE status = 'open' AND due_at >= ? AND due_at < ? ORDER BY due_at LIMIT ?", range.dayStart, range.dayEnd, limit);
      break;
    case "overdue":
      rows = await ctx.db.all<TaskRow>("SELECT * FROM tasks WHERE status = 'open' AND due_at IS NOT NULL AND due_at < ? ORDER BY due_at LIMIT ?", now, limit);
      break;
    case "upcoming":
    case "scheduled":
      rows = await ctx.db.all<TaskRow>(
        `SELECT t.* FROM tasks t JOIN (SELECT task_id, MIN(planned_at) AS next_at FROM reminders WHERE status = 'scheduled' GROUP BY task_id) r ON r.task_id = t.id
         WHERE t.status = 'open' ORDER BY r.next_at LIMIT ?`,
        limit,
      );
      break;
    default:
      rows = await ctx.db.all<TaskRow>("SELECT * FROM tasks WHERE status = 'open' ORDER BY COALESCE(due_at, 9e15), created_at LIMIT ?", limit);
  }
  return Promise.all(rows.map((r) => decryptTask(ctx, r)));
}

export async function nextReminderAt(ctx: AppContext, taskId: string): Promise<ReminderRow | null> {
  return ctx.db.first<ReminderRow>("SELECT * FROM reminders WHERE task_id = ? AND status = 'scheduled' ORDER BY planned_at LIMIT 1", taskId);
}

/** Fuzzy title match among open tasks (bounded). */
export async function findOpenTasksByText(ctx: AppContext, text: string, limit = 50): Promise<Task[]> {
  const rows = await ctx.db.all<TaskRow>("SELECT * FROM tasks WHERE status = 'open' ORDER BY updated_at DESC LIMIT ?", limit);
  const tasks = await Promise.all(rows.map((r) => decryptTask(ctx, r)));
  const words = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
  if (words.length === 0) return [];
  const scored = tasks
    .map((t) => {
      const title = t.title.toLowerCase();
      const hits = words.filter((w) => title.includes(w)).length;
      return { t, score: hits / words.length };
    })
    .filter((x) => x.score >= 0.5)
    .sort((a, b) => b.score - a.score);
  if (scored.length === 0) return [];
  const best = scored[0]!.score;
  return scored.filter((x) => x.score === best).map((x) => x.t);
}

const STOPWORDS = new Set(["the", "my", "task", "reminder", "for", "and", "that", "this", "about", "with", "to"]);
