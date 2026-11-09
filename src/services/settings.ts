import type { Db } from "../db/db";

export interface OwnerSettings {
  display_name: string;
  timezone: string;
  locale: string;
  week_starts_on: number;
  default_event_minutes: number;
  quiet_start_minute: number;
  quiet_end_minute: number;
  sms_enabled: number;
  calls_enabled: number;
  automation_paused_until: number | null;
  automation_pause_scope: "reminders" | "all" | null;
  restore_hold: number;
  followup_default_enabled: number;
  followup_default_delay_minutes: number;
  followup_max_per_occurrence: number;
  followup_min_gap_minutes: number;
  morning_brief_enabled: number;
  morning_brief_minute: number;
  calendar_headsup_enabled: number;
  calendar_headsup_lead_minutes: number;
  calendar_headsup_include_all_day: number;
  focus_day_start_minute: number;
  focus_day_end_minute: number;
  wake_snooze_minutes: number;
  sms_consent_at: number | null;
  sms_consent_source: string | null;
  call_consent_at: number | null;
  call_consent_source: string | null;
  sms_attestation_provider: string | null;
  sms_attestation_date: string | null;
  sms_attestation_sender_status: string | null;
  sms_attestation_reference: string | null;
  sms_attestation_recorded_at: number | null;
  limit_inbound_per_day: number;
  limit_sms_segments_per_day: number;
  limit_call_attempts_per_day: number;
  limit_call_minutes_per_day: number;
  limit_ai_requests_per_day: number;
  retention_message_days: number;
  retention_task_days: number;
  retention_audit_days: number;
  version: number;
  updated_at: number;
}

/** Pause sentinel for "until resumed". */
export const PAUSE_INDEFINITE = 8_640_000_000_000_000;

export async function getSettings(db: Db): Promise<OwnerSettings> {
  const s = await db.first<OwnerSettings>("SELECT * FROM owner_settings WHERE id = 1");
  if (!s) throw new Error("owner_settings row missing; run migrations");
  return s;
}

/** Fields an admin (or a bounded SMS setting action) may change. Owner phone is never here. */
export const MUTABLE_SETTING_FIELDS = [
  "display_name",
  "timezone",
  "default_event_minutes",
  "quiet_start_minute",
  "quiet_end_minute",
  "sms_enabled",
  "calls_enabled",
  "automation_paused_until",
  "automation_pause_scope",
  "restore_hold",
  "followup_default_enabled",
  "followup_default_delay_minutes",
  "followup_max_per_occurrence",
  "followup_min_gap_minutes",
  "morning_brief_enabled",
  "morning_brief_minute",
  "calendar_headsup_enabled",
  "calendar_headsup_lead_minutes",
  "calendar_headsup_include_all_day",
  "focus_day_start_minute",
  "focus_day_end_minute",
  "wake_snooze_minutes",
  "sms_consent_at",
  "sms_consent_source",
  "call_consent_at",
  "call_consent_source",
  "sms_attestation_provider",
  "sms_attestation_date",
  "sms_attestation_sender_status",
  "sms_attestation_reference",
  "sms_attestation_recorded_at",
  "limit_inbound_per_day",
  "limit_sms_segments_per_day",
  "limit_call_attempts_per_day",
  "limit_call_minutes_per_day",
  "limit_ai_requests_per_day",
  "retention_message_days",
  "retention_task_days",
  "retention_audit_days",
] as const;
export type MutableSettingField = (typeof MUTABLE_SETTING_FIELDS)[number];

/** Optimistic-concurrency update; returns false if the settings changed since `expectedVersion`. */
export async function updateSettings(db: Db, patch: Partial<Record<MutableSettingField, string | number | null>>, now: number, expectedVersion?: number): Promise<boolean> {
  const fields = Object.keys(patch).filter((k): k is MutableSettingField => (MUTABLE_SETTING_FIELDS as readonly string[]).includes(k));
  if (fields.length === 0) return true;
  const sets = fields.map((f) => `${f} = ?`).join(", ");
  const values = fields.map((f) => patch[f] ?? null);
  const where = expectedVersion === undefined ? "id = 1" : "id = 1 AND version = ?";
  const params = expectedVersion === undefined ? [...values, now] : [...values, now, expectedVersion];
  const changes = await db.run(`UPDATE owner_settings SET ${sets}, version = version + 1, updated_at = ? WHERE ${where}`, ...params);
  return changes === 1;
}

export async function getSystemState(db: Db, key: string): Promise<string | null> {
  const row = await db.first<{ value: string }>("SELECT value FROM system_state WHERE key = ?", key);
  return row?.value ?? null;
}

export async function setSystemState(db: Db, key: string, value: string, now: number): Promise<void> {
  await db.run(
    "INSERT INTO system_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    key,
    value,
    now,
  );
}

export function isPaused(s: OwnerSettings, now: number, scope: "reminders" | "calls"): boolean {
  if (s.restore_hold === 1) return true;
  if (s.automation_paused_until === null || s.automation_paused_until <= now) return false;
  if (scope === "calls") return s.automation_pause_scope === "all";
  return true;
}
