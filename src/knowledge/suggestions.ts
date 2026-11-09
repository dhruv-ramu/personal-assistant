import type { AppContext } from "../context";
import { parseJson } from "../db/db";
import { DAY, HOUR, isInQuietHours, todayLocal } from "../domain/time";
import { featureOn, getExtSettings } from "../ext/settings";
import { newId } from "../security/crypto";
import { deliverSmsEffect, ensureSmsEffect } from "../services/effects";
import type { JobOutcome } from "../services/jobs";
import { getSettings, getSystemState, isPaused, setSystemState } from "../services/settings";

export interface NewSuggestion {
  kind: string;
  dedupeKey: string;
  suppressionKey: string;
  text: string;
  evidence: string[];
  action: Record<string, unknown> | null;
  delivery: "digest" | "standalone";
  ttlMs: number;
  priority?: number;
}

/** Creates a suggestion unless suppressed or already present. Delivery is never a commitment. */
export async function createSuggestion(ctx: AppContext, n: NewSuggestion): Promise<"created" | "duplicate" | "suppressed" | "disabled"> {
  const ext = await getExtSettings(ctx.db);
  if (!featureOn(ctx, ext, "suggestions")) return "disabled";
  if (await ctx.db.first("SELECT suppression_key FROM suggestion_suppressions WHERE suppression_key = ?", n.suppressionKey)) return "suppressed";
  const now = ctx.clock.now();
  const changes = await ctx.db.run(
    `INSERT OR IGNORE INTO suggestions (id, kind, dedupe_key, suppression_key, status, priority, delivery, text_enc, evidence_json, action_enc, expires_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)`,
    newId("sug"),
    n.kind,
    n.dedupeKey,
    n.suppressionKey,
    n.priority ?? 1,
    n.delivery,
    await ctx.crypto.encrypt(n.text.slice(0, 400), "suggestion"),
    JSON.stringify(n.evidence.slice(0, 10)),
    n.action ? await ctx.crypto.encrypt(JSON.stringify(n.action), "suggestion") : null,
    now + n.ttlMs,
    now,
    now,
  );
  if (changes !== 1) return "duplicate";
  if (n.delivery === "standalone") await maybeSendStandalone(ctx);
  return "created";
}

async function sentToday(ctx: AppContext, tz: string): Promise<number> {
  const day = todayLocal(ctx.clock.now(), tz);
  return Number((await getSystemState(ctx.db, `suggestions_sent:${day}`)) ?? "0");
}

/** Standalone suggestions respect the daily cap, quiet hours, and pauses; overflow joins the digest. */
async function maybeSendStandalone(ctx: AppContext): Promise<void> {
  const s = await getSettings(ctx.db);
  const ext = await getExtSettings(ctx.db);
  const now = ctx.clock.now();
  if (isPaused(s, now, "reminders") || isInQuietHours(now, s.timezone, s.quiet_start_minute, s.quiet_end_minute)) return;
  const sent = await sentToday(ctx, s.timezone);
  if (sent >= ext.max_standalone_suggestions_per_day) return;
  const row = await ctx.db.first<{ id: string; text_enc: string }>(
    "SELECT id, text_enc FROM suggestions WHERE status = 'pending' AND delivery = 'standalone' AND expires_at > ? ORDER BY priority DESC, created_at LIMIT 1",
    now,
  );
  if (!row) return;
  const claimed = await ctx.db.run("UPDATE suggestions SET status = 'notified', notified_at = ?, updated_at = ? WHERE id = ? AND status = 'pending'", now, now, row.id);
  if (claimed !== 1) return;
  await setSystemState(ctx.db, `suggestions_sent:${todayLocal(now, s.timezone)}`, String(sent + 1), now);
  await setSystemState(ctx.db, "suggestion_numbers", JSON.stringify([row.id]), now);
  const text = await ctx.crypto.decrypt(row.text_enc, "suggestion");
  const effect = await ensureSmsEffect(ctx, { effectKey: `suggestion:${row.id}`, purpose: "summary", body: `${text} (Reply DISMISS 1, SNOOZE 1, or NEVER 1.)` });
  await deliverSmsEffect(ctx, effect.id, "proactive");
}

/** Daily digest: one message for ordinary suggestions (bounded), numbered for replies. */
export async function handleDigest(ctx: AppContext): Promise<JobOutcome> {
  const s = await getSettings(ctx.db);
  const ext = await getExtSettings(ctx.db);
  const now = ctx.clock.now();
  if (!featureOn(ctx, ext, "suggestions")) return { status: "skipped", result: { reason: "disabled" } };
  if (isPaused(s, now, "reminders")) return { status: "skipped", result: { reason: "paused" } };
  await ctx.db.run("UPDATE suggestions SET status = 'expired', updated_at = ? WHERE status IN ('pending','snoozed') AND expires_at <= ?", now, now);
  await ctx.db.run("UPDATE suggestions SET status = 'pending', updated_at = ? WHERE status = 'snoozed' AND snoozed_until <= ?", now, now);
  const rows = await ctx.db.all<{ id: string; text_enc: string }>(
    "SELECT id, text_enc FROM suggestions WHERE status = 'pending' AND expires_at > ? ORDER BY priority DESC, created_at LIMIT 5",
    now,
  );
  if (rows.length === 0) return { status: "skipped", result: { reason: "empty" } };
  const lines = [];
  for (let i = 0; i < rows.length; i++) lines.push(`${i + 1}) ${await ctx.crypto.decrypt(rows[i]!.text_enc, "suggestion")}`);
  for (const r of rows) await ctx.db.run("UPDATE suggestions SET status = 'notified', notified_at = ?, updated_at = ? WHERE id = ? AND status = 'pending'", now, now, r.id);
  await setSystemState(ctx.db, "suggestion_numbers", JSON.stringify(rows.map((r) => r.id)), now);
  const effect = await ensureSmsEffect(ctx, {
    effectKey: `digest:${todayLocal(now, s.timezone)}`,
    purpose: "brief",
    body: `Suggestions: ${lines.join(" ")} Reply DISMISS n, SNOOZE n, or NEVER n. Nothing happens unless you act.`,
  });
  const d = await deliverSmsEffect(ctx, effect.id, "proactive");
  return { status: "succeeded", result: { count: rows.length, delivery: d.state } };
}

/** Accept/dismiss/snooze/never by digest number. Dismissal is not evidence anything was done. */
export async function respondToSuggestion(ctx: AppContext, op: "accept" | "dismiss" | "snooze" | "never", number: number | null): Promise<string> {
  const ids = parseJson<string[]>(await getSystemState(ctx.db, "suggestion_numbers"), []);
  const id = ids[(number ?? 1) - 1];
  if (!id) return "I don't have a numbered suggestion to apply that to.";
  const row = await ctx.db.first<{ id: string; suppression_key: string; text_enc: string; action_enc: string | null }>("SELECT * FROM suggestions WHERE id = ?", id);
  if (!row) return "That suggestion no longer exists.";
  const now = ctx.clock.now();
  const text = (await ctx.crypto.decrypt(row.text_enc, "suggestion")).slice(0, 80);
  switch (op) {
    case "dismiss":
      await ctx.db.run("UPDATE suggestions SET status = 'dismissed', updated_at = ? WHERE id = ?", now, id);
      return `Dismissed: ${text}. (The underlying item is unchanged.)`;
    case "snooze":
      await ctx.db.run(
        "UPDATE suggestions SET status = 'snoozed', snoozed_until = ?, expires_at = MAX(expires_at, ?), updated_at = ? WHERE id = ?",
        now + DAY,
        now + 2 * DAY,
        now,
        id,
      );
      return `Snoozed until tomorrow: ${text}.`;
    case "never":
      await ctx.db.batch([
        ctx.db.prepare("UPDATE suggestions SET status = 'suppressed', updated_at = ? WHERE id = ?", now, id),
        ctx.db.prepare("INSERT OR IGNORE INTO suggestion_suppressions (suppression_key, created_at) VALUES (?, ?)", row.suppression_key, now),
      ]);
      return `Won't suggest that again: ${text}.`;
    case "accept":
      await ctx.db.run("UPDATE suggestions SET status = 'accepted', updated_at = ? WHERE id = ?", now, id);
      return `Noted: ${text}. Tell me what you'd like to do (I don't act on suggestions automatically).`;
  }
}

export const SUGGESTION_TTL_DEFAULT = 2 * DAY;
export const STANDALONE_RECHECK = HOUR;
