import type { AppContext } from "../context";
import type { Db } from "../db/db";

export interface ExtSettings {
  capture_enabled: number;
  capture_activated_at: number | null;
  capture_explained_at: number | null;
  capture_paused_until: number | null;
  sensitive_memory_enabled: number;
  semantic_enabled: number;
  uploads_enabled: number;
  mms_enabled: number;
  assessment_enabled: number;
  telemetry_enabled: number;
  morning_routines_enabled: number;
  task_accountability_enabled: number;
  email_enabled: number;
  info_enabled: number;
  suggestions_enabled: number;
  meeting_prep_enabled: number;
  meeting_prep_lead_minutes: number;
  post_meeting_enabled: number;
  evening_reset_enabled: number;
  evening_reset_minute: number;
  digest_minute: number;
  max_standalone_suggestions_per_day: number;
  work_window_start_minute: number;
  work_window_end_minute: number;
  durable_memory_days: number;
  raw_media_hours: number;
  telemetry_hours: number;
  accountability_summary_days: number;
  limit_embeddings_per_day: number;
  limit_semantic_queries_per_day: number;
  limit_media_bytes_per_day: number;
  limit_image_assessments_per_day: number;
  max_images_per_checkpoint: number;
  max_image_bytes: number;
  location_label: string | null;
  location_lat: number | null;
  location_lon: number | null;
  version: number;
}

export async function getExtSettings(db: Db): Promise<ExtSettings> {
  const s = await db.first<ExtSettings>("SELECT * FROM ext_settings WHERE id = 1");
  if (!s) throw new Error("ext_settings row missing; run migrations");
  return s;
}

export const EXT_MUTABLE = [
  "capture_enabled",
  "capture_activated_at",
  "capture_explained_at",
  "capture_paused_until",
  "sensitive_memory_enabled",
  "semantic_enabled",
  "uploads_enabled",
  "mms_enabled",
  "assessment_enabled",
  "telemetry_enabled",
  "morning_routines_enabled",
  "task_accountability_enabled",
  "email_enabled",
  "info_enabled",
  "suggestions_enabled",
  "meeting_prep_enabled",
  "meeting_prep_lead_minutes",
  "post_meeting_enabled",
  "evening_reset_enabled",
  "evening_reset_minute",
  "digest_minute",
  "max_standalone_suggestions_per_day",
  "work_window_start_minute",
  "work_window_end_minute",
  "durable_memory_days",
  "raw_media_hours",
  "telemetry_hours",
  "accountability_summary_days",
  "limit_embeddings_per_day",
  "limit_semantic_queries_per_day",
  "limit_media_bytes_per_day",
  "limit_image_assessments_per_day",
  "max_images_per_checkpoint",
  "max_image_bytes",
  "location_label",
  "location_lat",
  "location_lon",
] as const;

export async function updateExtSettings(db: Db, patch: Partial<Record<(typeof EXT_MUTABLE)[number], string | number | null>>, now: number): Promise<void> {
  const fields = Object.keys(patch).filter((k) => (EXT_MUTABLE as readonly string[]).includes(k)) as Array<(typeof EXT_MUTABLE)[number]>;
  if (!fields.length) return;
  await db.run(
    `UPDATE ext_settings SET ${fields.map((f) => `${f} = ?`).join(", ")}, version = version + 1, updated_at = ? WHERE id = 1`,
    ...fields.map((f) => patch[f] ?? null),
    now,
  );
}

export type Feature =
  | "capture"
  | "semantic"
  | "uploads"
  | "mms"
  | "assessment"
  | "telemetry"
  | "morning"
  | "task_accountability"
  | "email"
  | "info"
  | "suggestions"
  | "meeting_prep"
  | "post_meeting"
  | "evening_reset";

/** Feature on only if the deployment flag allows it AND the owner enabled it (deployment off wins). */
export function featureOn(ctx: AppContext, s: ExtSettings, f: Feature): boolean {
  const flags = ctx.config.ext.flags;
  switch (f) {
    case "capture":
      return flags.capture && s.capture_enabled === 1 && !(s.capture_paused_until && s.capture_paused_until > ctx.clock.now());
    case "semantic":
      return flags.semanticIndex && s.semantic_enabled === 1;
    case "uploads":
      return flags.uploads && s.uploads_enabled === 1;
    case "mms":
      return flags.mmsIngest && s.mms_enabled === 1;
    case "assessment":
      return flags.imageAssessment && s.assessment_enabled === 1;
    case "telemetry":
      return flags.browserTelemetry && s.telemetry_enabled === 1;
    case "morning":
      return flags.morningRoutines && s.morning_routines_enabled === 1;
    case "task_accountability":
      return flags.taskAccountability && s.task_accountability_enabled === 1;
    case "email":
      return flags.emailRead && s.email_enabled === 1;
    case "info":
      return flags.currentInfo && s.info_enabled === 1;
    case "suggestions":
      return flags.suggestions && s.suggestions_enabled === 1;
    case "meeting_prep":
      return flags.suggestions && s.meeting_prep_enabled === 1;
    case "post_meeting":
      return flags.suggestions && s.post_meeting_enabled === 1;
    case "evening_reset":
      return flags.suggestions && s.evening_reset_enabled === 1;
  }
}
