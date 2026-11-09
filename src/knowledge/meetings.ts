import type { AppContext } from "../context";
import { createClarification } from "../domain/conversations";
import { readEvents, sanitizeExternal } from "../domain/calendar";
import { formatDate, formatTime, MINUTE } from "../domain/time";
import { featureOn, getExtSettings } from "../ext/settings";
import type { CalendarEventData } from "../providers/types";
import { stableId } from "../security/crypto";
import { deliverSmsEffect, ensureSmsEffect } from "../services/effects";
import { jobInsertStatement, parsePayload, type JobOutcome, type JobRow } from "../services/jobs";
import { getSettings, isPaused } from "../services/settings";
import { listItems } from "./secretary";
import { activeEntities, labelTokens, type Entity } from "./store";

/**
 * Meeting preparation and post-meeting capture. People are matched only from trusted local data
 * (names the owner told Della) appearing in the event title; Della never invents attendees, roles,
 * or agendas. Calendar text is untrusted and only displayed.
 */
export async function scheduleMeetingJobs(ctx: AppContext, events: CalendarEventData[]): Promise<void> {
  const ext = await getExtSettings(ctx.db);
  const prep = featureOn(ctx, ext, "meeting_prep");
  const post = featureOn(ctx, ext, "post_meeting");
  if (!prep && !post) return;
  const now = ctx.clock.now();
  const stmts: D1PreparedStatement[] = [];
  for (const e of events) {
    if (e.allDay || e.startMs === null || e.endMs === null || e.status === "cancelled" || e.selfResponse === "declined" || e.createdByDella) continue;
    const key = await stableId("mtg", `${e.calendarId}:${e.id}:${e.startMs}`);
    if (prep && e.startMs - ext.meeting_prep_lead_minutes * MINUTE > now) {
      stmts.push(
        jobInsertStatement(ctx, {
          logicalKey: `meeting_prep:${key}`,
          kind: "meeting_prep",
          entityId: e.id,
          dueAt: e.startMs - ext.meeting_prep_lead_minutes * MINUTE,
          expiresAt: e.startMs,
          payload: { calendarId: e.calendarId, eventId: e.id, startMs: e.startMs },
        }),
      );
    }
    if (post && e.endMs > now) {
      stmts.push(
        jobInsertStatement(ctx, {
          logicalKey: `post_meeting:${key}`,
          kind: "post_meeting",
          entityId: e.id,
          dueAt: e.endMs + 5 * MINUTE,
          expiresAt: e.endMs + 6 * 60 * MINUTE,
          payload: { calendarId: e.calendarId, eventId: e.id, startMs: e.startMs },
        }),
      );
    }
  }
  if (stmts.length) await ctx.db.batch(stmts);
}

export async function peopleInText(ctx: AppContext, text: string): Promise<Entity[]> {
  const words = new Set(labelTokens(text));
  return (await activeEntities(ctx, new Set(["person"]))).filter((p) => {
    const t = labelTokens(p.label).filter((x) => x.length > 1);
    return t.length > 0 && t.every((x) => words.has(x));
  });
}

export async function meetingBrief(ctx: AppContext, title: string): Promise<{ text: string; empty: boolean }> {
  const people = await peopleInText(ctx, title);
  const lines: string[] = [];
  for (const p of people.slice(0, 3)) {
    const promises = await listItems(ctx, "promise", { status: ["open"], personId: p.id, limit: 3 });
    const questions = await listItems(ctx, "question", { status: ["open"], personId: p.id, limit: 3 });
    const waiting = await listItems(ctx, "waiting_for", { status: ["open"], personId: p.id, limit: 2 });
    const last = (await listItems(ctx, "interaction", { personId: p.id, limit: 20 })).sort((a, b) => b.created_at - a.created_at)[0];
    const bits = [];
    if (questions.length) bits.push(`questions: ${questions.map((q) => q.title).join("; ")}`);
    if (promises.length) bits.push(`you promised: ${promises.map((q) => q.title).join("; ")}`);
    if (waiting.length) bits.push(`waiting on: ${waiting.map((q) => q.title).join("; ")}`);
    if (last?.data.notes) bits.push(`last notes: ${String(last.data.notes).slice(0, 80)}`);
    if (bits.length) lines.push(`${p.label}: ${bits.join(" | ")}`);
  }
  const words = new Set(labelTokens(title));
  for (const l of await listItems(ctx, "lesson", { limit: 30 })) {
    const act = labelTokens(String(l.data.activity ?? ""));
    if (act.length && act.every((a) => words.has(a)))
      lines.push(`Last time (${String(l.data.activity)}, noted ${formatDate(l.created_at, (await getSettings(ctx.db)).timezone)}): ${l.title}`);
  }
  return { text: lines.join(" "), empty: lines.length === 0 };
}

export async function handleMeetingPrep(ctx: AppContext, job: JobRow): Promise<JobOutcome> {
  const p = parsePayload<{ calendarId: string; eventId: string; startMs: number }>(job);
  const s = await getSettings(ctx.db);
  if (isPaused(s, ctx.clock.now(), "reminders")) return { status: "skipped", result: { reason: "paused" } };
  let e: CalendarEventData | null;
  try {
    e = await ctx.calendar.getEvent(p.calendarId, p.eventId);
  } catch {
    return { status: "skipped", result: { reason: "calendar_unavailable" } };
  }
  if (!e || e.status === "cancelled" || e.startMs !== p.startMs) return { status: "skipped", result: { reason: "event_changed" } };
  const brief = await meetingBrief(ctx, e.summary);
  if (brief.empty) return { status: "skipped", result: { reason: "nothing_relevant" } };
  const effect = await ensureSmsEffect(ctx, {
    effectKey: `meeting_prep:${job.logical_key}`,
    purpose: "brief",
    body: `Before ${sanitizeExternal(e.summary, 40)} at ${formatTime(e.startMs, s.timezone)}: ${brief.text}`,
  });
  const d = await deliverSmsEffect(ctx, effect.id, "proactive");
  return { status: "succeeded", result: { delivery: d.state } };
}

export async function handlePostMeeting(ctx: AppContext, job: JobRow): Promise<JobOutcome> {
  const p = parsePayload<{ calendarId: string; eventId: string; startMs: number }>(job);
  const s = await getSettings(ctx.db);
  if (isPaused(s, ctx.clock.now(), "reminders")) return { status: "skipped", result: { reason: "paused" } };
  let e: CalendarEventData | null;
  try {
    e = await ctx.calendar.getEvent(p.calendarId, p.eventId);
  } catch {
    return { status: "skipped", result: { reason: "calendar_unavailable" } };
  }
  if (!e || e.status === "cancelled") return { status: "skipped", result: { reason: "event_cancelled" } };
  const prompt = `Anything to record or follow up from ${sanitizeExternal(e.summary, 40)}? Reply with notes, SKIP, or DIDN'T HAPPEN.`;
  await createClarification(ctx, {
    type: "post_meeting",
    options: [
      { label: "skip", keywords: ["skip", "nothing", "no"], value: "skip" },
      { label: "didn't happen", keywords: ["didn't happen", "didnt happen", "canceled", "cancelled", "didn't go", "missed it"], value: "did_not_happen" },
    ],
    freeform: "text",
    pending: {
      action: { eventId: e.id, calendarId: e.calendarId, title: sanitizeExternal(e.summary, 60), startMs: e.startMs },
      slot: null,
      anchorMs: ctx.clock.now(),
      sourceInboundId: null,
    },
    prompt,
    sourceActionKey: `post_meeting_q:${job.logical_key}`,
    ttlMs: 6 * 60 * MINUTE,
  });
  const effect = await ensureSmsEffect(ctx, { effectKey: `post_meeting:${job.logical_key}`, purpose: "brief", body: prompt });
  const d = await deliverSmsEffect(ctx, effect.id, "proactive");
  return { status: "succeeded", result: { delivery: d.state } };
}

/** Lists upcoming events for meeting scheduling during calendar sync. */
export async function upcomingForMeetings(ctx: AppContext): Promise<CalendarEventData[]> {
  const now = ctx.clock.now();
  const r = await readEvents(ctx, now, now + 24 * 60 * MINUTE, { maxPages: 1 });
  return r.ok ? r.value : [];
}
