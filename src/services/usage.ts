import type { AppContext } from "../context";
import { newId } from "../security/crypto";
import { todayLocal } from "../domain/time";
import { getSettings, type OwnerSettings } from "./settings";

export type UsageMetric = "inbound" | "sms_segments" | "call_attempts" | "call_minutes" | "ai_requests" | "embeddings" | "semantic_queries" | "media_bytes" | "image_assessments";

/**
 * Dated unit prices used only for ESTIMATES (not invoices). Checked 2026-11-08 from public pricing
 * pages; see docs/COSTS.md. Update the date and values when re-verifying.
 */
export const PRICE_SHEET = {
  checkedOn: "2026-11-08",
  openai: { model: "gpt-6-luna", inputPerMTokUsd: 0.1, outputPerMTokUsd: 0.5 },
  twilio: { smsSegmentUsd: 0.0083, carrierFeeEstimateUsd: 0.003, voiceOutboundPerMinUsd: 0.014, numberPerMonthUsd: 1.15 },
} as const;

export function estimateAiCostUsd(inputTokens: number, outputTokens: number): number {
  return (inputTokens * PRICE_SHEET.openai.inputPerMTokUsd + outputTokens * PRICE_SHEET.openai.outputPerMTokUsd) / 1_000_000;
}

export function limitFor(settings: OwnerSettings, metric: UsageMetric): number {
  switch (metric) {
    case "inbound":
      return settings.limit_inbound_per_day;
    case "sms_segments":
      return settings.limit_sms_segments_per_day;
    case "call_attempts":
      return settings.limit_call_attempts_per_day;
    case "call_minutes":
      return settings.limit_call_minutes_per_day;
    case "ai_requests":
      return settings.limit_ai_requests_per_day;
    default:
      // Extension metrics pass an explicit limit from ext_settings.
      return 0;
  }
}

export function usageDay(ctx: AppContext, tz: string): string {
  return todayLocal(ctx.clock.now(), tz);
}

/**
 * Atomically reserves `amount` of a daily quantity. Implemented as one D1 batch (one transaction):
 * insert a reservation row, then conditionally increment the counter only if the insert happened
 * and the limit holds, then delete the new reservation row if the increment did not happen.
 * Re-reserving the same key is idempotent (retries do not double-count).
 */
export async function reserveUsage(ctx: AppContext, key: string, metric: UsageMetric, amount: number, opts: { limit?: number; tz?: string } = {}): Promise<boolean> {
  const settings = await getSettings(ctx.db);
  const limit = opts.limit ?? limitFor(settings, metric);
  const day = usageDay(ctx, opts.tz ?? settings.timezone);
  const now = ctx.clock.now();
  const id = newId("res");
  const changes = await ctx.db.batch([
    ctx.db.prepare("INSERT OR IGNORE INTO usage_counters (day, metric, used, reserved, updated_at) VALUES (?, ?, 0, 0, ?)", day, metric, now),
    ctx.db.prepare(
      "INSERT OR IGNORE INTO usage_reservations (id, reservation_key, day, metric, amount, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'reserved', ?, ?)",
      id,
      key,
      day,
      metric,
      amount,
      now,
      now,
    ),
    ctx.db.prepare(
      "UPDATE usage_counters SET reserved = reserved + ?, updated_at = ? WHERE day = ? AND metric = ? AND changes() = 1 AND used + reserved + ? <= ?",
      amount,
      now,
      day,
      metric,
      amount,
      limit,
    ),
    ctx.db.prepare("DELETE FROM usage_reservations WHERE id = ? AND changes() = 0", id),
  ]);
  if (changes[1] === 1) return changes[2] === 1;
  const existing = await ctx.db.first<{ status: string }>("SELECT status FROM usage_reservations WHERE reservation_key = ?", key);
  return existing?.status === "reserved" || existing?.status === "committed";
}

async function settleReservation(ctx: AppContext, key: string, status: "committed" | "released", actual: number | null): Promise<void> {
  const r = await ctx.db.first<{ day: string; metric: string; amount: number; status: string }>(
    "SELECT day, metric, amount, status FROM usage_reservations WHERE reservation_key = ?",
    key,
  );
  if (!r || r.status !== "reserved") return;
  const now = ctx.clock.now();
  const used = status === "committed" ? (actual ?? r.amount) : 0;
  await ctx.db.batch([
    ctx.db.prepare("UPDATE usage_reservations SET status = ?, actual = ?, updated_at = ? WHERE reservation_key = ? AND status = 'reserved'", status, used, now, key),
    ctx.db.prepare(
      "UPDATE usage_counters SET reserved = MAX(0, reserved - ?), used = used + ?, updated_at = ? WHERE day = ? AND metric = ? AND changes() = 1",
      r.amount,
      used,
      now,
      r.day,
      r.metric,
    ),
  ]);
}

export function commitUsage(ctx: AppContext, key: string, actual: number | null = null): Promise<void> {
  return settleReservation(ctx, key, "committed", actual);
}

/**
 * Releases a reservation. `forget` deletes the row afterwards so a retry of the same logical
 * effect (after a definite, retryable rejection) can reserve again under the same key.
 */
export async function releaseUsage(ctx: AppContext, key: string, opts: { forget?: boolean } = {}): Promise<void> {
  await settleReservation(ctx, key, "released", null);
  if (opts.forget) await ctx.db.run("DELETE FROM usage_reservations WHERE reservation_key = ? AND status = 'released'", key);
}

/** Adds provider-reported usage discovered after the fact (e.g. call minutes) without a reservation. */
export async function recordUsage(ctx: AppContext, metric: UsageMetric, amount: number, tz: string): Promise<void> {
  const day = usageDay(ctx, tz);
  const now = ctx.clock.now();
  await ctx.db.run(
    "INSERT INTO usage_counters (day, metric, used, reserved, updated_at) VALUES (?, ?, ?, 0, ?) ON CONFLICT (day, metric) DO UPDATE SET used = used + excluded.used, updated_at = excluded.updated_at",
    day,
    metric,
    amount,
    now,
  );
}

export async function usageToday(ctx: AppContext, tz: string): Promise<Record<UsageMetric, { used: number; reserved: number }>> {
  const day = usageDay(ctx, tz);
  const rows = await ctx.db.all<{ metric: UsageMetric; used: number; reserved: number }>("SELECT metric, used, reserved FROM usage_counters WHERE day = ?", day);
  const out = {
    inbound: { used: 0, reserved: 0 },
    sms_segments: { used: 0, reserved: 0 },
    call_attempts: { used: 0, reserved: 0 },
    call_minutes: { used: 0, reserved: 0 },
    ai_requests: { used: 0, reserved: 0 },
    embeddings: { used: 0, reserved: 0 },
    semantic_queries: { used: 0, reserved: 0 },
    media_bytes: { used: 0, reserved: 0 },
    image_assessments: { used: 0, reserved: 0 },
  } as Record<UsageMetric, { used: number; reserved: number }>;
  for (const r of rows) out[r.metric] = { used: r.used, reserved: r.reserved };
  return out;
}
