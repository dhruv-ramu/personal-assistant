import type { AppContext } from "../context";
import { log } from "../observability/log";
import { CalendarAuthError, CalendarUnavailableError, type CalendarEventData } from "../providers/types";
import { googleEventIdFor, stableId } from "../security/crypto";
import { auditStatement } from "../services/audit";
import { getConnection, markNeedsReconnect, readCalendarIds, type ConnectionRow } from "../services/calendar-connection";
import { ensureSmsEffect, deliverSmsEffect } from "../services/effects";
import { jobInsertStatement, type JobOutcome, type JobRow } from "../services/jobs";
import { calendarWritesAllowed } from "../services/readiness";
import { getSettings, isPaused, type OwnerSettings } from "../services/settings";
import { DAY, MINUTE, formatDateString, formatRange, formatTime, isInQuietHours, localDayBounds, localParts, resolveLocalForRecurrence } from "./time";

export type CalendarReadResult<T> = { ok: true; value: T } | { ok: false; reason: "disconnected" | "unavailable" | "not_selected" };

async function guard<T>(ctx: AppContext, fn: () => Promise<T>): Promise<CalendarReadResult<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    if (err instanceof CalendarAuthError) {
      await markNeedsReconnect(ctx.db, ctx.clock, err.message);
      return { ok: false, reason: "disconnected" };
    }
    if (err instanceof CalendarUnavailableError) return { ok: false, reason: "unavailable" };
    throw err;
  }
}

export async function connectedCalendar(ctx: AppContext): Promise<ConnectionRow | null> {
  const conn = await getConnection(ctx.db);
  return conn.status === "connected" ? conn : null;
}

/** Live read across selected calendars, paginated and bounded. External text is untrusted data. */
export async function readEvents(ctx: AppContext, startMs: number, endMs: number, opts: { maxPages?: number } = {}): Promise<CalendarReadResult<CalendarEventData[]>> {
  const conn = await connectedCalendar(ctx);
  if (!conn) return { ok: false, reason: "disconnected" };
  const ids = readCalendarIds(conn);
  if (ids.length === 0) return { ok: false, reason: "not_selected" };
  return guard(ctx, async () => {
    const out: CalendarEventData[] = [];
    for (const id of ids) {
      let pageToken: string | null = null;
      for (let page = 0; page < (opts.maxPages ?? 4); page++) {
        const res = await ctx.calendar.listEvents(id, { timeMin: startMs, timeMax: endMs, pageToken, maxResults: 250 });
        out.push(...res.events);
        pageToken = res.nextPageToken;
        if (!pageToken) break;
      }
    }
    return out.filter((e) => e.status !== "cancelled").sort((a, b) => eventSortKey(a, ctx) - eventSortKey(b, ctx));
  });
}

function eventSortKey(e: CalendarEventData, ctx: AppContext): number {
  if (e.startMs !== null) return e.startMs;
  return e.startDate ? localDayBounds(e.startDate, ctx.config.ownerTimezone).start : 0;
}

/** Busy = timed, not declined, not transparent (free), not cancelled. */
export function isBusy(e: CalendarEventData): boolean {
  return !e.allDay && e.status !== "cancelled" && e.selfResponse !== "declined" && e.transparency !== "transparent" && e.startMs !== null && e.endMs !== null;
}

export function describeEvent(e: CalendarEventData, tz: string): string {
  const title = sanitizeExternal(e.summary);
  if (e.allDay && e.startDate) return `${title} (all day ${formatDateString(e.startDate)})`;
  return `${title}: ${formatRange(e.startMs!, e.endMs!, tz)}`;
}

/** External calendar text is displayed, never interpreted. Strip control chars and bound length. */
export function sanitizeExternal(text: string, max = 60): string {
  const clean = text
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean || "(no title)";
}

export async function agendaText(ctx: AppContext, date: string, tz: string, label: string): Promise<string> {
  const { start, end } = localDayBounds(date, tz);
  const res = await readEvents(ctx, start, end);
  if (!res.ok) return calendarUnavailableText(res.reason);
  const events = res.value.filter((e) => e.selfResponse !== "declined");
  if (events.length === 0) return `${label} (${formatDateString(date)}): nothing on your calendar.`;
  const lines = events.slice(0, 6).map((e) => (e.allDay ? `${sanitizeExternal(e.summary, 40)} (all day)` : `${formatTime(e.startMs!, tz)} ${sanitizeExternal(e.summary, 40)}`));
  const more = events.length > 6 ? ` +${events.length - 6} more` : "";
  return `${label} (${formatDateString(date)}): ${lines.join("; ")}${more}.`;
}

export function calendarUnavailableText(reason: "disconnected" | "unavailable" | "not_selected"): string {
  if (reason === "disconnected") return "Calendar isn't connected, so I can't check it. Reconnect it in the admin dashboard.";
  if (reason === "not_selected") return "No calendar is selected for reading. Choose one in the admin dashboard.";
  return "Calendar is unavailable right now; I can't check it. Try again shortly.";
}

export async function nextEventText(ctx: AppContext, tz: string): Promise<string> {
  const now = ctx.clock.now();
  const res = await readEvents(ctx, now, now + 7 * DAY);
  if (!res.ok) return calendarUnavailableText(res.reason);
  const next = res.value.find((e) => isBusy(e) && e.startMs! > now);
  return next ? `Next: ${describeEvent(next, tz)}.` : "Nothing on your calendar in the next 7 days.";
}

export async function findOverlaps(ctx: AppContext, startMs: number, endMs: number, excludeId?: string): Promise<CalendarReadResult<CalendarEventData[]>> {
  const res = await readEvents(ctx, startMs - DAY, endMs + DAY, { maxPages: 2 });
  if (!res.ok) return res;
  return { ok: true, value: res.value.filter((e) => isBusy(e) && e.id !== excludeId && e.startMs! < endMs && e.endMs! > startMs) };
}

/** Candidate events by fuzzy summary match within a day range. */
export async function findEvents(ctx: AppContext, query: string | null, startMs: number, endMs: number): Promise<CalendarReadResult<CalendarEventData[]>> {
  const res = await readEvents(ctx, startMs, endMs);
  if (!res.ok) return res;
  const words = (query ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !["my", "the", "event", "meeting", "appointment", "calendar"].includes(w));
  const timed = res.value.filter((e) => !e.allDay);
  if (words.length === 0) {
    // Generic nouns ("my appointment") match all timed events in range; ambiguity is resolved by asking.
    return { ok: true, value: timed };
  }
  return { ok: true, value: timed.filter((e) => words.some((w) => e.summary.toLowerCase().includes(w))) };
}

export type WriteOutcome =
  | { ok: true; event: CalendarEventData; dryRun?: false }
  | { ok: true; dryRun: true }
  | { ok: false; reason: "disconnected" | "unavailable" | "conflict" | "not_found" | "forbidden" | "duplicate" | "invalid" | "no_calendar"; detail?: string };

export interface CreateEventInput {
  actionKey: string;
  title: string;
  startMs: number;
  endMs: number;
  timeZone: string;
  location: string | null;
  description: string | null;
  rrule: string | null;
}

/**
 * Idempotent create: the Google event ID is derived from the stable action key, so a retry after
 * a lost response (timeout) re-uses it and the provider reports a duplicate that we reconcile.
 * Dry run and read-only modes never write.
 */
export async function createEvent(ctx: AppContext, input: CreateEventInput): Promise<WriteOutcome> {
  if (!calendarWritesAllowed(ctx)) return { ok: true, dryRun: true };
  const conn = await connectedCalendar(ctx);
  if (!conn) return { ok: false, reason: "disconnected" };
  const calendarId = conn.default_write_calendar_id;
  if (!calendarId) return { ok: false, reason: "no_calendar" };
  const eventId = await googleEventIdFor(input.actionKey);
  const write = {
    summary: input.title,
    description: input.description,
    location: input.location,
    startMs: input.startMs,
    endMs: input.endMs,
    timeZone: input.timeZone,
    recurrence: input.rrule ? [`RRULE:${input.rrule}`] : null,
    dellaActionKey: input.actionKey,
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await ctx.calendar.insertEvent(calendarId, eventId, write);
      if (r.ok) {
        await ctx.db.batch([auditStatement(ctx, "sms", "calendar.create", "event", eventId)]);
        return { ok: true, event: r.event };
      }
      return { ok: false, reason: r.reason, detail: r.detail };
    } catch (err) {
      if (err instanceof CalendarAuthError) {
        await markNeedsReconnect(ctx.db, ctx.clock, err.message);
        return { ok: false, reason: "disconnected" };
      }
      if (err instanceof CalendarUnavailableError && attempt === 0) {
        log("warn", "calendar_create_retry_same_id", { eventId });
        continue;
      }
      if (err instanceof CalendarUnavailableError) return { ok: false, reason: "unavailable" };
      throw err;
    }
  }
  return { ok: false, reason: "unavailable" };
}

export async function patchEventTimes(ctx: AppContext, calendarId: string, eventId: string, etag: string, startMs: number, endMs: number, tz: string): Promise<WriteOutcome> {
  if (!calendarWritesAllowed(ctx)) return { ok: true, dryRun: true };
  try {
    const r = await ctx.calendar.patchEvent(calendarId, eventId, { startMs, endMs, timeZone: tz }, etag);
    if (r.ok) {
      await ctx.db.batch([auditStatement(ctx, "sms", "calendar.move", "event", eventId)]);
      return { ok: true, event: r.event };
    }
    return { ok: false, reason: r.reason, detail: r.detail };
  } catch (err) {
    if (err instanceof CalendarAuthError) {
      await markNeedsReconnect(ctx.db, ctx.clock, err.message);
      return { ok: false, reason: "disconnected" };
    }
    if (err instanceof CalendarUnavailableError) return { ok: false, reason: "unavailable" };
    throw err;
  }
}

export async function deleteEventConditional(
  ctx: AppContext,
  calendarId: string,
  eventId: string,
  etag: string,
): Promise<{ ok: true; dryRun?: boolean } | { ok: false; reason: string }> {
  if (!calendarWritesAllowed(ctx)) return { ok: true, dryRun: true };
  try {
    const r = await ctx.calendar.deleteEvent(calendarId, eventId, etag);
    if (r.ok) {
      await ctx.db.batch([auditStatement(ctx, "sms", "calendar.delete", "event", eventId)]);
      return { ok: true };
    }
    return { ok: false, reason: r.reason };
  } catch (err) {
    if (err instanceof CalendarAuthError) {
      await markNeedsReconnect(ctx.db, ctx.clock, err.message);
      return { ok: false, reason: "disconnected" };
    }
    if (err instanceof CalendarUnavailableError) return { ok: false, reason: "unavailable" };
    throw err;
  }
}

/** Finds one concrete free slot inside a daytime window (15-minute grid). */
export async function findFreeSlot(
  ctx: AppContext,
  date: string,
  windowStartMin: number,
  windowEndMin: number,
  durationMin: number,
  tz: string,
): Promise<CalendarReadResult<{ startMs: number; endMs: number } | null>> {
  const ws = resolveLocalForRecurrence(date, Math.floor(windowStartMin / 60), windowStartMin % 60, tz);
  const we = resolveLocalForRecurrence(date, Math.floor(windowEndMin / 60), windowEndMin % 60, tz);
  const res = await readEvents(ctx, ws - DAY, we + DAY, { maxPages: 2 });
  if (!res.ok) return res;
  const busy = res.value.filter(isBusy);
  const now = ctx.clock.now();
  for (let t = ws; t + durationMin * MINUTE <= we; t += 15 * MINUTE) {
    if (t < now) continue;
    const end = t + durationMin * MINUTE;
    if (!busy.some((e) => e.startMs! < end && e.endMs! > t)) return { ok: true, value: { startMs: t, endMs: end } };
  }
  return { ok: true, value: null };
}

// ---------- Polling projection + heads-up reminders ----------

export const SYNC_INTERVAL_MS = 5 * MINUTE;
export const SYNC_HORIZON_MS = 7 * DAY;

/** Timed heads-ups exclude cancelled, declined, free/transparent, and all-day events (all-day events can appear in the morning brief instead). */
function headsupEligible(e: CalendarEventData): boolean {
  if (e.status === "cancelled" || e.selfResponse === "declined" || e.transparency === "transparent") return false;
  if (e.allDay) return false;
  return e.startMs !== null;
}

/**
 * Polls the rolling 7-day horizon (every five minutes, a deliberate simplicity trade-off: changes
 * can take about five minutes to appear), upserts the projection, marks vanished events cancelled,
 * and reconciles heads-up jobs. Policy: one heads-up per event instance and lead time; if an
 * event moves before its heads-up was sent, the heads-up moves with it; once sent, a moved event
 * does not get a second heads-up.
 */
export async function syncCalendar(ctx: AppContext): Promise<CalendarReadResult<{ events: number; scheduled: number; canceled: number }>> {
  const now = ctx.clock.now();
  const res = await readEvents(ctx, now - 6 * 60 * MINUTE, now + SYNC_HORIZON_MS);
  if (!res.ok) {
    await ctx.db.run("UPDATE calendar_connection SET last_sync_error = ?, last_error_at = ?, updated_at = ? WHERE id = 1", res.reason, now, now);
    return res;
  }
  const s = await getSettings(ctx.db);
  const seen = new Set<string>();
  let scheduled = 0;
  let canceled = 0;
  for (const e of res.value) {
    const cacheId = await stableId("cev", `${e.calendarId}:${e.id}`);
    seen.add(cacheId);
    await ctx.db.run(
      `INSERT INTO calendar_events (id, calendar_id, event_id, recurring_event_id, etag, summary_enc, location_enc, start_at, end_at, all_day, start_date, end_date, timezone, status, transparency, self_response, has_attendees, created_by_della, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (calendar_id, event_id) DO UPDATE SET etag = excluded.etag, summary_enc = excluded.summary_enc, location_enc = excluded.location_enc, start_at = excluded.start_at,
         end_at = excluded.end_at, all_day = excluded.all_day, start_date = excluded.start_date, end_date = excluded.end_date, status = excluded.status, transparency = excluded.transparency,
         self_response = excluded.self_response, has_attendees = excluded.has_attendees, fetched_at = excluded.fetched_at`,
      cacheId,
      e.calendarId,
      e.id,
      e.recurringEventId,
      e.etag,
      await ctx.crypto.encrypt(e.summary, "calendar"),
      await ctx.crypto.encryptNullable(e.location, "calendar"),
      e.startMs,
      e.endMs,
      e.allDay ? 1 : 0,
      e.startDate,
      e.endDate,
      e.timeZone,
      e.status,
      e.transparency,
      e.selfResponse,
      e.hasAttendees ? 1 : 0,
      e.createdByDella ? 1 : 0,
      now,
    );
    if (s.calendar_headsup_enabled === 1 && headsupEligible(e) && e.startMs! > now) {
      const r = await reconcileHeadsup(ctx, e, s.calendar_headsup_lead_minutes);
      if (r === "scheduled" || r === "moved") scheduled++;
    }
  }
  // Events that disappeared from the horizon (deleted/cancelled) cancel their pending heads-ups.
  const cached = await ctx.db.all<{ id: string; calendar_id: string; event_id: string }>(
    "SELECT id, calendar_id, event_id FROM calendar_events WHERE start_at > ? AND start_at < ?",
    now,
    now + SYNC_HORIZON_MS,
  );
  for (const c of cached) {
    if (seen.has(c.id)) continue;
    await ctx.db.run("UPDATE calendar_events SET status = 'cancelled', fetched_at = ? WHERE id = ?", now, c.id);
    canceled += await ctx.db.run(
      "UPDATE calendar_headsups SET status = 'canceled', status_reason = 'event_removed', generation = generation + 1, updated_at = ? WHERE calendar_id = ? AND event_id = ? AND status = 'scheduled'",
      now,
      c.calendar_id,
      c.event_id,
    );
  }
  await ctx.db.run("DELETE FROM calendar_events WHERE COALESCE(end_at, 0) < ? AND all_day = 0", now - DAY);
  await ctx.db.run("UPDATE calendar_connection SET last_sync_at = ?, last_sync_error = NULL, updated_at = ? WHERE id = 1", now, now);
  return { ok: true, value: { events: res.value.length, scheduled, canceled } };
}

interface HeadsupRow {
  id: string;
  logical_key: string;
  calendar_id: string;
  event_id: string;
  lead_minutes: number;
  event_start_at: number;
  planned_at: number;
  generation: number;
  status: "scheduled" | "sent" | "skipped" | "canceled";
}

function headsupJob(ctx: AppContext, h: { id: string }, generation: number, plannedAt: number, eventStart: number): D1PreparedStatement {
  return jobInsertStatement(ctx, {
    logicalKey: `headsup:${h.id}:g${generation}`,
    kind: "calendar_headsup",
    entityId: h.id,
    entityGeneration: generation,
    dueAt: plannedAt,
    intendedAt: plannedAt,
    expiresAt: eventStart,
    maxAttempts: 3,
  });
}

export async function reconcileHeadsup(ctx: AppContext, e: CalendarEventData, leadMinutes: number): Promise<"scheduled" | "moved" | "unchanged" | "already_sent"> {
  const key = `headsup:${e.calendarId}:${e.id}:${leadMinutes}`;
  const id = await stableId("hdu", key);
  const plannedAt = e.startMs! - leadMinutes * MINUTE;
  const now = ctx.clock.now();
  const existing = await ctx.db.first<HeadsupRow>("SELECT * FROM calendar_headsups WHERE logical_key = ?", key);
  if (!existing) {
    if (plannedAt < now - 5 * MINUTE) return "unchanged";
    await ctx.db.batch([
      ctx.db.prepare(
        "INSERT INTO calendar_headsups (id, logical_key, calendar_id, event_id, lead_minutes, event_start_at, planned_at, generation, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'scheduled', ?, ?) ON CONFLICT (logical_key) DO NOTHING",
        id,
        key,
        e.calendarId,
        e.id,
        leadMinutes,
        e.startMs!,
        Math.max(plannedAt, now),
        now,
        now,
      ),
      headsupJob(ctx, { id }, 1, Math.max(plannedAt, now), e.startMs!),
    ]);
    return "scheduled";
  }
  if (existing.status === "sent") return "already_sent";
  if (existing.status !== "scheduled" || existing.event_start_at === e.startMs) return "unchanged";
  const gen = existing.generation + 1;
  const won = await ctx.db.run(
    "UPDATE calendar_headsups SET event_start_at = ?, planned_at = ?, generation = ?, updated_at = ? WHERE id = ? AND generation = ? AND status = 'scheduled'",
    e.startMs!,
    Math.max(plannedAt, now),
    gen,
    now,
    existing.id,
    existing.generation,
  );
  if (won === 1) {
    await ctx.db.batch([
      ctx.db.prepare(
        "UPDATE jobs SET status = 'canceled', last_error = 'event_moved', updated_at = ? WHERE entity_id = ? AND kind = 'calendar_headsup' AND status = 'pending'",
        now,
        existing.id,
      ),
      headsupJob(ctx, existing, gen, Math.max(plannedAt, now), e.startMs!),
    ]);
  }
  return "moved";
}

/** Heads-up job: re-read the event live right before sending; never send a known-stale reminder. */
export async function handleHeadsupJob(ctx: AppContext, job: JobRow): Promise<JobOutcome> {
  const h = await ctx.db.first<HeadsupRow>("SELECT * FROM calendar_headsups WHERE id = ?", job.entity_id ?? "");
  if (!h || h.status !== "scheduled") return { status: "skipped", result: { reason: "not_scheduled" } };
  if (h.generation !== job.entity_generation) return { status: "skipped", result: { reason: "stale_generation" } };
  const now = ctx.clock.now();
  const s = await getSettings(ctx.db);
  const markSkipped = async (reason: string) => {
    await ctx.db.run("UPDATE calendar_headsups SET status = 'skipped', status_reason = ?, updated_at = ? WHERE id = ? AND generation = ?", reason, now, h.id, h.generation);
  };
  if (s.calendar_headsup_enabled !== 1) {
    await markSkipped("headsups_disabled");
    return { status: "skipped", result: { reason: "disabled" } };
  }
  let event: CalendarEventData | null;
  try {
    event = await ctx.calendar.getEvent(h.calendar_id, h.event_id);
  } catch (err) {
    if (err instanceof CalendarAuthError) {
      await markNeedsReconnect(ctx.db, ctx.clock, err.message);
      await markSkipped("calendar_disconnected");
      return { status: "skipped", result: { reason: "disconnected" } };
    }
    // Live revalidation failed: defer within the validity window instead of sending stale data.
    if (now + 2 * MINUTE < h.event_start_at) return { status: "reschedule", dueAt: now + 2 * MINUTE, reason: "revalidation_failed" };
    await markSkipped("revalidation_failed");
    return { status: "skipped", result: { reason: "unverified" } };
  }
  if (!event || event.status === "cancelled" || event.selfResponse === "declined") {
    await markSkipped("event_cancelled");
    return { status: "skipped", result: { reason: "event_cancelled" } };
  }
  if (event.startMs === null || event.startMs <= now) {
    await markSkipped("event_started");
    return { status: "skipped", result: { reason: "stale" } };
  }
  if (event.startMs !== h.event_start_at) {
    const r = await reconcileHeadsup(ctx, event, h.lead_minutes);
    return { status: "skipped", result: { reason: "event_moved", reconcile: r } };
  }
  if (isPaused(s, now, "reminders")) {
    await markSkipped("paused");
    return { status: "skipped", result: { reason: "paused" } };
  }
  if (isInQuietHours(now, s.timezone, s.quiet_start_minute, s.quiet_end_minute)) {
    await markSkipped("quiet_hours");
    return { status: "skipped", result: { reason: "quiet_hours" } };
  }
  const minutes = Math.max(1, Math.round((event.startMs - now) / MINUTE));
  const loc = event.location ? ` at ${sanitizeExternal(event.location, 40)}` : "";
  const body = `Heads-up: ${sanitizeExternal(event.summary, 50)} at ${formatTime(event.startMs, s.timezone)}${loc} (in ${minutes} min).`;
  const effect = await ensureSmsEffect(ctx, { effectKey: `headsup:${h.logical_key}`, purpose: "headsup", body });
  const d = await deliverSmsEffect(ctx, effect.id, "proactive");
  if (d.state === "retry") return { status: "retry", error: d.reason, delayMs: 60_000 };
  await ctx.db.run(
    "UPDATE calendar_headsups SET status = ?, status_reason = ?, updated_at = ? WHERE id = ? AND generation = ?",
    d.state === "accepted" || d.state === "unknown" || d.state === "delivered" ? "sent" : "skipped",
    d.state,
    now,
    h.id,
    h.generation,
  );
  return { status: "succeeded", result: { delivery: d.state } };
}

export function partOfDayWindow(part: string | null, s: OwnerSettings): { start: number; end: number; label: string } {
  switch (part) {
    case "morning":
      return { start: 8 * 60, end: 12 * 60, label: "morning" };
    case "afternoon":
      return { start: 12 * 60, end: 17 * 60, label: "afternoon" };
    case "evening":
      return { start: 17 * 60, end: 21 * 60, label: "evening" };
    default:
      return { start: s.focus_day_start_minute, end: s.focus_day_end_minute, label: "day" };
  }
}

export function localDateOf(ms: number, tz: string): string {
  return localParts(ms, tz).date;
}
