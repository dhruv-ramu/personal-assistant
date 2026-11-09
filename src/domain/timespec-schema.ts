import { z } from "zod";
import { WEEKDAYS } from "./time";

/** Time expressions as written by the owner; resolved deterministically by domain/timespec.ts. */
export const TimeSpecSchema = z.object({
  raw: z.string().max(120).describe("The original time words from the message, verbatim."),
  relative_minutes: z.number().int().min(1).max(525600).nullable().describe("For durations such as 'in 20 minutes' or 'in 24 hours'. Otherwise null."),
  day_kind: z.enum(["none", "today", "tomorrow", "weekday", "date"]),
  weekday: z.enum(WEEKDAYS).nullable(),
  weekday_qualifier: z.enum(["bare", "this", "next"]).nullable(),
  date: z.string().nullable().describe("YYYY-MM-DD only when the message names a calendar date explicitly."),
  hour: z.number().int().min(0).max(23).nullable().describe("Hour as written (1-12 with meridiem, or 0-23 for 24-hour times)."),
  minute: z.number().int().min(0).max(59).nullable(),
  meridiem: z.enum(["am", "pm", "none"]).nullable().describe("'none' when AM/PM was not stated."),
  part_of_day: z.enum(["morning", "afternoon", "evening", "night"]).nullable(),
});
