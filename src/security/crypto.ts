import type { EncryptionKey } from "../config";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function utf8(s: string): Uint8Array {
  return encoder.encode(s);
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  return base64ToBytes(b64);
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += bytes[i]!.toString(16).padStart(2, "0");
  return out;
}

export function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

export function randomToken(nBytes = 32): string {
  return bytesToBase64Url(randomBytes(nBytes));
}

export async function sha256(data: string | Uint8Array): Promise<Uint8Array> {
  const input = typeof data === "string" ? utf8(data) : data;
  return new Uint8Array(await crypto.subtle.digest("SHA-256", input));
}

export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  return bytesToHex(await sha256(data));
}

export async function hmac(algorithm: "SHA-1" | "SHA-256", key: string | Uint8Array, data: string): Promise<Uint8Array> {
  const keyBytes = typeof key === "string" ? utf8(key) : key;
  const cryptoKey = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: algorithm }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, utf8(data)));
}

/** Constant-time comparison of two strings (length leak only). */
export function timingSafeEqual(a: string, b: string): boolean {
  const ab = utf8(a);
  const bb = utf8(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i]! ^ bb[i]!;
  return diff === 0;
}

/** Compares secrets of different lengths without short-circuiting by hashing both first. */
export async function secretsEqual(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([sha256Hex(a), sha256Hex(b)]);
  return timingSafeEqual(ha, hb);
}

const ENVELOPE_VERSION = "v1";

/**
 * Authenticated encryption for sensitive stored text (AES-256-GCM, random 96-bit nonce per value).
 * Envelope: `v1.<keyId>.<nonce b64url>.<ciphertext+tag b64url>`. The key id enables rotation:
 * new writes use the current key; reads accept the current or any configured previous key.
 */
export class FieldCrypto {
  private readonly keys = new Map<string, Promise<CryptoKey>>();
  private readonly currentId: string;

  constructor(current: EncryptionKey, previous: EncryptionKey[] = []) {
    this.currentId = current.id;
    for (const k of [current, ...previous]) {
      if (!this.keys.has(k.id)) {
        this.keys.set(k.id, crypto.subtle.importKey("raw", k.raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]));
      }
    }
  }

  get currentKeyId(): string {
    return this.currentId;
  }

  async encrypt(plaintext: string, aad = ""): Promise<string> {
    const key = await this.keys.get(this.currentId)!;
    const iv = randomBytes(12);
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: utf8(aad) }, key, utf8(plaintext));
    return `${ENVELOPE_VERSION}.${this.currentId}.${bytesToBase64Url(iv)}.${bytesToBase64Url(new Uint8Array(ct))}`;
  }

  async encryptNullable(plaintext: string | null | undefined, aad = ""): Promise<string | null> {
    if (plaintext === null || plaintext === undefined) return null;
    return this.encrypt(plaintext, aad);
  }

  async decrypt(envelope: string, aad = ""): Promise<string> {
    const parts = envelope.split(".");
    if (parts.length !== 4 || parts[0] !== ENVELOPE_VERSION) throw new Error("Unsupported ciphertext envelope");
    const keyPromise = this.keys.get(parts[1]!);
    if (!keyPromise) throw new Error(`Missing decryption key '${parts[1]}' (configure DATA_ENCRYPTION_KEY_PREVIOUS)`);
    const key = await keyPromise;
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: base64UrlToBytes(parts[2]!), additionalData: utf8(aad) }, key, base64UrlToBytes(parts[3]!));
    return decoder.decode(pt);
  }

  async decryptNullable(envelope: string | null | undefined, aad = ""): Promise<string | null> {
    if (envelope === null || envelope === undefined) return null;
    return this.decrypt(envelope, aad);
  }

  keyIdOf(envelope: string): string | null {
    const parts = envelope.split(".");
    return parts.length === 4 ? parts[1]! : null;
  }
}

const SHORT_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

/** Short, human-typable code such as `T4K8`: prefix + 3 characters without ambiguous glyphs. */
export function shortCodeFromBytes(prefix: string, bytes: Uint8Array, offset = 0): string {
  let out = prefix;
  for (let i = 0; i < 3; i++) out += SHORT_ALPHABET[bytes[(offset + i) % bytes.length]! % SHORT_ALPHABET.length];
  return out;
}

export function isShortCode(value: string, prefix: string): boolean {
  return new RegExp(`^${prefix}[${SHORT_ALPHABET}]{3}$`).test(value);
}

export const SHORT_CODE_ALPHABET = SHORT_ALPHABET;

/** Random identifier with a readable prefix, e.g. `tsk_9f…`. */
export function newId(prefix: string): string {
  return `${prefix}_${bytesToHex(randomBytes(12))}`;
}

/** Deterministic identifier derived from a stable logical key (idempotent retries). */
export async function stableId(prefix: string, logicalKey: string): Promise<string> {
  const h = await sha256(logicalKey);
  return `${prefix}_${bytesToHex(h.slice(0, 12))}`;
}

const BASE32HEX = "0123456789abcdefghijklmnopqrstuv";

/** Google Calendar event IDs allow base32hex characters (0-9, a-v), length 5-1024. */
export async function googleEventIdFor(actionKey: string): Promise<string> {
  const h = await sha256(`della-event:${actionKey}`);
  let bits = 0;
  let value = 0;
  let out = "della";
  // "della" contains only a-v characters, so the prefix is valid base32hex.
  for (const byte of h) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32HEX[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out.slice(0, 32);
}
