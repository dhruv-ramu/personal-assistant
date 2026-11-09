import { describe, expect, it } from "vitest";
import { buildRRule, countOccurrencesBetween, firstOccurrence, nextOccurrenceAfter, type SeriesRule } from "../../src/domain/recurrence";
import { formatDateTime } from "../../src/domain/time";

const LA = "America/Los_Angeles";

function rule(spec: Parameters<typeof buildRRule>[0], dtstartLocal: string): SeriesRule {
  const r = buildRRule(spec);
  if (!r.ok) throw new Error(r.reason);
  return { rrule: r.rrule, dtstartLocal, timezone: LA };
}

function walk(series: SeriesRule, fromIso: string, n: number): string[] {
  const out: string[] = [];
  let cursor = Date.parse(fromIso);
  for (let i = 0; i < n; i++) {
    const o = nextOccurrenceAfter(series, cursor);
    if (!o) break;
    out.push(new Date(o.ms).toISOString());
    cursor = o.ms;
  }
  return out;
}

describe("recurrence", () => {
  it("daily 8 AM stays 8 AM local across spring-forward (not a fixed 24h interval)", () => {
    const s = rule({ freq: "daily", weekdays: null, interval: null, count: null, until_date: null }, "2027-03-12T08:00");
    expect(walk(s, "2027-03-12T00:00:00Z", 4)).toEqual([
      "2027-03-12T16:00:00.000Z", // PST
      "2027-03-13T16:00:00.000Z",
      "2027-03-14T15:00:00.000Z", // PDT
      "2027-03-15T15:00:00.000Z",
    ]);
  });

  it("daily 8 AM across fall-back", () => {
    const s = rule({ freq: "daily", weekdays: null, interval: null, count: null, until_date: null }, "2027-11-06T08:00");
    expect(walk(s, "2027-11-06T00:00:00Z", 3)).toEqual(["2027-11-06T15:00:00.000Z", "2027-11-07T16:00:00.000Z", "2027-11-08T16:00:00.000Z"]);
  });

  it("weekdays skip the weekend and cross the year boundary", () => {
    const s = rule({ freq: "weekdays", weekdays: null, interval: null, count: null, until_date: null }, "2026-12-30T07:00");
    const got = walk(s, "2026-12-30T00:00:00Z", 4).map((iso) => formatDateTime(Date.parse(iso), LA));
    expect(got).toEqual(["Wed Dec 30, 7 AM PT", "Thu Dec 31, 7 AM PT", "Fri Jan 1, 7 AM PT", "Mon Jan 4, 7 AM PT"]);
  });

  it("weekly on selected days with a count", () => {
    const s = rule({ freq: "weekly", weekdays: ["tue", "thu"], interval: null, count: 3, until_date: null }, "2026-11-10T19:00");
    expect(walk(s, "2026-11-09T00:00:00Z", 10).map((iso) => formatDateTime(Date.parse(iso), LA))).toEqual(["Tue Nov 10, 7 PM PT", "Thu Nov 12, 7 PM PT", "Tue Nov 17, 7 PM PT"]);
  });

  it("until date is inclusive and ends the series", () => {
    const s = rule({ freq: "daily", weekdays: null, interval: null, count: null, until_date: "2026-11-11" }, "2026-11-09T09:00");
    expect(walk(s, "2026-11-09T00:00:00Z", 10)).toHaveLength(3);
  });

  it("every N days", () => {
    const s = rule({ freq: "interval_days", weekdays: null, interval: 3, count: null, until_date: null }, "2026-11-09T09:00");
    expect(walk(s, "2026-11-09T00:00:00Z", 3).map((iso) => formatDateTime(Date.parse(iso), LA))).toEqual(["Mon Nov 9, 9 AM PT", "Thu Nov 12, 9 AM PT", "Sun Nov 15, 9 AM PT"]);
  });

  it("established rules: nonexistent time moves to the next valid instant; ambiguous uses the earlier", () => {
    const gap = rule({ freq: "daily", weekdays: null, interval: null, count: null, until_date: null }, "2027-03-13T02:30");
    expect(walk(gap, "2027-03-13T00:00:00Z", 2)).toEqual(["2027-03-13T10:30:00.000Z", "2027-03-14T10:00:00.000Z"]); // 2:30 PST, then 3:00 PDT
    const fold = rule({ freq: "daily", weekdays: null, interval: null, count: null, until_date: null }, "2027-11-06T01:30");
    expect(walk(fold, "2027-11-06T00:00:00Z", 2)).toEqual(["2027-11-06T08:30:00.000Z", "2027-11-07T08:30:00.000Z"]); // earlier (PDT) only
  });

  it("rejects an unsupported/contradictory definition", () => {
    expect(buildRRule({ freq: "weekly", weekdays: [], interval: null, count: null, until_date: null }).ok).toBe(false);
    expect(buildRRule({ freq: "daily", weekdays: null, interval: null, count: 3, until_date: "2026-12-01" }).ok).toBe(false);
  });

  it("first occurrence and bounded counting", () => {
    const s = rule({ freq: "daily", weekdays: null, interval: null, count: null, until_date: null }, "2026-11-09T08:00");
    expect(new Date(firstOccurrence(s)!.ms).toISOString()).toBe("2026-11-09T16:00:00.000Z");
    expect(countOccurrencesBetween(s, Date.parse("2026-11-09T00:00:00Z"), Date.parse("2027-11-09T00:00:00Z"), 100)).toBe(100);
  });
});
