import { RRule, type Options as RRuleOptions } from "rrule";
import { z } from "zod";
import { WEEKDAYS, isValidDateString, localParts, resolveLocalForRecurrence, type Weekday } from "./time";

/**
 * Recurrence uses the vetted `rrule` library in *floating* wall-clock mode: occurrences are
 * generated as local dates/times (no zone), then converted to instants with the zone's DST policy
 * (resolveLocalForRecurrence). A daily 8 AM rule therefore stays 8 AM local across DST, rather
 * than drifting as a fixed 24-hour UTC interval would.
 *
 * Supported subset: daily, weekdays (Mon–Fri), weekly on selected weekdays, every N days/weeks,
 * optional COUNT or UNTIL (local date, inclusive). Anything else is reported as unsupported.
 */

export const RecurrenceSpecSchema = z.object({
  freq: z.enum(["daily", "weekdays", "weekly", "interval_days"]),
  weekdays: z.array(z.enum(WEEKDAYS)).max(7).nullable(),
  interval: z.number().int().min(1).max(30).nullable(),
  count: z.number().int().min(1).max(500).nullable(),
  until_date: z.string().nullable(),
});
export type RecurrenceSpec = z.infer<typeof RecurrenceSpecSchema>;

const RRULE_DAYS: Record<Weekday, string> = { mon: "MO", tue: "TU", wed: "WE", thu: "TH", fri: "FR", sat: "SA", sun: "SU" };

export type RecurrenceValidation = { ok: true; rrule: string } | { ok: false; reason: string };

export function buildRRule(spec: RecurrenceSpec): RecurrenceValidation {
  const parts: string[] = [];
  const interval = spec.interval ?? 1;
  switch (spec.freq) {
    case "daily":
      parts.push("FREQ=DAILY");
      if (interval > 1) parts.push(`INTERVAL=${interval}`);
      break;
    case "interval_days":
      parts.push("FREQ=DAILY", `INTERVAL=${interval}`);
      break;
    case "weekdays":
      parts.push("FREQ=WEEKLY", "BYDAY=MO,TU,WE,TH,FR");
      break;
    case "weekly": {
      if (!spec.weekdays || spec.weekdays.length === 0) return { ok: false, reason: "Weekly recurrence needs at least one weekday." };
      const days = [...new Set(spec.weekdays)].sort((a, b) => WEEKDAYS.indexOf(a) - WEEKDAYS.indexOf(b));
      parts.push("FREQ=WEEKLY", `BYDAY=${days.map((d) => RRULE_DAYS[d]).join(",")}`);
      if (interval > 1) parts.push(`INTERVAL=${interval}`);
      break;
    }
  }
  if (spec.count !== null && spec.until_date !== null) return { ok: false, reason: "Use either an end date or a count, not both." };
  if (spec.count !== null) parts.push(`COUNT=${spec.count}`);
  if (spec.until_date !== null) {
    if (!isValidDateString(spec.until_date)) return { ok: false, reason: "The end date is not a valid date." };
    parts.push(`UNTIL=${spec.until_date.replace(/-/g, "")}T235959Z`);
  }
  return { ok: true, rrule: parts.join(";") };
}

function floatingDate(date: string, hour: number, minute: number): Date {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d, hour, minute, 0));
}

function floatingToLocal(f: Date): { date: string; hour: number; minute: number } {
  const date = `${f.getUTCFullYear()}-${String(f.getUTCMonth() + 1).padStart(2, "0")}-${String(f.getUTCDate()).padStart(2, "0")}`;
  return { date, hour: f.getUTCHours(), minute: f.getUTCMinutes() };
}

export interface SeriesRule {
  rrule: string;
  dtstartLocal: string; // "YYYY-MM-DDTHH:MM"
  timezone: string;
}

function ruleFor(series: SeriesRule): RRule {
  const [date, time] = series.dtstartLocal.split("T") as [string, string];
  const [h, m] = time.split(":").map(Number) as [number, number];
  const opts: Partial<RRuleOptions> = RRule.parseString(series.rrule);
  return new RRule({ ...opts, dtstart: floatingDate(date, h, m), tzid: null });
}

export interface Occurrence {
  key: string; // local "YYYY-MM-DDTHH:MM"; stable occurrence identity
  localDate: string;
  hour: number;
  minute: number;
  ms: number; // instant after DST policy
}

function toOccurrence(f: Date, tz: string): Occurrence {
  const l = floatingToLocal(f);
  const key = `${l.date}T${String(l.hour).padStart(2, "0")}:${String(l.minute).padStart(2, "0")}`;
  return { key, localDate: l.date, hour: l.hour, minute: l.minute, ms: resolveLocalForRecurrence(l.date, l.hour, l.minute, tz) };
}

/** First occurrence strictly after `afterMs` (by intended series schedule), or null when the rule ended. */
export function nextOccurrenceAfter(series: SeriesRule, afterMs: number): Occurrence | null {
  const rule = ruleFor(series);
  const p = localParts(afterMs, series.timezone);
  let cursor = floatingDate(p.date, p.hour, p.minute);
  for (let i = 0; i < 4; i++) {
    const f = rule.after(cursor, false);
    if (!f) return null;
    const occ = toOccurrence(f, series.timezone);
    if (occ.ms > afterMs) return occ;
    cursor = f;
  }
  return null;
}

/** First occurrence at or after the series start. */
export function firstOccurrence(series: SeriesRule): Occurrence | null {
  const rule = ruleFor(series);
  const [date, time] = series.dtstartLocal.split("T") as [string, string];
  const [h, m] = time.split(":").map(Number) as [number, number];
  const f = rule.after(floatingDate(date, h, m), true);
  return f ? toOccurrence(f, series.timezone) : null;
}

/** Bounded count of occurrences in (fromMs, toMs]; used to summarize, never to materialize a backlog. */
export function countOccurrencesBetween(series: SeriesRule, fromMs: number, toMs: number, cap = 100): number {
  let n = 0;
  let cursor = fromMs;
  while (n < cap) {
    const occ = nextOccurrenceAfter(series, cursor);
    if (!occ || occ.ms > toMs) break;
    n++;
    cursor = occ.ms;
  }
  return n;
}

export function describeRecurrence(spec: RecurrenceSpec): string {
  const interval = spec.interval ?? 1;
  let base: string;
  switch (spec.freq) {
    case "daily":
      base = interval > 1 ? `every ${interval} days` : "daily";
      break;
    case "interval_days":
      base = `every ${interval} days`;
      break;
    case "weekdays":
      base = "weekdays";
      break;
    case "weekly": {
      const names = (spec.weekdays ?? []).map((d) => d[0]!.toUpperCase() + d.slice(1));
      base = `${interval > 1 ? `every ${interval} weeks on` : "every"} ${names.join(", ")}`;
      break;
    }
  }
  if (spec.count !== null) base += `, ${spec.count} times`;
  if (spec.until_date !== null) base += `, until ${spec.until_date}`;
  return base;
}
