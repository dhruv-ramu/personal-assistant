-- Della initial schema.
-- Conventions:
--   * Every *_at column is an INTEGER count of MILLISECONDS since the Unix epoch (UTC).
--   * Columns ending in _enc hold AES-GCM envelopes produced by src/security/crypto.ts.
--   * Mutable entities carry a `version` (optimistic concurrency) and, where jobs
--     depend on them, a `generation` that invalidates previously scheduled jobs.
--   * Scheduling metadata (due times, statuses, short IDs) stays plaintext so that
--     indexed due-work queries work; see docs/SECURITY.md for what remains readable.

PRAGMA foreign_keys = ON;

-- 1. Owner/settings (single row, id = 1). The owner phone number is NOT stored here:
--    the trusted source is the OWNER_PHONE_E164 deployment variable.
CREATE TABLE owner_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  display_name TEXT NOT NULL DEFAULT 'Dhruv',
  timezone TEXT NOT NULL DEFAULT 'America/Los_Angeles',
  locale TEXT NOT NULL DEFAULT 'en-US',
  week_starts_on INTEGER NOT NULL DEFAULT 1,
  default_event_minutes INTEGER NOT NULL DEFAULT 60 CHECK (default_event_minutes BETWEEN 5 AND 1440),
  quiet_start_minute INTEGER NOT NULL DEFAULT 1380 CHECK (quiet_start_minute BETWEEN 0 AND 1439),
  quiet_end_minute INTEGER NOT NULL DEFAULT 420 CHECK (quiet_end_minute BETWEEN 0 AND 1439),
  sms_enabled INTEGER NOT NULL DEFAULT 1 CHECK (sms_enabled IN (0, 1)),
  calls_enabled INTEGER NOT NULL DEFAULT 1 CHECK (calls_enabled IN (0, 1)),
  automation_paused_until INTEGER,
  automation_pause_scope TEXT CHECK (automation_pause_scope IN ('reminders', 'all')),
  restore_hold INTEGER NOT NULL DEFAULT 0 CHECK (restore_hold IN (0, 1)),
  followup_default_enabled INTEGER NOT NULL DEFAULT 0 CHECK (followup_default_enabled IN (0, 1)),
  followup_default_delay_minutes INTEGER NOT NULL DEFAULT 180,
  followup_max_per_occurrence INTEGER NOT NULL DEFAULT 2 CHECK (followup_max_per_occurrence BETWEEN 0 AND 5),
  followup_min_gap_minutes INTEGER NOT NULL DEFAULT 120,
  morning_brief_enabled INTEGER NOT NULL DEFAULT 0 CHECK (morning_brief_enabled IN (0, 1)),
  morning_brief_minute INTEGER NOT NULL DEFAULT 480,
  calendar_headsup_enabled INTEGER NOT NULL DEFAULT 0 CHECK (calendar_headsup_enabled IN (0, 1)),
  calendar_headsup_lead_minutes INTEGER NOT NULL DEFAULT 30,
  calendar_headsup_include_all_day INTEGER NOT NULL DEFAULT 0,
  focus_day_start_minute INTEGER NOT NULL DEFAULT 540,
  focus_day_end_minute INTEGER NOT NULL DEFAULT 1080,
  wake_snooze_minutes INTEGER NOT NULL DEFAULT 10 CHECK (wake_snooze_minutes BETWEEN 1 AND 60),
  sms_consent_at INTEGER,
  sms_consent_source TEXT,
  call_consent_at INTEGER,
  call_consent_source TEXT,
  sms_attestation_provider TEXT,
  sms_attestation_date TEXT,
  sms_attestation_sender_status TEXT,
  sms_attestation_reference TEXT,
  sms_attestation_recorded_at INTEGER,
  limit_inbound_per_day INTEGER NOT NULL DEFAULT 100,
  limit_sms_segments_per_day INTEGER NOT NULL DEFAULT 50,
  limit_call_attempts_per_day INTEGER NOT NULL DEFAULT 5,
  limit_call_minutes_per_day INTEGER NOT NULL DEFAULT 10,
  limit_ai_requests_per_day INTEGER NOT NULL DEFAULT 100,
  retention_message_days INTEGER NOT NULL DEFAULT 30,
  retention_task_days INTEGER NOT NULL DEFAULT 90,
  retention_audit_days INTEGER NOT NULL DEFAULT 90,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL DEFAULT 0
);
INSERT INTO owner_settings (id) VALUES (1);

-- Generic durable key/value state (scheduler heartbeat, simulator clock, alert throttles).
CREATE TABLE system_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 2. Inbound messages.
CREATE TABLE inbound_messages (
  id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL UNIQUE,
  provider TEXT NOT NULL,
  provider_message_id TEXT NOT NULL,
  from_e164 TEXT NOT NULL,
  to_e164 TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  body_enc TEXT,
  num_media INTEGER NOT NULL DEFAULT 0,
  keyword TEXT NOT NULL DEFAULT 'none' CHECK (keyword IN ('none', 'stop', 'start', 'help')),
  status TEXT NOT NULL DEFAULT 'received'
    CHECK (status IN ('received', 'processing', 'processed', 'failed', 'ignored')),
  status_detail TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  processed_at INTEGER,
  content_purged_at INTEGER,
  UNIQUE (provider, provider_message_id)
);
CREATE INDEX idx_inbound_status_seq ON inbound_messages (status, seq);
CREATE INDEX idx_inbound_received ON inbound_messages (received_at);

-- 3. Conversation context (bounded log + single state row).
CREATE TABLE conversation_log (
  id TEXT PRIMARY KEY,
  direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  body_enc TEXT,
  inbound_id TEXT REFERENCES inbound_messages (id) ON DELETE SET NULL,
  effect_id TEXT,
  task_ids_json TEXT NOT NULL DEFAULT '[]',
  event_refs_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_convlog_created ON conversation_log (created_at);

CREATE TABLE conversation_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_task_ids_json TEXT NOT NULL DEFAULT '[]',
  last_event_refs_json TEXT NOT NULL DEFAULT '[]',
  last_referenced_at INTEGER,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL DEFAULT 0
);
INSERT INTO conversation_state (id) VALUES (1);

-- 5. Schedules / series (recurring wall-clock definitions; occurrences are materialized lazily).
CREATE TABLE series (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('task', 'alarm')),
  rrule TEXT NOT NULL,
  dtstart_local TEXT NOT NULL,
  timezone TEXT NOT NULL,
  local_time TEXT NOT NULL,
  until_date TEXT,
  max_count INTEGER,
  generated_count INTEGER NOT NULL DEFAULT 0,
  template_enc TEXT,
  template_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'canceled', 'ended')),
  next_occurrence_at INTEGER,
  next_occurrence_key TEXT,
  last_materialized_key TEXT,
  canceled_at INTEGER,
  cancel_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_series_due ON series (status, next_occurrence_at);

-- 4. Tasks (each recurring occurrence is its own task row).
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  short_id TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL DEFAULT 'task' CHECK (kind IN ('task', 'reminder')),
  title_enc TEXT NOT NULL,
  notes_enc TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'completed', 'canceled')),
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high')),
  due_at INTEGER,
  timezone TEXT NOT NULL,
  series_id TEXT REFERENCES series (id),
  occurrence_key TEXT,
  followup_enabled INTEGER NOT NULL DEFAULT 0 CHECK (followup_enabled IN (0, 1)),
  checks_disabled INTEGER NOT NULL DEFAULT 0 CHECK (checks_disabled IN (0, 1)),
  generation INTEGER NOT NULL DEFAULT 1,
  source_inbound_id TEXT,
  source_action_key TEXT UNIQUE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  canceled_at INTEGER,
  content_purged_at INTEGER,
  version INTEGER NOT NULL DEFAULT 1,
  UNIQUE (series_id, occurrence_key)
);
CREATE INDEX idx_tasks_status_due ON tasks (status, due_at);
CREATE INDEX idx_tasks_series ON tasks (series_id);

-- 6. Reminders and follow-ups for a task occurrence.
CREATE TABLE reminders (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('reminder', 'followup')),
  ordinal INTEGER NOT NULL DEFAULT 1,
  planned_at INTEGER NOT NULL,
  intended_at INTEGER NOT NULL,
  quiet_policy TEXT NOT NULL CHECK (quiet_policy IN ('exact', 'defer')),
  explicit INTEGER NOT NULL DEFAULT 1 CHECK (explicit IN (0, 1)),
  status TEXT NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled', 'sent', 'skipped', 'canceled', 'missed')),
  task_generation INTEGER NOT NULL,
  status_reason TEXT,
  late INTEGER NOT NULL DEFAULT 0,
  missed_summarized INTEGER NOT NULL DEFAULT 0,
  logical_key TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_reminders_task ON reminders (task_id, status);
CREATE INDEX idx_reminders_status_planned ON reminders (status, planned_at);

-- 7. Durable jobs.
CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  logical_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  entity_id TEXT,
  entity_generation INTEGER,
  seq INTEGER,
  payload_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'succeeded', 'skipped', 'canceled', 'failed', 'blocked', 'dead')),
  due_at INTEGER NOT NULL,
  intended_at INTEGER NOT NULL,
  expires_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  next_dispatch_at INTEGER,
  dispatch_count INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT,
  lease_owner TEXT,
  lease_expires_at INTEGER,
  last_error TEXT,
  result_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX idx_jobs_due ON jobs (status, due_at);
CREATE INDEX idx_jobs_lease ON jobs (status, lease_expires_at);
CREATE INDEX idx_jobs_entity ON jobs (entity_id, status);
CREATE INDEX idx_jobs_kind_status ON jobs (kind, status);

-- 8. Plans and individual action executions (resume-not-replan on retry).
CREATE TABLE plans (
  id TEXT PRIMARY KEY,
  inbound_id TEXT NOT NULL UNIQUE REFERENCES inbound_messages (id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('deterministic', 'ai', 'ai_unavailable')),
  plan_enc TEXT NOT NULL,
  action_count INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'executed', 'failed')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE action_executions (
  id TEXT PRIMARY KEY,
  action_key TEXT NOT NULL UNIQUE,
  plan_id TEXT REFERENCES plans (id) ON DELETE CASCADE,
  source_inbound_id TEXT,
  action_index INTEGER NOT NULL,
  action_type TEXT NOT NULL,
  args_enc TEXT,
  target_version TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'succeeded', 'failed', 'needs_clarification', 'needs_confirmation', 'skipped')),
  result_enc TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_actions_plan ON action_executions (plan_id, action_index);

-- 9. Outbound effects (SMS and calls). Destination is always the configured owner.
CREATE TABLE outbound_effects (
  id TEXT PRIMARY KEY,
  effect_key TEXT NOT NULL UNIQUE,
  channel TEXT NOT NULL CHECK (channel IN ('sms', 'call')),
  purpose TEXT NOT NULL,
  destination TEXT NOT NULL DEFAULT 'owner' CHECK (destination = 'owner'),
  body_enc TEXT,
  template TEXT,
  provider TEXT,
  provider_id TEXT,
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'sending', 'accepted', 'delivered', 'failed', 'unknown', 'suppressed', 'canceled')),
  provider_status TEXT,
  error_code TEXT,
  error_detail TEXT,
  segments INTEGER,
  encoding TEXT,
  related_task_id TEXT,
  related_alarm_occurrence_id TEXT,
  attempt_ordinal INTEGER NOT NULL DEFAULT 1,
  call_duration_sec INTEGER,
  call_acknowledged INTEGER NOT NULL DEFAULT 0,
  job_id TEXT,
  requested_at INTEGER,
  accepted_at INTEGER,
  delivered_at INTEGER,
  failed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  content_purged_at INTEGER
);
CREATE UNIQUE INDEX idx_effects_provider_id ON outbound_effects (provider, provider_id) WHERE provider_id IS NOT NULL;
CREATE INDEX idx_effects_state ON outbound_effects (state, created_at);
CREATE INDEX idx_effects_alarm ON outbound_effects (related_alarm_occurrence_id);

-- Immutable provider callback facts.
CREATE TABLE provider_callbacks (
  id TEXT PRIMARY KEY,
  dedupe_key TEXT NOT NULL UNIQUE,
  provider TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('sms_status', 'call_status', 'call_input')),
  effect_id TEXT,
  provider_id TEXT,
  status TEXT,
  detail_json TEXT NOT NULL DEFAULT '{}',
  outcome TEXT NOT NULL DEFAULT 'applied',
  received_at INTEGER NOT NULL
);
CREATE INDEX idx_callbacks_effect ON provider_callbacks (effect_id);

-- 10. Calendar connection (single row) and token storage.
CREATE TABLE calendar_connection (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  provider TEXT NOT NULL DEFAULT 'none',
  status TEXT NOT NULL DEFAULT 'disconnected'
    CHECK (status IN ('disconnected', 'pending_activation', 'connected', 'needs_reconnect', 'error')),
  account_email TEXT,
  account_sub TEXT,
  scopes TEXT,
  access_token_enc TEXT,
  refresh_token_enc TEXT,
  access_expires_at INTEGER,
  default_write_calendar_id TEXT,
  read_calendar_ids_json TEXT NOT NULL DEFAULT '[]',
  calendars_json TEXT NOT NULL DEFAULT '[]',
  last_sync_at INTEGER,
  last_sync_error TEXT,
  last_error_at INTEGER,
  connected_at INTEGER,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL DEFAULT 0
);
INSERT INTO calendar_connection (id) VALUES (1);

-- 11. Calendar projection (rolling horizon) and heads-up reminders.
CREATE TABLE calendar_events (
  id TEXT PRIMARY KEY,
  calendar_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  recurring_event_id TEXT,
  etag TEXT,
  summary_enc TEXT,
  location_enc TEXT,
  start_at INTEGER,
  end_at INTEGER,
  all_day INTEGER NOT NULL DEFAULT 0,
  start_date TEXT,
  end_date TEXT,
  timezone TEXT,
  status TEXT NOT NULL DEFAULT 'confirmed',
  transparency TEXT,
  self_response TEXT,
  has_attendees INTEGER NOT NULL DEFAULT 0,
  created_by_della INTEGER NOT NULL DEFAULT 0,
  fetched_at INTEGER NOT NULL,
  UNIQUE (calendar_id, event_id)
);
CREATE INDEX idx_calendar_events_start ON calendar_events (start_at);

CREATE TABLE calendar_headsups (
  id TEXT PRIMARY KEY,
  logical_key TEXT NOT NULL UNIQUE,
  calendar_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  lead_minutes INTEGER NOT NULL,
  event_start_at INTEGER NOT NULL,
  planned_at INTEGER NOT NULL,
  generation INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled', 'sent', 'skipped', 'canceled')),
  status_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_headsups_status ON calendar_headsups (status, planned_at);

-- 12. Wake-up alarms and their occurrences.
CREATE TABLE alarm_schedules (
  id TEXT PRIMARY KEY,
  short_id TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL DEFAULT 'Wake-up call',
  local_time TEXT NOT NULL,
  timezone TEXT NOT NULL,
  series_id TEXT REFERENCES series (id),
  one_time_at INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  retry_enabled INTEGER NOT NULL DEFAULT 0 CHECK (retry_enabled IN (0, 1)),
  max_attempts INTEGER NOT NULL DEFAULT 2 CHECK (max_attempts BETWEEN 1 AND 2),
  retry_delay_minutes INTEGER NOT NULL DEFAULT 5,
  snooze_minutes INTEGER NOT NULL DEFAULT 10,
  max_snoozes INTEGER NOT NULL DEFAULT 3,
  read_agenda INTEGER NOT NULL DEFAULT 0 CHECK (read_agenda IN (0, 1)),
  source_action_key TEXT UNIQUE,
  generation INTEGER NOT NULL DEFAULT 1,
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  canceled_at INTEGER
);

CREATE TABLE alarm_occurrences (
  id TEXT PRIMARY KEY,
  alarm_id TEXT NOT NULL REFERENCES alarm_schedules (id) ON DELETE CASCADE,
  occurrence_key TEXT NOT NULL,
  intended_at INTEGER NOT NULL,
  target_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled', 'calling', 'snoozed', 'retry_scheduled', 'acknowledged', 'missed', 'canceled', 'expired', 'unknown')),
  generation INTEGER NOT NULL DEFAULT 1,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  window_attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 2,
  snooze_count INTEGER NOT NULL DEFAULT 0,
  active_effect_id TEXT,
  acknowledged_at INTEGER,
  acknowledged_via TEXT,
  status_reason TEXT,
  agenda_enc TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (alarm_id, occurrence_key)
);
CREATE INDEX idx_alarm_occ_status ON alarm_occurrences (status, target_at);

-- 13. Confirmations and clarifications.
CREATE TABLE confirmations (
  id TEXT PRIMARY KEY,
  nonce TEXT NOT NULL,
  action_type TEXT NOT NULL,
  action_enc TEXT NOT NULL,
  action_hash TEXT NOT NULL,
  targets_json TEXT NOT NULL DEFAULT '[]',
  prompt_enc TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'consumed', 'canceled', 'expired', 'superseded')),
  source_inbound_id TEXT,
  source_action_key TEXT UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  result_enc TEXT
);
CREATE INDEX idx_confirmations_status ON confirmations (status, created_at);
CREATE UNIQUE INDEX idx_confirmations_nonce_pending ON confirmations (nonce) WHERE status = 'pending';

CREATE TABLE clarifications (
  id TEXT PRIMARY KEY,
  question_type TEXT NOT NULL,
  candidates_json TEXT NOT NULL DEFAULT '[]',
  pending_enc TEXT NOT NULL,
  prompt_enc TEXT,
  referenced_effect_id TEXT,
  source_inbound_id TEXT,
  source_action_key TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'answered', 'canceled', 'expired', 'superseded')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  answered_at INTEGER,
  answer_inbound_id TEXT
);
CREATE INDEX idx_clarifications_status ON clarifications (status, created_at);

-- 14. Consent / suppression (per channel) plus an append-only consent log.
CREATE TABLE suppressions (
  channel TEXT PRIMARY KEY CHECK (channel IN ('sms', 'call')),
  state TEXT NOT NULL CHECK (state IN ('active', 'opted_out')),
  source TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE consent_events (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  event TEXT NOT NULL,
  source TEXT NOT NULL,
  detail TEXT,
  created_at INTEGER NOT NULL
);

-- 15. Audit and usage.
CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  detail TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_audit_created ON audit_log (created_at);

CREATE TABLE usage_counters (
  day TEXT NOT NULL,
  metric TEXT NOT NULL,
  used REAL NOT NULL DEFAULT 0,
  reserved REAL NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (day, metric)
);

CREATE TABLE usage_reservations (
  id TEXT PRIMARY KEY,
  reservation_key TEXT NOT NULL UNIQUE,
  day TEXT NOT NULL,
  metric TEXT NOT NULL,
  amount REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved', 'committed', 'released')),
  actual REAL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE ai_requests (
  id TEXT PRIMARY KEY,
  inbound_id TEXT,
  model TEXT NOT NULL,
  outcome TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  latency_ms INTEGER,
  estimated_cost_usd REAL NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_ai_requests_created ON ai_requests (created_at);

-- 16. Admin sessions, login throttling, OAuth state.
CREATE TABLE admin_sessions (
  token_hash TEXT PRIMARY KEY,
  csrf_token TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE TABLE login_attempts (
  client_hash TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (client_hash, window_start)
);

CREATE TABLE oauth_states (
  state_hash TEXT PRIMARY KEY,
  session_hash TEXT NOT NULL,
  code_verifier_enc TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);

-- Minimal deduplication tombstones that outlive content retention/erase.
CREATE TABLE dedupe_tombstones (
  key_hash TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);
