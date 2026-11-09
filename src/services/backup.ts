import type { AppContext } from "../context";
import type { Db } from "../db/db";
import { MINUTE } from "../domain/time";
import { ROUTINE_LATENESS_MS } from "../domain/tasks";
import { sha256Hex } from "../security/crypto";
import { audit } from "./audit";
import { disconnectCalendar } from "./calendar-connection";
import { PAUSE_INDEFINITE, getSettings, setSystemState, updateSettings } from "./settings";

/** Tables included in a raw backup (encrypted columns stay encrypted). Order respects foreign keys. */
export const BACKUP_TABLES = [
  "owner_settings",
  "system_state",
  "inbound_messages",
  "conversation_log",
  "conversation_state",
  "series",
  "tasks",
  "reminders",
  "jobs",
  "plans",
  "action_executions",
  "outbound_effects",
  "provider_callbacks",
  "calendar_connection",
  "calendar_events",
  "calendar_headsups",
  "alarm_schedules",
  "alarm_occurrences",
  "confirmations",
  "clarifications",
  "suppressions",
  "consent_events",
  "audit_log",
  "usage_counters",
  "usage_reservations",
  "ai_requests",
  "dedupe_tombstones",
  // Extension (knowledge schema v3). Derived indexes, caches, challenges, upload tokens, pairing
  // codes, and raw telemetry are deliberately excluded: they are rebuilt or must not survive.
  "ext_settings",
  "source_records",
  "entities",
  "entity_aliases",
  "assertions",
  "memory_proposals",
  "memory_events",
  "extraction_runs",
  "deletion_tombstones",
  "secretary_items",
  "task_meta",
  "task_dependencies",
  "suggestions",
  "suggestion_suppressions",
  "undo_log",
  "acc_policies",
  "acc_sessions",
  "acc_checkpoints",
  "registered_devices",
  "media_objects",
  "evidence_submissions",
  "evidence_assessments",
  "email_connection",
  "email_candidates",
] as const;

const SINGLETONS = ["owner_settings", "conversation_state", "calendar_connection", "ext_settings", "email_connection"];

export type DatabaseDump = { version: 1; createdAt: number; tables: Record<string, Array<Record<string, unknown>>> };

export async function dumpDatabase(db: Db, now: number): Promise<DatabaseDump> {
  const tables: DatabaseDump["tables"] = {};
  for (const t of BACKUP_TABLES) tables[t] = await db.all<Record<string, unknown>>(`SELECT * FROM ${t}`);
  return { version: 1, createdAt: now, tables };
}

/** Loads a dump into an empty, migrated database. Singleton rows are replaced. */
export async function restoreDatabase(db: Db, dump: DatabaseDump): Promise<void> {
  for (const t of BACKUP_TABLES) {
    const rows = dump.tables[t] ?? [];
    if (SINGLETONS.includes(t) && rows.length) await db.run(`DELETE FROM ${t}`);
    for (const row of rows) {
      const cols = Object.keys(row);
      await db.run(`INSERT OR REPLACE INTO ${t} (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`, ...cols.map((c) => row[c] as string | number | null));
    }
  }
}

/**
 * After a restore: hold all proactive automation, invalidate admin/OAuth sessions, and treat any
 * in-flight effect as unknown. A backup may predate effects the provider already accepted, so a
 * restore cannot prove those were never sent; the operator must review and resume explicitly.
 */
export async function applyPostRestoreSafety(ctx: AppContext): Promise<void> {
  const now = ctx.clock.now();
  await ctx.db.batch([
    ctx.db.prepare("UPDATE owner_settings SET restore_hold = 1, version = version + 1, updated_at = ? WHERE id = 1", now),
    ctx.db.prepare("DELETE FROM admin_sessions"),
    ctx.db.prepare("DELETE FROM oauth_states"),
    ctx.db.prepare(
      "UPDATE outbound_effects SET state = 'unknown', error_detail = 'In flight at backup time; outcome unknown after restore.', updated_at = ? WHERE state = 'sending'",
      now,
    ),
    ctx.db.prepare("UPDATE jobs SET status = 'pending', lease_token = NULL, lease_expires_at = NULL, next_dispatch_at = NULL, updated_at = ? WHERE status = 'running'", now),
    // Extension: no stale device trust, no instant telemetry, no resumed accountability.
    ctx.db.prepare("UPDATE registered_devices SET revoked_at = ?, revoked_reason = 'restored_backup' WHERE revoked_at IS NULL", now),
    ctx.db.prepare("DELETE FROM device_challenges"),
    ctx.db.prepare("DELETE FROM device_pairing_codes"),
    ctx.db.prepare("DELETE FROM device_events"),
    ctx.db.prepare("UPDATE upload_tokens SET state = 'revoked' WHERE state = 'open'"),
    ctx.db.prepare("UPDATE ext_settings SET telemetry_enabled = 0, version = version + 1, updated_at = ? WHERE id = 1", now),
    ctx.db.prepare(
      "UPDATE acc_checkpoints SET state = 'canceled', status_label = 'restored_backup', generation = generation + 1, updated_at = ? WHERE state IN ('pending','requested','needs_clarification')",
      now,
    ),
    ctx.db.prepare(
      "UPDATE acc_sessions SET state = 'canceled', reason = 'restored_backup', version = version + 1, updated_at = ? WHERE state NOT IN ('completed','canceled','expired','needs_attention')",
      now,
    ),
    ctx.db.prepare(
      "UPDATE jobs SET status = 'canceled', last_error = 'restored_backup', updated_at = ? WHERE status = 'pending' AND kind IN ('acc_checkpoint','acc_session_end','evidence_assess')",
      now,
    ),
    ctx.db.prepare("DELETE FROM semantic_vectors"),
    ctx.db.prepare("DELETE FROM retrieval_evidence"),
    ctx.db.prepare("UPDATE index_state SET dirty = 1, indexed_version = NULL, retries = 0, updated_at = ? WHERE deleted = 0", now),
  ]);
  await setSystemState(ctx.db, "restored_at", String(now), now);
}

/**
 * Deletions made after the backup was taken still win: tombstones from the database being
 * replaced are re-applied to the restored copy (canonical rows blanked, tombstone re-inserted).
 */
export async function carryDeletionsForward(liveDb: Db, ctx: AppContext): Promise<number> {
  const tombs = await liveDb.all<{ object_id: string; object_type: string; deleted_at: number }>("SELECT object_id, object_type, deleted_at FROM deletion_tombstones");
  const now = ctx.clock.now();
  let n = 0;
  for (const t of tombs) {
    const stmts: D1PreparedStatement[] = [
      ctx.db.prepare("INSERT OR IGNORE INTO deletion_tombstones (object_id, object_type, deleted_at) VALUES (?, ?, ?)", t.object_id, t.object_type, t.deleted_at),
    ];
    if (t.object_type === "assertion")
      stmts.push(ctx.db.prepare("UPDATE assertions SET status = 'deleted', object_value_enc = NULL, excerpt_enc = NULL, updated_at = ? WHERE id = ?", now, t.object_id));
    else if (t.object_type === "secretary")
      stmts.push(ctx.db.prepare("UPDATE secretary_items SET status = 'deleted', deleted_at = ?, data_enc = '', updated_at = ? WHERE id = ?", now, now, t.object_id));
    else if (t.object_type === "entity")
      stmts.push(
        ctx.db.prepare("UPDATE entities SET status = 'deleted', description_enc = NULL, attributes_enc = NULL, deleted_at = ?, updated_at = ? WHERE id = ?", now, now, t.object_id),
      );
    else if (t.object_type === "source") stmts.push(ctx.db.prepare("UPDATE source_records SET content_enc = NULL, deleted_at = ? WHERE id = ?", now, t.object_id));
    stmts.push(ctx.db.prepare("UPDATE index_state SET deleted = 1, dirty = 1, updated_at = ? WHERE object_id = ?", now, t.object_id));
    await ctx.db.batch(stmts);
    n++;
  }
  return n;
}

/**
 * Operator-initiated resume after restore: expire occurrences/jobs that are past their window
 * (never replay them), then lift the hold. Future schedules continue normally.
 */
export async function resumeAfterRestore(ctx: AppContext): Promise<{ expiredReminders: number; expiredCalls: number; expiredHeadsups: number }> {
  const now = ctx.clock.now();
  const expiredReminders = await ctx.db.run(
    "UPDATE reminders SET status = 'missed', status_reason = 'expired_after_restore', missed_summarized = 0, updated_at = ? WHERE status = 'scheduled' AND planned_at < ?",
    now,
    now - ROUTINE_LATENESS_MS,
  );
  await ctx.db.run(
    "UPDATE jobs SET status = 'canceled', last_error = 'expired_after_restore', updated_at = ? WHERE status = 'pending' AND kind = 'send_reminder' AND due_at < ?",
    now,
    now - ROUTINE_LATENESS_MS,
  );
  const expiredCalls = await ctx.db.run(
    "UPDATE alarm_occurrences SET status = 'expired', status_reason = 'expired_after_restore', updated_at = ? WHERE status IN ('scheduled','snoozed','retry_scheduled') AND target_at < ?",
    now,
    now - 10 * MINUTE,
  );
  await ctx.db.run(
    "UPDATE jobs SET status = 'canceled', last_error = 'expired_after_restore', updated_at = ? WHERE status = 'pending' AND kind = 'alarm_call' AND expires_at < ?",
    now,
    now,
  );
  const expiredHeadsups = await ctx.db.run(
    "UPDATE calendar_headsups SET status = 'skipped', status_reason = 'expired_after_restore', updated_at = ? WHERE status = 'scheduled' AND event_start_at < ?",
    now,
    now,
  );
  await ctx.db.run(
    "UPDATE jobs SET status = 'canceled', last_error = 'expired_after_restore', updated_at = ? WHERE status = 'pending' AND kind = 'calendar_headsup' AND expires_at < ?",
    now,
    now,
  );
  await updateSettings(ctx.db, { restore_hold: 0 }, now);
  await audit(ctx, "admin", "restore.resume", "settings", "1", `reminders=${expiredReminders} calls=${expiredCalls} headsups=${expiredHeadsups}`);
  return { expiredReminders, expiredCalls, expiredHeadsups };
}

/** Owner-readable export (decrypted). Served only to an authenticated admin session. */
export async function exportOwnerData(ctx: AppContext): Promise<Record<string, unknown>> {
  const settings = await getSettings(ctx.db);
  const tasks = [];
  for (const t of await ctx.db.all<Record<string, unknown> & { title_enc: string; notes_enc: string | null }>("SELECT * FROM tasks ORDER BY created_at")) {
    const { title_enc, notes_enc, ...rest } = t;
    tasks.push({ ...rest, title: await ctx.crypto.decrypt(title_enc, "task"), notes: await ctx.crypto.decryptNullable(notes_enc, "task") });
  }
  const conversation = [];
  for (const c of await ctx.db.all<{ direction: string; body_enc: string | null; created_at: number }>(
    "SELECT direction, body_enc, created_at FROM conversation_log ORDER BY created_at",
  )) {
    conversation.push({ direction: c.direction, text: await ctx.crypto.decryptNullable(c.body_enc, "convlog"), at: new Date(c.created_at).toISOString() });
  }
  return {
    exportedAt: new Date(ctx.clock.now()).toISOString(),
    note: "Della export. Provider-held records (carrier/Twilio/Google/OpenAI logs) are not included and are not erased by Della.",
    settings,
    tasks,
    reminders: await ctx.db.all("SELECT id, task_id, kind, planned_at, intended_at, status, status_reason FROM reminders ORDER BY planned_at"),
    alarms: await ctx.db.all("SELECT * FROM alarm_schedules"),
    alarmOccurrences: await ctx.db.all("SELECT id, alarm_id, occurrence_key, intended_at, target_at, status, attempt_count, acknowledged_at FROM alarm_occurrences"),
    conversation,
    calendar: await ctx.db.first("SELECT provider, status, account_email, default_write_calendar_id, read_calendar_ids_json, last_sync_at FROM calendar_connection WHERE id = 1"),
    consent: await ctx.db.all("SELECT * FROM consent_events ORDER BY created_at"),
  };
}

export const ERASE_CONFIRMATION_PHRASE = "ERASE ALL DATA";

/**
 * Erase: first disables all future work (pause, channel switches, cancel jobs), then deletes
 * content. Keeps hashed dedupe tombstones so a late provider retry cannot recreate erased work.
 * Does not and cannot erase provider-held logs or existing backups.
 */
export async function eraseAllData(ctx: AppContext, phrase: string): Promise<boolean> {
  if (phrase !== ERASE_CONFIRMATION_PHRASE) return false;
  const now = ctx.clock.now();
  await updateSettings(ctx.db, { automation_paused_until: PAUSE_INDEFINITE, automation_pause_scope: "all", sms_enabled: 0, calls_enabled: 0 }, now);
  await ctx.db.run("UPDATE jobs SET status = 'canceled', last_error = 'erased', updated_at = ? WHERE status IN ('pending','running')", now);
  try {
    await disconnectCalendar(ctx);
  } catch {
    // Disconnect failure must not block local erasure.
  }
  const inbound = await ctx.db.all<{ provider: string; provider_message_id: string }>("SELECT provider, provider_message_id FROM inbound_messages");
  for (const m of inbound)
    await ctx.db.run("INSERT OR IGNORE INTO dedupe_tombstones (key_hash, created_at) VALUES (?, ?)", await sha256Hex(`${m.provider}:${m.provider_message_id}`), now);
  const indexed = (await ctx.db.all<{ object_id: string }>("SELECT object_id FROM index_state")).map((r) => r.object_id);
  for (let i = 0; i < indexed.length; i += 100) await ctx.ext.semantic.delete(indexed.slice(i, i + 100)).catch(() => undefined);
  for (const m of await ctx.db.all<{ storage_key: string }>("SELECT storage_key FROM media_objects WHERE deleted_at IS NULL")) {
    try {
      await ctx.ext.media.delete(m.storage_key);
    } catch {
      // Storage outage: the row is removed below; the object expires by bucket lifecycle (documented).
    }
  }
  for (const t of [
    "evidence_assessments",
    "evidence_submissions",
    "media_objects",
    "upload_tokens",
    "device_events",
    "device_challenges",
    "device_pairing_codes",
    "registered_devices",
    "acc_checkpoints",
    "acc_sessions",
    "acc_policies",
    "email_candidates",
    "info_snapshots",
    "local_media_store",
    "undo_log",
    "suggestion_suppressions",
    "suggestions",
    "task_dependencies",
    "task_meta",
    "secretary_items",
    "retrieval_evidence",
    "semantic_vectors",
    "index_state",
    "memory_events",
    "memory_proposals",
    "extraction_runs",
    "entity_aliases",
    "assertions",
    "entities",
    "source_records",
    "deletion_tombstones",
    "action_executions",
    "plans",
    "conversation_log",
    "reminders",
    "tasks",
    "series",
    "alarm_occurrences",
    "alarm_schedules",
    "calendar_headsups",
    "calendar_events",
    "confirmations",
    "clarifications",
    "provider_callbacks",
    "outbound_effects",
    "inbound_messages",
    "jobs",
    "ai_requests",
    "audit_log",
  ]) {
    await ctx.db.run(`DELETE FROM ${t}`);
  }
  await ctx.db.run("UPDATE conversation_state SET last_task_ids_json = '[]', last_event_refs_json = '[]', last_referenced_at = NULL WHERE id = 1");
  await ctx.db.run(
    "UPDATE ext_settings SET capture_enabled = 0, telemetry_enabled = 0, morning_routines_enabled = 0, task_accountability_enabled = 0, email_enabled = 0, version = version + 1, updated_at = ? WHERE id = 1",
    now,
  );
  await ctx.db.run(
    "UPDATE email_connection SET status = 'disconnected', access_token_enc = NULL, refresh_token_enc = NULL, account_email = NULL, scopes = NULL, version = version + 1, updated_at = ? WHERE id = 1",
    now,
  );
  await audit(ctx, "admin", "data.erase", null, null, "all content erased; automation paused and channels disabled");
  return true;
}
