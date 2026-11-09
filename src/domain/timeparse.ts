import { blankTimeSpec, type TimeSpec } from "./actions";
import type { Weekday } from "./time";

/**
 * Small deterministic phrase parser for short time expressions. It extracts *expressions*
 * (day words, clock times, durations) into a TimeSpec; it never resolves instants, which is
 * resolveTimeSpec's job. Used for clarification answers, explicit commands, and the simulated
 * planner. It intentionally does not try to be a general natural-language date parser.
 */

export interface ParsedTime {
  spec: TimeSpec;
  spans: Array<[number, number]>;
}

const WEEKDAY_WORDS: Array<[RegExp, Weekday]> = [
  [/^mon(day)?$/, "mon"],
  [/^tue(s|sday)?$/, "tue"],
  [/^wed(nesday)?$/, "wed"],
  [/^thu(r|rs|rsday)?$/, "thu"],
  [/^fri(day)?$/, "fri"],
  [/^sat(urday)?$/, "sat"],
  [/^sun(day)?$/, "sun"],
];

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

export function weekdayFromWord(word: string): Weekday | null {
  const w = word.toLowerCase();
  for (const [re, d] of WEEKDAY_WORDS) if (re.test(w)) return d;
  return null;
}

const RE_RELATIVE = /\bin\s+(\d+(?:\.\d+)?|an?|one|two|three|half\s+an?)\s*(minutes?|mins?|hours?|hrs?|h|days?|weeks?)\b/i;
const RE_DAY = /\b(today|tonight|tomorrow|tmrw|tmr)\b/i;
const RE_WEEKDAY = /\b(?:(this|next|on)\s+)?(monday|mon|tuesday|tues|tue|wednesday|wed|thursday|thurs|thur|thu|friday|fri|saturday|sat|sunday|sun)\b/i;
const RE_MONTH_DAY = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?\b/i;
const RE_ISO = /\b(\d{4})-(\d{2})-(\d{2})\b/;
const RE_NUMERIC_DATE = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/;
const RE_NOON = /\b(noon|midday|midnight)\b/i;
const RE_TIME_MERIDIEM = /\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)(?![a-z])/i;
const RE_TIME_AT = /\bat\s+(\d{1,2})(?::(\d{2}))?(?!\s*(?:minutes?|mins?|hours?|%|\d))\b/i;
const RE_TIME_24 = /\b([01]?\d|2[0-3]):([0-5]\d)\b/;
const RE_PART = /\b(morning|afternoon|evening|night)\b/i;

function numberWord(w: string): number {
  const t = w.toLowerCase().replace(/\s+/g, " ");
  if (t === "a" || t === "an" || t === "one") return 1;
  if (t === "two") return 2;
  if (t === "three") return 3;
  if (t.startsWith("half")) return 0.5;
  return Number(t);
}

export function parseTimePhrase(input: string, anchorYear: number): ParsedTime | null {
  const text = input;
  const spec = blankTimeSpec();
  const spans: Array<[number, number]> = [];
  let matched = false;
  const take = (m: RegExpExecArray) => {
    spans.push([m.index, m.index + m[0].length]);
    matched = true;
  };

  const rel = RE_RELATIVE.exec(text);
  if (rel) {
    const n = numberWord(rel[1]!);
    const unit = rel[2]!.toLowerCase();
    const factor = unit.startsWith("m") ? 1 : unit.startsWith("h") ? 60 : unit.startsWith("d") ? 1440 : 10080;
    const minutes = Math.round(n * factor);
    if (minutes >= 1) {
      spec.relative_minutes = minutes;
      take(rel);
    }
  }

  const day = RE_DAY.exec(text);
  if (day) {
    const w = day[1]!.toLowerCase();
    if (w === "today") spec.day_kind = "today";
    else if (w === "tonight") {
      spec.day_kind = "today";
      spec.part_of_day = "night";
    } else spec.day_kind = "tomorrow";
    take(day);
  }

  if (spec.day_kind === "none") {
    const iso = RE_ISO.exec(text);
    const md = RE_MONTH_DAY.exec(text);
    const nd = RE_NUMERIC_DATE.exec(text);
    if (iso) {
      spec.day_kind = "date";
      spec.date = `${iso[1]}-${iso[2]}-${iso[3]}`;
      take(iso);
    } else if (md) {
      const month = MONTHS.indexOf(md[1]!.toLowerCase().slice(0, 3)) + 1;
      const year = md[3] ? Number(md[3]) : anchorYear;
      spec.day_kind = "date";
      spec.date = `${year}-${String(month).padStart(2, "0")}-${String(Number(md[2])).padStart(2, "0")}`;
      take(md);
    } else if (nd && !/\d:\d/.test(nd[0])) {
      const yearRaw = nd[3] ? Number(nd[3]) : anchorYear;
      const year = yearRaw < 100 ? 2000 + yearRaw : yearRaw;
      spec.day_kind = "date";
      spec.date = `${year}-${String(Number(nd[1])).padStart(2, "0")}-${String(Number(nd[2])).padStart(2, "0")}`;
      take(nd);
    } else {
      const wd = RE_WEEKDAY.exec(text);
      if (wd) {
        const d = weekdayFromWord(wd[2]!);
        if (d) {
          spec.day_kind = "weekday";
          spec.weekday = d;
          const q = wd[1]?.toLowerCase();
          spec.weekday_qualifier = q === "this" ? "this" : q === "next" ? "next" : "bare";
          take(wd);
        }
      }
    }
  }

  const noon = RE_NOON.exec(text);
  const tm = RE_TIME_MERIDIEM.exec(text);
  const t24 = RE_TIME_24.exec(text);
  const tat = RE_TIME_AT.exec(text);
  if (noon) {
    const w = noon[1]!.toLowerCase();
    spec.hour = 12;
    spec.minute = 0;
    spec.meridiem = w === "midnight" ? "am" : "pm";
    take(noon);
  } else if (tm) {
    spec.hour = Number(tm[1]);
    spec.minute = tm[2] ? Number(tm[2]) : 0;
    spec.meridiem = tm[3]!.toLowerCase().startsWith("a") ? "am" : "pm";
    if (spec.hour > 12 || spec.hour === 0) spec.meridiem = "none";
    take(tm);
    const atBefore = /\bat\s+$/i.exec(text.slice(0, tm.index));
    if (atBefore) spans.push([atBefore.index, tm.index]);
  } else if (t24) {
    spec.hour = Number(t24[1]);
    spec.minute = Number(t24[2]);
    spec.meridiem = "none";
    take(t24);
    const atBefore = /\bat\s+$/i.exec(text.slice(0, t24.index));
    if (atBefore) spans.push([atBefore.index, t24.index]);
  } else if (tat) {
    const h = Number(tat[1]);
    if (h <= 23) {
      spec.hour = h;
      spec.minute = tat[2] ? Number(tat[2]) : 0;
      spec.meridiem = "none";
      take(tat);
    }
  }

  const part = RE_PART.exec(text);
  if (part && !spec.part_of_day) {
    spec.part_of_day = part[1]!.toLowerCase() as TimeSpec["part_of_day"];
    const prefix = /\b(?:in\s+the|this|tomorrow|at)\s+$/i.exec(text.slice(0, part.index));
    spans.push([prefix && !/tomorrow/i.test(prefix[0]) ? prefix.index : part.index, part.index + part[0].length]);
    matched = true;
  }

  if (!matched) return null;
  spans.sort((a, b) => a[0] - b[0]);
  const first = spans[0]![0];
  const last = Math.max(...spans.map((s) => s[1]));
  spec.raw = text.slice(first, last).trim().slice(0, 120);
  return { spec, spans };
}

/** Removes matched spans and connective filler from text (for title extraction). */
export function stripSpans(text: string, spans: Array<[number, number]>): string {
  let out = "";
  let cursor = 0;
  for (const [s, e] of [...spans].sort((a, b) => a[0] - b[0])) {
    if (s < cursor) {
      cursor = Math.max(cursor, e);
      continue;
    }
    out += text.slice(cursor, s) + " ";
    cursor = e;
  }
  out += text.slice(cursor);
  return out.replace(/\s+/g, " ").trim();
}
