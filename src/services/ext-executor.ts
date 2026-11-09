import { controlSession, createMorningRoutine, startCheckOnce, startTaskSession, submitTextEvidence } from "../accountability/sessions";
import type { ActionOf, TimeSpec } from "../domain/actions";
import { createConfirmation, matchOption, type PendingClarification } from "../domain/conversations";
import { describeRecurrence, type RecurrenceSpec } from "../domain/recurrence";
import { MINUTE, formatDateTime, formatMinuteOfDay, zoneLabel } from "../domain/time";
import { parseTimePhrase } from "../domain/timeparse";
import { resolveTimeSpec } from "../domain/timespec";
import { featureOn, getExtSettings, updateExtSettings, type Feature } from "../ext/settings";
import { freeTime, tripBrief } from "../knowledge/briefs";
import { answerWaitingCheck } from "../knowledge/checks";
import { forgetLastCapture, forgetText } from "../knowledge/forget";
import { ingestKnowledge, type IngestInput } from "../knowledge/ingest";
import { contextTasks, eveningReset, planDay } from "../knowledge/planning";
import { answerQuery, resumeProject } from "../knowledge/retrieval";
import { getItem, updateItem } from "../knowledge/secretary";
import { respondToSuggestion } from "../knowledge/suggestions";
import { activityHistory, undoLast } from "../knowledge/undo";
import { audit } from "./audit";
import { updateSettings } from "./settings";
import type { ExecEnv, StepResult } from "./executor";

export const EXT_ACTIONS = new Set([
  "memory_query",
  "memory_forget",
  "memory_correct",
  "capture_control",
  "resume_project",
  "plan_day",
  "context_tasks",
  "free_time",
  "trip_brief",
  "accountability_start",
  "accountability_control",
  "morning_routine",
  "activity_history",
  "undo",
  "suggestion_response",
  "enable_feature",
]);

export type ExtAction = ActionOf<
  | "memory_query"
  | "memory_forget"
  | "memory_correct"
  | "capture_control"
  | "resume_project"
  | "plan_day"
  | "context_tasks"
  | "free_time"
  | "trip_brief"
  | "accountability_start"
  | "accountability_control"
  | "morning_routine"
  | "activity_history"
  | "undo"
  | "suggestion_response"
  | "enable_feature"
>;

const done = (text: string): StepResult => ({ text, ok: true });
const fail = (text: string): StepResult => ({ text, ok: false });

const FEATURE_COLUMNS: Record<ActionOf<"enable_feature">["feature"], { column: string; feature: Feature; label: string }> = {
  memory: { column: "capture_enabled", feature: "capture", label: "Memory" },
  task_accountability: { column: "task_accountability_enabled", feature: "task_accountability", label: "Task accountability" },
  morning_routines: { column: "morning_routines_enabled", feature: "morning", label: "Morning routines" },
  suggestions: { column: "suggestions_enabled", feature: "suggestions", label: "Suggestions" },
  meeting_prep: { column: "meeting_prep_enabled", feature: "meeting_prep", label: "Meeting prep" },
  post_meeting: { column: "post_meeting_enabled", feature: "post_meeting", label: "Post-meeting check-ins" },
  evening_reset: { column: "evening_reset_enabled", feature: "evening_reset", label: "Evening reset" },
  photos_assessment: { column: "assessment_enabled", feature: "assessment", label: "Photo assessment" },
};

function resolveAt(env: ExecEnv, spec: TimeSpec | null, purpose: "event_start" | "event_end" | "reminder"): number | null {
  if (!spec) return null;
  const r = resolveTimeSpec(spec, { anchorMs: env.anchorMs, tz: env.tz, purpose });
  return r.ok ? r.ms : null;
}

export async function runExtensionAction(env: ExecEnv, a: ExtAction): Promise<StepResult> {
  const ctx = env.ctx;
  switch (a.type) {
    case "memory_query":
      return done((await answerQuery(ctx, a.query_kind, a.subject)).text);
    case "memory_forget": {
      if (a.scope === "last_message") {
        const r = await forgetLastCapture(ctx);
        const n = r.assertions + r.items;
        return done(
          n === 0 ? "Nothing saved from your last message, so nothing to forget." : `Forgot ${r.description} (${n} item${n === 1 ? "" : "s"}), including search entries.`,
        );
      }
      return done(await forgetText(ctx, a.target));
    }
    case "memory_correct":
      return done(
        `To correct "${a.target.slice(0, 60)}", just tell me the right version (e.g. "my passport is in the safe"); I'll keep the old report as history. Or say FORGET ${a.target.slice(0, 40)} to delete it.`,
      );
    case "capture_control": {
      const ext = await getExtSettings(ctx.db);
      const now = ctx.clock.now();
      if (a.mode === "status")
        return done(
          featureOn(ctx, ext, "capture")
            ? "Memory is on."
            : ext.capture_paused_until && ext.capture_paused_until > now
              ? `Memory is paused until ${formatDateTime(ext.capture_paused_until, env.tz)}.`
              : "Memory is off.",
        );
      if (a.mode === "enable" || a.mode === "resume") return enableFeature(env, "memory", true);
      const until = resolveAt(env, a.until, "reminder") ?? now + 24 * 60 * MINUTE;
      await updateExtSettings(ctx.db, { capture_paused_until: until }, now);
      await audit(ctx, "sms", "memory.paused", "ext_settings", "1");
      return done(`Memory paused until ${formatDateTime(until, env.tz)}. Reminders and tasks still work. Say RESUME MEMORY to turn it back on.`);
    }
    case "resume_project":
      return done(await resumeProject(ctx, a.project));
    case "plan_day": {
      if (a.mode === "evening_reset") return done(await eveningReset(ctx));
      return done((await planDay(ctx, a.mode)).text);
    }
    case "context_tasks":
      return done(await contextTasks(ctx, a.minutes, a.context));
    case "free_time":
      return done(await freeTime(ctx, a.minutes));
    case "trip_brief":
      return done(await tripBrief(ctx, a.destination));
    case "accountability_start": {
      if (a.within_minutes && !a.start) return done(await startCheckOnce(ctx, a.within_minutes, env.actionKey));
      const start = resolveAt(env, a.start, "event_start") ?? env.anchorMs;
      const end = resolveAt(env, a.end, "event_end") ?? start + 60 * MINUTE;
      if (end <= start) return fail("The session end must be after its start.");
      if (end - start > 8 * 60 * MINUTE) return fail("Sessions can be at most 8 hours.");
      return done(
        await startTaskSession(ctx, {
          taskRef: a.task_ref,
          start,
          end,
          checkpoints: a.checkpoints.map((c) => ({ at: c.at, offsetMinutes: c.offset_minutes, evidence: c.evidence, criterion: c.criterion })),
          allowCall: a.allow_call,
          actionKey: env.actionKey,
        }),
      );
    }
    case "accountability_control":
      return done(await controlSession(ctx, a.op, a.minutes));
    case "morning_routine": {
      if (!featureOn(ctx, await getExtSettings(ctx.db), "morning")) return done("Morning routines are off. Reply ENABLE MORNING ROUTINES to allow one.");
      const w = a.wake;
      if (w.hour === null) return fail('What time should the routine start? e.g. "morning routine at 7 AM on weekdays".');
      if (w.meridiem === "none" && w.hour <= 12) return fail(`Is that ${w.hour} AM or ${w.hour} PM? Send the routine again with AM or PM.`);
      let hour = w.hour;
      if (w.meridiem === "pm" && hour < 12) hour += 12;
      if (w.meridiem === "am" && hour === 12) hour = 0;
      const recurrence = a.recurrence ?? { freq: "weekdays" as const, weekdays: null, interval: null, count: null, until_date: null };
      const describe = describeRecurrence(recurrence);
      const activity = a.first_activity ?? "first activity";
      const conf = await createConfirmation(ctx, {
        action: { type: "routine_create", actionKey: env.actionKey, hour, minute: w.minute ?? 0, recurrence, firstActivity: a.first_activity, deviceCheck: a.device_check },
        targets: [],
        prompt: (n) =>
          `Set a ${describe} morning routine at ${formatMinuteOfDay(hour * 60 + (w.minute ?? 0))} ${zoneLabel(env.anchorMs, env.tz)}: wake call, ${a.device_check ? "laptop check-in" : "text check-in"} at +5 min, ${activity} at +15, one later check, then it stops. Max 2 calls per morning. Reply YES ${n}.`,
        sourceInboundId: env.inboundId,
        sourceActionKey: env.actionKey,
      });
      return { text: conf.prompt, ok: true, awaiting: "confirmation" };
    }
    case "activity_history":
      return done(await activityHistory(ctx, a.day));
    case "undo":
      return done(await undoLast(ctx));
    case "suggestion_response":
      return done(await respondToSuggestion(ctx, a.op, a.number));
    case "enable_feature":
      return enableFeature(env, a.feature, a.enabled);
  }
}

/** Confirmed routine creation (the YES reply): routines place calls, so they need explicit consent. */
export async function executeRoutineConfirmed(env: ExecEnv, a: Record<string, unknown>): Promise<StepResult> {
  const ctx = env.ctx;
  const text = await createMorningRoutine(ctx, {
    hour: a.hour as number,
    minute: a.minute as number,
    recurrence: a.recurrence as RecurrenceSpec,
    firstActivity: (a.firstActivity as string | null) ?? null,
    deviceCheck: a.deviceCheck === true,
    actionKey: a.actionKey as string,
  });
  if (!env.s.call_consent_at) {
    await updateSettings(ctx.db, { call_consent_at: ctx.clock.now(), call_consent_source: "sms_confirmation" }, ctx.clock.now());
    await audit(ctx, "sms", "consent.call", "settings", "1", "routine_confirmation");
  }
  return done(text);
}

async function enableFeature(env: ExecEnv, feature: ActionOf<"enable_feature">["feature"], enabled: boolean): Promise<StepResult> {
  const ctx = env.ctx;
  const f = FEATURE_COLUMNS[feature];
  const now = ctx.clock.now();
  const patch: Record<string, number | null> = { [f.column]: enabled ? 1 : 0 };
  if (feature === "memory") {
    patch.capture_paused_until = null;
    if (enabled) patch.capture_activated_at = now;
  }
  await updateExtSettings(ctx.db, patch, now);
  await audit(ctx, "sms", `feature.${enabled ? "enabled" : "disabled"}`, "ext_settings", feature);
  const ext = await getExtSettings(ctx.db);
  if (enabled && !featureOn(ctx, ext, f.feature)) return done(`${f.label} is turned on in your settings, but it's disabled for this deployment, so it stays off.`);
  if (!enabled) return done(`${f.label} off.`);
  const notes: Record<string, string> = {
    memory:
      "Memory on. I'll save things you tell me (where items are, promises, who you're waiting on). Say \"don't store this\" for any message, or FORGET THAT to delete the last one.",
    task_accountability: "Task accountability on. Sessions happen only when you ask, limited to the task and time you set. Check-ins are evidence you answered, not proof of work.",
    morning_routines: 'Morning routines on. Set one with e.g. "morning routine at 7 AM weekdays, gym first". Max 2 calls per morning.',
    photos_assessment:
      "Photo assessment on. Photos you send for checks are described by an AI vision model (it can read them; this isn't end-to-end encrypted). Photos are deleted within 24 hours.",
  };
  return done(notes[feature] ?? `${f.label} on.`);
}

function parseAnswerTime(env: ExecEnv, answer: string, anchorMs: number): number | null {
  const year = Number(new Date(anchorMs).getUTCFullYear());
  const p = parseTimePhrase(answer, year) ?? parseTimePhrase(`at ${answer}`, year);
  if (!p) return null;
  const r = resolveTimeSpec(p.spec, { anchorMs, tz: env.tz, purpose: "reminder" });
  return r.ok ? r.ms : null;
}

/** Resumes extension clarifications; returns null for types owned by the core executor. */
export async function resumeExtClarification(env: ExecEnv, clar: PendingClarification, answer: string): Promise<StepResult | null> {
  const ctx = env.ctx;
  const pending = clar.pending;
  const opt = matchOption(clar.options, answer);
  switch (clar.question_type) {
    case "which_entity": {
      if (!opt) return fail(`Please reply with the number or NEW. ${clar.prompt}`);
      const act = pending.action as { type: "_knowledge"; input: IngestInput; field: string };
      const input: IngestInput = {
        ...act.input,
        forcedEntities: { ...(act.input.forcedEntities ?? {}), [act.field]: String(opt.value) },
        originId: `${act.input.originId}:clar:${clar.id}`,
      };
      const r = await ingestKnowledge(ctx, input);
      return done([...r.lines, r.question?.text].filter(Boolean).join(" ") || "Saved.");
    }
    case "waiting_check": {
      const itemId = (pending.action as { itemId: string }).itemId;
      if (opt?.value === "yes") return done(await answerWaitingCheck(ctx, itemId, "yes"));
      if (opt?.value === "no") return done(await answerWaitingCheck(ctx, itemId, "no"));
      const at = parseAnswerTime(env, answer, env.anchorMs);
      if (at) return done(await answerWaitingCheck(ctx, itemId, at));
      return fail(`Reply YES, NO, or a time to check again. ${clar.prompt}`);
    }
    case "post_meeting": {
      const meta = pending.action as { title: string; startMs: number };
      if (opt?.value === "skip") return done("OK, nothing recorded.");
      if (opt?.value === "did_not_happen") return done(`Noted that ${meta.title} didn't happen. I won't ask about it again.`);
      const r = await ingestKnowledge(ctx, {
        candidates: [{ kind: "note", text: answer.slice(0, 500), project: null, evidence_span: answer.slice(0, 400) }],
        sourceText: answer,
        originId: `post_meeting:${clar.id}`,
        sourceKind: "meeting",
        anchorMs: env.anchorMs,
        model: "owner",
      });
      return done(r.status === "applied" ? `Saved your notes from ${meta.title}.` : r.lines.join(" ") || "Memory is off, so I didn't save those notes.");
    }
    case "acc_check": {
      const cpId = (pending.action as { checkpointId: string }).checkpointId;
      return done(await submitTextEvidence(ctx, cpId, answer));
    }
    case "time": {
      const act = pending.action as { type?: string; itemId?: string };
      if (act.type !== "_waiting_check" || !act.itemId) return null;
      const at = parseAnswerTime(env, answer, pending.anchorMs);
      const item = await getItem(ctx, act.itemId);
      if (!item) return done("That item no longer exists.");
      if (!at) return fail(`Please reply with a time, e.g. 3 PM. ${clar.prompt}`);
      await updateItem(ctx, item, { checkAt: at });
      return done(`OK, I'll check about ${item.title} at ${formatDateTime(at, env.tz)}.`);
    }
    default:
      return null;
  }
}
