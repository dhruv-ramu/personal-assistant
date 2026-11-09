import { redactText } from "../../security/redaction";
import type { Fetcher } from "../http";
import { isAbortOrNetworkError } from "../http";
import type { ProviderOutcome } from "../types";

export interface TwilioCredentials {
  accountSid: string;
  authToken: string;
}

export const TWILIO_API_BASE = "https://api.twilio.com/2010-04-01";

/**
 * Twilio REST POST with Basic auth (AccountSid:AuthToken). Twilio documents no idempotency
 * key for the Messages or Calls create endpoints, so none is sent; duplicate protection lives
 * in Della's effect outbox instead.
 *
 * Outcome classification:
 *  - 2xx with a SID: accepted (NOT delivered).
 *  - 400/401/403/404: rejected, permanent (invalid number, auth, unsubscribed, registration).
 *  - 429: rejected, retryable (rate limited; the request was not accepted).
 *  - 5xx, timeout, connection failure: unknown (the request may have been accepted).
 */
export async function twilioCreate(
  fetcher: Fetcher,
  creds: TwilioCredentials,
  resource: "Messages" | "Calls",
  form: URLSearchParams,
  timeoutMs = 10_000,
): Promise<ProviderOutcome> {
  const url = `${TWILIO_API_BASE}/Accounts/${encodeURIComponent(creds.accountSid)}/${resource}.json`;
  let res: Response;
  try {
    res = await fetcher(url, {
      method: "POST",
      headers: {
        authorization: `Basic ${btoa(`${creds.accountSid}:${creds.authToken}`)}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (isAbortOrNetworkError(err)) return { kind: "unknown", detail: "Request timed out or connection failed after sending." };
    return { kind: "rejected", retryable: false, code: "client_error", detail: redactText(String(err)) };
  }
  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    // Non-JSON body; classification below relies on status.
  }
  if (res.status >= 200 && res.status < 300) {
    const sid = typeof body.sid === "string" ? body.sid : null;
    if (!sid) return { kind: "unknown", detail: "Provider returned success without a SID." };
    const segments = body.num_segments !== undefined && body.num_segments !== null ? Number(body.num_segments) : null;
    return { kind: "accepted", providerId: sid, providerStatus: String(body.status ?? "queued"), segments: Number.isFinite(segments) ? segments : null };
  }
  const code = body.code !== undefined ? String(body.code) : `http_${res.status}`;
  const detail = redactText(typeof body.message === "string" ? body.message : `HTTP ${res.status}`);
  if (res.status === 429) return { kind: "rejected", retryable: true, code, detail };
  if (res.status >= 500) return { kind: "unknown", detail: `Provider error ${res.status}; acceptance unknown.` };
  return { kind: "rejected", retryable: false, code, detail };
}
