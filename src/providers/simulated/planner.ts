import type { Db } from "../../db/db";
import { blankTimeSpec, type Action, type Interpretation, type TimeSpec } from "../../domain/actions";
import type { RecurrenceSpec } from "../../domain/recurrence";
import type { Weekday } from "../../domain/time";
import { parseTimePhrase, stripSpans, weekdayFromWord } from "../../domain/timeparse";
import type { Planner, PlannerContext, PlannerResult } from "../types";
import { nextSimOutcome } from "./common";
import { ruleExtAction, ruleKnowledge } from "./knowledge-rules";

/**
 * Deterministic, rule-based stand-in for the AI planner. It implements the same typed
 * interface and output schema so the demo and acceptance tests exercise the real pipeline.
 * It recognizes a bounded set of phrasings; it does NOT demonstrate real language-model quality.
 */
export class RulePlanner implements Planner {
  readonly name = "simulated";
  readonly live = false;
  constructor(private readonly db?: Db) {}

  async interpret(ctx: PlannerContext): Promise<PlannerResult> {
    const usage = { inputTokens: 0, outputTokens: 0 };
    if (this.db) {
      const outcome = await nextSimOutcome(this.db, "ai");
      if (outcome === "unavailable") return { kind: "unavailable", detail: "Simulated AI outage", usage, model: "rule-planner" };
      if (outcome === "timeout") return { kind: "timeout", detail: "Simulated AI timeout", usage, model: "rule-planner" };
      if (outcome === "refusal") return { kind: "refused", detail: "Simulated refusal", usage, model: "rule-planner" };
      if (outcome === "invalid") return { kind: "invalid", detail: "Simulated schema-invalid output", usage, model: "rule-planner" };
      if (outcome === "incomplete") return { kind: "incomplete", detail: "Simulated truncated output", usage, model: "rule-planner" };
      if (outcome === "rate_limited") return { kind: "rate_limited", detail: "Simulated 429", usage, model: "rule-planner" };
    }
    const year = Number(/^(\d{4})/.exec(ctx.localNow)?.[1] ?? new Date().getUTCFullYear());
    return { kind: "ok", interpretation: ruleInterpret(ctx.messageText, year), usage, model: "rule-planner" };
  }
}

function cleanTitle(s: string): string {
  return s
    .replace(/^[\s,;:-]+|[\s,;:.!-]+$/g, "")
    .replace(/^(to|that i need to|that i have to|about|for|i need to|i have to)\s+/i, "")
    .replace(/\s+(on|for|at|by)$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function capitalize(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}

const RE_RECUR =
  /\b(?:on\s+)?(?:every\s+(weekday|weekdays|day|morning|evening|night|other day|week)|(weekdays)|(daily)|every\s+((?:mon|tue|tues|wed|thu|thurs|fri|sat|sun)[a-z]*(?:\s*(?:,|and|&)\s*(?:mon|tue|tues|wed|thu|thurs|fri|sat|sun)[a-z]*)*)|(?:weekly\s+on|on)\s+((?:mon|tue|tues|wed|thu|thurs|fri|sat|sun)[a-z]*s(?:\s*(?:,|and|&)\s*(?:mon|tue|tues|wed|thu|thurs|fri|sat|sun)[a-z]*s)*))\b/i;

function parseRecurrence(text: string, year: number): { spec: RecurrenceSpec; span: [number, number]; extraSpans: Array<[number, number]> } | null {
  const m = RE_RECUR.exec(text);
  if (!m) return null;
  let spec: RecurrenceSpec = { freq: "daily", weekdays: null, interval: null, count: null, until_date: null };
  const word = (m[1] ?? m[2] ?? m[3] ?? "").toLowerCase();
  if (word === "weekday" || word === "weekdays") spec = { ...spec, freq: "weekdays" };
  else if (word === "other day") spec = { ...spec, freq: "interval_days", interval: 2 };
  else if (word === "week") spec = { ...spec, freq: "weekly", weekdays: null };
  else if (word) spec = { ...spec, freq: "daily" };
  const daysText = m[4] ?? m[5];
  if (daysText) {
    const days = daysText
      .split(/\s*(?:,|and|&)\s*/i)
      .map((d) => weekdayFromWord(d.replace(/s$/i, "")))
      .filter((d): d is Weekday => d !== null);
    spec = { ...spec, freq: "weekly", weekdays: days };
  }
  const extraSpans: Array<[number, number]> = [];
  const until = /\buntil\s+([a-z]+\s+\d{1,2}(?:,?\s*\d{4})?|\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2})/i.exec(text);
  if (until) {
    const p = parseTimePhrase(until[1]!, year);
    if (p?.spec.date) {
      spec.until_date = p.spec.date;
      extraSpans.push([until.index, until.index + until[0].length]);
    }
  }
  const count = /\bfor\s+(\d+)\s+(times|weeks|days|occurrences)\b/i.exec(text);
  if (count) {
    spec.count = Number(count[1]);
    extraSpans.push([count.index, count.index + count[0].length]);
  }
  if (spec.freq === "weekly" && (!spec.weekdays || spec.weekdays.length === 0)) spec.weekdays = null;
  return { spec, span: [m.index, m.index + m[0].length], extraSpans };
}

function timeOf(text: string, year: number): { spec: TimeSpec; rest: string } {
  const p = parseTimePhrase(text, year);
  if (!p) return { spec: blankTimeSpec(), rest: text };
  return { spec: p.spec, rest: stripSpans(text, p.spans) };
}

function interp(intent: string, actions: Action[], times: string[] = []): Interpretation {
  return { intent, time_expressions: times.filter(Boolean), references: [], missing_fields: [], actions, knowledge: [] };
}

function parseReminder(clause: string, year: number): Action {
  let body = clause.replace(/^(?:please\s+)?(?:can you\s+)?remind me\s*/i, "");
  let followup: TimeSpec | null = null;
  const fu = /,?\s*(?:and\s+)?(?:then\s+)?(?:ask|check(?:\s+in)?|follow up)(?:\s+with)?(?:\s+me)?\s+(.*?)\s+(?:if|whether)\b.*$/i.exec(body);
  if (fu) {
    const p = parseTimePhrase(fu[1]!, year);
    if (p) followup = p.spec;
    body = body.slice(0, fu.index);
  }
  const rec = parseRecurrence(body, year);
  let recurrence: RecurrenceSpec | null = null;
  if (rec) {
    recurrence = rec.spec;
    body = stripSpans(body, [rec.span, ...rec.extraSpans]);
  }
  const { spec, rest } = timeOf(body, year);
  const title = capitalize(cleanTitle(rest)) || "Reminder";
  return { type: "create_reminder", title: title.slice(0, 200), at: spec, followup_at: followup, recurrence };
}

const RE_RANGE_FROM = /\bfrom\s+(\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)?|noon)\s*(?:to|until|till|-|–)\s*(\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)?|noon|midnight)/i;
const RE_RANGE_DASH = /\b(\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)?)\s*[-–]\s*(\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)?)/i;

function parseEvent(clause: string, year: number): Action {
  let body = clause.replace(/^(?:please\s+)?(?:add|schedule|put|book|create)\s+(?:an?\s+)?(?:event\s+)?/i, "");
  body = body.replace(/\b(?:on|to)\s+(?:my\s+)?calendar\b/i, " ");
  let start: TimeSpec | null = null;
  let end: TimeSpec | null = null;
  const range = RE_RANGE_FROM.exec(body) ?? RE_RANGE_DASH.exec(body);
  if (range) {
    const s = parseTimePhrase(`at ${range[1]}`, year)?.spec ?? null;
    const e = parseTimePhrase(`at ${range[2]}`, year)?.spec ?? null;
    if (s && e) {
      if ((s.meridiem === "none" || s.meridiem === null) && (e.meridiem === "am" || e.meridiem === "pm") && s.hour !== null && e.hour !== null && s.hour <= 12) {
        // "12 to 1 PM" → noon; "11 to 1 PM" → 11 AM: the start takes whichever meridiem puts it before the end.
        const to24 = (h: number, m: "am" | "pm") => (m === "am" ? h % 12 : (h % 12) + 12);
        const end24 = to24(e.hour, e.meridiem) * 60 + (e.minute ?? 0);
        const other = e.meridiem === "am" ? "pm" : "am";
        if (to24(s.hour, e.meridiem) * 60 + (s.minute ?? 0) < end24) s.meridiem = e.meridiem;
        else if (to24(s.hour, other) * 60 + (s.minute ?? 0) < end24) s.meridiem = other;
      }
      start = s;
      end = e;
    }
    body = body.slice(0, range.index) + " " + body.slice(range.index + range[0].length);
  }
  let duration: number | null = null;
  const dur = /\bfor\s+(\d+(?:\.\d+)?)\s*(minutes?|mins?|hours?|hrs?)\b/i.exec(body);
  if (dur) {
    duration = Math.round(Number(dur[1]) * (dur[2]!.toLowerCase().startsWith("h") ? 60 : 1));
    body = body.slice(0, dur.index) + " " + body.slice(dur.index + dur[0].length);
  }
  const rec = parseRecurrence(body, year);
  let recurrence: RecurrenceSpec | null = null;
  if (rec) {
    recurrence = rec.spec;
    body = stripSpans(body, [rec.span, ...rec.extraSpans]);
  }
  const t = timeOf(body, year);
  if (start) {
    start = {
      ...start,
      day_kind: t.spec.day_kind,
      weekday: t.spec.weekday,
      weekday_qualifier: t.spec.weekday_qualifier,
      date: t.spec.date,
      raw: `${t.spec.raw} ${start.raw}`.trim(),
    };
  } else {
    start = t.spec;
  }
  const title = capitalize(cleanTitle(t.rest.replace(/\b(on|at)\s*$/i, ""))) || "Event";
  return { type: "create_calendar_event", title, start, end, duration_minutes: duration, location: null, description: null, recurrence, allow_overlap: false };
}

function parseMove(clause: string, year: number): Action {
  const body = clause.replace(/^(?:please\s+)?(?:move|reschedule|push|shift)\s+/i, "");
  const idx = body.search(/\s+to\s+(?=(?:\d|noon|midnight|tomorrow|today|next|this|mon|tue|wed|thu|fri|sat|sun))/i);
  const target = idx >= 0 ? body.slice(idx).replace(/^\s+to\s+/i, "") : "";
  const subject = idx >= 0 ? body.slice(0, idx) : body;
  const tgt = parseTimePhrase(target, year);
  const subj = timeOf(subject, year);
  const query = cleanTitle(subj.rest.replace(/^(my|the)\s+/i, ""));
  return {
    type: "update_calendar_event",
    event_query: query || null,
    event_day: subj.spec.day_kind !== "none" ? subj.spec : null,
    new_start: tgt?.spec ?? null,
    new_end: null,
    new_title: null,
    scope: /\b(all|every|series|whole)\b/i.test(clause) ? "series" : /\bthis and (all )?future\b/i.test(clause) ? "this_and_future" : "instance",
  };
}

function parseCancel(clause: string, year: number): Action {
  const body = clause.replace(/^(?:please\s+)?(?:cancel|delete|remove|drop)\s+/i, "");
  if (/\b(wake|alarm|wake-up|wakeup)\b/i.test(body)) return { type: "cancel_wake_alarm", scope: /\b(all|every|recurring|weekday)\b/i.test(body) ? "all" : "next" };
  const isEvent = /\b(appointment|meeting|event|calendar|lunch|dinner|call with|class|session|game|practice)\b/i.test(body);
  const t = timeOf(body, year);
  const query = cleanTitle(t.rest.replace(/^(my|the)\s+/i, ""));
  if (isEvent) {
    return {
      type: "cancel_calendar_event",
      event_query: query || null,
      event_day: t.spec.day_kind !== "none" ? t.spec : null,
      scope: /\b(all|every|series|whole)\b/i.test(clause) ? "series" : /\bthis and (all )?future\b/i.test(clause) ? "this_and_future" : "instance",
    };
  }
  return {
    type: "cancel_task",
    task_ref: query.replace(/\b(reminder|task)\b/gi, "").trim() || null,
    scope: /\b(series|all future|every)\b/i.test(clause) ? "series" : "occurrence",
  };
}

function parseWake(clause: string, year: number): Action {
  let body = clause.replace(/^(?:please\s+)?(?:call me|wake me(?: up)?|set (?:a |an )?(?:wake[- ]?up call|alarm))\s*/i, "");
  const rec = parseRecurrence(body, year);
  let recurrence: RecurrenceSpec | null = null;
  if (rec) {
    recurrence = rec.spec;
    body = stripSpans(body, [rec.span, ...rec.extraSpans]);
  }
  const { spec } = timeOf(body, year);
  return {
    type: "set_wake_alarm",
    time: spec,
    recurrence,
    read_agenda: /\b(agenda|read (me )?my (day|calendar))\b/i.test(clause) ? true : null,
    retry_if_missed: /\b(retry|call again|try again)\b/i.test(clause) ? true : null,
  };
}

function parseFocus(clause: string, year: number): Action {
  const dur = /(\d+(?:\.\d+)?)\s*(minutes?|mins?|hours?|hrs?)/i.exec(clause);
  const minutes = dur ? Math.round(Number(dur[1]) * (dur[2]!.toLowerCase().startsWith("h") ? 60 : 1)) : 60;
  const forMatch = /\bfor\s+(?!\d)(.+?)(?=\s+(?:tomorrow|today|tonight|on|this|next|mon|tue|wed|thu|fri|sat|sun|in the)\b|$)/i.exec(clause);
  const { spec } = timeOf(clause.replace(dur?.[0] ?? "", " "), year);
  return {
    type: "propose_focus_block",
    title: capitalize(cleanTitle(forMatch?.[1] ?? "Focus time")) || "Focus time",
    duration_minutes: Math.max(15, Math.min(480, minutes)),
    day: spec,
  };
}

function hhmm(spec: TimeSpec | undefined): string | null {
  if (!spec || spec.hour === null) return null;
  let h = spec.hour;
  if (spec.meridiem === "pm" && h < 12) h += 12;
  if (spec.meridiem === "am" && h === 12) h = 0;
  return `${String(h).padStart(2, "0")}:${String(spec.minute ?? 0).padStart(2, "0")}`;
}

export function ruleInterpret(text: string, year: number): Interpretation {
  const whole = ruleExtAction(text.trim(), year);
  if (whole) return interp(whole.type, [whole]);
  const clauses = text
    .split(/(?<=[.!?])\s+(?=[A-Z])/)
    .flatMap((sentence) => sentence.split(/\s*(?:;|\band also\b|\balso\b|,?\s+and\s+(?=(?:remind|add|schedule|call me|wake me|block|move|cancel)\b))\s*/i))
    .map((c) => c.trim())
    .filter(Boolean)
    .slice(0, 5);
  const actions: Action[] = [];
  const times: string[] = [];
  for (const clause of clauses) {
    const a = interpretClause(clause, year);
    actions.push(a);
    for (const v of Object.values(a)) if (v && typeof v === "object" && "raw" in (v as object)) times.push((v as TimeSpec).raw);
  }
  const knowledge = ruleKnowledge(text, year);
  const actionable = actions.filter((a) => a.type !== "unsupported");
  // A pure statement ("I put my passport in the desk") is memory, not an unsupported request.
  // Sentences that were memory statements are not failed requests.
  const finalActions: Action[] = knowledge.length
    ? actionable.length
      ? actionable
      : [{ type: "general_reply", text: "Noted." }]
    : actions.length
      ? actions
      : [{ type: "unsupported", reason: "Could not interpret the message." }];
  return { ...interp(finalActions.map((a) => a.type).join("+"), finalActions, times), knowledge };
}

function interpretClause(clause: string, year: number): Action {
  const c = clause.trim();
  const l = c.toLowerCase();
  const ext = ruleExtAction(c, year);
  if (ext) return ext;
  if (/\b(invite|attendees?|guests?)\b/.test(l))
    return { type: "unsupported", reason: "Calendar invitations aren't supported yet; I can add the event to your calendar without guests." };
  if (/\b(text|message|sms|call)\s+(?!me\b)(\+?\d|[a-z]+\s+(?:at|on)\s+\+?\d|my (mom|dad|wife|husband|friend|boss))/i.test(c))
    return { type: "unsupported", reason: "I can only message or call you." };
  if (/\b(change|update|set)\s+(?:my\s+)?(phone|number|owner)/i.test(c)) return { type: "unsupported", reason: "The owner phone number can only be changed by the administrator." };
  if (/\b(export|password|secret|api key|token)\b/i.test(c)) return { type: "unsupported", reason: "That can only be done from the admin dashboard." };
  if (/^(?:please\s+)?(?:can you\s+)?remind me\b/i.test(c)) return parseReminder(c, year);
  if (/^(?:please\s+)?(?:call me|wake me|set (?:a |an )?(?:wake[- ]?up call|alarm))\b/i.test(c)) return parseWake(c, year);
  if (/^(?:please\s+)?block\b/i.test(c)) return parseFocus(c, year);
  if (/^(?:please\s+)?(?:move|reschedule|push|shift)\b/i.test(c)) return parseMove(c, year);
  if (/^(?:please\s+)?(?:cancel|delete|remove|drop)\b/i.test(c)) return parseCancel(c, year);
  if (/^(?:please\s+)?add\s+(?:a\s+)?task\b|\bto my (?:list|to-?do)\b/i.test(c)) {
    const body = c.replace(/^(?:please\s+)?add\s+(?:a\s+)?task:?\s*/i, "").replace(/\bto my (?:list|to-?do(?: list)?)\b/i, "");
    const { spec, rest } = timeOf(body, year);
    return {
      type: "create_task",
      title: capitalize(cleanTitle(rest)) || "Task",
      notes: null,
      due: spec.day_kind !== "none" || spec.hour !== null ? spec : null,
      reminders: [],
      followups: [],
      recurrence: null,
      priority: null,
    };
  }
  if (/^(?:please\s+)?(?:add|schedule|put|book|create)\b/i.test(c)) return parseEvent(c, year);
  if (/\b(what'?s|what is)\s+next\b|\bnext (event|meeting|appointment)\b/i.test(c)) return { type: "get_agenda", day: "next_event", other_day: null };
  if (/\b(calendar|agenda|schedule)\b|\bwhat do i have\b/i.test(c) && !/\bscheduled\b/i.test(c)) {
    if (/\btomorrow\b/i.test(c)) return { type: "get_agenda", day: "tomorrow", other_day: null };
    const p = parseTimePhrase(c, year);
    if (p && (p.spec.day_kind === "weekday" || p.spec.day_kind === "date")) return { type: "get_agenda", day: "other", other_day: p.spec };
    return { type: "get_agenda", day: "today", other_day: null };
  }
  if (/\boverdue\b/i.test(c)) return { type: "list_tasks", filter: "overdue" };
  if (/\bdue today\b|\bwhat'?s due\b/i.test(c)) return { type: "list_tasks", filter: "today" };
  if (/\bwhat (?:have you|did you) scheduled?\b|\bscheduled\b/i.test(c)) return { type: "list_tasks", filter: "scheduled" };
  if (/\b(my tasks|to-?do|what do i (?:need|have) to do)\b/i.test(c)) return { type: "list_tasks", filter: "open" };
  if (/^(?:please\s+)?pause\b/i.test(c)) {
    const scope = /\b(everything|all|calls)\b/i.test(c) ? "all" : "reminders";
    const until = /\buntil\s+(.+)$/i.exec(c);
    const p = until ? parseTimePhrase(until[1]!, year) : null;
    return { type: "pause_automation", scope, until: p?.spec ?? null };
  }
  if (/^(?:please\s+)?(?:resume|unpause)\b/i.test(c)) return { type: "resume_automation" };
  if (/\bquiet hours\b/i.test(c)) {
    const range = /from\s+(.+?)\s+(?:to|until|-)\s+(.+)$/i.exec(c);
    const s = range ? parseTimePhrase(`at ${range[1]}`, year)?.spec : undefined;
    const e = range ? parseTimePhrase(`at ${range[2]}`, year)?.spec : undefined;
    return {
      type: "update_allowed_settings",
      display_name: null,
      timezone: null,
      quiet_start: hhmm(s),
      quiet_end: hhmm(e),
      morning_brief_enabled: null,
      morning_brief_time: null,
      followup_default_enabled: null,
      calendar_headsup_enabled: null,
      calendar_headsup_lead_minutes: null,
    };
  }
  if (/\bmorning brief\b/i.test(c)) {
    const on = !/\b(off|disable|stop|no)\b/i.test(c);
    const at = parseTimePhrase(c, year)?.spec;
    return {
      type: "update_allowed_settings",
      display_name: null,
      timezone: null,
      quiet_start: null,
      quiet_end: null,
      morning_brief_enabled: on,
      morning_brief_time: hhmm(at),
      followup_default_enabled: null,
      calendar_headsup_enabled: null,
      calendar_headsup_lead_minutes: null,
    };
  }
  if (/\b(heads[- ]?ups?)\b/i.test(c)) {
    const on = !/\b(off|disable|stop|no)\b/i.test(c);
    const lead = /(\d+)\s*min/i.exec(c);
    return {
      type: "update_allowed_settings",
      display_name: null,
      timezone: null,
      quiet_start: null,
      quiet_end: null,
      morning_brief_enabled: null,
      morning_brief_time: null,
      followup_default_enabled: null,
      calendar_headsup_enabled: on,
      calendar_headsup_lead_minutes: lead ? Number(lead[1]) : null,
    };
  }
  const tzm = /\b(?:time ?zone|i'?m (?:now )?in)\b.*?\b([A-Z][a-z]+\/[A-Za-z_]+)\b/.exec(c);
  if (tzm) {
    return {
      type: "update_allowed_settings",
      display_name: null,
      timezone: tzm[1]!,
      quiet_start: null,
      quiet_end: null,
      morning_brief_enabled: null,
      morning_brief_time: null,
      followup_default_enabled: null,
      calendar_headsup_enabled: null,
      calendar_headsup_lead_minutes: null,
    };
  }
  if (/^(?:please\s+)?snooze\b/i.test(c)) {
    const n = /(\d+)\s*(minutes?|mins?|hours?|hrs?|h)\b/i.exec(c);
    const minutes = n ? Number(n[1]) * (n[2]!.toLowerCase().startsWith("h") ? 60 : 1) : /\bhour\b/i.test(c) ? 60 : null;
    return { type: "snooze_reminder", task_ref: null, minutes, until: minutes ? null : (parseTimePhrase(c, year)?.spec ?? null) };
  }
  if (/\b(don'?t|do not) (ask|check)( me)? again\b|\bstop (asking|checking)\b/i.test(c))
    return { type: "set_followup_policy", task_ref: null, applies_to: "task", enabled: false, at: null };
  if (/^(hi|hello|hey|thanks|thank you|good morning|good night)\b/i.test(c))
    return { type: "general_reply", text: "Hi. Text me a task, reminder, calendar request, or wake-up call." };
  if (/\bsettings\b/i.test(c)) return { type: "get_settings" };
  return { type: "unsupported", reason: "Simulated planner could not interpret this." };
}
