import type { AppContext } from "../context";
import { parseJson } from "../db/db";
import { deleteEventConditional } from "../domain/calendar";
import { cancelTask, getTask, reopenTask } from "../domain/tasks";
import { DAY, formatTime, localDayBounds, todayLocal, addDays } from "../domain/time";
import { getSettings } from "../services/settings";
import { forgetSource } from "./forget";

/**
 * Activity history and undo. Each supported mutation records a compensating operation. Undo checks
 * current state first; it cannot unsend an SMS or a call that was already delivered.
 */
export type Inverse =
  | { op: "cancel_task"; taskId: string }
  | { op: "reopen_task"; taskId: string }
  | { op: "delete_event"; calendarId: string; eventId: string }
  | { op: "forget_source"; sourceId: string };

export async function recordUndo(ctx: AppContext, actionKey: string, kind: string, entityType: string, entityId: string, description: string, inverse: Inverse): Promise<void> {
  await ctx.db.run(
    "INSERT OR IGNORE INTO undo_log (id, action_key, kind, entity_type, entity_id, description_enc, inverse_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    `und_${actionKey.replace(/[^A-Za-z0-9]/g, "").slice(-40)}`,
    actionKey,
    kind,
    entityType,
    entityId,
    await ctx.crypto.encrypt(description.slice(0, 200), "undo"),
    JSON.stringify(inverse),
    ctx.clock.now(),
  );
}

export async function activityHistory(ctx: AppContext, day: "today" | "yesterday"): Promise<string> {
  const s = await getSettings(ctx.db);
  const today = todayLocal(ctx.clock.now(), s.timezone);
  const b = localDayBounds(day === "today" ? today : addDays(today, -1), s.timezone);
  const rows = await ctx.db.all<{ description_enc: string; created_at: number; undone_at: number | null }>(
    "SELECT description_enc, created_at, undone_at FROM undo_log WHERE created_at >= ? AND created_at < ? ORDER BY created_at LIMIT 12",
    b.start,
    b.end,
  );
  if (rows.length === 0) return `I made no changes ${day}.`;
  const lines = [];
  for (const r of rows) lines.push(`${formatTime(r.created_at, s.timezone)} ${await ctx.crypto.decrypt(r.description_enc, "undo")}${r.undone_at ? " (undone)" : ""}`);
  return `Changes ${day}: ${lines.join("; ")}. (Messages already sent can't be unsent.)`;
}

export async function undoLast(ctx: AppContext): Promise<string> {
  const row = await ctx.db.first<{ id: string; description_enc: string; inverse_json: string }>(
    "SELECT * FROM undo_log WHERE undone_at IS NULL AND created_at > ? ORDER BY created_at DESC LIMIT 1",
    ctx.clock.now() - DAY,
  );
  if (!row) return "Nothing recent to undo.";
  const desc = await ctx.crypto.decrypt(row.description_enc, "undo");
  const inv = parseJson<Inverse | null>(row.inverse_json, null);
  if (!inv) return "That change can't be undone.";
  let result: string;
  switch (inv.op) {
    case "cancel_task": {
      const t = await getTask(ctx, inv.taskId);
      if (!t || t.status !== "open") return `Can't undo "${desc}": the task is already ${t?.status ?? "gone"}.`;
      await cancelTask(ctx, inv.taskId);
      result = `Undid: ${desc} (task canceled; any reminder already sent stays sent).`;
      break;
    }
    case "reopen_task": {
      const t = await getTask(ctx, inv.taskId);
      if (!t || t.status === "open") return `Can't undo "${desc}": the task is already open.`;
      await reopenTask(ctx, inv.taskId);
      result = `Undid: ${desc} (task reopened; reminders aren't rescheduled automatically).`;
      break;
    }
    case "delete_event": {
      const e = await ctx.calendar.getEvent(inv.calendarId, inv.eventId).catch(() => null);
      if (!e || e.status === "cancelled") return `Can't undo "${desc}": the event is already gone.`;
      if (!e.createdByDella) return `Can't undo "${desc}": that event wasn't created by me.`;
      const r = await deleteEventConditional(ctx, inv.calendarId, inv.eventId, e.etag);
      if (!r.ok) return `Couldn't undo "${desc}" (${r.reason}).`;
      result = `Undid: ${desc} (event deleted).`;
      break;
    }
    case "forget_source":
      await forgetSource(ctx, inv.sourceId);
      result = `Undid: ${desc} (those memories were deleted).`;
      break;
  }
  await ctx.db.run("UPDATE undo_log SET undone_at = ? WHERE id = ?", ctx.clock.now(), row.id);
  return result;
}
