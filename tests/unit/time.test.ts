import { describe, expect, it } from "vitest";
import { blankTimeSpec, type TimeSpec } from "../../src/domain/actions";
import { HOUR, formatDateTime, formatRange, isInQuietHours, localDayBounds, localParts, quietHoursEnd, resolveLocal, todayLocal } from "../../src/domain/time";
import { resolveTimeSpec } from "../../src/domain/timespec";
import { parseTimePhrase } from "../../src/domain/timeparse";

const LA = "America/Los_Angeles";
const T0 = Date.parse("2026-11-08T18:00:00Z"); // Sun Nov 8 2026, 10:00 PST

function spec(p: Partial<TimeSpec>): TimeSpec {
  return { ...blankTimeSpec("test"), ...p };
}

describe("local dates and boundaries", () => {
  it("local midnight differs from the UTC date boundary", () => {
    // 2026-11-09T07:30Z is still Nov 8 in Los Angeles.
    expect(localParts(Date.parse("2026-11-09T07:30:00Z"), LA).date).toBe("2026-11-08");
    expect(localParts(Date.parse("2026-11-09T08:00:00Z"), LA).date).toBe("2026-11-09");
    const b = localDayBounds("2026-11-09", LA);
    expect(new Date(b.start).toISOString()).toBe("2026-11-09T08:00:00.000Z");
    expect(b.end - b.start).toBe(24 * HOUR);
  });

  it("DST days are 23 and 25 hours long", () => {
    const spring = localDayBounds("2027-03-14", LA);
    expect(spring.end - spring.start).toBe(23 * HOUR);
    const fall = localDayBounds("2026-11-01", LA);
    expect(fall.end - fall.start).toBe(25 * HOUR);
  });

  it("tomorrow is the next local calendar date, 'in 24 hours' is a duration (across spring-forward)", () => {
    const anchor = Date.parse("2027-03-13T18:00:00Z"); // Sat Mar 13 2027 10:00 PST
    const tomorrow = resolveTimeSpec(spec({ day_kind: "tomorrow", hour: 10, minute: 0, meridiem: "am" }), { anchorMs: anchor, tz: LA, purpose: "reminder" });
    const in24 = resolveTimeSpec(spec({ relative_minutes: 1440 }), { anchorMs: anchor, tz: LA, purpose: "reminder" });
    expect(tomorrow.ok && new Date(tomorrow.ms).toISOString()).toBe("2027-03-14T17:00:00.000Z"); // 10:00 PDT
    expect(in24.ok && new Date(in24.ms).toISOString()).toBe("2027-03-14T18:00:00.000Z"); // 11:00 PDT
  });

  it("tomorrow near local midnight uses the local date, not UTC", () => {
    const anchor = Date.parse("2026-11-09T07:30:00Z"); // Nov 8, 23:30 PST
    const r = resolveTimeSpec(spec({ day_kind: "tomorrow", hour: 9, minute: 0, meridiem: "am" }), { anchorMs: anchor, tz: LA, purpose: "reminder" });
    expect(r.ok && localParts(r.ms, LA).date).toBe("2026-11-09");
  });
});

describe("ambiguity requires clarification", () => {
  it("bare 'at 5' asks AM or PM", () => {
    const r = resolveTimeSpec(spec({ day_kind: "tomorrow", hour: 5, minute: 0, meridiem: "none" }), { anchorMs: T0, tz: LA, purpose: "reminder" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.question.kind).toBe("ampm");
      expect(r.question.prompt).toBe("Tomorrow at 5 AM or 5 PM?");
    }
  });

  it("immediate context resolves a follow-up's meridiem (5 PM reminder, check at 8)", () => {
    const reminder = Date.parse("2026-11-10T01:00:00Z"); // Mon 5 PM PST
    const r = resolveTimeSpec(spec({ hour: 8, minute: 0, meridiem: "none" }), { anchorMs: T0, tz: LA, purpose: "followup", after: reminder });
    expect(r.ok && formatDateTime(r.ms, LA)).toBe("Mon Nov 9, 8 PM PT");
  });

  it("bare 'tomorrow' for a reminder asks for a time; part of day is a window, not a timestamp", () => {
    const a = resolveTimeSpec(spec({ day_kind: "tomorrow" }), { anchorMs: T0, tz: LA, purpose: "reminder" });
    expect(!a.ok && a.question.prompt).toBe("What time tomorrow?");
    const b = resolveTimeSpec(spec({ day_kind: "tomorrow", part_of_day: "afternoon" }), { anchorMs: T0, tz: LA, purpose: "reminder" });
    expect(!b.ok && b.question.prompt).toBe("What time tomorrow afternoon?");
  });

  it("'next Friday' asks which concrete date", () => {
    const r = resolveTimeSpec(spec({ day_kind: "weekday", weekday: "fri", weekday_qualifier: "next", hour: 9, minute: 0, meridiem: "am" }), {
      anchorMs: T0,
      tz: LA,
      purpose: "reminder",
    });
    expect(!r.ok && r.question.prompt).toBe("Which Fri: 1) Fri Nov 13 or 2) Fri Nov 20?");
  });

  it("a bare weekday later this week resolves without asking", () => {
    const r = resolveTimeSpec(spec({ day_kind: "weekday", weekday: "tue", weekday_qualifier: "bare", hour: 19, minute: 0, meridiem: "none" }), {
      anchorMs: T0,
      tz: LA,
      purpose: "event_start",
    });
    expect(r.ok && formatDateTime(r.ms, LA)).toBe("Tue Nov 10, 7 PM PT");
  });

  it("a past time asks before using the next occurrence", () => {
    const r = resolveTimeSpec(spec({ hour: 9, minute: 0, meridiem: "am" }), { anchorMs: T0, tz: LA, purpose: "reminder" });
    expect(!r.ok && r.question.kind).toBe("past");
    expect(!r.ok && r.question.prompt).toContain("9 AM today has passed");
  });
});

describe("DST transitions for new one-time actions", () => {
  it("spring-forward nonexistent time asks to use the next valid time", () => {
    const anchor = Date.parse("2027-03-12T18:00:00Z");
    expect(resolveLocal("2027-03-14", 2, 30, LA).kind).toBe("gap");
    const r = resolveTimeSpec(spec({ day_kind: "date", date: "2027-03-14", hour: 2, minute: 30, meridiem: "am" }), { anchorMs: anchor, tz: LA, purpose: "reminder" });
    expect(!r.ok && r.question.kind).toBe("dst_gap");
    expect(!r.ok && r.question.prompt).toContain("Use 3 AM instead?");
    const ok = resolveTimeSpec(spec({ day_kind: "date", date: "2027-03-14", hour: 2, minute: 30, meridiem: "am", gap_ok: true }), {
      anchorMs: anchor,
      tz: LA,
      purpose: "reminder",
    });
    expect(ok.ok && new Date(ok.ms).toISOString()).toBe("2027-03-14T10:00:00.000Z"); // 3:00 PDT
  });

  it("fall-back ambiguous time asks which offset and honours the answer", () => {
    const anchor = Date.parse("2027-11-05T18:00:00Z");
    const s = spec({ day_kind: "date", date: "2027-11-07", hour: 1, minute: 30, meridiem: "am" });
    const r = resolveTimeSpec(s, { anchorMs: anchor, tz: LA, purpose: "reminder" });
    expect(!r.ok && r.question.kind).toBe("dst_fold");
    const first = resolveTimeSpec({ ...s, fold: "earlier" }, { anchorMs: anchor, tz: LA, purpose: "reminder" });
    const second = resolveTimeSpec({ ...s, fold: "later" }, { anchorMs: anchor, tz: LA, purpose: "reminder" });
    expect(first.ok && new Date(first.ms).toISOString()).toBe("2027-11-07T08:30:00.000Z");
    expect(second.ok && new Date(second.ms).toISOString()).toBe("2027-11-07T09:30:00.000Z");
    // Display uses numeric offsets when the abbreviation would be ambiguous.
    expect(first.ok && formatDateTime(first.ms, LA)).toBe("Sun Nov 7, 1:30 AM (UTC-07:00)");
  });
});

describe("quiet hours", () => {
  it("handles windows that cross midnight", () => {
    const at = (iso: string) => isInQuietHours(Date.parse(iso), LA, 23 * 60, 7 * 60);
    expect(at("2026-11-09T07:30:00Z")).toBe(true); // 23:30 PST
    expect(at("2026-11-09T14:59:00Z")).toBe(true); // 06:59
    expect(at("2026-11-09T15:00:00Z")).toBe(false); // 07:00
    expect(at("2026-11-09T06:59:00Z")).toBe(false); // 22:59
    const end = quietHoursEnd(Date.parse("2026-11-09T07:30:00Z"), LA, 23 * 60, 7 * 60);
    expect(new Date(end).toISOString()).toBe("2026-11-09T15:00:00.000Z");
  });
});

describe("formatting and parsing", () => {
  it("formats ranges like the spec examples", () => {
    expect(formatRange(Date.parse("2026-11-11T03:00:00Z"), Date.parse("2026-11-11T05:00:00Z"), LA)).toBe("Tue Nov 10, 7–9 PM PT");
    expect(todayLocal(T0, LA)).toBe("2026-11-08");
  });

  it("parses short time phrases into expressions without resolving them", () => {
    const p = parseTimePhrase("tomorrow at 5 PM", 2026)!;
    expect(p.spec).toMatchObject({ day_kind: "tomorrow", hour: 5, minute: 0, meridiem: "pm" });
    expect(parseTimePhrase("in 20 minutes", 2026)!.spec.relative_minutes).toBe(20);
    expect(parseTimePhrase("next Friday at 9", 2026)!.spec).toMatchObject({ day_kind: "weekday", weekday: "fri", weekday_qualifier: "next", hour: 9, meridiem: "none" });
    expect(parseTimePhrase("Nov 12 at 17:30", 2026)!.spec).toMatchObject({ day_kind: "date", date: "2026-11-12", hour: 17, minute: 30 });
    expect(parseTimePhrase("hello there", 2026)).toBeNull();
  });
});
