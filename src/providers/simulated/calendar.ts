import type { Db } from "../../db/db";
import type { Clock } from "../../domain/time";
import {
  CalendarAuthError,
  CalendarUnavailableError,
  type CalendarEventData,
  type CalendarInfo,
  type CalendarProvider,
  type CalendarWriteResult,
  type EventPatch,
  type EventWrite,
  type ListEventsOptions,
} from "../types";
import { logSimProvider, nextSimOutcome } from "./common";

type StoredEvent = Omit<CalendarEventData, "etag" | "calendarId" | "id" | "recurringEventId">;

interface Row {
  calendar_id: string;
  event_id: string;
  recurring_event_id: string | null;
  etag_counter: number;
  data_json: string;
}

function toEvent(r: Row): CalendarEventData {
  const d = JSON.parse(r.data_json) as StoredEvent;
  return { ...d, calendarId: r.calendar_id, id: r.event_id, recurringEventId: r.recurring_event_id, etag: `"sim-${r.etag_counter}"` };
}

export const SIM_PRIMARY_CALENDAR = "primary-sim@calendar.invalid";

/**
 * Simulated Google-like calendar with etags, conditional writes (412 on mismatch), duplicate-ID
 * detection (409 semantics), explicit recurring instances, revocation, and outages.
 */
export class SimulatedCalendarProvider implements CalendarProvider {
  readonly name = "simulated";
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  private async gate(operation: string): Promise<void> {
    const revoked = await this.db.first<{ value: string }>("SELECT value FROM system_state WHERE key = 'sim_calendar_revoked'");
    if (revoked?.value === "1") throw new CalendarAuthError("Simulated consent revoked (invalid_grant)");
    const outcome = await nextSimOutcome(this.db, `calendar_${operation}`);
    if (outcome === "unavailable") throw new CalendarUnavailableError("Simulated calendar outage");
  }

  async listCalendars(): Promise<CalendarInfo[]> {
    await this.gate("read");
    const rows = await this.db.all<{ id: string; summary: string; is_primary: number; access_role: string; timezone: string }>(
      "SELECT * FROM sim_calendars ORDER BY is_primary DESC, id",
    );
    return rows.map((r) => ({ id: r.id, summary: r.summary, primary: r.is_primary === 1, accessRole: r.access_role, timeZone: r.timezone }));
  }

  async listEvents(calendarId: string, opts: ListEventsOptions): Promise<{ events: CalendarEventData[]; nextPageToken: string | null }> {
    await this.gate("read");
    const pageSize = Math.min(opts.maxResults ?? 250, 250);
    const offset = opts.pageToken ? Number(opts.pageToken) : 0;
    const rows = await this.db.all<Row>("SELECT * FROM sim_calendar_events WHERE calendar_id = ? ORDER BY event_id", calendarId);
    const all = rows
      .map(toEvent)
      .filter((e) => e.status !== "cancelled" && !e.isRecurringSeries)
      .filter((e) => {
        if (e.allDay && e.startDate && e.endDate) {
          const s = Date.parse(`${e.startDate}T00:00:00Z`) - 14 * 3600_000;
          const en = Date.parse(`${e.endDate}T00:00:00Z`) + 14 * 3600_000;
          return en > opts.timeMin && s < opts.timeMax;
        }
        return e.startMs !== null && e.endMs !== null && e.endMs > opts.timeMin && e.startMs < opts.timeMax;
      })
      .sort((a, b) => (a.startMs ?? 0) - (b.startMs ?? 0));
    const page = all.slice(offset, offset + pageSize);
    return { events: page, nextPageToken: offset + pageSize < all.length ? String(offset + pageSize) : null };
  }

  async getEvent(calendarId: string, eventId: string): Promise<CalendarEventData | null> {
    await this.gate("read");
    const row = await this.db.first<Row>("SELECT * FROM sim_calendar_events WHERE calendar_id = ? AND event_id = ?", calendarId, eventId);
    return row ? toEvent(row) : null;
  }

  async insertEvent(calendarId: string, eventId: string, write: EventWrite): Promise<CalendarWriteResult> {
    await this.gate("write");
    const stored: StoredEvent = {
      summary: write.summary,
      description: write.description,
      location: write.location,
      status: "confirmed",
      allDay: false,
      startMs: write.startMs,
      endMs: write.endMs,
      startDate: null,
      endDate: null,
      timeZone: write.timeZone,
      transparency: "opaque",
      selfResponse: null,
      hasAttendees: false,
      createdByDella: true,
      isRecurringSeries: false,
    };
    const changes = await this.db.run(
      "INSERT OR IGNORE INTO sim_calendar_events (calendar_id, event_id, recurring_event_id, etag_counter, data_json, updated_at) VALUES (?, ?, NULL, 1, ?, ?)",
      calendarId,
      eventId,
      JSON.stringify(stored),
      this.clock.now(),
    );
    await logSimProvider(this.db, this.clock, "calendar", "insert", { calendarId, eventId, created: changes === 1 });
    const outcome = await nextSimOutcome(this.db, "calendar_insert_response");
    if (outcome === "timeout") throw new CalendarUnavailableError("Simulated timeout after the event was written");
    if (changes === 0) {
      const existing = await this.getEvent(calendarId, eventId);
      if (existing?.createdByDella) return { ok: true, event: existing };
      return { ok: false, reason: "duplicate", detail: "An event with this ID already exists." };
    }
    return { ok: true, event: (await this.getEvent(calendarId, eventId))! };
  }

  async patchEvent(calendarId: string, eventId: string, patch: EventPatch, etag: string): Promise<CalendarWriteResult> {
    await this.gate("write");
    const row = await this.db.first<Row>("SELECT * FROM sim_calendar_events WHERE calendar_id = ? AND event_id = ?", calendarId, eventId);
    if (!row) return { ok: false, reason: "not_found", detail: "Event not found." };
    if (toEvent(row).etag !== etag) return { ok: false, reason: "conflict", detail: "The event changed since it was read." };
    const d = JSON.parse(row.data_json) as StoredEvent;
    if (patch.summary !== undefined) d.summary = patch.summary;
    if (patch.startMs !== undefined) d.startMs = patch.startMs;
    if (patch.endMs !== undefined) d.endMs = patch.endMs;
    const changes = await this.db.run(
      "UPDATE sim_calendar_events SET data_json = ?, etag_counter = etag_counter + 1, updated_at = ? WHERE calendar_id = ? AND event_id = ? AND etag_counter = ?",
      JSON.stringify(d),
      this.clock.now(),
      calendarId,
      eventId,
      row.etag_counter,
    );
    if (changes !== 1) return { ok: false, reason: "conflict", detail: "The event changed since it was read." };
    await logSimProvider(this.db, this.clock, "calendar", "patch", { calendarId, eventId });
    return { ok: true, event: (await this.getEvent(calendarId, eventId))! };
  }

  async deleteEvent(calendarId: string, eventId: string, etag: string): Promise<{ ok: true } | { ok: false; reason: "conflict" | "not_found" | "forbidden"; detail: string }> {
    await this.gate("write");
    const row = await this.db.first<Row>("SELECT * FROM sim_calendar_events WHERE calendar_id = ? AND event_id = ?", calendarId, eventId);
    if (!row || toEvent(row).status === "cancelled") return { ok: false, reason: "not_found", detail: "Event already deleted." };
    if (toEvent(row).etag !== etag) return { ok: false, reason: "conflict", detail: "The event changed since it was read." };
    const d = JSON.parse(row.data_json) as StoredEvent;
    d.status = "cancelled";
    await this.db.run(
      "UPDATE sim_calendar_events SET data_json = ?, etag_counter = etag_counter + 1, updated_at = ? WHERE calendar_id = ? AND event_id = ?",
      JSON.stringify(d),
      this.clock.now(),
      calendarId,
      eventId,
    );
    await logSimProvider(this.db, this.clock, "calendar", "delete", { calendarId, eventId });
    return { ok: true };
  }
}

// ---------- Simulator helpers (act as "the outside world" editing the calendar) ----------

export interface SimEventInput {
  calendarId?: string;
  eventId: string;
  summary: string;
  startMs?: number;
  endMs?: number;
  allDayStart?: string;
  allDayEnd?: string;
  timeZone?: string;
  location?: string | null;
  description?: string | null;
  recurringEventId?: string | null;
  selfResponse?: CalendarEventData["selfResponse"];
  transparency?: CalendarEventData["transparency"];
  hasAttendees?: boolean;
  status?: CalendarEventData["status"];
}

export async function simEnsureCalendars(db: Db): Promise<void> {
  await db.run(
    "INSERT OR IGNORE INTO sim_calendars (id, summary, is_primary, access_role, timezone) VALUES (?, 'Personal (simulated)', 1, 'owner', 'America/Los_Angeles')",
    SIM_PRIMARY_CALENDAR,
  );
}

export async function simUpsertExternalEvent(db: Db, clock: Clock, input: SimEventInput): Promise<void> {
  const allDay = Boolean(input.allDayStart);
  const stored: StoredEvent = {
    summary: input.summary,
    description: input.description ?? null,
    location: input.location ?? null,
    status: input.status ?? "confirmed",
    allDay,
    startMs: allDay ? null : (input.startMs ?? null),
    endMs: allDay ? null : (input.endMs ?? null),
    startDate: input.allDayStart ?? null,
    endDate: input.allDayEnd ?? null,
    timeZone: input.timeZone ?? "America/Los_Angeles",
    transparency: input.transparency ?? "opaque",
    selfResponse: input.selfResponse ?? null,
    hasAttendees: input.hasAttendees ?? false,
    createdByDella: false,
    isRecurringSeries: false,
  };
  await db.run(
    `INSERT INTO sim_calendar_events (calendar_id, event_id, recurring_event_id, etag_counter, data_json, updated_at) VALUES (?, ?, ?, 1, ?, ?)
     ON CONFLICT (calendar_id, event_id) DO UPDATE SET data_json = excluded.data_json, recurring_event_id = excluded.recurring_event_id, etag_counter = sim_calendar_events.etag_counter + 1, updated_at = excluded.updated_at`,
    input.calendarId ?? SIM_PRIMARY_CALENDAR,
    input.eventId,
    input.recurringEventId ?? null,
    JSON.stringify(stored),
    clock.now(),
  );
}

export async function simMoveEvent(db: Db, clock: Clock, calendarId: string, eventId: string, startMs: number, endMs: number): Promise<void> {
  const row = await db.first<Row>("SELECT * FROM sim_calendar_events WHERE calendar_id = ? AND event_id = ?", calendarId, eventId);
  if (!row) throw new Error("No such simulated event");
  const d = JSON.parse(row.data_json) as StoredEvent;
  d.startMs = startMs;
  d.endMs = endMs;
  await db.run(
    "UPDATE sim_calendar_events SET data_json = ?, etag_counter = etag_counter + 1, updated_at = ? WHERE calendar_id = ? AND event_id = ?",
    JSON.stringify(d),
    clock.now(),
    calendarId,
    eventId,
  );
}

export async function simSetRevoked(db: Db, clock: Clock, revoked: boolean): Promise<void> {
  await db.run(
    "INSERT INTO system_state (key, value, updated_at) VALUES ('sim_calendar_revoked', ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    revoked ? "1" : "0",
    clock.now(),
  );
}
