import type { Fetcher } from "../http";
import {
  WebhookVerificationError,
  type CallStatus,
  type CreateCallInput,
  type ProviderOutcome,
  type VerifiedVoiceRequest,
  type VoiceCapabilities,
  type VoiceRequestKind,
  type VoiceScript,
  type VoiceTransport,
} from "../types";
import { twilioCreate } from "./client";
import { escapeXml, firstParam, normalizeE164 } from "./signature";
import { verifyTwilioRequest } from "./sms";

export interface TwilioVoiceConfig {
  accountSid: string;
  authToken: string;
  phoneNumber: string;
  publicBaseUrl: string;
  live: boolean;
}

const CALL_STATUSES: ReadonlySet<string> = new Set(["queued", "initiated", "ringing", "in-progress", "completed", "busy", "no-answer", "failed", "canceled"]);

/** Renders a bounded TwiML script: at most two keypad prompts, then hang up. No redirects. */
export function renderTwiml(script: VoiceScript): string {
  if (script.kind === "say_hangup") {
    return `<?xml version="1.0" encoding="UTF-8"?><Response><Say>${escapeXml(script.text)}</Say><Hangup/></Response>`;
  }
  const action = escapeXml(script.gatherActionUrl);
  const gather = (text: string) =>
    `<Gather input="dtmf" numDigits="1" timeout="${script.inputTimeoutSec}" action="${action}" method="POST" actionOnEmptyResult="false"><Say>${escapeXml(text)}</Say></Gather>`;
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${gather(script.text)}${gather(script.repeatText)}<Say>No response received. Goodbye.</Say><Hangup/></Response>`;
}

export class TwilioVoiceTransport implements VoiceTransport {
  readonly name = "twilio";
  constructor(
    private readonly cfg: TwilioVoiceConfig,
    private readonly fetcher: Fetcher,
  ) {}

  capabilities(): VoiceCapabilities {
    return { provider: "twilio", live: this.cfg.live, supportsIdempotencyKey: false };
  }

  async createCall(input: CreateCallInput): Promise<ProviderOutcome> {
    const form = new URLSearchParams();
    form.set("To", input.to);
    form.set("From", this.cfg.phoneNumber);
    form.set("Url", input.instructionsUrl);
    form.set("Method", "POST");
    form.set("StatusCallback", input.statusCallbackUrl);
    form.set("StatusCallbackMethod", "POST");
    for (const ev of ["initiated", "ringing", "answered", "completed"]) form.append("StatusCallbackEvent", ev);
    form.set("Timeout", String(input.ringTimeoutSec));
    form.set("TimeLimit", String(input.maxDurationSec));
    return twilioCreate(this.fetcher, this.cfg, "Calls", form);
  }

  async verifyVoiceRequest(request: Request, _kind: VoiceRequestKind): Promise<VerifiedVoiceRequest> {
    const params = await verifyTwilioRequest(request, this.cfg);
    const callSid = firstParam(params, "CallSid");
    if (!callSid || !/^CA[0-9a-fA-F]{32}$/.test(callSid)) throw new WebhookVerificationError("Missing call SID", 400);
    const from = normalizeE164(firstParam(params, "From"));
    if (from !== null && from !== this.cfg.phoneNumber) throw new WebhookVerificationError("Unexpected caller ID", 403);
    const statusRaw = (firstParam(params, "CallStatus") ?? "").toLowerCase();
    const duration = firstParam(params, "CallDuration");
    const digits = firstParam(params, "Digits");
    return {
      provider: "twilio",
      callId: callSid,
      effectRef: new URL(request.url).searchParams.get("e"),
      digits: digits && /^[0-9*#]{1,4}$/.test(digits) ? digits : null,
      callStatus: CALL_STATUSES.has(statusRaw) ? (statusRaw as CallStatus) : null,
      durationSec: duration !== null && /^\d+$/.test(duration) ? Number(duration) : null,
      to: normalizeE164(firstParam(params, "To")),
    };
  }

  render(script: VoiceScript): Response {
    return new Response(renderTwiml(script), { status: 200, headers: { "content-type": "text/xml; charset=utf-8" } });
  }
}
