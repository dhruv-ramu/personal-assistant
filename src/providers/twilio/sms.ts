import type { Fetcher } from "../http";
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
import { twilioCreate } from "./client";
import { canonicalWebhookUrl, firstParam, normalizeE164, parseForm, readFormBody, signatureAlgorithm, validateSignature, type FormParams } from "./signature";

export interface TwilioSmsConfig {
  accountSid: string;
  authToken: string;
  phoneNumber: string;
  messagingServiceSid: string | null;
  publicBaseUrl: string;
  providerManagedKeywords: boolean;
  live: boolean;
}

const STATUS_MAP: Record<string, SmsDeliveryStatus> = {
  accepted: "accepted",
  scheduled: "accepted",
  queued: "queued",
  sending: "sending",
  sent: "sent",
  delivered: "delivered",
  read: "delivered",
  undelivered: "undelivered",
  failed: "failed",
  canceled: "canceled",
};

export async function verifyTwilioRequest(request: Request, cfg: { authToken: string; accountSid: string; publicBaseUrl: string }): Promise<FormParams> {
  let body: string;
  try {
    body = await readFormBody(request);
  } catch (err) {
    const status = (err as { status?: number }).status === 413 ? 413 : 415;
    throw new WebhookVerificationError("Unsupported webhook payload", status);
  }
  const params = parseForm(body);
  const algorithm = signatureAlgorithm(request.headers.get("x-twilio-webhooks-signature-settings"));
  if (!algorithm) throw new WebhookVerificationError("Unsupported signature algorithm", 403);
  const ok = await validateSignature({
    secret: cfg.authToken,
    signature: request.headers.get("x-twilio-signature"),
    url: canonicalWebhookUrl(cfg.publicBaseUrl, request),
    params,
    algorithm,
  });
  if (!ok) throw new WebhookVerificationError("Invalid signature", 403);
  // Post-verification checks on the original (signed) values.
  if (firstParam(params, "AccountSid") !== cfg.accountSid) throw new WebhookVerificationError("Unexpected account", 403);
  return params;
}

export class TwilioSmsTransport implements SmsTransport {
  readonly name = "twilio";
  constructor(
    private readonly cfg: TwilioSmsConfig,
    private readonly fetcher: Fetcher,
  ) {}

  capabilities(): SmsCapabilities {
    return {
      provider: "twilio",
      live: this.cfg.live,
      supportsValidityPeriod: true,
      providerManagedKeywords: this.cfg.providerManagedKeywords,
      supportsIdempotencyKey: false,
    };
  }

  async verifyInbound(request: Request): Promise<VerifiedInboundSms> {
    const params = await verifyTwilioRequest(request, this.cfg);
    const sid = firstParam(params, "MessageSid") ?? firstParam(params, "SmsSid");
    if (!sid || !/^(SM|MM)[0-9a-fA-F]{32}$/.test(sid)) throw new WebhookVerificationError("Missing message SID", 400);
    const to = normalizeE164(firstParam(params, "To"));
    if (to !== this.cfg.phoneNumber) throw new WebhookVerificationError("Unexpected destination number", 403);
    const from = normalizeE164(firstParam(params, "From"));
    if (!from) throw new WebhookVerificationError("Invalid sender", 400);
    const optOut = (firstParam(params, "OptOutType") ?? "").toUpperCase();
    const providerKeyword: ProviderKeyword = optOut === "STOP" ? "stop" : optOut === "START" ? "start" : optOut === "HELP" ? "help" : null;
    const numMedia = Number(firstParam(params, "NumMedia") ?? "0");
    return {
      provider: "twilio",
      providerMessageId: sid,
      from,
      to,
      body: firstParam(params, "Body") ?? "",
      numMedia: Number.isFinite(numMedia) ? numMedia : 0,
      mediaUrls: Array.from({ length: Math.min(Number.isFinite(numMedia) ? numMedia : 0, 10) }, (_, i) => firstParam(params, `MediaUrl${i}`) ?? "").filter((u) =>
        u.startsWith("https://api.twilio.com/"),
      ),
      providerKeyword,
      metadata: {
        numSegments: firstParam(params, "NumSegments") ?? "",
        fromCountry: firstParam(params, "FromCountry") ?? "",
      },
    };
  }

  async verifyStatusCallback(request: Request): Promise<VerifiedSmsStatus> {
    const params = await verifyTwilioRequest(request, this.cfg);
    const sid = firstParam(params, "MessageSid") ?? firstParam(params, "SmsSid");
    if (!sid || !/^(SM|MM)[0-9a-fA-F]{32}$/.test(sid)) throw new WebhookVerificationError("Missing message SID", 400);
    const raw = (firstParam(params, "MessageStatus") ?? firstParam(params, "SmsStatus") ?? "").toLowerCase();
    return {
      provider: "twilio",
      providerMessageId: sid,
      effectRef: new URL(request.url).searchParams.get("e"),
      status: STATUS_MAP[raw] ?? "unknown",
      errorCode: firstParam(params, "ErrorCode"),
      to: normalizeE164(firstParam(params, "To")),
    };
  }

  async send(input: SendSmsInput): Promise<ProviderOutcome> {
    const form = new URLSearchParams();
    form.set("To", input.to);
    // With a Messaging Service SID, Twilio selects the sender from the service's sender pool.
    if (this.cfg.messagingServiceSid) form.set("MessagingServiceSid", this.cfg.messagingServiceSid);
    else form.set("From", this.cfg.phoneNumber);
    form.set("Body", input.body);
    form.set("StatusCallback", input.statusCallbackUrl);
    form.set("ValidityPeriod", String(Math.max(5, Math.min(36000, Math.floor(input.validitySeconds)))));
    return twilioCreate(this.fetcher, this.cfg, "Messages", form);
  }

  inboundAck(): Response {
    return new Response('<?xml version="1.0" encoding="UTF-8"?><Response></Response>', {
      status: 200,
      headers: { "content-type": "text/xml; charset=utf-8" },
    });
  }
}
