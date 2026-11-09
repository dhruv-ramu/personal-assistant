import { Temporal } from "temporal-polyfill";

/**
 * Time utilities. Execution uses UTC epoch milliseconds; interpretation and display use IANA zones.
 *
 * DST policy (documented in docs/ARCHITECTURE.md and shown in settings):
 *  - New one-time actions at a nonexistent local time (spring-forward gap) or an ambiguous local
 *    time (fall-back fold) require a clarification.
 *  - Established recurring rules: a nonexistent time moves to the next valid local instant (the
 *    moment clocks jump forward, e.g. 3:00 AM); an ambiguous time uses the EARLIER occurrence only.
 */

export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

export class FixedClock implements Clock {
  constructor(private ms: number) {}
  now(): number {
    return this.ms;
  }
  set(ms: number): void {
    this.ms = ms;
  }
  advance(ms: number): void {
    this.ms += ms;
  }
}

/** Simulator clock: real time until frozen; freezing updates every holder of this instance at once. */
export class SimClock implements Clock {
  constructor(private frozenAt: number | null) {}
  now(): number {
    return this.frozenAt ?? Date.now();
  }
  set(ms: number | null): void {
    this.frozenAt = ms;
  }
  get frozen(): boolean {
    return this.frozenAt !== null;
  }
}

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export function weekdayIndex(day: Weekday): number {
  return WEEKDAYS.indexOf(day) + 1; // ISO: Monday = 1
}

export function zoned(ms: number, tz: string): Temporal.ZonedDateTime {
  return Temporal.Instant.fromEpochMilliseconds(ms).toZonedDateTimeISO(tz);
}

export interface LocalParts {
  date: string; // YYYY-MM-DD
  hour: number;
  minute: number;
  weekday: number; // 1 = Monday
  minuteOfDay: number;
  offset: string;
}

export function localParts(ms: number, tz: string): LocalParts {
  const z = zoned(ms, tz);
  return {
    date: z.toPlainDate().toString(),
    hour: z.hour,
    minute: z.minute,
    weekday: z.dayOfWeek,
    minuteOfDay: z.hour * 60 + z.minute,
    offset: z.offset,
  };
}

export function isValidDateString(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  try {
    return Temporal.PlainDate.from(date, { overflow: "reject" }).toString() === date;
  } catch {
    return false;
  }
}

export function addDays(date: string, days: number): string {
  return Temporal.PlainDate.from(date).add({ days }).toString();
}

export function weekdayOfDate(date: string): number {
  return Temporal.PlainDate.from(date).dayOfWeek;
}

export function compareDates(a: string, b: string): number {
  return Temporal.PlainDate.compare(Temporal.PlainDate.from(a), Temporal.PlainDate.from(b));
}

export type LocalResolution = { kind: "exact"; ms: number } | { kind: "gap"; nextValidMs: number; shiftedMs: number } | { kind: "fold"; earlierMs: number; laterMs: number };

/** Classifies a local wall time in a zone as existing exactly once, nonexistent (gap), or ambiguous (fold). */
export function resolveLocal(date: string, hour: number, minute: number, tz: string): LocalResolution {
  const pdt = Temporal.PlainDate.from(date).toPlainDateTime({ hour, minute });
  const earlier = pdt.toZonedDateTime(tz, { disambiguation: "earlier" });
  const later = pdt.toZonedDateTime(tz, { disambiguation: "later" });
  if (earlier.epochMilliseconds === later.epochMilliseconds) {
    return { kind: "exact", ms: earlier.epochMilliseconds };
  }
  const earlierMatches = Temporal.PlainDateTime.compare(earlier.toPlainDateTime(), pdt) === 0;
  const laterMatches = Temporal.PlainDateTime.compare(later.toPlainDateTime(), pdt) === 0;
  if (earlierMatches && laterMatches) {
    return { kind: "fold", earlierMs: earlier.epochMilliseconds, laterMs: later.epochMilliseconds };
  }
  // Gap: the transition instant is the first valid local time after the jump.
  const transition = earlier.getTimeZoneTransition("next");
  const nextValidMs = transition ? transition.epochMilliseconds : later.epochMilliseconds;
  return { kind: "gap", nextValidMs, shiftedMs: later.epochMilliseconds };
}

/** Policy for established recurring rules: gap -> next valid instant; fold -> earlier occurrence. */
export function resolveLocalForRecurrence(date: string, hour: number, minute: number, tz: string): number {
  const r = resolveLocal(date, hour, minute, tz);
  if (r.kind === "exact") return r.ms;
  if (r.kind === "gap") return r.nextValidMs;
  return r.earlierMs;
}

/** [start, end) instants for a local calendar date in a zone (handles 23/25-hour days). */
export function localDayBounds(date: string, tz: string): { start: number; end: number } {
  const d = Temporal.PlainDate.from(date);
  const start = d.toZonedDateTime({ timeZone: tz }).epochMilliseconds;
  const end = d.add({ days: 1 }).toZonedDateTime({ timeZone: tz }).epochMilliseconds;
  return { start, end };
}

export function todayLocal(nowMs: number, tz: string): string {
  return localParts(nowMs, tz).date;
}

/** Quiet hours may cross midnight (e.g. 23:00–07:00). */
export function isInQuietHours(ms: number, tz: string, startMinute: number, endMinute: number): boolean {
  if (startMinute === endMinute) return false;
  const m = localParts(ms, tz).minuteOfDay;
  return startMinute < endMinute ? m >= startMinute && m < endMinute : m >= startMinute || m < endMinute;
}

/** The instant quiet hours end, for an instant inside quiet hours. */
export function quietHoursEnd(ms: number, tz: string, startMinute: number, endMinute: number): number {
  const p = localParts(ms, tz);
  const endHour = Math.floor(endMinute / 60);
  const endMin = endMinute % 60;
  let date = p.date;
  if (startMinute > endMinute && p.minuteOfDay >= startMinute) date = addDays(date, 1);
  return resolveLocalForRecurrence(date, endHour, endMin, tz);
}

// ---------- Formatting ----------

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string, opts: Intl.DateTimeFormatOptions, key: string): Intl.DateTimeFormat {
  const k = `${tz}|${key}`;
  let f = fmtCache.get(k);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, ...opts });
    fmtCache.set(k, f);
  }
  return f;
}

function part(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string {
  return parts.find((p) => p.type === type)?.value ?? "";
}

/** Generic zone label such as "PT"; falls back to a numeric offset when no short generic name exists. */
export function zoneLabel(ms: number, tz: string): string {
  try {
    const name = part(fmt(tz, { timeZoneName: "shortGeneric" }, "zg").formatToParts(ms), "timeZoneName");
    if (name && !/^GMT/.test(name)) return name;
  } catch {
    // fall through to numeric offset
  }
  return `UTC${zoned(ms, tz).offset}`;
}

/** "7 PM" or "7:30 PM". */
export function formatTime(ms: number, tz: string): string {
  const parts = fmt(tz, { hour: "numeric", minute: "2-digit", hour12: true }, "t").formatToParts(ms);
  const hour = part(parts, "hour");
  const minute = part(parts, "minute");
  const ampm = part(parts, "dayPeriod").toUpperCase();
  return minute === "00" ? `${hour} ${ampm}` : `${hour}:${minute} ${ampm}`;
}

/** "Tue Nov 10". */
export function formatDate(ms: number, tz: string): string {
  const parts = fmt(tz, { weekday: "short", month: "short", day: "numeric" }, "d").formatToParts(ms);
  return `${part(parts, "weekday")} ${part(parts, "month")} ${part(parts, "day")}`;
}

export function formatDateString(date: string): string {
  const d = Temporal.PlainDate.from(date);
  const ms = d.toZonedDateTime({ timeZone: "UTC", plainTime: { hour: 12 } }).epochMilliseconds;
  return formatDate(ms, "UTC");
}

/** Whether the local wall time of this instant also occurs at another instant (fall-back fold). */
function isAmbiguousWallTime(ms: number, tz: string): boolean {
  const p = localParts(ms, tz);
  return resolveLocal(p.date, p.hour, p.minute, tz).kind === "fold";
}

function zoneSuffix(ms: number, tz: string): string {
  // During a fold the abbreviation alone is ambiguous, so use the numeric offset.
  if (isAmbiguousWallTime(ms, tz)) return `(UTC${zoned(ms, tz).offset})`;
  return zoneLabel(ms, tz);
}

/** "Tue Nov 10, 7 PM PT" */
export function formatDateTime(ms: number, tz: string): string {
  return `${formatDate(ms, tz)}, ${formatTime(ms, tz)} ${zoneSuffix(ms, tz)}`;
}

/** "Tue Nov 10, 7–9 PM PT" (same day/meridiem collapsed). */
export function formatRange(startMs: number, endMs: number, tz: string): string {
  const s = localParts(startMs, tz);
  const e = localParts(endMs, tz);
  const startTime = formatTime(startMs, tz);
  const endTime = formatTime(endMs, tz);
  if (s.date === e.date) {
    const sameMeridiem = startTime.slice(-2) === endTime.slice(-2);
    const startShort = sameMeridiem ? startTime.slice(0, -3) : startTime;
    return `${formatDate(startMs, tz)}, ${startShort}–${endTime} ${zoneSuffix(endMs, tz)}`;
  }
  return `${formatDateTime(startMs, tz)} – ${formatDateTime(endMs, tz)}`;
}

/** "today at 5 PM PT", "tomorrow at 5 PM PT", or the full date. */
export function formatRelativeDateTime(ms: number, nowMs: number, tz: string): string {
  const today = todayLocal(nowMs, tz);
  const target = localParts(ms, tz).date;
  const t = `${formatTime(ms, tz)} ${zoneSuffix(ms, tz)}`;
  if (target === today) return `today at ${t}`;
  if (target === addDays(today, 1)) return `tomorrow (${formatDate(ms, tz)}) at ${t}`;
  return `${formatDate(ms, tz)} at ${t}`;
}

export function minuteOfDayToHHMM(m: number): string {
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

export function parseHHMM(s: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

export function formatMinuteOfDay(m: number): string {
  const h = Math.floor(m / 60);
  const min = m % 60;
  const ampm = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return min === 0 ? `${h12} ${ampm}` : `${h12}:${String(min).padStart(2, "0")} ${ampm}`;
}
