import type { Db } from "../../db/db";
import type { Clock } from "../../domain/time";
import { bytesToHex, randomBytes } from "../../security/crypto";
import { computeSignature, validateSignature, type FormParams } from "../twilio/signature";

export type SimOutcome =
  | "accept"
  | "reject_permanent"
  | "reject_retryable"
  | "unknown"
  | "unknown_but_accepted"
  | "revoked"
  | "unavailable"
  | "timeout"
  | "refusal"
  | "invalid"
  | "incomplete"
  | "rate_limited";

/** Pops the next scripted outcome for an operation (FIFO); default is success. */
export async function nextSimOutcome(db: Db, operation: string): Promise<SimOutcome> {
  const row = await db.first<{ id: number; outcome: string }>("SELECT id, outcome FROM sim_behaviors WHERE operation = ? ORDER BY id LIMIT 1", operation);
  if (!row) return "accept";
  const removed = await db.run("DELETE FROM sim_behaviors WHERE id = ?", row.id);
  return removed === 1 ? (row.outcome as SimOutcome) : "accept";
}

export async function scriptSimOutcome(db: Db, operation: string, outcome: SimOutcome, clock: Clock, times = 1): Promise<void> {
  for (let i = 0; i < times; i++) {
    await db.run("INSERT INTO sim_behaviors (operation, outcome, created_at) VALUES (?, ?, ?)", operation, outcome, clock.now());
  }
}

export async function logSimProvider(db: Db, clock: Clock, provider: string, operation: string, detail: Record<string, unknown>): Promise<void> {
  await db.run("INSERT INTO sim_provider_log (provider, operation, detail, created_at) VALUES (?, ?, ?, ?)", provider, operation, JSON.stringify(detail), clock.now());
}

export function simSid(prefix: "SM" | "CA"): string {
  return `${prefix}${bytesToHex(randomBytes(16))}`;
}

export const SIM_SIGNATURE_HEADER = "x-sim-signature";

/** Simulated webhooks are signed exactly like provider webhooks, with HMAC-SHA256 and the simulator secret. */
export async function signSimRequest(secret: string, url: string, params: FormParams): Promise<string> {
  return computeSignature(secret, url, params, "SHA-256");
}

export async function verifySimSignature(secret: string, url: string, params: FormParams, signature: string | null): Promise<boolean> {
  return validateSignature({ secret, signature, url, params, algorithm: "SHA-256" });
}
