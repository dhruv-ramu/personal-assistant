import type { TimeSpec } from "./actions";
import {
  MINUTE,
  addDays,
  compareDates,
  formatDate,
  formatDateString,
  formatMinuteOfDay,
  formatTime,
  isValidDateString,
  localParts,
  resolveLocal,
  todayLocal,
  weekdayIndex,
  weekdayOfDate,
  zoned,
} from "./time";

/**
 * Deterministic resolution of model- or parser-produced time expressions. The model never
 * computes instants; this module does, anchored to the inbound message's receipt time.
 */

export type TimePurpose = "reminder" | "followup" | "due" | "event_start" | "event_end" | "alarm" | "until" | "day";

export interface ClarifyOption {
  label: string;
  keywords: string[];
  patch: Partial<TimeSpec>;
}

export interface TimeQuestion {
  kind: "ampm" | "noon_midnight" | "need_time" | "weekday" | "past" | "dst_gap" | "dst_fold" | "invalid" | "order";
  prompt: string;
  options: ClarifyOption[];
  freeform: "time" | null;
}

export type TimeResolution = { ok: true; ms: number; localDate: string; hour: number; minute: number; notes: string[] } | { ok: false; question: TimeQuestion };

export interface TimeContext {
  anchorMs: number;
  tz: string;
  purpose: TimePurpose;
  /** Resolved instant this time must follow (reminder → follow-up, start → end). */
  after?: number | null;
  /** Date inherited when the spec names no date (end time on the start's day). */
  baseDate?: string | null;
}

type TimeOfDay = { hour: number; minute: number };
type TimeOfDayResult = { kind: "ok"; tod: TimeOfDay } | { kind: "candidates"; candidates: Array<TimeOfDay & { label: string; patch: Partial<TimeSpec> }> } | { kind: "missing" };

function to24(hour: number, meridiem: "am" | "pm"): number {
  if (hour >= 13) return hour;
  if (meridiem === "am") return hour === 12 ? 0 : hour;
  return hour === 12 ? 12 : hour + 12;
}

export function resolveTimeOfDay(spec: TimeSpec): TimeOfDayResult {
  if (spec.hour === null) return { kind: "missing" };
  const minute = spec.minute ?? 0;
  const h = spec.hour;
  if (spec.meridiem === "am" || spec.meridiem === "pm") return { kind: "ok", tod: { hour: to24(h, spec.meridiem), minute } };
  if (h === 0 || h >= 13) return { kind: "ok", tod: { hour: h, minute } };
  const pod = spec.part_of_day;
  if (h === 12) {
    if (pod === "night") return { kind: "ok", tod: { hour: 0, minute } };
    if (pod === "afternoon" || pod === "morning") return { kind: "ok", tod: { hour: 12, minute } };
    return {
      kind: "candidates",
      candidates: [
        { hour: 12, minute, label: minute ? `12:${String(minute).padStart(2, "0")} PM` : "noon", patch: { meridiem: "pm" } },
        { hour: 0, minute, label: minute ? `12:${String(minute).padStart(2, "0")} AM` : "midnight", patch: { meridiem: "am" } },
      ],
    };
  }
  if (pod === "morning") return { kind: "ok", tod: { hour: h, minute } };
  if (pod === "afternoon" || pod === "evening") return { kind: "ok", tod: { hour: h + 12, minute } };
  if (pod === "night") return { kind: "ok", tod: { hour: h >= 6 ? h + 12 : h, minute } };
  const label = (hh: number) => formatMinuteOfDay(hh * 60 + minute);
  return {
    kind: "candidates",
    candidates: [
      { hour: h, minute, label: label(h), patch: { meridiem: "am" } },
      { hour: h + 12, minute, label: label(h + 12), patch: { meridiem: "pm" } },
    ],
  };
}

function dayLabel(date: string, anchorMs: number, tz: string): string {
  const today = todayLocal(anchorMs, tz);
  if (date === today) return "Today";
  if (date === addDays(today, 1)) return "Tomorrow";
  return formatDateString(date);
}

type DateResult = { kind: "ok"; date: string; implicit: boolean } | { kind: "question"; question: TimeQuestion } | { kind: "none" };

function resolveDate(spec: TimeSpec, ctx: TimeContext): DateResult {
  const today = todayLocal(ctx.anchorMs, ctx.tz);
  switch (spec.day_kind) {
    case "today":
      return { kind: "ok", date: today, implicit: false };
    case "tomorrow":
      return { kind: "ok", date: addDays(today, 1), implicit: false };
    case "date": {
      if (!spec.date || !isValidDateString(spec.date)) {
        return { kind: "question", question: { kind: "invalid", prompt: "Which date did you mean?", options: [], freeform: "time" } };
      }
      return { kind: "ok", date: spec.date, implicit: false };
    }
    case "weekday": {
      if (!spec.weekday) return { kind: "none" };
      const target = weekdayIndex(spec.weekday);
      const current = weekdayOfDate(today);
      const delta = (target - current + 7) % 7;
      const qualifier = spec.weekday_qualifier ?? "bare";
      if (qualifier === "this" || (qualifier === "bare" && delta > 0)) {
        return { kind: "ok", date: addDays(today, delta), implicit: false };
      }
      // "next Friday" (and a bare weekday naming today) have two plausible readings: ask.
      const first = addDays(today, delta === 0 ? (qualifier === "next" ? 7 : 0) : delta);
      const second = addDays(first, 7);
      const name = formatDateString(first).slice(0, 3);
      const options: ClarifyOption[] = [
        { label: formatDateString(first), keywords: ["1", "first", "this", formatDateString(first).toLowerCase()], patch: { day_kind: "date", date: first } },
        { label: formatDateString(second), keywords: ["2", "second", "next", "following", formatDateString(second).toLowerCase()], patch: { day_kind: "date", date: second } },
      ];
      return {
        kind: "question",
        question: { kind: "weekday", prompt: `Which ${name}: 1) ${options[0]!.label} or 2) ${options[1]!.label}?`, options, freeform: null },
      };
    }
    case "none":
    default:
      if (ctx.baseDate) return { kind: "ok", date: ctx.baseDate, implicit: true };
      if (ctx.after) return { kind: "ok", date: localParts(ctx.after, ctx.tz).date, implicit: true };
      return { kind: "ok", date: today, implicit: true };
  }
}

const NEEDS_TIME: ReadonlySet<TimePurpose> = new Set(["reminder", "followup", "event_start", "alarm", "due", "event_end"]);

export function resolveTimeSpec(spec: TimeSpec, ctx: TimeContext): TimeResolution {
  const notes: string[] = [];
  if (spec.relative_minutes !== null) {
    const ms = ctx.anchorMs + spec.relative_minutes * MINUTE;
    const p = localParts(ms, ctx.tz);
    return { ok: true, ms, localDate: p.date, hour: p.hour, minute: p.minute, notes };
  }

  const dr = resolveDate(spec, ctx);
  if (dr.kind === "question") return { ok: false, question: dr.question };
  const date = dr.kind === "ok" ? dr.date : todayLocal(ctx.anchorMs, ctx.tz);
  const implicitDate = dr.kind === "ok" ? dr.implicit : true;
  const label = dayLabel(date, ctx.anchorMs, ctx.tz);

  const todr = resolveTimeOfDay(spec);
  let tod: TimeOfDay;
  if (todr.kind === "missing") {
    if (!NEEDS_TIME.has(ctx.purpose)) {
      const p = localParts(ctx.anchorMs, ctx.tz);
      return { ok: true, ms: ctx.anchorMs, localDate: date, hour: p.hour, minute: p.minute, notes };
    }
    const pod = spec.part_of_day ? ` ${spec.part_of_day}` : "";
    const when = implicitDate && spec.day_kind === "none" && !spec.part_of_day ? "" : ` ${label.toLowerCase()}${pod}`;
    return { ok: false, question: { kind: "need_time", prompt: `What time${when}?`, options: [], freeform: "time" } };
  } else if (todr.kind === "candidates") {
    let chosen: (typeof todr.candidates)[number] | null = null;
    if (ctx.after) {
      const viable = todr.candidates.filter((c) => {
        const r = resolveLocal(date, c.hour, c.minute, ctx.tz);
        const ms = r.kind === "exact" ? r.ms : r.kind === "gap" ? r.nextValidMs : r.earlierMs;
        return ms > ctx.after! && ms - ctx.after! < 24 * 60 * MINUTE;
      });
      if (viable.length === 1) {
        chosen = viable[0]!;
        notes.push(`Interpreted ${spec.raw || "the time"} as ${chosen.label}.`);
      }
    }
    if (!chosen) {
      const [a, b] = todr.candidates as [(typeof todr.candidates)[number], (typeof todr.candidates)[number]];
      const isNoon = a.label === "noon" || b.label === "midnight";
      const prompt = isNoon ? `${label} at noon or midnight?` : `${label} at ${a.label} or ${b.label}?`;
      return {
        ok: false,
        question: {
          kind: isNoon ? "noon_midnight" : "ampm",
          prompt,
          options: [
            {
              label: a.label,
              keywords: ["1", a.label.toLowerCase(), a.patch.meridiem ?? "", a.patch.meridiem === "am" ? "morning" : "afternoon", isNoon ? "noon" : ""].filter(Boolean),
              patch: a.patch,
            },
            {
              label: b.label,
              keywords: ["2", b.label.toLowerCase(), b.patch.meridiem ?? "", b.patch.meridiem === "pm" ? "evening" : "night", isNoon ? "midnight" : ""].filter(Boolean),
              patch: b.patch,
            },
          ],
          freeform: null,
        },
      };
    }
    tod = { hour: chosen.hour, minute: chosen.minute };
  } else {
    tod = todr.tod;
  }

  const lr = resolveLocal(date, tod.hour, tod.minute, ctx.tz);
  let ms: number;
  if (lr.kind === "exact") {
    ms = lr.ms;
  } else if (lr.kind === "gap") {
    if (!spec.gap_ok) {
      const next = formatTime(lr.nextValidMs, ctx.tz);
      return {
        ok: false,
        question: {
          kind: "dst_gap",
          prompt: `${formatMinuteOfDay(tod.hour * 60 + tod.minute)} doesn't exist on ${formatDateString(date)} (clocks spring forward). Use ${next} instead? Reply YES or give another time.`,
          options: [{ label: next, keywords: ["yes", "y", "1", "ok", next.toLowerCase()], patch: { gap_ok: true } }],
          freeform: "time",
        },
      };
    }
    ms = lr.nextValidMs;
    notes.push(`Moved to ${formatTime(ms, ctx.tz)} because of the DST change.`);
  } else {
    if (!spec.fold) {
      const t = formatMinuteOfDay(tod.hour * 60 + tod.minute);
      const o1 = zoned(lr.earlierMs, ctx.tz).offset;
      const o2 = zoned(lr.laterMs, ctx.tz).offset;
      return {
        ok: false,
        question: {
          kind: "dst_fold",
          prompt: `${t} happens twice on ${formatDateString(date)}. 1) first (UTC${o1}) or 2) second (UTC${o2})?`,
          options: [
            { label: `first (UTC${o1})`, keywords: ["1", "first", "earlier"], patch: { fold: "earlier" } },
            { label: `second (UTC${o2})`, keywords: ["2", "second", "later"], patch: { fold: "later" } },
          ],
          freeform: null,
        },
      };
    }
    ms = spec.fold === "later" ? lr.laterMs : lr.earlierMs;
  }

  if (ctx.after && ms <= ctx.after) {
    if (ctx.purpose === "event_end" && implicitDate) {
      // "11 PM to 1 AM": an end time earlier than the start on the same date means the next day.
      const next = addDays(date, 1);
      const r2 = resolveLocal(next, tod.hour, tod.minute, ctx.tz);
      ms = r2.kind === "exact" ? r2.ms : r2.kind === "gap" ? r2.nextValidMs : r2.earlierMs;
    } else {
      return {
        ok: false,
        question: {
          kind: "order",
          prompt: ctx.purpose === "followup" ? "The check-in time is before the reminder. When should I check?" : "The end is before the start. What end time?",
          options: [],
          freeform: "time",
        },
      };
    }
  }

  const pastCheck = ctx.purpose !== "event_end" && ctx.purpose !== "day" && ctx.purpose !== "until";
  if (pastCheck && ms < ctx.anchorMs - MINUTE && !spec.past_ok) {
    const when = `${formatMinuteOfDay(tod.hour * 60 + tod.minute)}${date === todayLocal(ctx.anchorMs, ctx.tz) ? " today" : ` on ${formatDateString(date)}`}`;
    if (spec.day_kind === "none" || spec.day_kind === "today") {
      return {
        ok: false,
        question: {
          kind: "past",
          prompt: `${when} has passed. Tomorrow at ${formatMinuteOfDay(tod.hour * 60 + tod.minute)} instead? Reply YES or give another time.`,
          options: [{ label: "tomorrow", keywords: ["yes", "y", "ok", "1", "tomorrow"], patch: { day_kind: "tomorrow", date: null } }],
          freeform: "time",
        },
      };
    }
    if (spec.day_kind === "date" && spec.date && compareDates(spec.date, todayLocal(ctx.anchorMs, ctx.tz)) < 0) {
      const nextYear = `${Number(spec.date.slice(0, 4)) + 1}${spec.date.slice(4)}`;
      if (isValidDateString(nextYear)) {
        return {
          ok: false,
          question: {
            kind: "past",
            prompt: `${when} is in the past. Did you mean ${formatDateString(nextYear)}, ${nextYear.slice(0, 4)}? Reply YES or give another date.`,
            options: [{ label: formatDateString(nextYear), keywords: ["yes", "y", "1", "ok"], patch: { date: nextYear } }],
            freeform: "time",
          },
        };
      }
    }
    return { ok: false, question: { kind: "past", prompt: `${when} is in the past. When should it be?`, options: [], freeform: "time" } };
  }

  const p = localParts(ms, ctx.tz);
  return { ok: true, ms, localDate: p.date, hour: p.hour, minute: p.minute, notes };
}

/** Wall-clock time (for recurring rules) without date resolution. */
export function resolveRecurringTimeOfDay(spec: TimeSpec, dayWord: string): { ok: true; hour: number; minute: number } | { ok: false; question: TimeQuestion } {
  const r = resolveTimeOfDay(spec);
  if (r.kind === "ok") return { ok: true, ...r.tod };
  if (r.kind === "missing") return { ok: false, question: { kind: "need_time", prompt: `What time ${dayWord}?`, options: [], freeform: "time" } };
  const [a, b] = r.candidates as [(typeof r.candidates)[number], (typeof r.candidates)[number]];
  return {
    ok: false,
    question: {
      kind: "ampm",
      prompt: `${dayWord[0]!.toUpperCase()}${dayWord.slice(1)} at ${a.label} or ${b.label}?`,
      options: [
        { label: a.label, keywords: ["1", a.label.toLowerCase(), "am", "morning"], patch: a.patch },
        { label: b.label, keywords: ["2", b.label.toLowerCase(), "pm", "evening"], patch: b.patch },
      ],
      freeform: null,
    },
  };
}

export function describeDay(ms: number, tz: string): string {
  return formatDate(ms, tz);
}
