import { bytesToBase64, hmac, timingSafeEqual } from "../../security/crypto";

/**
 * Twilio webhook signature validation, implemented with Web Crypto because the official
 * `twilio` Node package depends on Node's crypto/Buffer. Mirrors twilio-node's
 * `validateRequest` (verified against twilio@6.3.0 source and Twilio's published test vector):
 *
 *   data = fullUrl + for each param name sorted ascending: name + value
 *          (repeated names: unique values sorted ascending, each as name + value)
 *   signature = base64(HMAC-SHA1(authToken, utf8(data)))
 *
 * The URL candidates tried are the URL as configured with and without the default port,
 * matching the official library. `X-Twilio-Webhooks-Signature-Settings` may select
 * HMAC_SHA256; any other algorithm fails closed.
 */

export type FormParams = Map<string, string[]>;

export function parseForm(body: string): FormParams {
  const params: FormParams = new Map();
  for (const [k, v] of new URLSearchParams(body)) {
    const list = params.get(k);
    if (list) list.push(v);
    else params.set(k, [v]);
  }
  return params;
}

export function firstParam(params: FormParams, name: string): string | null {
  return params.get(name)?.[0] ?? null;
}

export function signaturePayload(url: string, params: FormParams): string {
  let data = url;
  for (const key of [...params.keys()].sort()) {
    const values = params.get(key)!;
    const unique = values.length > 1 ? [...new Set(values)].sort() : values;
    for (const v of unique) data += key + v;
  }
  return data;
}

export function signatureAlgorithm(settingsHeader: string | null): "SHA-1" | "SHA-256" | null {
  if (!settingsHeader) return "SHA-1";
  for (const part of settingsHeader.split(",")) {
    const i = part.indexOf("=");
    if (i !== -1 && part.slice(0, i).trim() === "algorithm") {
      const alg = part
        .slice(i + 1)
        .trim()
        .toUpperCase();
      if (!alg || alg === "HMAC_SHA1") return "SHA-1";
      if (alg === "HMAC_SHA256") return "SHA-256";
      return null;
    }
  }
  return "SHA-1";
}

export async function computeSignature(secret: string, url: string, params: FormParams, algorithm: "SHA-1" | "SHA-256" = "SHA-1"): Promise<string> {
  return bytesToBase64(await hmac(algorithm, secret, signaturePayload(url, params)));
}

const URL_PARTS = /^(https?):\/\/([^/:?#]+)(?::(\d+))?(.*)$/i;

/** String-level port handling: `new URL()` would silently drop an explicit default port. */
function withPort(url: string): string {
  const m = URL_PARTS.exec(url);
  if (!m || m[3]) return url;
  return `${m[1]}://${m[2]}:${m[1]!.toLowerCase() === "https" ? "443" : "80"}${m[4]}`;
}

function withoutPort(url: string): string {
  const m = URL_PARTS.exec(url);
  if (!m || !m[3]) return url;
  return `${m[1]}://${m[2]}${m[4]}`;
}

export async function validateSignature(opts: { secret: string; signature: string | null; url: string; params: FormParams; algorithm?: "SHA-1" | "SHA-256" }): Promise<boolean> {
  if (!opts.signature) return false;
  const algorithm = opts.algorithm ?? "SHA-1";
  for (const candidate of new Set([withoutPort(opts.url), withPort(opts.url)])) {
    const expected = await computeSignature(opts.secret, candidate, opts.params, algorithm);
    if (timingSafeEqual(expected, opts.signature)) return true;
  }
  return false;
}

/**
 * The trusted canonical URL = configured public origin + the request's path and query string.
 * The host is never taken from Host/X-Forwarded-* headers.
 */
export function canonicalWebhookUrl(publicBaseUrl: string, request: Request): string {
  const u = new URL(request.url);
  return `${publicBaseUrl}${u.pathname}${u.search}`;
}

export const MAX_WEBHOOK_BODY_BYTES = 32 * 1024;

export async function readFormBody(request: Request): Promise<string> {
  const ct = (request.headers.get("content-type") ?? "").toLowerCase();
  if (!ct.startsWith("application/x-www-form-urlencoded")) {
    throw Object.assign(new Error("Unsupported content type"), { status: 415 });
  }
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_WEBHOOK_BODY_BYTES) throw Object.assign(new Error("Payload too large"), { status: 413 });
  const text = await request.text();
  if (text.length > MAX_WEBHOOK_BODY_BYTES) throw Object.assign(new Error("Payload too large"), { status: 413 });
  return text;
}

export function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]!);
}

export function normalizeE164(raw: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  return /^\+[1-9]\d{7,14}$/.test(trimmed) ? trimmed : null;
}
