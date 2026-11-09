import type { Interpretation } from "../domain/actions";

/** Thrown by adapters when a webhook fails verification. Never includes secret material. */
export class WebhookVerificationError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 401 | 403 | 413 | 415 = 403,
  ) {
    super(message);
    this.name = "WebhookVerificationError";
  }
}

// ---------------- SMS ----------------

export type ProviderKeyword = "stop" | "start" | "help" | null;

export interface VerifiedInboundSms {
  provider: string;
  providerMessageId: string;
  from: string; // E.164, normalized after signature verification
  to: string;
  body: string;
  numMedia: number;
  /** Provider media URLs (MMS); fetched only when MMS ingestion is enabled. */
  mediaUrls: string[];
  /** Keyword classification reported by the provider (e.g. Twilio Advanced Opt-Out `OptOutType`). */
  providerKeyword: ProviderKeyword;
  metadata: Record<string, string>;
}

export type SmsDeliveryStatus = "accepted" | "queued" | "sending" | "sent" | "delivered" | "undelivered" | "failed" | "canceled" | "unknown";

export interface VerifiedSmsStatus {
  provider: string;
  providerMessageId: string;
  effectRef: string | null;
  status: SmsDeliveryStatus;
  errorCode: string | null;
  to: string | null;
}

export interface SendSmsInput {
  to: string;
  body: string;
  effectId: string;
  statusCallbackUrl: string;
  /** Seconds the provider may keep the message queued before discarding it. */
  validitySeconds: number;
}

export type ProviderOutcome =
  | { kind: "accepted"; providerId: string; providerStatus: string; segments: number | null }
  /** Provider definitively did not accept the request. */
  | { kind: "rejected"; retryable: boolean; code: string; detail: string }
  /** The request may or may not have been accepted (timeout, connection reset, 5xx after send). */
  | { kind: "unknown"; detail: string };

export interface SmsCapabilities {
  provider: string;
  live: boolean;
  supportsValidityPeriod: boolean;
  /** Provider answers STOP/START/HELP itself; Della must not send a duplicate reply. */
  providerManagedKeywords: boolean;
  /** Twilio documents no idempotency key for Messages; adapters must not pretend otherwise. */
  supportsIdempotencyKey: boolean;
}

export interface SmsTransport {
  readonly name: string;
  verifyInbound(request: Request): Promise<VerifiedInboundSms>;
  verifyStatusCallback(request: Request): Promise<VerifiedSmsStatus>;
  send(input: SendSmsInput): Promise<ProviderOutcome>;
  capabilities(): SmsCapabilities;
  /** Fast acknowledgement body after durable ingestion (e.g. empty TwiML). */
  inboundAck(): Response;
}

// ---------------- Voice ----------------

export interface CreateCallInput {
  to: string;
  effectId: string;
  instructionsUrl: string;
  statusCallbackUrl: string;
  ringTimeoutSec: number;
  maxDurationSec: number;
}

export type VoiceRequestKind = "instructions" | "gather" | "status";

export type CallStatus = "queued" | "initiated" | "ringing" | "in-progress" | "completed" | "busy" | "no-answer" | "failed" | "canceled";

export interface VerifiedVoiceRequest {
  provider: string;
  callId: string;
  effectRef: string | null;
  digits: string | null;
  callStatus: CallStatus | null;
  durationSec: number | null;
  to: string | null;
}

export type VoiceScript = { kind: "prompt"; text: string; gatherActionUrl: string; inputTimeoutSec: number; repeatText: string } | { kind: "say_hangup"; text: string };

export interface VoiceCapabilities {
  provider: string;
  live: boolean;
  supportsIdempotencyKey: boolean;
}

export interface VoiceTransport {
  readonly name: string;
  createCall(input: CreateCallInput): Promise<ProviderOutcome>;
  verifyVoiceRequest(request: Request, kind: VoiceRequestKind): Promise<VerifiedVoiceRequest>;
  render(script: VoiceScript): Response;
  capabilities(): VoiceCapabilities;
}

// ---------------- Calendar ----------------

export class CalendarAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CalendarAuthError";
  }
}

export class CalendarUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CalendarUnavailableError";
  }
}

export interface CalendarInfo {
  id: string;
  summary: string;
  primary: boolean;
  accessRole: string;
  timeZone: string | null;
}

export interface CalendarEventData {
  calendarId: string;
  id: string;
  recurringEventId: string | null;
  etag: string;
  summary: string;
  description: string | null;
  location: string | null;
  status: "confirmed" | "tentative" | "cancelled";
  allDay: boolean;
  /** Timed events: epoch ms. All-day events: null, with startDate/endDate (end exclusive). */
  startMs: number | null;
  endMs: number | null;
  startDate: string | null;
  endDate: string | null;
  timeZone: string | null;
  transparency: "opaque" | "transparent";
  selfResponse: "accepted" | "declined" | "tentative" | "needsAction" | null;
  hasAttendees: boolean;
  createdByDella: boolean;
  isRecurringSeries: boolean;
}

export interface EventWrite {
  summary: string;
  description: string | null;
  location: string | null;
  startMs: number;
  endMs: number;
  timeZone: string;
  recurrence: string[] | null;
  dellaActionKey: string;
}

export interface EventPatch {
  summary?: string;
  startMs?: number;
  endMs?: number;
  timeZone?: string;
}

export type CalendarWriteResult = { ok: true; event: CalendarEventData } | { ok: false; reason: "conflict" | "not_found" | "duplicate" | "forbidden" | "invalid"; detail: string };

export interface ListEventsOptions {
  timeMin: number;
  timeMax: number;
  pageToken?: string | null;
  maxResults?: number;
}

export interface CalendarProvider {
  readonly name: string;
  listCalendars(): Promise<CalendarInfo[]>;
  listEvents(calendarId: string, opts: ListEventsOptions): Promise<{ events: CalendarEventData[]; nextPageToken: string | null }>;
  getEvent(calendarId: string, eventId: string): Promise<CalendarEventData | null>;
  insertEvent(calendarId: string, eventId: string, write: EventWrite): Promise<CalendarWriteResult>;
  patchEvent(calendarId: string, eventId: string, patch: EventPatch, etag: string): Promise<CalendarWriteResult>;
  deleteEvent(calendarId: string, eventId: string, etag: string): Promise<{ ok: true } | { ok: false; reason: "conflict" | "not_found" | "forbidden"; detail: string }>;
}

// ---------------- AI planner ----------------

export interface PlannerContext {
  messageText: string;
  nowUtcIso: string;
  localNow: string;
  timezone: string;
  ownerName: string;
  recentTurns: Array<{ direction: "in" | "out"; text: string; at: string }>;
  pendingQuestion: string | null;
  openTasks: Array<{ ref: string; title: string; due: string | null }>;
  /** Untrusted external calendar text, passed only as data. */
  upcomingEvents: Array<{ title: string; when: string }>;
  capabilitiesNote: string;
  /** Optional vocabulary offered to the model; omitted parts aren't sent (smaller, cheaper requests). */
  features?: { memory: boolean; knowledge?: boolean; accountability: boolean };
}

export type PlannerResult =
  | { kind: "ok"; interpretation: Interpretation; usage: { inputTokens: number; outputTokens: number; cachedInputTokens?: number }; model: string }
  | {
      kind: "refused" | "invalid" | "incomplete" | "unavailable" | "timeout" | "rate_limited" | "disabled";
      detail: string;
      usage: { inputTokens: number; outputTokens: number; cachedInputTokens?: number };
      model: string;
    };

export interface Planner {
  readonly name: string;
  readonly live: boolean;
  interpret(ctx: PlannerContext): Promise<PlannerResult>;
}
