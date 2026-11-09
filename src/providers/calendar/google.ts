import { redactText } from "../../security/redaction";
import type { Fetcher } from "../http";
import { isAbortOrNetworkError } from "../http";
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

const API = "https://www.googleapis.com/calendar/v3";

export interface AccessTokenSource {
  /** Returns a valid access token, refreshing if needed. Throws CalendarAuthError when revoked. */
  getAccessToken(forceRefresh?: boolean): Promise<string>;
}

interface GoogleEventJson {
  id: string;
  etag: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  recurringEventId?: string;
  recurrence?: string[];
  transparency?: string;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string; timeZone?: string };
  attendees?: Array<{ self?: boolean; responseStatus?: string }>;
  extendedProperties?: { private?: Record<string, string> };
}

export function parseGoogleEvent(calendarId: string, e: GoogleEventJson): CalendarEventData {
  const allDay = Boolean(e.start?.date && !e.start?.dateTime);
  const self = e.attendees?.find((a) => a.self);
  const response = self?.responseStatus;
  return {
    calendarId,
    id: e.id,
    recurringEventId: e.recurringEventId ?? null,
    etag: e.etag,
    summary: e.summary ?? "(no title)",
    description: e.description ?? null,
    location: e.location ?? null,
    status: e.status === "cancelled" ? "cancelled" : e.status === "tentative" ? "tentative" : "confirmed",
    allDay,
    startMs: e.start?.dateTime ? Date.parse(e.start.dateTime) : null,
    endMs: e.end?.dateTime ? Date.parse(e.end.dateTime) : null,
    startDate: e.start?.date ?? null,
    endDate: e.end?.date ?? null,
    timeZone: e.start?.timeZone ?? null,
    transparency: e.transparency === "transparent" ? "transparent" : "opaque",
    selfResponse: response === "accepted" || response === "declined" || response === "tentative" || response === "needsAction" ? response : null,
    hasAttendees: (e.attendees?.filter((a) => !a.self).length ?? 0) > 0,
    createdByDella: e.extendedProperties?.private?.dellaOwner === "della",
    isRecurringSeries: Array.isArray(e.recurrence) && e.recurrence.length > 0,
  };
}

export class GoogleCalendarProvider implements CalendarProvider {
  readonly name = "google";
  constructor(
    private readonly tokens: AccessTokenSource,
    private readonly fetcher: Fetcher,
  ) {}

  private async request(method: string, path: string, opts: { body?: unknown; etag?: string; query?: Record<string, string> } = {}): Promise<Response> {
    const url = new URL(`${API}${path}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.tokens.getAccessToken(attempt > 0);
      const headers: Record<string, string> = { authorization: `Bearer ${token}` };
      if (opts.body !== undefined) headers["content-type"] = "application/json";
      if (opts.etag) headers["if-match"] = opts.etag;
      let res: Response;
      try {
        res = await this.fetcher(url.toString(), {
          method,
          headers,
          body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
          signal: AbortSignal.timeout(10_000),
        });
      } catch (err) {
        if (isAbortOrNetworkError(err)) throw new CalendarUnavailableError("Google Calendar request timed out or failed");
        throw err;
      }
      if (res.status === 401 && attempt === 0) continue;
      if (res.status === 401) throw new CalendarAuthError("Google rejected the access token");
      if (res.status === 429 || res.status >= 500) throw new CalendarUnavailableError(`Google Calendar unavailable (${res.status})`);
      return res;
    }
    throw new CalendarAuthError("Google rejected the access token");
  }

  async listCalendars(): Promise<CalendarInfo[]> {
    const out: CalendarInfo[] = [];
    let pageToken: string | null = null;
    for (let page = 0; page < 5; page++) {
      const query: Record<string, string> = { minAccessRole: "reader", maxResults: "100" };
      if (pageToken) query.pageToken = pageToken;
      const res = await this.request("GET", "/users/me/calendarList", { query });
      if (!res.ok) throw new CalendarUnavailableError(`calendarList failed (${res.status})`);
      const body = (await res.json()) as { items?: Array<Record<string, unknown>>; nextPageToken?: string };
      for (const c of body.items ?? []) {
        out.push({
          id: String(c.id),
          summary: String(c.summaryOverride ?? c.summary ?? c.id),
          primary: c.primary === true,
          accessRole: String(c.accessRole ?? "reader"),
          timeZone: typeof c.timeZone === "string" ? c.timeZone : null,
        });
      }
      pageToken = body.nextPageToken ?? null;
      if (!pageToken) break;
    }
    return out;
  }

  async listEvents(calendarId: string, opts: ListEventsOptions): Promise<{ events: CalendarEventData[]; nextPageToken: string | null }> {
    const query: Record<string, string> = {
      timeMin: new Date(opts.timeMin).toISOString(),
      timeMax: new Date(opts.timeMax).toISOString(),
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: String(Math.min(opts.maxResults ?? 250, 250)),
      showDeleted: "false",
    };
    if (opts.pageToken) query.pageToken = opts.pageToken;
    const res = await this.request("GET", `/calendars/${encodeURIComponent(calendarId)}/events`, { query });
    if (res.status === 404 || res.status === 403) return { events: [], nextPageToken: null };
    if (!res.ok) throw new CalendarUnavailableError(`events.list failed (${res.status})`);
    const body = (await res.json()) as { items?: GoogleEventJson[]; nextPageToken?: string };
    return { events: (body.items ?? []).map((e) => parseGoogleEvent(calendarId, e)), nextPageToken: body.nextPageToken ?? null };
  }

  async getEvent(calendarId: string, eventId: string): Promise<CalendarEventData | null> {
    const res = await this.request("GET", `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`);
    if (res.status === 404 || res.status === 410) return null;
    if (!res.ok) throw new CalendarUnavailableError(`events.get failed (${res.status})`);
    return parseGoogleEvent(calendarId, (await res.json()) as GoogleEventJson);
  }

  async insertEvent(calendarId: string, eventId: string, write: EventWrite): Promise<CalendarWriteResult> {
    const body = {
      id: eventId,
      summary: write.summary,
      description: write.description ?? undefined,
      location: write.location ?? undefined,
      start: { dateTime: new Date(write.startMs).toISOString(), timeZone: write.timeZone },
      end: { dateTime: new Date(write.endMs).toISOString(), timeZone: write.timeZone },
      recurrence: write.recurrence ?? undefined,
      extendedProperties: { private: { dellaOwner: "della", dellaAction: write.dellaActionKey.slice(0, 100) } },
    };
    const res = await this.request("POST", `/calendars/${encodeURIComponent(calendarId)}/events`, { body, query: { sendUpdates: "none" } });
    if (res.status === 409) {
      // Same deterministic ID already exists (e.g. a retried create whose first response was lost).
      const existing = await this.getEvent(calendarId, eventId);
      if (existing && existing.createdByDella) return { ok: true, event: existing };
      return { ok: false, reason: "duplicate", detail: "An event with this ID already exists." };
    }
    if (res.status === 403) return { ok: false, reason: "forbidden", detail: "No write access to this calendar." };
    if (!res.ok) return { ok: false, reason: "invalid", detail: redactText(`events.insert failed (${res.status})`) };
    return { ok: true, event: parseGoogleEvent(calendarId, (await res.json()) as GoogleEventJson) };
  }

  async patchEvent(calendarId: string, eventId: string, patch: EventPatch, etag: string): Promise<CalendarWriteResult> {
    const body: Record<string, unknown> = {};
    if (patch.summary !== undefined) body.summary = patch.summary;
    if (patch.startMs !== undefined) body.start = { dateTime: new Date(patch.startMs).toISOString(), timeZone: patch.timeZone };
    if (patch.endMs !== undefined) body.end = { dateTime: new Date(patch.endMs).toISOString(), timeZone: patch.timeZone };
    const res = await this.request("PATCH", `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, {
      body,
      etag,
      query: { sendUpdates: "none" },
    });
    if (res.status === 412) return { ok: false, reason: "conflict", detail: "The event changed since it was read." };
    if (res.status === 404 || res.status === 410) return { ok: false, reason: "not_found", detail: "Event not found." };
    if (res.status === 403) return { ok: false, reason: "forbidden", detail: "No write access to this event." };
    if (!res.ok) return { ok: false, reason: "invalid", detail: `events.patch failed (${res.status})` };
    return { ok: true, event: parseGoogleEvent(calendarId, (await res.json()) as GoogleEventJson) };
  }

  async deleteEvent(calendarId: string, eventId: string, etag: string): Promise<{ ok: true } | { ok: false; reason: "conflict" | "not_found" | "forbidden"; detail: string }> {
    const res = await this.request("DELETE", `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, {
      etag,
      query: { sendUpdates: "none" },
    });
    if (res.status === 412) return { ok: false, reason: "conflict", detail: "The event changed since it was read." };
    if (res.status === 404 || res.status === 410) return { ok: false, reason: "not_found", detail: "Event already deleted." };
    if (res.status === 403) return { ok: false, reason: "forbidden", detail: "No write access to this event." };
    if (!res.ok) throw new CalendarUnavailableError(`events.delete failed (${res.status})`);
    return { ok: true };
  }
}
