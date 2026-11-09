import type { AppContext } from "../context";
import { DAY } from "../domain/time";
import { getSettings } from "./settings";
import { getExtSettings } from "../ext/settings";
import { purgeExpiredMedia } from "../media/uploads";

/**
 * Extension retention: raw source text follows message retention; staging sources and cached
 * evidence/info are short-lived; accountability summaries follow their own window; media and
 * telemetry are purged by expiry. Durable facts persist until the owner deletes them.
 */
async function runExtensionRetention(ctx: AppContext): Promise<Record<string, number>> {
  const ext = await getExtSettings(ctx.db);
  const now = ctx.clock.now();
  const out: Record<string, number> = {};
  out.sources_raw = await ctx.db.run("UPDATE source_records SET content_enc = NULL WHERE content_enc IS NOT NULL AND expires_at IS NOT NULL AND expires_at <= ?", now);
  out.retrieval_evidence = await ctx.db.run("DELETE FROM retrieval_evidence WHERE expires_at <= ?", now);
  out.info = await ctx.db.run("DELETE FROM info_snapshots WHERE fetched_at < ?", now - DAY);
  out.email_candidates = await ctx.db.run("DELETE FROM email_candidates WHERE created_at < ?", now - 30 * DAY);
  out.undo = await ctx.db.run("DELETE FROM undo_log WHERE created_at < ?", now - 30 * DAY);
  out.suggestions = await ctx.db.run("DELETE FROM suggestions WHERE status IN ('accepted','dismissed','expired','suppressed') AND updated_at < ?", now - 30 * DAY);
  const accCutoff = now - ext.accountability_summary_days * DAY;
  out.acc_checkpoints = await ctx.db.run(
    "DELETE FROM acc_checkpoints WHERE session_id IN (SELECT id FROM acc_sessions WHERE state IN ('completed','canceled','expired','needs_attention') AND updated_at < ?)",
    accCutoff,
  );
  out.acc_sessions = await ctx.db.run("DELETE FROM acc_sessions WHERE state IN ('completed','canceled','expired','needs_attention') AND updated_at < ?", accCutoff);
  out.media = await purgeExpiredMedia(ctx, 500);
  out.extraction_runs = await ctx.db.run("UPDATE extraction_runs SET summary_enc = NULL WHERE created_at < ? AND summary_enc IS NOT NULL", now - 30 * DAY);
  return out;
}

/**
 * Daily retention sweep. Defaults: message content 30 days, completed/canceled task text 90 days,
 * redacted audit 90 days (configurable). Tasks belonging to an ACTIVE series keep their text via
 * the series template; scheduling rows and dedupe keys survive without sensitive content.
 */
export async function runRetention(ctx: AppContext): Promise<Record<string, number>> {
  const s = await getSettings(ctx.db);
  const now = ctx.clock.now();
  const msgCutoff = now - s.retention_message_days * DAY;
  const taskCutoff = now - s.retention_task_days * DAY;
  const auditCutoff = now - s.retention_audit_days * DAY;
  const purged = await ctx.crypto.encrypt("(content removed by retention)", "task");
  const out: Record<string, number> = {};
  out.inbound = await ctx.db.run(
    "UPDATE inbound_messages SET body_enc = NULL, content_purged_at = ? WHERE received_at < ? AND body_enc IS NOT NULL AND status IN ('processed','failed','ignored')",
    now,
    msgCutoff,
  );
  out.conversation = await ctx.db.run("DELETE FROM conversation_log WHERE created_at < ?", msgCutoff);
  out.effects = await ctx.db.run(
    "UPDATE outbound_effects SET body_enc = NULL, content_purged_at = ? WHERE created_at < ? AND body_enc IS NOT NULL AND state IN ('accepted','delivered','failed','suppressed','canceled')",
    now,
    msgCutoff,
  );
  out.plans = await ctx.db.run("DELETE FROM plans WHERE created_at < ? AND status != 'planned'", msgCutoff);
  out.tasks = await ctx.db.run(
    "UPDATE tasks SET title_enc = ?, notes_enc = NULL, content_purged_at = ? WHERE status IN ('completed','canceled') AND updated_at < ? AND content_purged_at IS NULL",
    purged,
    now,
    taskCutoff,
  );
  out.audit = await ctx.db.run("DELETE FROM audit_log WHERE created_at < ?", auditCutoff);
  out.callbacks = await ctx.db.run("DELETE FROM provider_callbacks WHERE received_at < ?", auditCutoff);
  out.ai = await ctx.db.run("DELETE FROM ai_requests WHERE created_at < ?", auditCutoff);
  out.confirmations = await ctx.db.run("DELETE FROM confirmations WHERE status != 'pending' AND created_at < ?", now - 7 * DAY);
  out.clarifications = await ctx.db.run("DELETE FROM clarifications WHERE status != 'pending' AND created_at < ?", now - 7 * DAY);
  out.jobs = await ctx.db.run("DELETE FROM jobs WHERE status IN ('succeeded','skipped','canceled') AND finished_at < ?", now - 30 * DAY);
  out.sessions = await ctx.db.run("DELETE FROM admin_sessions WHERE expires_at < ? OR revoked_at IS NOT NULL", now);
  out.oauth = await ctx.db.run("DELETE FROM oauth_states WHERE expires_at < ?", now - DAY);
  out.logins = await ctx.db.run("DELETE FROM login_attempts WHERE window_start < ?", now - DAY);
  out.usage = await ctx.db.run("DELETE FROM usage_reservations WHERE status != 'reserved' AND created_at < ?", now - 60 * DAY);
  Object.assign(out, await runExtensionRetention(ctx));
  return out;
}
