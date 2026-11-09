import {
  CalendarAuthError,
  WebhookVerificationError,
  type CalendarProvider,
  type Planner,
  type PlannerResult,
  type ProviderOutcome,
  type SmsCapabilities,
  type SmsTransport,
  type VerifiedInboundSms,
  type VerifiedSmsStatus,
  type VerifiedVoiceRequest,
  type VoiceCapabilities,
  type VoiceScript,
  type VoiceTransport,
} from "./types";
import { renderTwiml } from "./twilio/voice";

/**
 * Used when a live provider is *selected* but its configuration is invalid. These fail closed and
 * visibly (diagnostics lists the configuration errors) instead of silently falling back to the
 * simulator, so a misconfigured production deployment never looks like it is working.
 */
export class UnconfiguredSmsTransport implements SmsTransport {
  constructor(readonly name: string) {}
  capabilities(): SmsCapabilities {
    return { provider: this.name, live: false, supportsValidityPeriod: false, providerManagedKeywords: true, supportsIdempotencyKey: false };
  }
  async verifyInbound(): Promise<VerifiedInboundSms> {
    throw new WebhookVerificationError("SMS provider not configured", 403);
  }
  async verifyStatusCallback(): Promise<VerifiedSmsStatus> {
    throw new WebhookVerificationError("SMS provider not configured", 403);
  }
  async send(): Promise<ProviderOutcome> {
    return { kind: "rejected", retryable: false, code: "not_configured", detail: "SMS provider configuration is invalid." };
  }
  inboundAck(): Response {
    return new Response("", { status: 503 });
  }
}

export class UnconfiguredVoiceTransport implements VoiceTransport {
  constructor(readonly name: string) {}
  capabilities(): VoiceCapabilities {
    return { provider: this.name, live: false, supportsIdempotencyKey: false };
  }
  async createCall(): Promise<ProviderOutcome> {
    return { kind: "rejected", retryable: false, code: "not_configured", detail: "Voice provider configuration is invalid." };
  }
  async verifyVoiceRequest(): Promise<VerifiedVoiceRequest> {
    throw new WebhookVerificationError("Voice provider not configured", 403);
  }
  render(script: VoiceScript): Response {
    return new Response(renderTwiml(script), { headers: { "content-type": "text/xml; charset=utf-8" } });
  }
}

export class UnconfiguredCalendarProvider implements CalendarProvider {
  constructor(readonly name: string) {}
  private fail(): never {
    throw new CalendarAuthError("Calendar provider configuration is invalid");
  }
  listCalendars = async () => this.fail();
  listEvents = async () => this.fail();
  getEvent = async () => this.fail();
  insertEvent = async () => this.fail();
  patchEvent = async () => this.fail();
  deleteEvent = async () => this.fail();
}

export class UnconfiguredPlanner implements Planner {
  readonly live = false;
  constructor(readonly name: string) {}
  async interpret(): Promise<PlannerResult> {
    return { kind: "disabled", detail: "AI provider configuration is invalid.", usage: { inputTokens: 0, outputTokens: 0 }, model: "none" };
  }
}
