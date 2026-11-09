import type { Db } from "../../db/db";
import type { Clock } from "../../domain/time";
import { canonicalWebhookUrl, firstParam, normalizeE164, parseForm, readFormBody } from "../twilio/signature";
import {
  WebhookVerificationError,
  type ProviderKeyword,
  type ProviderOutcome,
  type SendSmsInput,
  type SmsCapabilities,
  type SmsDeliveryStatus,
  type SmsTransport,
  type VerifiedInboundSms,
  type VerifiedSmsStatus,
} from "../types";
import { SIM_SIGNATURE_HEADER, logSimProvider, nextSimOutcome, simSid, verifySimSignature } from "./common";

export const SIM_DELLA_NUMBER = "+15550100999";

/**
 * Deterministic simulated SMS provider. It mirrors the provider lifecycle: signed inbound webhooks,
 * acceptance separate from delivery, signed status callbacks, scripted rejections and unknown
 * outcomes. Messages it "sends" are written to sim_messages for the simulator UI and tests.
 */
export class SimulatedSmsTransport implements SmsTransport {
  readonly name = "simulated";
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly secret: string,
    private readonly baseUrl: (req: Request) => string,
    /** Production never accepts simulated webhooks, even correctly signed ones. */
    private readonly acceptWebhooks = true,
  ) {}

  capabilities(): SmsCapabilities {
    return { provider: "simulated", live: false, supportsValidityPeriod: true, providerManagedKeywords: true, supportsIdempotencyKey: false };
  }

  private async verify(request: Request) {
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
    return params;
  }

  async verifyInbound(request: Request): Promise<VerifiedInboundSms> {
    const params = await this.verify(request);
    const sid = firstParam(params, "MessageSid");
    if (!sid) throw new WebhookVerificationError("Missing message SID", 400);
    const to = normalizeE164(firstParam(params, "To"));
    if (to !== SIM_DELLA_NUMBER) throw new WebhookVerificationError("Unexpected destination number", 403);
    const from = normalizeE164(firstParam(params, "From"));
    if (!from) throw new WebhookVerificationError("Invalid sender", 400);
    const kw = (firstParam(params, "OptOutType") ?? "").toUpperCase();
    const providerKeyword: ProviderKeyword = kw === "STOP" ? "stop" : kw === "START" ? "start" : kw === "HELP" ? "help" : null;
    return {
      provider: "simulated",
      providerMessageId: sid,
      from,
      to,
      body: firstParam(params, "Body") ?? "",
      numMedia: Number(firstParam(params, "NumMedia") ?? "0") || 0,
      mediaUrls: Array.from({ length: Math.min(Number(firstParam(params, "NumMedia") ?? "0") || 0, 10) }, (_, i) => firstParam(params, `MediaUrl${i}`) ?? "").filter((u) =>
        u.startsWith("sim-media:"),
      ),
      providerKeyword,
      metadata: { simulated: "true" },
    };
  }

  async verifyStatusCallback(request: Request): Promise<VerifiedSmsStatus> {
    const params = await this.verify(request);
    const sid = firstParam(params, "MessageSid");
    if (!sid) throw new WebhookVerificationError("Missing message SID", 400);
    return {
      provider: "simulated",
      providerMessageId: sid,
      effectRef: new URL(request.url).searchParams.get("e"),
      status: ((firstParam(params, "MessageStatus") ?? "unknown").toLowerCase() as SmsDeliveryStatus) ?? "unknown",
      errorCode: firstParam(params, "ErrorCode"),
      to: normalizeE164(firstParam(params, "To")),
    };
  }

  async send(input: SendSmsInput): Promise<ProviderOutcome> {
    const outcome = await nextSimOutcome(this.db, "sms_send");
    await logSimProvider(this.db, this.clock, "sms", "send", { effectId: input.effectId, outcome });
    if (outcome === "reject_permanent") return { kind: "rejected", retryable: false, code: "21610", detail: "Simulated permanent rejection." };
    if (outcome === "reject_retryable") return { kind: "rejected", retryable: true, code: "20429", detail: "Simulated rate limit." };
    if (outcome === "unknown") return { kind: "unknown", detail: "Simulated timeout before acceptance (message not created)." };
    const sid = simSid("SM");
    await this.db.run(
      "INSERT INTO sim_messages (id, direction, body, provider_sid, status, status_callback_url, created_at) VALUES (?, 'to_owner', ?, ?, 'queued', ?, ?)",
      `simmsg_${sid}`,
      input.body,
      sid,
      input.statusCallbackUrl,
      this.clock.now(),
    );
    if (outcome === "unknown_but_accepted") return { kind: "unknown", detail: "Simulated timeout after the provider accepted the message." };
    return { kind: "accepted", providerId: sid, providerStatus: "queued", segments: null };
  }

  inboundAck(): Response {
    return new Response('<?xml version="1.0" encoding="UTF-8"?><Response></Response>', { status: 200, headers: { "content-type": "text/xml; charset=utf-8" } });
  }
}
