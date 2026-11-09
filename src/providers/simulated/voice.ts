import type { Db } from "../../db/db";
import type { Clock } from "../../domain/time";
import { renderTwiml } from "../twilio/voice";
import { canonicalWebhookUrl, firstParam, normalizeE164, parseForm, readFormBody } from "../twilio/signature";
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
import { SIM_SIGNATURE_HEADER, logSimProvider, nextSimOutcome, simSid, verifySimSignature } from "./common";

/**
 * Simulated voice provider: call creation with scripted outcomes (accepted, rejected, unknown,
 * accepted-but-response-lost); signed instruction/keypad/status webhooks driven by the simulator.
 * It renders the same bounded TwiML as the Twilio adapter so the voice script is exercised.
 */
export class SimulatedVoiceTransport implements VoiceTransport {
  readonly name = "simulated";
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly secret: string,
    private readonly baseUrl: (req: Request) => string,
    /** Production never accepts simulated webhooks, even correctly signed ones. */
    private readonly acceptWebhooks = true,
  ) {}

  capabilities(): VoiceCapabilities {
    return { provider: "simulated", live: false, supportsIdempotencyKey: false };
  }

  async createCall(input: CreateCallInput): Promise<ProviderOutcome> {
    const outcome = await nextSimOutcome(this.db, "call_create");
    await logSimProvider(this.db, this.clock, "voice", "create_call", { effectId: input.effectId, outcome });
    if (outcome === "reject_permanent") return { kind: "rejected", retryable: false, code: "13224", detail: "Simulated invalid destination." };
    if (outcome === "reject_retryable") return { kind: "rejected", retryable: true, code: "20429", detail: "Simulated rate limit." };
    if (outcome === "unknown") return { kind: "unknown", detail: "Simulated timeout before acceptance." };
    const sid = simSid("CA");
    await this.db.run(
      "INSERT INTO sim_calls (sid, instructions_url, status_callback_url, status, created_at) VALUES (?, ?, ?, 'queued', ?)",
      sid,
      input.instructionsUrl,
      input.statusCallbackUrl,
      this.clock.now(),
    );
    if (outcome === "unknown_but_accepted") return { kind: "unknown", detail: "Simulated timeout after acceptance." };
    return { kind: "accepted", providerId: sid, providerStatus: "queued", segments: null };
  }

  async verifyVoiceRequest(request: Request, _kind: VoiceRequestKind): Promise<VerifiedVoiceRequest> {
    if (!this.acceptWebhooks) throw new WebhookVerificationError("Simulated webhooks are disabled in this environment", 403);
    let body: string;
    try {
      body = await readFormBody(request);
    } catch (err) {
      throw new WebhookVerificationError("Unsupported webhook payload", (err as { status?: number }).status === 413 ? 413 : 415);
    }
    const params = parseForm(body);
    const ok = await verifySimSignature(this.secret, canonicalWebhookUrl(this.baseUrl(request), request), params, request.headers.get(SIM_SIGNATURE_HEADER));
    if (!ok) throw new WebhookVerificationError("Invalid signature", 403);
    if (firstParam(params, "AccountSid") !== "ACsimulated") throw new WebhookVerificationError("Unexpected account", 403);
    const callId = firstParam(params, "CallSid");
    if (!callId) throw new WebhookVerificationError("Missing call SID", 400);
    const digits = firstParam(params, "Digits");
    const duration = firstParam(params, "CallDuration");
    return {
      provider: "simulated",
      callId,
      effectRef: new URL(request.url).searchParams.get("e"),
      digits: digits && /^[0-9*#]{1,4}$/.test(digits) ? digits : null,
      callStatus: (firstParam(params, "CallStatus") as CallStatus | null) ?? null,
      durationSec: duration ? Number(duration) : null,
      to: normalizeE164(firstParam(params, "To")),
    };
  }

  render(script: VoiceScript): Response {
    return new Response(renderTwiml(script), { status: 200, headers: { "content-type": "text/xml; charset=utf-8" } });
  }
}
