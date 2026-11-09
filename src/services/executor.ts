import { isValidTimeZone } from "../config";
import type { AppContext } from "../context";
import { blankTimeSpec, type Action, type ActionOf, type TimeSpec } from "../domain/actions";
import {
  ACTIVE_OCCURRENCE_STATUSES,
  acknowledgeOccurrence,
  activeOccurrenceForSms,
  cancelAlarm,
  cancelNextOccurrence,
  createAlarm,
  listAlarms,
  nextOccurrenceTime,
  snoozeOccurrence,
} from "../domain/alarms";
import {
  agendaText,
  calendarUnavailableText,
  connectedCalendar,
  createEvent,
  deleteEventConditional,
  describeEvent,
  findEvents,
  findFreeSlot,
  findOverlaps,
  localDateOf,
  nextEventText,
  partOfDayWindow,
  patchEventTimes,
  sanitizeExternal,
} from "../domain/calendar";
import {
  createClarification,
  createConfirmation,
  matchOption,
  recentTaskCandidates,
  setLastReferenced,
  type ClarificationOption,
  type ClarificationType,
  type Confirmation,
  type ConfirmationTarget,
  type PendingClarification,
} from "../domain/conversations";
import { buildRRule, describeRecurrence, type RecurrenceSpec } from "../domain/recurrence";
import {
  addFollowup,
  cancelScheduledChecks,
  cancelSeries,
  cancelTask,
  completeTask,
  createTask,
  disableChecks,
  findOpenTasksByText,
  getTask,
  getTaskByShortId,
  listTasks,
  nextReminderAt,
  reopenTask,
  rescheduleReminder,
  updateTaskFields,
  type PlannedReminder,
  type Task,
} from "../domain/tasks";
import {
  DAY,
  MINUTE,
  addDays,
  formatDate,
  formatDateString,
  formatDateTime,
  formatMinuteOfDay,
  formatRange,
  formatTime,
  localDayBounds,
  localParts,
  parseHHMM,
  todayLocal,
  zoneLabel,
} from "../domain/time";
import { parseTimePhrase } from "../domain/timeparse";
import { resolveRecurringTimeOfDay, resolveTimeSpec, type TimePurpose } from "../domain/timespec";
import type { CalendarEventData } from "../providers/types";
import { isShortCode } from "../security/crypto";
import { onTaskCompleted } from "../knowledge/triggers";
import { bumpPostpone, unblockedBy } from "../knowledge/planning";
import { audit } from "./audit";
import { executeRoutineConfirmed, resumeExtClarification, runExtensionAction } from "./ext-executor";
import { getConnection } from "./calendar-connection";
import { calendarReadiness, smsReadiness, voiceReadiness } from "./readiness";
import { createTaskSeries } from "./series";
import { PAUSE_INDEFINITE, getSettings, updateSettings, type OwnerSettings } from "./settings";

export interface ExecEnv {
  ctx: AppContext;
  s: OwnerSettings;
  tz: string;
  anchorMs: number;
  inboundId: string | null;
  actionKey: string;
}

export interface StepResult {
  text: string;
  ok: boolean;
  taskIds?: string[];
  awaiting?: "clarification" | "confirmation";
}

type InternalAction = Action & { _event?: { calendarId: string; eventId: string } };

const done = (text: string, taskIds?: string[]): StepResult => ({ text, ok: true, taskIds });
const fail = (text: string): StepResult => ({ text, ok: false });

// ---------- Clarification helpers ----------

async function ask(
  env: ExecEnv,
  type: ClarificationType,
  prompt: string,
  action: unknown,
  slot: string | null,
  options: ClarificationOption[],
  freeform: "time" | "text" | null,
  extra?: Record<string, unknown>,
): Promise<StepResult> {
  await createClarification(env.ctx, {
    type,
    options,
    freeform,
    pending: { action, slot, anchorMs: env.anchorMs, sourceInboundId: env.inboundId, extra },
    prompt,
    sourceActionKey: env.actionKey,
  });
  return { text: prompt, ok: true, awaiting: "clarification" };
}

type TimeOk = { ok: true; ms: number; notes: string[] };

async function timeAt(
  env: ExecEnv,
  action: unknown,
  slot: string,
  spec: TimeSpec,
  purpose: TimePurpose,
  extra: { after?: number | null; baseDate?: string | null } = {},
): Promise<TimeOk | { ok: false; step: StepResult }> {
  const r = resolveTimeSpec(spec, { anchorMs: env.anchorMs, tz: env.tz, purpose, after: extra.after ?? null, baseDate: extra.baseDate ?? null });
  if (r.ok) return { ok: true, ms: r.ms, notes: r.notes };
  const q = r.question;
  const options: ClarificationOption[] = q.options.map((o) => ({ label: o.label, keywords: o.keywords, value: o.patch }));
  return { ok: false, step: await ask(env, "time", q.prompt, action, slot, options, q.freeform) };
}

function getSlot(action: Record<string, unknown>, slot: string): TimeSpec | null {
  const [key, idx] = slot.split(".") as [string, string | undefined];
  const v = action[key];
  if (idx !== undefined) return ((v as TimeSpec[] | undefined)?.[Number(idx)] ?? null) as TimeSpec | null;
  return (v as TimeSpec | null) ?? null;
}

function setSlot(action: Record<string, unknown>, slot: string, spec: TimeSpec): Record<string, unknown> {
  const copy = JSON.parse(JSON.stringify(action)) as Record<string, unknown>;
  const [key, idx] = slot.split(".") as [string, string | undefined];
  if (idx !== undefined) {
    const arr = [...((copy[key] as TimeSpec[] | undefined) ?? [])];
    arr[Number(idx)] = spec;
    copy[key] = arr;
  } else copy[key] = spec;
  return copy;
}

/** Converts a free-form answer like "5 pm" or "tomorrow at 9" into a patch over the original spec. */
function patchFromAnswer(original: TimeSpec | null, answer: string, year: number): Partial<TimeSpec> | null {
  const p = parseTimePhrase(answer, year) ?? parseTimePhrase(`at ${answer}`, year);
  if (!p) return null;
  const a = p.spec;
  if (a.relative_minutes !== null) return { ...blankTimeSpec(answer), relative_minutes: a.relative_minutes };
  const patch: Partial<TimeSpec> = {};
  if (a.hour !== null) Object.assign(patch, { hour: a.hour, minute: a.minute, meridiem: a.meridiem, past_ok: undefined, gap_ok: undefined, fold: undefined });
  if (a.part_of_day) patch.part_of_day = a.part_of_day;
  if (a.day_kind !== "none") Object.assign(patch, { day_kind: a.day_kind, weekday: a.weekday, weekday_qualifier: a.weekday_qualifier, date: a.date });
  if (Object.keys(patch).length === 0) return null;
  patch.raw = `${original?.raw ?? ""} ${answer}`.trim().slice(0, 120);
  return patch;
}

/** Resumes the exact proposed action behind a clarification with the owner's answer applied. */
export async function resumeClarification(env: ExecEnv, clar: PendingClarification, answer: string): Promise<StepResult> {
  const pending = clar.pending;
  // Time questions resume relative to the ORIGINAL message ("tomorrow" stays tomorrow); answers that
  // introduce a new duration ("snooze 1 hour") are anchored to the answer's own receipt time.
  const anchorMs = clar.question_type === "followup" || clar.question_type === "not_yet" ? env.anchorMs : pending.anchorMs;
  const env2: ExecEnv = { ...env, anchorMs, actionKey: `clar:${clar.id}` };
  const extResult = await resumeExtClarification(env2, clar, answer);
  if (extResult) return extResult;
  const opt = matchOption(clar.options, answer);
  switch (clar.question_type) {
    case "time": {
      const action = pending.action as Record<string, unknown>;
      const slot = pending.slot!;
      const original = getSlot(action, slot);
      let patch: Partial<TimeSpec> | null = opt ? (opt.value as Partial<TimeSpec>) : null;
      if (!patch && clar.freeform === "time") patch = patchFromAnswer(original, answer, Number(localParts(env.anchorMs, env.tz).date.slice(0, 4)));
      if (!patch) return fail(`Sorry, I didn't catch that. ${clar.prompt}`);
      const merged = { ...(original ?? blankTimeSpec()), ...patch } as TimeSpec;
      return runAction(env2, setSlot(action, slot, merged) as InternalAction);
    }
    case "which_task": {
      if (!opt) return fail(`Please reply with the number or task ID. ${clar.prompt}`);
      const action = { ...(pending.action as Record<string, unknown>), task_ref: opt.value as string };
      return runAction(env2, action as InternalAction);
    }
    case "which_event": {
      if (!opt) return fail(`Please reply with the number. ${clar.prompt}`);
      const action = { ...(pending.action as Record<string, unknown>), _event: opt.value };
      return runAction(env2, action as InternalAction);
    }
    case "event_scope": {
      if (!opt) return fail(`Please reply 1 or 2. ${clar.prompt}`);
      const action = { ...(pending.action as Record<string, unknown>), scope: opt.value };
      return runAction(env2, action as InternalAction);
    }
    case "followup":
    case "not_yet": {
      const taskId = (pending.action as { taskId: string }).taskId;
      const task = await getTask(env.ctx, taskId);
      if (!task || task.status !== "open") return done(task ? `${task.title} is already ${task.status}. [${task.short_id}]` : "That task no longer exists.");
      const a = answer.trim().toLowerCase();
      if (clar.question_type === "followup") {
        if (opt?.value === "done") return runAction(env2, { type: "complete_task", task_ref: task.short_id });
        if (opt?.value === "not_yet" || /^not yet|^no\b|^nope/.test(a)) return askNotYet(env2, task);
        return fail(`Reply DONE or NOT YET. [${task.short_id}]`);
      }
      if (opt?.value === "snooze") return runAction(env2, { type: "snooze_reminder", task_ref: task.short_id, minutes: 60, until: null });
      if (opt?.value === "later")
        return runAction(env2, {
          type: "set_followup_policy",
          task_ref: task.short_id,
          applies_to: "task",
          enabled: true,
          at: { ...blankTimeSpec("in 2 hours"), relative_minutes: 120 },
        });
      if (opt?.value === "stop") return runAction(env2, { type: "set_followup_policy", task_ref: task.short_id, applies_to: "task", enabled: false, at: null });
      const m = /(\d+)\s*(min|minute|minutes|h|hr|hour|hours)\b/.exec(a) ?? (/\b(an?|one)\s+hour\b/.test(a) ? ["", "1", "hour"] : null);
      if (m) return runAction(env2, { type: "snooze_reminder", task_ref: task.short_id, minutes: Number(m[1]) * (m[2]!.startsWith("h") ? 60 : 1), until: null });
      return fail(`Reply 1, 2, or 3. ${clar.prompt}`);
    }
    case "timezone_follow": {
      if (!opt) return fail(`Please reply 1 or 2. ${clar.prompt}`);
      const tz = (pending.extra?.timezone as string) ?? env.tz;
      return applyTimezone(env2, tz, opt.value === "follow");
    }
    default:
      return fail("That question can't be answered anymore.");
  }
}

async function askNotYet(env: ExecEnv, task: Task): Promise<StepResult> {
  return ask(
    env,
    "not_yet",
    `OK. 1) Snooze 1 hour 2) Check again in 2 hours 3) Stop checks. Reply 1, 2, or 3. [${task.short_id}]`,
    { taskId: task.id },
    null,
    [
      { label: "snooze 1 hour", keywords: ["snooze", "1 hour", "an hour"], value: "snooze" },
      { label: "check later", keywords: ["later", "check later", "check again"], value: "later" },
      { label: "stop checks", keywords: ["stop", "stop checks", "no more", "don't ask"], value: "stop" },
    ],
    "text",
  );
}

// ---------- Task references ----------

type TaskRefResult = { ok: true; task: Task } | { ok: false; step: StepResult };

async function resolveTaskRef(env: ExecEnv, action: InternalAction, ref: string | null, verb: string, opts: { includeClosed?: boolean } = {}): Promise<TaskRefResult> {
  const ctx = env.ctx;
  if (ref && isShortCode(ref.toUpperCase().replace(/[[\]]/g, ""), "T")) {
    const t = await getTaskByShortId(ctx, ref.toUpperCase().replace(/[[\]]/g, ""));
    if (!t) return { ok: false, step: fail(`I don't have a task ${ref.toUpperCase()}. Reply LIST to see open tasks.`) };
    if (!opts.includeClosed && t.status !== "open") return { ok: false, step: done(`${t.title} is already ${t.status}. [${t.short_id}]`) };
    return { ok: true, task: t };
  }
  let candidates: Task[];
  if (ref && ref.trim()) {
    candidates = await findOpenTasksByText(ctx, ref);
    if (candidates.length === 0) return { ok: false, step: fail(`I couldn't find an open task matching "${ref.slice(0, 40)}". Reply LIST to see open tasks.`) };
  } else {
    const ids = await recentTaskCandidates(ctx);
    candidates = (await Promise.all(ids.map((id) => getTask(ctx, id)))).filter((t): t is Task => t !== null && t.status === "open");
    if (candidates.length === 0) {
      const open = await listTasks(ctx, "open", { dayStart: 0, dayEnd: 0 }, 3);
      if (open.length === 1) candidates = open;
      else if (open.length === 0) return { ok: false, step: fail("You have no open tasks.") };
      else candidates = open;
      if (candidates.length > 1) {
        return { ok: false, step: await askWhichTask(env, action, candidates, verb) };
      }
    }
  }
  if (candidates.length === 1) return { ok: true, task: candidates[0]! };
  return { ok: false, step: await askWhichTask(env, action, candidates.slice(0, 4), verb) };
}

async function askWhichTask(env: ExecEnv, action: InternalAction, tasks: Task[], verb: string): Promise<StepResult> {
  const list = tasks.map((t, i) => `${i + 1}) ${t.title.slice(0, 30)} [${t.short_id}]`).join(" ");
  return ask(
    env,
    "which_task",
    `Which one${verb ? ` to ${verb}` : ""}: ${list}?`,
    action,
    null,
    tasks.map((t) => ({ label: t.short_id, keywords: [t.short_id.toLowerCase()], value: t.short_id })),
    null,
  );
}

// ---------- Formatting ----------

function when(ms: number, tz: string): string {
  return formatDateTime(ms, tz);
}

function sameDay(a: number, b: number, tz: string): boolean {
  return localParts(a, tz).date === localParts(b, tz).date;
}

function cleanTitle(s: string): string {
  return (
    s
      .replace(/[\u0000-\u001f]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120) || "Untitled"
  );
}

// ---------- Main dispatcher ----------

export async function runAction(env: ExecEnv, action: InternalAction): Promise<StepResult> {
  switch (action.type) {
    case "create_reminder":
      return createReminderAction(env, action);
    case "create_task":
      return createTaskAction(env, action);
    case "list_tasks":
      return listTasksAction(env, action);
    case "get_task": {
      const r = await resolveTaskRef(env, action, action.task_ref, "show", { includeClosed: true });
      if (!r.ok) return r.step;
      const next = await nextReminderAt(env.ctx, r.task.id);
      const due = r.task.due_at ? `, due ${when(r.task.due_at, env.tz)}` : "";
      const rem = next ? ` Next ${next.kind}: ${when(next.planned_at, env.tz)}.` : "";
      return done(`${r.task.title} (${r.task.status})${due}.${rem} [${r.task.short_id}]`, [r.task.id]);
    }
    case "complete_task": {
      const r = await resolveTaskRef(env, action, action.task_ref, "complete");
      if (!r.ok) return r.step;
      const res = await completeTask(env.ctx, r.task.id);
      if (!res.ok)
        return res.reason === "invalid_state"
          ? done(`${r.task.title} is already ${r.task.status}. [${r.task.short_id}]`)
          : fail(`Couldn't complete ${r.task.title}; it changed. Try again. [${r.task.short_id}]`);
      await env.ctx.db.run(
        "UPDATE clarifications SET status = 'answered', answered_at = ? WHERE status = 'pending' AND question_type IN ('followup','not_yet')",
        env.ctx.clock.now(),
      );
      const series = r.task.series_id ? " This occurrence only; the recurring schedule continues." : "";
      const checks = res.canceledChecks > 0 ? " Remaining checks canceled." : "";
      await onTaskCompleted(env.ctx, r.task.id);
      const unblocked = await unblockedBy(env.ctx, r.task.id);
      const next = unblocked.length ? ` Now unblocked: ${unblocked.map((t) => `${t.title} [${t.short_id}]`).join(", ")}.` : "";
      return done(`Completed: ${r.task.title}.${checks}${series}${next} [${r.task.short_id}]`, [r.task.id]);
    }
    case "reopen_task": {
      const r = await resolveTaskRef(env, action, action.task_ref, "reopen", { includeClosed: true });
      if (!r.ok) return r.step;
      const res = await reopenTask(env.ctx, r.task.id);
      if (!res.ok) return done(res.reason === "invalid_state" ? `${r.task.title} is already open. [${r.task.short_id}]` : `Couldn't reopen ${r.task.title}. [${r.task.short_id}]`);
      return done(`Reopened: ${r.task.title}. No reminders are scheduled; tell me a time to add one. [${r.task.short_id}]`, [r.task.id]);
    }
    case "update_task":
      return updateTaskAction(env, action);
    case "cancel_task":
      return cancelTaskAction(env, action);
    case "snooze_reminder":
      return snoozeAction(env, action);
    case "cancel_reminder": {
      const r = await resolveTaskRef(env, action, action.task_ref, "stop reminding");
      if (!r.ok) return r.step;
      await cancelScheduledChecks(env.ctx, r.task.id, "reminders_canceled");
      return done(`Reminders canceled for ${r.task.title}. The task stays open. [${r.task.short_id}]`, [r.task.id]);
    }
    case "set_followup_policy":
      return followupPolicyAction(env, action);
    case "get_agenda": {
      const today = todayLocal(env.ctx.clock.now(), env.tz);
      if (action.day === "next_event") return done(await nextEventText(env.ctx, env.tz));
      if (action.day === "tomorrow") return done(await agendaText(env.ctx, addDays(today, 1), env.tz, "Tomorrow"));
      if (action.day === "other" && action.other_day) {
        const d = resolveTimeSpec({ ...action.other_day, hour: null, minute: null, meridiem: null }, { anchorMs: env.anchorMs, tz: env.tz, purpose: "day" });
        if (!d.ok) {
          const q = d.question;
          return ask(
            env,
            "time",
            q.prompt,
            action,
            "other_day",
            q.options.map((o) => ({ label: o.label, keywords: o.keywords, value: o.patch })),
            q.freeform,
          );
        }
        return done(await agendaText(env.ctx, d.localDate, env.tz, "Agenda"));
      }
      return done(await agendaText(env.ctx, today, env.tz, "Today"));
    }
    case "find_calendar_events": {
      const range = await dayRange(env, action, "day", action.day);
      if ("step" in range) return range.step;
      const res = await findEvents(env.ctx, action.query, range.start, range.end);
      if (!res.ok) return fail(calendarUnavailableText(res.reason));
      if (res.value.length === 0) return done("No matching events.");
      return done(
        res.value
          .slice(0, 5)
          .map((e) => describeEvent(e, env.tz))
          .join("; "),
      );
    }
    case "create_calendar_event":
      return createEventAction(env, action);
    case "update_calendar_event":
      return updateEventAction(env, action);
    case "cancel_calendar_event":
      return cancelEventAction(env, action);
    case "propose_focus_block":
      return focusBlockAction(env, action);
    case "set_wake_alarm":
      return wakeAlarmAction(env, action);
    case "snooze_wake_alarm": {
      const occ = await activeOccurrenceForSms(env.ctx);
      if (!occ || !["calling", "scheduled", "retry_scheduled"].includes(occ.status)) return done("No active wake-up call to snooze.");
      const r = await snoozeOccurrence(env.ctx, occ, action.minutes ?? env.s.wake_snooze_minutes);
      return r.ok
        ? done(`Snoozed. I'll call again at ${formatTime(r.targetAt!, env.tz)} ${zoneLabel(r.targetAt!, env.tz)}.`)
        : done(r.reason === "snooze_limit" ? "Snooze limit reached for this wake-up call." : "That wake-up call is no longer active.");
    }
    case "cancel_wake_alarm":
      return cancelWakeAction(env, action);
    case "acknowledge_awake": {
      const occ = await activeOccurrenceForSms(env.ctx);
      if (!occ) return done("No active wake-up call right now.");
      const ok = await acknowledgeOccurrence(env.ctx, occ, "sms");
      return done(ok ? "Got it, you're up. No more wake-up calls this morning." : "That wake-up call was already resolved.");
    }
    case "get_settings":
      return done(settingsSummary(env.s));
    case "get_status":
      return statusAction(env);
    case "update_allowed_settings":
      return updateSettingsAction(env, action);
    case "pause_automation":
      return pauseAction(env, action);
    case "resume_automation": {
      await updateSettings(env.ctx.db, { automation_paused_until: null, automation_pause_scope: null }, env.ctx.clock.now());
      await audit(env.ctx, "sms", "automation.resume", "settings", "1");
      return done("Resumed. Reminders skipped while paused won't be resent; reply LIST to see open tasks.");
    }
    case "help":
      return done(HELP_TEXT);
    case "general_reply":
      return done(action.text.replace(/[\u0000-\u001f]/g, " ").slice(0, 300));
    case "unsupported":
      return fail(unsupportedText(action.reason));
    case "answer_clarification":
      if (/^not yet/i.test(action.answer)) return fail("Which task? Reply with its ID, e.g. T4K8 NOT YET, or LIST.");
      return fail("Nothing is waiting for an answer right now.");
    case "answer_confirmation":
      return fail("There's nothing waiting for confirmation.");
    case "memory_query":
    case "memory_forget":
    case "memory_correct":
    case "capture_control":
    case "resume_project":
    case "plan_day":
    case "context_tasks":
    case "free_time":
    case "trip_brief":
    case "accountability_start":
    case "accountability_control":
    case "morning_routine":
    case "activity_history":
    case "undo":
    case "suggestion_response":
    case "enable_feature":
      return runExtensionAction(env, action);
  }
}

export const HELP_TEXT =
  'I can: set reminders ("remind me tomorrow at 5 PM to..."), track tasks (DONE T4K8), check on unfinished tasks, read and edit your calendar, and place wake-up calls. Also: LIST, STATUS, PAUSE, RESUME.';

function unsupportedText(reason: string): string {
  if (reason.startsWith("ai_unavailable")) return "I can't interpret free-form requests right now. Simple commands still work: LIST, STATUS, DONE T4K8, PAUSE, RESUME.";
  if (reason === "budget:ai_requests") return "I've hit today's limit for interpreting messages. Simple commands still work: LIST, STATUS, DONE T4K8.";
  if (reason === "media") return "I can only read text messages; attachments aren't supported.";
  if (reason === "empty_message") return "That message was empty.";
  if (reason.startsWith("Simulated planner")) return 'I didn\'t understand that. Try: "remind me tomorrow at 5 PM to ..." or reply HELP.';
  return reason.length > 4 ? reason.slice(0, 200) : "I can't do that.";
}

// ---------- Reminders / tasks ----------

async function createReminderAction(env: ExecEnv, a: ActionOf<"create_reminder">): Promise<StepResult> {
  if (a.recurrence) return createRecurring(env, a, a.title, null, a.at, a.recurrence, a.followup_at ? [a.followup_at] : [], "reminder");
  const at = await timeAt(env, a, "at", a.at, "reminder");
  if (!at.ok) return at.step;
  let followupMs: number | null = null;
  if (a.followup_at) {
    const f = await timeAt(env, a, "followup_at", a.followup_at, "followup", { after: at.ms });
    if (!f.ok) return f.step;
    followupMs = f.ms;
  }
  return finishCreate(env, {
    title: a.title,
    notes: null,
    kind: "reminder",
    priority: "normal",
    dueAt: at.ms,
    reminderAts: [at.ms],
    followupAts: followupMs ? [followupMs] : [],
    notes2: at.notes,
  });
}

async function createTaskAction(env: ExecEnv, a: ActionOf<"create_task">): Promise<StepResult> {
  if (a.recurrence) {
    const spec = a.reminders[0] ?? a.due;
    if (!spec) return ask(env, "time", "What time should the recurring reminder be?", { ...a, reminders: [blankTimeSpec()] }, "reminders.0", [], "time");
    return createRecurring(env, a, a.title, a.notes, spec, a.recurrence, a.followups, "task");
  }
  let dueAt: number | null = null;
  if (a.due) {
    const d = await timeAt(env, a, "due", a.due, "due");
    if (!d.ok) return d.step;
    dueAt = d.ms;
  }
  const reminderAts: number[] = [];
  for (let i = 0; i < a.reminders.length; i++) {
    const r = await timeAt(env, a, `reminders.${i}`, a.reminders[i]!, "reminder");
    if (!r.ok) return r.step;
    reminderAts.push(r.ms);
  }
  const followupAts: number[] = [];
  const base = reminderAts[reminderAts.length - 1] ?? dueAt;
  for (let i = 0; i < a.followups.length; i++) {
    const f = await timeAt(env, a, `followups.${i}`, a.followups[i]!, "followup", { after: base });
    if (!f.ok) return f.step;
    followupAts.push(f.ms);
  }
  return finishCreate(env, { title: a.title, notes: a.notes, kind: "task", priority: a.priority ?? "normal", dueAt, reminderAts, followupAts, notes2: [] });
}

async function finishCreate(
  env: ExecEnv,
  p: {
    title: string;
    notes: string | null;
    kind: "task" | "reminder";
    priority: "low" | "normal" | "high";
    dueAt: number | null;
    reminderAts: number[];
    followupAts: number[];
    notes2: string[];
  },
): Promise<StepResult> {
  const reminders: PlannedReminder[] = [
    ...p.reminderAts.map((at) => ({ kind: "reminder" as const, at, explicit: true, quietPolicy: "exact" as const })),
    ...p.followupAts.map((at) => ({ kind: "followup" as const, at, explicit: true, quietPolicy: "exact" as const })),
  ];
  let defaultFollowupAt: number | null = null;
  const base = p.reminderAts[p.reminderAts.length - 1] ?? p.dueAt;
  if (p.followupAts.length === 0 && env.s.followup_default_enabled === 1 && base) {
    defaultFollowupAt = base + env.s.followup_default_delay_minutes * MINUTE;
    reminders.push({ kind: "followup", at: defaultFollowupAt, explicit: false, quietPolicy: "defer" });
  }
  const { task } = await createTask(env.ctx, {
    actionKey: env.actionKey,
    title: cleanTitle(p.title),
    notes: p.notes,
    kind: p.kind,
    priority: p.priority,
    dueAt: p.dueAt,
    timezone: env.tz,
    reminders,
    followupEnabled: p.followupAts.length > 0 || defaultFollowupAt !== null,
    sourceInboundId: env.inboundId,
  });
  await setLastReferenced(env.ctx, [task.id]);
  const tz = env.tz;
  let text: string;
  if (p.reminderAts.length > 0) {
    text = `Reminder set: ${task.title}, ${when(p.reminderAts[0]!, tz)}.`;
    if (p.reminderAts.length > 1)
      text += ` Also at ${p.reminderAts
        .slice(1)
        .map((m) => formatTime(m, tz))
        .join(", ")}.`;
  } else {
    text = `Added task: ${task.title}${p.dueAt ? `, due ${when(p.dueAt, tz)}` : ""}.`;
  }
  const fu = p.followupAts[0] ?? defaultFollowupAt;
  if (fu) {
    const fuText = base && sameDay(fu, base, tz) ? formatTime(fu, tz) : when(fu, tz);
    text += ` I'll check at ${fuText} if it's still open.`;
  }
  if (p.notes2.length) text += ` ${p.notes2.join(" ")}`;
  return done(`${text} [${task.short_id}]`, [task.id]);
}

async function createRecurring(
  env: ExecEnv,
  a: Action,
  title: string,
  notes: string | null,
  spec: TimeSpec,
  rec: RecurrenceSpec,
  followups: TimeSpec[],
  kind: "task" | "reminder",
): Promise<StepResult> {
  const rr = buildRRule(rec);
  if (!rr.ok) return fail(`${rr.reason} I support daily, weekdays, weekly on chosen days, or every N days, with an optional end date or count.`);
  const slot = a.type === "create_reminder" ? "at" : "reminders.0";
  const tod = resolveRecurringTimeOfDay(spec, describeRecurrence(rec));
  if (!tod.ok) {
    const options = tod.question.options.map((o) => ({ label: o.label, keywords: o.keywords, value: o.patch }));
    return ask(
      env,
      "time",
      tod.question.prompt,
      a.type === "create_task" && !(a as ActionOf<"create_task">).reminders.length ? { ...a, reminders: [spec] } : a,
      slot,
      options,
      tod.question.freeform,
    );
  }
  let startDate = todayLocal(env.anchorMs, env.tz);
  if (spec.day_kind !== "none") {
    const d = resolveTimeSpec({ ...spec, hour: tod.hour, minute: tod.minute, meridiem: "none" }, { anchorMs: env.anchorMs, tz: env.tz, purpose: "day" });
    if (d.ok) startDate = d.localDate;
  }
  const offsets: number[] = [];
  for (const f of followups) {
    const fr = resolveRecurringTimeOfDay(f, "for the check-in");
    if (fr.ok) {
      let diff = fr.hour * 60 + fr.minute - (tod.hour * 60 + tod.minute);
      if (diff <= 0) diff += 24 * 60;
      offsets.push(diff);
    }
  }
  const res = await createTaskSeries(env.ctx, {
    actionKey: env.actionKey,
    title: cleanTitle(title),
    notes,
    rrule: rr.rrule,
    startDate,
    hour: tod.hour,
    minute: tod.minute,
    timezone: env.tz,
    template: { kind, priority: "normal", followupOffsetsMin: offsets, followupEnabled: offsets.length > 0 },
  });
  if (!res.first || !res.firstAt) return fail("That schedule has no future occurrences.");
  await setLastReferenced(env.ctx, [res.first.id]);
  const timeText = `${formatMinuteOfDay(tod.hour * 60 + tod.minute)} ${zoneLabel(res.firstAt, env.tz)}`;
  return done(`Recurring reminder set: ${res.first.title}, ${describeRecurrence(rec)} at ${timeText}, starting ${formatDate(res.firstAt, env.tz)}. [${res.first.short_id}]`, [
    res.first.id,
  ]);
}

async function listTasksAction(env: ExecEnv, a: ActionOf<"list_tasks">): Promise<StepResult> {
  const today = todayLocal(env.ctx.clock.now(), env.tz);
  const b = localDayBounds(today, env.tz);
  const tasks = await listTasks(env.ctx, a.filter, { dayStart: b.start, dayEnd: b.end }, 6);
  const label = { open: "Open", today: "Due today", overdue: "Overdue", upcoming: "Upcoming", completed: "Recently completed", scheduled: "Scheduled" }[a.filter];
  const parts: string[] = [];
  for (const t of tasks) {
    const next = a.filter === "scheduled" || a.filter === "upcoming" ? await nextReminderAt(env.ctx, t.id) : null;
    const timeMs = next?.planned_at ?? t.due_at;
    parts.push(`${t.title.slice(0, 32)}${timeMs ? ` (${formatDate(timeMs, env.tz)} ${formatTime(timeMs, env.tz)})` : ""} [${t.short_id}]`);
  }
  if (a.filter === "scheduled") {
    for (const al of (await listAlarms(env.ctx)).filter((x) => x.enabled === 1).slice(0, 2)) {
      const nxt = await nextOccurrenceTime(env.ctx, al.id);
      if (nxt) parts.push(`Wake-up call ${formatDate(nxt, env.tz)} ${formatTime(nxt, env.tz)} [${al.short_id}]`);
    }
  }
  if (parts.length === 0) return done(`${label}: nothing.`);
  await setLastReferenced(
    env.ctx,
    tasks.map((t) => t.id),
  );
  return done(
    `${label}: ${parts.map((p, i) => `${i + 1}) ${p}`).join(" ")}`,
    tasks.map((t) => t.id),
  );
}

async function updateTaskAction(env: ExecEnv, a: ActionOf<"update_task">): Promise<StepResult> {
  const r = await resolveTaskRef(env, a, a.task_ref, "change");
  if (!r.ok) return r.step;
  const patch: { title?: string; dueAt?: number | null } = {};
  if (a.new_title) patch.title = cleanTitle(a.new_title);
  let newDue: number | null = null;
  if (a.new_due) {
    const d = await timeAt(env, a, "new_due", a.new_due, r.task.kind === "reminder" ? "reminder" : "due");
    if (!d.ok) return d.step;
    newDue = d.ms;
    patch.dueAt = d.ms;
  }
  if (!patch.title && patch.dueAt === undefined) return fail("What should I change?");
  const res = await updateTaskFields(env.ctx, r.task.id, patch);
  if (!res.ok) return fail(`Couldn't update ${r.task.title}; it changed. Try again.`);
  if (newDue !== null && r.task.kind === "reminder") {
    await rescheduleReminder(env.ctx, r.task.id, newDue, { reason: "rescheduled", cancelKinds: ["reminder"] });
    return done(`Updated: ${res.task.title}, reminder moved to ${when(newDue, env.tz)}. [${res.task.short_id}]`, [res.task.id]);
  }
  return done(`Updated: ${res.task.title}${newDue !== null ? `, due ${when(newDue, env.tz)}` : ""}. [${res.task.short_id}]`, [res.task.id]);
}

async function cancelTaskAction(env: ExecEnv, a: ActionOf<"cancel_task">): Promise<StepResult> {
  const r = await resolveTaskRef(env, a, a.task_ref, "cancel");
  if (!r.ok) return r.step;
  if (a.scope === "series") {
    if (!r.task.series_id) return fail(`${r.task.title} isn't recurring. Reply CANCEL ${r.task.short_id} to cancel it.`);
    const conf = await createConfirmation(env.ctx, {
      action: { type: "task_series_cancel", seriesId: r.task.series_id, title: r.task.title },
      targets: [{ kind: "task", id: r.task.id, version: r.task.version }],
      prompt: (n) => `Stop all future occurrences of "${r.task.title}"? Reply YES ${n}.`,
      sourceInboundId: env.inboundId,
      sourceActionKey: env.actionKey,
    });
    return { text: conf.prompt, ok: true, awaiting: "confirmation" };
  }
  const res = await cancelTask(env.ctx, r.task.id);
  if (!res.ok) return fail(`Couldn't cancel ${r.task.title}.`);
  const series = r.task.series_id ? " This occurrence only; future ones continue." : "";
  return done(`Canceled: ${r.task.title}.${series} [${r.task.short_id}]`, [r.task.id]);
}

async function snoozeAction(env: ExecEnv, a: ActionOf<"snooze_reminder">): Promise<StepResult> {
  // With no task in context but an active wake-up call, "snooze" means the call.
  if (!a.task_ref) {
    const candidates = await recentTaskCandidates(env.ctx);
    const occ = await activeOccurrenceForSms(env.ctx);
    if (candidates.length === 0 && occ && ACTIVE_OCCURRENCE_STATUSES.includes(occ.status)) {
      return runAction(env, { type: "snooze_wake_alarm", minutes: a.minutes });
    }
  }
  const r = await resolveTaskRef(env, a, a.task_ref, "snooze");
  if (!r.ok) return r.step;
  let at: number;
  if (a.minutes) at = env.anchorMs + a.minutes * MINUTE;
  else if (a.until) {
    const t = await timeAt(env, a, "until", a.until, "reminder");
    if (!t.ok) return t.step;
    at = t.ms;
  } else {
    return ask(env, "time", `Snooze ${r.task.title} until when?`, { ...a, task_ref: r.task.short_id, until: blankTimeSpec() }, "until", [], "time");
  }
  const res = await rescheduleReminder(env.ctx, r.task.id, at, { reason: "snoozed" });
  if (!res.ok) return fail(`Couldn't snooze ${r.task.title}.`);
  await env.ctx.db.run("UPDATE clarifications SET status = 'answered', answered_at = ? WHERE status = 'pending' AND question_type IN ('followup','not_yet')", env.ctx.clock.now());
  await bumpPostpone(env.ctx, r.task.id, r.task.title, r.task.short_id);
  return done(`Snoozed: ${r.task.title} until ${when(at, env.tz)}. Earlier checks canceled. [${r.task.short_id}]`, [r.task.id]);
}

async function followupPolicyAction(env: ExecEnv, a: ActionOf<"set_followup_policy">): Promise<StepResult> {
  if (a.applies_to === "global_default") {
    await updateSettings(env.ctx.db, { followup_default_enabled: a.enabled ? 1 : 0 }, env.ctx.clock.now());
    return done(
      a.enabled
        ? `Default check-ins on: I'll ask about unfinished reminders about ${Math.round(env.s.followup_default_delay_minutes / 60)} hours later (max ${env.s.followup_max_per_occurrence} per task).`
        : "Default check-ins off. Explicit check-ins you ask for still happen.",
    );
  }
  const r = await resolveTaskRef(env, a, a.task_ref, a.enabled ? "check on" : "stop checking");
  if (!r.ok) return r.step;
  if (!a.enabled) {
    const res = await disableChecks(env.ctx, r.task.id);
    if (!res.ok) return fail("Couldn't change that task.");
    await env.ctx.db.run(
      "UPDATE clarifications SET status = 'answered', answered_at = ? WHERE status = 'pending' AND question_type IN ('followup','not_yet')",
      env.ctx.clock.now(),
    );
    return done(`OK, no more check-ins about ${r.task.title}. Other reminders are unchanged. [${r.task.short_id}]`, [r.task.id]);
  }
  if (!a.at) return ask(env, "time", `When should I check on ${r.task.title}?`, { ...a, task_ref: r.task.short_id, at: blankTimeSpec() }, "at", [], "time");
  const t = await timeAt(env, { ...a, task_ref: r.task.short_id }, "at", a.at, "followup");
  if (!t.ok) return t.step;
  const res = await addFollowup(env.ctx, r.task.id, t.ms, true);
  if (!res.ok) return fail("Couldn't schedule that check-in.");
  await env.ctx.db.run("UPDATE clarifications SET status = 'answered', answered_at = ? WHERE status = 'pending' AND question_type IN ('followup','not_yet')", env.ctx.clock.now());
  return done(`OK, I'll check on ${r.task.title} at ${when(t.ms, env.tz)}. [${r.task.short_id}]`, [r.task.id]);
}

// ---------- Calendar ----------

async function dayRange(env: ExecEnv, action: unknown, slot: string, spec: TimeSpec | null): Promise<{ start: number; end: number } | { step: StepResult }> {
  if (!spec) {
    const now = env.ctx.clock.now();
    return { start: now - DAY, end: now + 14 * DAY };
  }
  const r = resolveTimeSpec(spec, { anchorMs: env.anchorMs, tz: env.tz, purpose: "day" });
  if (!r.ok) {
    const q = r.question;
    return {
      step: await ask(
        env,
        "time",
        q.prompt,
        action,
        slot,
        q.options.map((o) => ({ label: o.label, keywords: o.keywords, value: o.patch })),
        q.freeform,
      ),
    };
  }
  return localDayBounds(r.localDate, env.tz);
}

async function createEventAction(env: ExecEnv, a: ActionOf<"create_calendar_event">): Promise<StepResult> {
  if (!(await connectedCalendar(env.ctx))) return fail(`${calendarUnavailableText("disconnected")} Nothing was added.`);
  const start = await timeAt(env, a, "start", a.start, "event_start");
  if (!start.ok) return start.step;
  let endMs: number;
  let defaultNote = "";
  if (a.end) {
    const e = await timeAt(env, a, "end", a.end, "event_end", { after: start.ms, baseDate: localDateOf(start.ms, env.tz) });
    if (!e.ok) return e.step;
    endMs = e.ms;
  } else if (a.duration_minutes) {
    endMs = start.ms + a.duration_minutes * MINUTE;
  } else {
    endMs = start.ms + env.s.default_event_minutes * MINUTE;
    defaultNote = ` (${env.s.default_event_minutes} min default)`;
  }
  let rrule: string | null = null;
  if (a.recurrence) {
    const rr = buildRRule(a.recurrence);
    if (!rr.ok) return fail(rr.reason);
    rrule = rr.rrule;
  }
  const title = cleanTitle(a.title);
  const resolved = { type: "calendar_create", actionKey: env.actionKey, title, startMs: start.ms, endMs, location: a.location, description: a.description, rrule, defaultNote };
  if (!a.allow_overlap) {
    const ov = await findOverlaps(env.ctx, start.ms, endMs);
    if (!ov.ok) return fail(`${calendarUnavailableText(ov.reason)} Nothing was added.`);
    if (ov.value.length > 0) {
      const o = ov.value[0]!;
      const conf = await createConfirmation(env.ctx, {
        action: { ...resolved, knownOverlaps: ov.value.map((x) => x.id) },
        targets: ov.value.map((x) => ({ kind: "event" as const, id: x.id, calendarId: x.calendarId, version: x.etag })),
        prompt: (n) =>
          `${title} ${formatRange(start.ms, endMs, env.tz)} overlaps ${sanitizeExternal(o.summary, 30)} (${formatRange(o.startMs!, o.endMs!, env.tz)}). Add anyway? Reply YES ${n}.`,
        sourceInboundId: env.inboundId,
        sourceActionKey: env.actionKey,
      });
      return { text: conf.prompt, ok: true, awaiting: "confirmation" };
    }
  }
  return executeCalendarCreate(env, resolved);
}

async function executeCalendarCreate(
  env: ExecEnv,
  r: { actionKey: string; title: string; startMs: number; endMs: number; location: string | null; description: string | null; rrule: string | null; defaultNote?: string },
): Promise<StepResult> {
  const res = await createEvent(env.ctx, {
    actionKey: r.actionKey,
    title: r.title,
    startMs: r.startMs,
    endMs: r.endMs,
    timeZone: env.tz,
    location: r.location,
    description: r.description,
    rrule: r.rrule,
  });
  const range = formatRange(r.startMs, r.endMs, env.tz);
  if (res.ok && res.dryRun) return done(`Dry run: would add ${r.title}: ${range}. Calendar writes are disabled.`);
  if (!res.ok) {
    if (res.reason === "disconnected" || res.reason === "unavailable") return fail(`${calendarUnavailableText(res.reason)} ${r.title} was not added.`);
    return fail(`Couldn't add ${r.title} (${res.reason}).`);
  }
  return done(`Added ${r.title}: ${range}${r.rrule ? `, repeating` : ""}${r.defaultNote ?? ""}.`);
}

async function resolveEvent(
  env: ExecEnv,
  a: InternalAction & { event_query: string | null; event_day: TimeSpec | null },
  verb: string,
): Promise<{ ok: true; event: CalendarEventData } | { ok: false; step: StepResult }> {
  if (!(await connectedCalendar(env.ctx))) return { ok: false, step: fail(calendarUnavailableText("disconnected")) };
  if (a._event) {
    try {
      const e = await env.ctx.calendar.getEvent(a._event.calendarId, a._event.eventId);
      if (!e || e.status === "cancelled") return { ok: false, step: fail("That event no longer exists.") };
      return { ok: true, event: e };
    } catch {
      return { ok: false, step: fail(calendarUnavailableText("unavailable")) };
    }
  }
  const range = await dayRange(env, a, "event_day", a.event_day);
  if ("step" in range) return { ok: false, step: range.step };
  const res = await findEvents(env.ctx, a.event_query, Math.max(range.start, env.ctx.clock.now() - DAY), range.end);
  if (!res.ok) return { ok: false, step: fail(calendarUnavailableText(res.reason)) };
  const candidates = res.value.slice(0, 4);
  if (candidates.length === 0)
    return { ok: false, step: fail(`I couldn't find ${a.event_query ? `"${a.event_query.slice(0, 40)}"` : "that event"}${a.event_day ? ` ${a.event_day.raw}` : ""}.`) };
  if (candidates.length === 1) return { ok: true, event: candidates[0]! };
  const list = candidates.map((e, i) => `${i + 1}) ${sanitizeExternal(e.summary, 25)} ${formatTime(e.startMs!, env.tz)}`).join(" ");
  return {
    ok: false,
    step: await ask(
      env,
      "which_event",
      `Which one to ${verb}: ${list}?`,
      a,
      null,
      candidates.map((e) => ({ label: sanitizeExternal(e.summary, 25), keywords: [], value: { calendarId: e.calendarId, eventId: e.id } })),
      null,
    ),
  };
}

async function updateEventAction(env: ExecEnv, a: ActionOf<"update_calendar_event"> & { _event?: { calendarId: string; eventId: string } }): Promise<StepResult> {
  if (a.scope === "this_and_future") return fail('Changing "this and future" occurrences isn\'t supported. I can change just this occurrence or the whole series.');
  const r = await resolveEvent(env, a, "move");
  if (!r.ok) return r.step;
  const ev = r.event;
  if (ev.startMs === null || ev.endMs === null) return fail("All-day events can't be moved by text yet.");
  if (ev.recurringEventId && a.scope === "series") {
    return fail("Moving a whole recurring series by text isn't supported yet; I can move this occurrence.");
  }
  if (!a.new_start)
    return ask(
      env,
      "time",
      `Move ${sanitizeExternal(ev.summary, 30)} to when?`,
      { ...a, _event: { calendarId: ev.calendarId, eventId: ev.id }, new_start: blankTimeSpec() },
      "new_start",
      [],
      "time",
    );
  const actionWithEvent = { ...a, _event: { calendarId: ev.calendarId, eventId: ev.id } };
  const ns = await timeAt(env, actionWithEvent, "new_start", a.new_start, "event_start", { baseDate: a.new_start.day_kind === "none" ? localDateOf(ev.startMs, env.tz) : null });
  if (!ns.ok) return ns.step;
  let newEnd = ns.ms + (ev.endMs - ev.startMs);
  if (a.new_end) {
    const ne = await timeAt(env, actionWithEvent, "new_end", a.new_end, "event_end", { after: ns.ms, baseDate: localDateOf(ns.ms, env.tz) });
    if (!ne.ok) return ne.step;
    newEnd = ne.ms;
  }
  const resolved = {
    type: "calendar_update",
    calendarId: ev.calendarId,
    eventId: ev.id,
    etag: ev.etag,
    summary: ev.summary,
    oldStartMs: ev.startMs,
    oldEndMs: ev.endMs,
    newStartMs: ns.ms,
    newEndMs: newEnd,
  };
  const ov = await findOverlaps(env.ctx, ns.ms, newEnd, ev.id);
  const overlapNote = ov.ok && ov.value.length ? ` It would overlap ${sanitizeExternal(ov.value[0]!.summary, 25)}.` : "";
  const guestsNote = ev.hasAttendees ? " Guests won't be emailed, but they'll see the new time." : "";
  const needsConfirm = !ev.createdByDella || overlapNote !== "" || ev.hasAttendees;
  if (needsConfirm) {
    const day = sameDay(ev.startMs, ns.ms, env.tz) ? ` ${formatDate(ns.ms, env.tz)}` : "";
    const conf = await createConfirmation(env.ctx, {
      action: resolved,
      targets: [{ kind: "event", id: ev.id, calendarId: ev.calendarId, version: ev.etag }],
      prompt: (n) =>
        `Move ${sanitizeExternal(ev.summary, 30)} from ${formatTime(ev.startMs!, env.tz)} to ${sameDay(ev.startMs!, ns.ms, env.tz) ? formatTime(ns.ms, env.tz) : when(ns.ms, env.tz)}${day}?${overlapNote}${guestsNote} Reply YES ${n}.`,
      sourceInboundId: env.inboundId,
      sourceActionKey: env.actionKey,
    });
    return { text: conf.prompt, ok: true, awaiting: "confirmation" };
  }
  return executeCalendarUpdate(env, resolved);
}

async function executeCalendarUpdate(
  env: ExecEnv,
  r: { calendarId: string; eventId: string; etag: string; summary: string; newStartMs: number; newEndMs: number },
): Promise<StepResult> {
  const res = await patchEventTimes(env.ctx, r.calendarId, r.eventId, r.etag, r.newStartMs, r.newEndMs, env.tz);
  if (res.ok && res.dryRun) return done(`Dry run: would move ${sanitizeExternal(r.summary, 30)} to ${formatRange(r.newStartMs, r.newEndMs, env.tz)}.`);
  if (!res.ok) {
    if (res.reason === "conflict") return fail(`${sanitizeExternal(r.summary, 30)} was changed elsewhere, so I didn't overwrite it. Ask again to see the current time.`);
    return fail(`Couldn't move ${sanitizeExternal(r.summary, 30)} (${res.reason}).`);
  }
  return done(`Moved ${sanitizeExternal(r.summary, 30)}: ${formatRange(r.newStartMs, r.newEndMs, env.tz)}.`);
}

async function cancelEventAction(env: ExecEnv, a: ActionOf<"cancel_calendar_event"> & { _event?: { calendarId: string; eventId: string } }): Promise<StepResult> {
  if (a.scope === "this_and_future") return fail('Canceling "this and future" occurrences isn\'t supported. I can cancel this occurrence or the whole series.');
  const r = await resolveEvent(env, a, "cancel");
  if (!r.ok) return r.step;
  const ev = r.event;
  let targetId = ev.id;
  let label = sanitizeExternal(ev.summary, 30);
  if (ev.recurringEventId && a.scope === "series") {
    targetId = ev.recurringEventId;
    label = `all occurrences of ${label}`;
  }
  let etag = ev.etag;
  if (targetId !== ev.id) {
    const series = await env.ctx.calendar.getEvent(ev.calendarId, targetId).catch(() => null);
    if (!series) return fail("Couldn't load that recurring series.");
    etag = series.etag;
  }
  const resolved = { type: "calendar_cancel", calendarId: ev.calendarId, eventId: targetId, etag, summary: ev.summary, startMs: ev.startMs, label };
  const needsConfirm = !ev.createdByDella || targetId !== ev.id || ev.hasAttendees;
  if (needsConfirm) {
    const whenText = ev.startMs ? ` (${when(ev.startMs, env.tz)})` : "";
    const guestsNote = ev.hasAttendees ? " Guests won't be emailed, but it will disappear from their view." : "";
    const conf = await createConfirmation(env.ctx, {
      action: resolved,
      targets: [{ kind: "event", id: targetId, calendarId: ev.calendarId, version: etag }],
      prompt: (n) => `Delete ${label}${targetId === ev.id ? whenText : ""}?${guestsNote} Reply YES ${n}.`,
      sourceInboundId: env.inboundId,
      sourceActionKey: env.actionKey,
    });
    return { text: conf.prompt, ok: true, awaiting: "confirmation" };
  }
  return executeCalendarCancel(env, resolved);
}

async function executeCalendarCancel(env: ExecEnv, r: { calendarId: string; eventId: string; etag: string; label: string }): Promise<StepResult> {
  const res = await deleteEventConditional(env.ctx, r.calendarId, r.eventId, r.etag);
  if (res.ok && res.dryRun) return done(`Dry run: would delete ${r.label}.`);
  if (!res.ok) {
    if (res.reason === "conflict") return fail(`${r.label} was changed elsewhere, so I didn't delete it. Ask again to confirm the current version.`);
    if (res.reason === "not_found") return done(`${r.label} was already deleted.`);
    return fail(`Couldn't delete ${r.label} (${res.reason}).`);
  }
  return done(`Deleted ${r.label}.`);
}

async function focusBlockAction(env: ExecEnv, a: ActionOf<"propose_focus_block">): Promise<StepResult> {
  if (!(await connectedCalendar(env.ctx))) return fail(calendarUnavailableText("disconnected"));
  const day = resolveTimeSpec({ ...a.day, hour: null, minute: null, meridiem: null }, { anchorMs: env.anchorMs, tz: env.tz, purpose: "day" });
  if (!day.ok) {
    const q = day.question;
    return ask(
      env,
      "time",
      q.prompt,
      a,
      "day",
      q.options.map((o) => ({ label: o.label, keywords: o.keywords, value: o.patch })),
      q.freeform,
    );
  }
  const win = partOfDayWindow(a.day.part_of_day, env.s);
  const slot = await findFreeSlot(env.ctx, day.localDate, win.start, win.end, a.duration_minutes, env.tz);
  if (!slot.ok) return fail(calendarUnavailableText(slot.reason));
  const dayText = formatDateString(day.localDate);
  if (!slot.value) return done(`No free ${a.duration_minutes}-minute slot ${dayText} ${win.label} (${formatMinuteOfDay(win.start)}–${formatMinuteOfDay(win.end)}).`);
  const title = cleanTitle(a.title);
  const resolved = {
    type: "calendar_create",
    actionKey: env.actionKey,
    title,
    startMs: slot.value.startMs,
    endMs: slot.value.endMs,
    location: null,
    description: null,
    rrule: null,
    knownOverlaps: [] as string[],
  };
  const conf = await createConfirmation(env.ctx, {
    action: resolved,
    targets: [],
    prompt: (n) => `Block ${formatRange(slot.value!.startMs, slot.value!.endMs, env.tz)} for ${title}? Reply YES ${n}.`,
    sourceInboundId: env.inboundId,
    sourceActionKey: env.actionKey,
  });
  return { text: conf.prompt, ok: true, awaiting: "confirmation" };
}

// ---------- Wake-up calls ----------

async function wakeAlarmAction(env: ExecEnv, a: ActionOf<"set_wake_alarm">): Promise<StepResult> {
  const backup = " Calls are best effort; keep your phone's alarm as a backup.";
  if (a.recurrence) {
    const rr = buildRRule(a.recurrence);
    if (!rr.ok) return fail(rr.reason);
    const tod = resolveRecurringTimeOfDay(a.time, describeRecurrence(a.recurrence));
    if (!tod.ok)
      return ask(
        env,
        "time",
        tod.question.prompt,
        a,
        "time",
        tod.question.options.map((o) => ({ label: o.label, keywords: o.keywords, value: o.patch })),
        tod.question.freeform,
      );
    const startDate = todayLocal(env.anchorMs, env.tz);
    const resolved = {
      type: "alarm_create",
      actionKey: env.actionKey,
      hour: tod.hour,
      minute: tod.minute,
      rrule: rr.rrule,
      startDate,
      retry: a.retry_if_missed === true,
      readAgenda: a.read_agenda === true,
      describe: describeRecurrence(a.recurrence),
    };
    const conf = await createConfirmation(env.ctx, {
      action: resolved,
      targets: [],
      prompt: (n) =>
        `Set ${resolved.describe} wake-up calls at ${formatMinuteOfDay(tod.hour * 60 + tod.minute)} ${zoneLabel(env.anchorMs, env.tz)}? Press 1 on the call to confirm you're up, 2 to snooze.${resolved.retry ? " One retry if missed." : ""} Reply YES ${n}.`,
      sourceInboundId: env.inboundId,
      sourceActionKey: env.actionKey,
    });
    return { text: conf.prompt, ok: true, awaiting: "confirmation" };
  }
  const t = await timeAt(env, a, "time", a.time, "alarm");
  if (!t.ok) return t.step;
  const p = localParts(t.ms, env.tz);
  const res = await createAlarm(env.ctx, {
    actionKey: env.actionKey,
    hour: p.hour,
    minute: p.minute,
    timezone: env.tz,
    rrule: null,
    startDate: null,
    oneTimeAt: t.ms,
    retryEnabled: a.retry_if_missed === true,
    readAgenda: a.read_agenda === true,
  });
  await recordCallConsent(env, "sms_request");
  const off = (await voiceReadiness(env.ctx)).ready ? "" : " Note: calls are currently off or not ready; see the admin dashboard.";
  return done(`Wake-up call set: ${when(t.ms, env.tz)}. Press 1 to confirm you're up, 2 to snooze.${off}${backup} [${res.alarm.short_id}]`);
}

async function recordCallConsent(env: ExecEnv, source: string): Promise<void> {
  if (env.s.call_consent_at) return;
  await updateSettings(env.ctx.db, { call_consent_at: env.ctx.clock.now(), call_consent_source: source }, env.ctx.clock.now());
  await audit(env.ctx, "sms", "consent.call", "settings", "1", source);
}

async function cancelWakeAction(env: ExecEnv, a: ActionOf<"cancel_wake_alarm">): Promise<StepResult> {
  const alarms = (await listAlarms(env.ctx)).filter((x) => x.enabled === 1);
  if (alarms.length === 0) return done("No wake-up calls are scheduled.");
  if (a.scope === "next") {
    const soonest = await env.ctx.db.first<{ alarm_id: string }>(
      "SELECT alarm_id FROM alarm_occurrences WHERE status IN ('scheduled','snoozed','retry_scheduled') ORDER BY target_at LIMIT 1",
    );
    const target = soonest ? alarms.find((x) => x.id === soonest.alarm_id) : alarms[0];
    if (!target) return done("No upcoming wake-up call.");
    if (!target.series_id) {
      await cancelAlarm(env.ctx, target.id);
      return done(`Canceled the wake-up call. [${target.short_id}]`);
    }
    const occ = await cancelNextOccurrence(env.ctx, target.id);
    return done(occ ? `Skipped the ${when(occ.target_at, env.tz)} wake-up call; the schedule continues. [${target.short_id}]` : "No upcoming occurrence to skip.");
  }
  if (alarms.length > 1) {
    const conf = await createConfirmation(env.ctx, {
      action: { type: "alarm_cancel_all", alarmIds: alarms.map((x) => x.id) },
      targets: alarms.map((x) => ({ kind: "alarm" as const, id: x.id, version: x.version })),
      prompt: (n) => `Cancel all ${alarms.length} wake-up call schedules? Reply YES ${n}.`,
      sourceInboundId: env.inboundId,
      sourceActionKey: env.actionKey,
    });
    return { text: conf.prompt, ok: true, awaiting: "confirmation" };
  }
  await cancelAlarm(env.ctx, alarms[0]!.id);
  return done(`Canceled wake-up calls. [${alarms[0]!.short_id}]`);
}

// ---------- Settings / status ----------

function settingsSummary(s: OwnerSettings): string {
  return `Settings: ${s.display_name}, ${s.timezone}. Quiet hours ${formatMinuteOfDay(s.quiet_start_minute)}–${formatMinuteOfDay(s.quiet_end_minute)}. Morning brief ${s.morning_brief_enabled ? `on at ${formatMinuteOfDay(s.morning_brief_minute)}` : "off"}. Default check-ins ${s.followup_default_enabled ? "on" : "off"}. Calendar heads-ups ${s.calendar_headsup_enabled ? `on (${s.calendar_headsup_lead_minutes} min)` : "off"}. SMS ${s.sms_enabled ? "on" : "off"}, calls ${s.calls_enabled ? "on" : "off"}.`;
}

async function statusAction(env: ExecEnv): Promise<StepResult> {
  const ctx = env.ctx;
  const now = ctx.clock.now();
  const open = (await ctx.db.first<{ n: number }>("SELECT COUNT(*) AS n FROM tasks WHERE status = 'open'"))?.n ?? 0;
  const next = await ctx.db.first<{ planned_at: number }>("SELECT planned_at FROM reminders WHERE status = 'scheduled' ORDER BY planned_at LIMIT 1");
  const nextCall = await ctx.db.first<{ target_at: number }>(
    "SELECT target_at FROM alarm_occurrences WHERE status IN ('scheduled','snoozed','retry_scheduled') ORDER BY target_at LIMIT 1",
  );
  const cal = await calendarReadiness(ctx);
  const sms = await smsReadiness(ctx, env.s);
  const paused =
    env.s.automation_paused_until && env.s.automation_paused_until > now
      ? ` Paused (${env.s.automation_pause_scope}) until ${env.s.automation_paused_until >= PAUSE_INDEFINITE ? "resumed" : when(env.s.automation_paused_until, env.tz)}.`
      : "";
  const conn = await getConnection(ctx.db);
  return done(
    `Status: ${open} open task${open === 1 ? "" : "s"}. Next reminder: ${next ? when(next.planned_at, env.tz) : "none"}. Next wake-up call: ${nextCall ? when(nextCall.target_at, env.tz) : "none"}. Calendar: ${conn.status}${cal.provider === "simulated" ? " (simulated)" : ""}. SMS: ${sms.mode}.${paused}`,
  );
}

async function updateSettingsAction(env: ExecEnv, a: ActionOf<"update_allowed_settings">): Promise<StepResult> {
  const patch: Record<string, string | number | null> = {};
  const changes: string[] = [];
  if (a.display_name) {
    patch.display_name = a.display_name.replace(/[^\p{L}\p{N} .'-]/gu, "").slice(0, 40);
    changes.push(`name ${patch.display_name}`);
  }
  if (a.quiet_start || a.quiet_end) {
    const qs = a.quiet_start ? parseHHMM(a.quiet_start) : env.s.quiet_start_minute;
    const qe = a.quiet_end ? parseHHMM(a.quiet_end) : env.s.quiet_end_minute;
    if (qs === null || qe === null) return fail("Quiet hours need times like 23:00 and 07:00.");
    patch.quiet_start_minute = qs;
    patch.quiet_end_minute = qe;
    changes.push(`quiet hours ${formatMinuteOfDay(qs)}–${formatMinuteOfDay(qe)}`);
  }
  if (a.morning_brief_enabled !== null) {
    patch.morning_brief_enabled = a.morning_brief_enabled ? 1 : 0;
    changes.push(`morning brief ${a.morning_brief_enabled ? "on" : "off"}`);
  }
  if (a.morning_brief_time) {
    const m = parseHHMM(a.morning_brief_time);
    if (m === null) return fail("Morning brief time should look like 08:00.");
    patch.morning_brief_minute = m;
    changes.push(`brief at ${formatMinuteOfDay(m)}`);
  }
  if (a.followup_default_enabled !== null) {
    patch.followup_default_enabled = a.followup_default_enabled ? 1 : 0;
    changes.push(`default check-ins ${a.followup_default_enabled ? "on" : "off"}`);
  }
  if (a.calendar_headsup_enabled !== null) {
    patch.calendar_headsup_enabled = a.calendar_headsup_enabled ? 1 : 0;
    changes.push(`calendar heads-ups ${a.calendar_headsup_enabled ? "on" : "off"}`);
  }
  if (a.calendar_headsup_lead_minutes !== null) {
    patch.calendar_headsup_lead_minutes = a.calendar_headsup_lead_minutes;
    changes.push(`heads-up lead ${a.calendar_headsup_lead_minutes} min`);
  }
  if (Object.keys(patch).length) await updateSettings(env.ctx.db, patch, env.ctx.clock.now());
  if (Object.keys(patch).length) await audit(env.ctx, "sms", "settings.update", "settings", "1", Object.keys(patch).join(","));
  if (a.timezone) {
    if (!isValidTimeZone(a.timezone)) return fail(`"${a.timezone.slice(0, 40)}" isn't a valid timezone name (e.g. America/New_York).`);
    if (a.timezone === env.s.timezone) return done(changes.length ? `Updated: ${changes.join(", ")}. Timezone unchanged.` : `Timezone is already ${a.timezone}.`);
    const recurring = (await env.ctx.db.first<{ n: number }>("SELECT COUNT(*) AS n FROM series WHERE status = 'active'"))?.n ?? 0;
    if (recurring === 0) return applyTimezone(env, a.timezone, true, changes);
    return ask(
      env,
      "timezone_follow",
      `Switching to ${a.timezone}. Should your ${recurring} recurring schedule${recurring === 1 ? "" : "s"} 1) follow the new timezone (same local times) or 2) keep ${env.s.timezone}? One-time reminders keep their exact times.`,
      a,
      null,
      [
        { label: "follow", keywords: ["follow", "new", "1"], value: "follow" },
        { label: "keep", keywords: ["keep", "original", "2"], value: "keep" },
      ],
      null,
      { timezone: a.timezone },
    );
  }
  if (changes.length === 0) return fail("Which setting should I change? (Quiet hours, morning brief, check-ins, heads-ups.)");
  return done(`Updated: ${changes.join(", ")}.`);
}

async function applyTimezone(env: ExecEnv, tz: string, follow: boolean, prior: string[] = []): Promise<StepResult> {
  const now = env.ctx.clock.now();
  await updateSettings(env.ctx.db, { timezone: tz }, now);
  if (follow) {
    // Recurring wall-time rules follow the new zone; only not-yet-materialized occurrences change.
    await env.ctx.db.run(
      "UPDATE series SET timezone = ?, next_occurrence_at = NULL, next_occurrence_key = NULL, updated_at = ? WHERE status = 'active' AND kind = 'task'",
      tz,
      now,
    );
    await env.ctx.db.run("UPDATE alarm_schedules SET timezone = ?, updated_at = ? WHERE enabled = 1", tz, now);
    await env.ctx.db.run(
      "UPDATE series SET timezone = ?, next_occurrence_at = NULL, next_occurrence_key = NULL, updated_at = ? WHERE status = 'active' AND kind = 'alarm'",
      tz,
      now,
    );
  }
  await audit(env.ctx, "sms", "settings.timezone", "settings", "1", `${tz} follow=${follow}`);
  const head = prior.length ? `Updated: ${prior.join(", ")}. ` : "";
  return done(`${head}Timezone set to ${tz}. Recurring schedules ${follow ? "now follow it" : "keep their original timezone"}; one-time reminders keep their exact times.`);
}

async function pauseAction(env: ExecEnv, a: ActionOf<"pause_automation">): Promise<StepResult> {
  let until = PAUSE_INDEFINITE;
  if (a.until) {
    if (a.until.hour === null && a.until.relative_minutes === null) {
      const r = resolveTimeSpec(a.until, { anchorMs: env.anchorMs, tz: env.tz, purpose: "until" });
      if (!r.ok) {
        const q = r.question;
        return ask(
          env,
          "time",
          q.prompt,
          a,
          "until",
          q.options.map((o) => ({ label: o.label, keywords: o.keywords, value: o.patch })),
          q.freeform,
        );
      }
      until = localDayBounds(r.localDate, env.tz).start;
    } else {
      const t = await timeAt(env, a, "until", a.until, "until");
      if (!t.ok) return t.step;
      until = t.ms;
    }
    if (until <= env.ctx.clock.now()) return fail("That time has already passed.");
  }
  await updateSettings(env.ctx.db, { automation_paused_until: until, automation_pause_scope: a.scope }, env.ctx.clock.now());
  await audit(env.ctx, "sms", "automation.pause", "settings", "1", a.scope);
  const untilText = until >= PAUSE_INDEFINITE ? "until you reply RESUME" : `until ${when(until, env.tz)}`;
  const scopeText = a.scope === "all" ? "All proactive messages and wake-up calls are paused" : "Reminders, check-ins, briefs, and heads-ups are paused (wake-up calls still ring)";
  return done(`${scopeText} ${untilText}. Replies to your texts still work.`);
}

// ---------- Confirmed actions ----------

/**
 * Executes the exact saved action behind a consumed confirmation, after rechecking target
 * versions. If a target changed, the proposal is refreshed instead of executed.
 */
export async function executeConfirmed(env: ExecEnv, conf: Confirmation): Promise<StepResult> {
  const a = conf.action as Record<string, unknown> & { type: string };
  switch (a.type) {
    case "calendar_update":
    case "calendar_cancel": {
      const target = conf.targets[0] as ConfirmationTarget;
      let current: CalendarEventData | null;
      try {
        current = await env.ctx.calendar.getEvent(target.calendarId!, target.id);
      } catch {
        return fail(calendarUnavailableText("unavailable"));
      }
      if (!current || current.status === "cancelled") return fail("That event no longer exists; nothing changed.");
      if (current.etag !== target.version) {
        return fail(
          `${sanitizeExternal(current.summary, 30)} changed since I asked (now ${current.startMs ? formatRange(current.startMs, current.endMs!, env.tz) : "all day"}). Nothing changed; ask again if you still want it.`,
        );
      }
      if (a.type === "calendar_update") return executeCalendarUpdate(env, a as unknown as Parameters<typeof executeCalendarUpdate>[1]);
      return executeCalendarCancel(env, a as unknown as Parameters<typeof executeCalendarCancel>[1]);
    }
    case "calendar_create": {
      const known = new Set((a.knownOverlaps as string[] | undefined) ?? []);
      const ov = await findOverlaps(env.ctx, a.startMs as number, a.endMs as number);
      if (!ov.ok) return fail(calendarUnavailableText(ov.reason));
      const fresh = ov.value.filter((e) => !known.has(e.id));
      if (fresh.length > 0) return fail(`Something new is now booked then (${sanitizeExternal(fresh[0]!.summary, 30)}). Nothing was added; ask again to pick another time.`);
      return executeCalendarCreate(env, a as unknown as Parameters<typeof executeCalendarCreate>[1]);
    }
    case "alarm_create": {
      const res = await createAlarm(env.ctx, {
        actionKey: a.actionKey as string,
        hour: a.hour as number,
        minute: a.minute as number,
        timezone: env.tz,
        rrule: a.rrule as string,
        startDate: a.startDate as string,
        oneTimeAt: null,
        retryEnabled: a.retry === true,
        readAgenda: a.readAgenda === true,
      });
      await recordCallConsent(env, "sms_confirmation");
      const nextAt = res.nextAt;
      const off = (await voiceReadiness(env.ctx)).ready ? "" : " Note: calls are currently off or not ready; see the admin dashboard.";
      return done(
        `Wake-up calls set: ${a.describe as string} at ${formatMinuteOfDay((a.hour as number) * 60 + (a.minute as number))}${nextAt ? `, first ${when(nextAt, env.tz)}` : ""}.${off} Keep your phone's alarm as a backup. [${res.alarm.short_id}]`,
      );
    }
    case "task_series_cancel": {
      const target = conf.targets[0]!;
      const t = await getTask(env.ctx, target.id);
      if (!t) return fail("That task no longer exists.");
      const n = await cancelSeries(env.ctx, a.seriesId as string);
      return done(`Stopped all future occurrences of ${a.title as string}${n ? ` (and canceled the open one)` : ""}.`);
    }
    case "routine_create":
      return executeRoutineConfirmed(env, a);
    case "alarm_cancel_all": {
      let n = 0;
      for (const id of a.alarmIds as string[]) if (await cancelAlarm(env.ctx, id)) n++;
      return done(`Canceled ${n} wake-up call schedule${n === 1 ? "" : "s"}.`);
    }
    default:
      return fail("That confirmation can't be executed.");
  }
}

export async function loadExecEnv(ctx: AppContext, anchorMs: number, inboundId: string | null, actionKey: string): Promise<ExecEnv> {
  const s = await getSettings(ctx.db);
  return { ctx, s, tz: s.timezone, anchorMs, inboundId, actionKey };
}
