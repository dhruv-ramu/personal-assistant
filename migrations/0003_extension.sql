-- Della extension: knowledge memory, secretary records, suggestions, accountability, devices,
-- media/evidence, optional email/info sources. Conventions as in 0001 (ms timestamps, *_enc).
-- Rollback strategy: additive only (no existing table is altered); see docs/DELLA_EXTENSION_ARCHITECTURE.md.

-- Owner-level extension settings and consents (single row). Deployment flags override these.
CREATE TABLE ext_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  capture_enabled INTEGER NOT NULL DEFAULT 0 CHECK (capture_enabled IN (0, 1)),
  capture_activated_at INTEGER,
  capture_explained_at INTEGER,
  capture_paused_until INTEGER,
  sensitive_memory_enabled INTEGER NOT NULL DEFAULT 0,
  semantic_enabled INTEGER NOT NULL DEFAULT 0,
  uploads_enabled INTEGER NOT NULL DEFAULT 1,
  mms_enabled INTEGER NOT NULL DEFAULT 0,
  assessment_enabled INTEGER NOT NULL DEFAULT 0,
  telemetry_enabled INTEGER NOT NULL DEFAULT 0,
  morning_routines_enabled INTEGER NOT NULL DEFAULT 0,
  task_accountability_enabled INTEGER NOT NULL DEFAULT 0,
  email_enabled INTEGER NOT NULL DEFAULT 0,
  info_enabled INTEGER NOT NULL DEFAULT 0,
  suggestions_enabled INTEGER NOT NULL DEFAULT 0,
  meeting_prep_enabled INTEGER NOT NULL DEFAULT 0,
  meeting_prep_lead_minutes INTEGER NOT NULL DEFAULT 30,
  post_meeting_enabled INTEGER NOT NULL DEFAULT 0,
  evening_reset_enabled INTEGER NOT NULL DEFAULT 0,
  evening_reset_minute INTEGER NOT NULL DEFAULT 1260,
  digest_minute INTEGER NOT NULL DEFAULT 1080,
  max_standalone_suggestions_per_day INTEGER NOT NULL DEFAULT 2,
  work_window_start_minute INTEGER NOT NULL DEFAULT 540,
  work_window_end_minute INTEGER NOT NULL DEFAULT 1080,
  durable_memory_days INTEGER NOT NULL DEFAULT 3650,
  raw_media_hours INTEGER NOT NULL DEFAULT 24,
  telemetry_hours INTEGER NOT NULL DEFAULT 24,
  accountability_summary_days INTEGER NOT NULL DEFAULT 90,
  limit_embeddings_per_day INTEGER NOT NULL DEFAULT 500,
  limit_semantic_queries_per_day INTEGER NOT NULL DEFAULT 100,
  limit_media_bytes_per_day INTEGER NOT NULL DEFAULT 52428800,
  limit_image_assessments_per_day INTEGER NOT NULL DEFAULT 20,
  max_images_per_checkpoint INTEGER NOT NULL DEFAULT 2,
  max_image_bytes INTEGER NOT NULL DEFAULT 10485760,
  location_label TEXT,
  location_lat REAL,
  location_lon REAL,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL DEFAULT 0
);
INSERT INTO ext_settings (id) VALUES (1);

-- 1. Source records (provenance). Raw sources expire with chat retention; durable excerpts
--    supporting retained facts follow durable_memory_days; staging is excluded from retrieval.
CREATE TABLE source_records (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('sms', 'note', 'upload', 'calendar', 'email', 'device', 'admin', 'meeting')),
  origin_id TEXT NOT NULL,
  speaker TEXT NOT NULL DEFAULT 'owner' CHECK (speaker IN ('owner', 'assistant', 'third_party', 'system')),
  content_enc TEXT,
  content_hash TEXT,
  retention_class TEXT NOT NULL DEFAULT 'raw' CHECK (retention_class IN ('raw', 'durable', 'staging')),
  consent_scope TEXT NOT NULL DEFAULT 'memory',
  event_at INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  expires_at INTEGER,
  deleted_at INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE (kind, origin_id)
);
CREATE INDEX idx_sources_expiry ON source_records (retention_class, expires_at);

-- 3. Entities and aliases. Labels are encrypted; `bidx` is an HMAC blind index of the
--    normalized label/alias for exact lookup without plaintext search indexes.
CREATE TABLE entities (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('item', 'container', 'place', 'person', 'project', 'organization', 'document', 'activity', 'topic', 'owner')),
  label_enc TEXT NOT NULL,
  bidx TEXT NOT NULL,
  description_enc TEXT,
  attributes_enc TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'merged', 'deleted')),
  merged_into TEXT,
  source_id TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX idx_entities_bidx ON entities (bidx, status);
CREATE INDEX idx_entities_type ON entities (type, status);

CREATE TABLE entity_aliases (
  id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL REFERENCES entities (id) ON DELETE CASCADE,
  alias_enc TEXT NOT NULL,
  bidx TEXT NOT NULL,
  source_id TEXT,
  ambiguous INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'removed')),
  created_at INTEGER NOT NULL,
  UNIQUE (entity_id, bidx)
);
CREATE INDEX idx_aliases_bidx ON entity_aliases (bidx, status);

-- 2/3. Atomic assertions (facts, relationships, intentions, observations) with provenance,
--      epistemic label, modality/polarity, attribution, effective and recorded time.
CREATE TABLE assertions (
  id TEXT PRIMARY KEY,
  extraction_key TEXT NOT NULL UNIQUE,
  subject_id TEXT NOT NULL REFERENCES entities (id),
  predicate TEXT NOT NULL,
  object_entity_id TEXT REFERENCES entities (id),
  object_value_enc TEXT,
  value_type TEXT NOT NULL DEFAULT 'text',
  evidence_type TEXT NOT NULL CHECK (evidence_type IN ('explicit_report', 'observed_event', 'confirmed_external_record', 'tentative', 'assistant_proposal', 'inference', 'disputed', 'superseded', 'retracted')),
  speaker TEXT NOT NULL DEFAULT 'owner',
  attributed_to TEXT,
  polarity TEXT NOT NULL DEFAULT 'affirmative' CHECK (polarity IN ('affirmative', 'negated')),
  modality TEXT NOT NULL DEFAULT 'actual' CHECK (modality IN ('actual', 'intended', 'possible', 'hypothetical', 'obligation')),
  source_id TEXT,
  excerpt_enc TEXT,
  effective_from INTEGER NOT NULL,
  effective_to INTEGER,
  recorded_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'current' CHECK (status IN ('current', 'historical', 'tentative', 'disputed', 'retracted', 'deleted')),
  supersedes_id TEXT,
  scope_key TEXT,
  schema_version INTEGER NOT NULL DEFAULT 1,
  model TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_assertions_subject ON assertions (subject_id, predicate, status);
CREATE INDEX idx_assertions_object ON assertions (object_entity_id, predicate, status);
CREATE INDEX idx_assertions_source ON assertions (source_id);

CREATE TABLE memory_proposals (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  payload_enc TEXT NOT NULL,
  candidate_ids_json TEXT NOT NULL DEFAULT '[]',
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected', 'expired')),
  source_id TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  resolved_at INTEGER
);

CREATE TABLE memory_events (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  entity_id TEXT,
  assertion_id TEXT,
  source_id TEXT,
  detail_enc TEXT,
  reason TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_memory_events_created ON memory_events (created_at);

CREATE TABLE extraction_runs (
  id TEXT PRIMARY KEY,
  inbound_id TEXT NOT NULL UNIQUE,
  source_id TEXT,
  status TEXT NOT NULL,
  summary_enc TEXT,
  created_at INTEGER NOT NULL
);

-- 5. Retrieval indexes (derived, replaceable) and tombstones for deletion propagation.
CREATE TABLE index_state (
  object_id TEXT PRIMARY KEY,
  object_type TEXT NOT NULL,
  canonical_version INTEGER NOT NULL,
  indexed_version INTEGER,
  index_kind TEXT,
  dirty INTEGER NOT NULL DEFAULT 1,
  deleted INTEGER NOT NULL DEFAULT 0,
  retries INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_index_state_dirty ON index_state (dirty, updated_at);

CREATE TABLE semantic_vectors (
  object_id TEXT PRIMARY KEY,
  object_type TEXT NOT NULL,
  model TEXT NOT NULL,
  dims INTEGER NOT NULL,
  vector_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE retrieval_evidence (
  id TEXT PRIMARY KEY,
  query_hash TEXT NOT NULL,
  assertion_ids_json TEXT NOT NULL,
  source_ids_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE deletion_tombstones (
  object_id TEXT PRIMARY KEY,
  object_type TEXT NOT NULL,
  deleted_at INTEGER NOT NULL
);

-- Secretary records (typed domain items sharing one table).
CREATE TABLE secretary_items (
  id TEXT PRIMARY KEY,
  extraction_key TEXT UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('promise', 'waiting_for', 'question', 'decision', 'prediction', 'accomplishment', 'checkpoint', 'idea', 'future_message', 'admin_item', 'recruiting', 'interaction', 'lesson', 'preference', 'note', 'trip', 'opportunity', 'interest', 'meeting_note')),
  status TEXT NOT NULL DEFAULT 'open',
  title_enc TEXT NOT NULL,
  data_enc TEXT NOT NULL DEFAULT '',
  person_id TEXT REFERENCES entities (id),
  project_id TEXT REFERENCES entities (id),
  task_id TEXT,
  due_at INTEGER,
  check_at INTEGER,
  trigger_kind TEXT,
  trigger_bidx TEXT,
  source_id TEXT,
  evidence_type TEXT NOT NULL DEFAULT 'explicit_report',
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  resolved_at INTEGER,
  deleted_at INTEGER
);
CREATE INDEX idx_secretary_kind ON secretary_items (kind, status);
CREATE INDEX idx_secretary_person ON secretary_items (person_id, kind);
CREATE INDEX idx_secretary_check ON secretary_items (status, check_at);

CREATE TABLE task_meta (
  task_id TEXT PRIMARY KEY REFERENCES tasks (id) ON DELETE CASCADE,
  estimate_minutes INTEGER,
  estimate_source TEXT,
  context_tags_json TEXT NOT NULL DEFAULT '[]',
  effort TEXT,
  postpone_count INTEGER NOT NULL DEFAULT 0,
  project_id TEXT,
  deadline_kind TEXT NOT NULL DEFAULT 'none' CHECK (deadline_kind IN ('none', 'external', 'self_imposed')),
  consequence_enc TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE task_dependencies (
  task_id TEXT NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  depends_on_id TEXT NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'explicit' CHECK (status IN ('explicit', 'proposed')),
  source_id TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (task_id, depends_on_id)
);

-- 10. One suggestion service for all proactive features.
CREATE TABLE suggestions (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  suppression_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'notified', 'accepted', 'dismissed', 'snoozed', 'expired', 'suppressed')),
  priority INTEGER NOT NULL DEFAULT 1,
  delivery TEXT NOT NULL DEFAULT 'digest' CHECK (delivery IN ('digest', 'standalone')),
  text_enc TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '[]',
  action_enc TEXT,
  scope TEXT,
  expires_at INTEGER NOT NULL,
  snoozed_until INTEGER,
  notified_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_suggestions_status ON suggestions (status, expires_at);
CREATE TABLE suggestion_suppressions (suppression_key TEXT PRIMARY KEY, created_at INTEGER NOT NULL);

CREATE TABLE undo_log (
  id TEXT PRIMARY KEY,
  action_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  description_enc TEXT NOT NULL,
  inverse_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  undone_at INTEGER
);
CREATE INDEX idx_undo_created ON undo_log (created_at);

-- 11/12. Accountability.
CREATE TABLE acc_policies (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('task', 'morning', 'check_once')),
  task_id TEXT,
  alarm_id TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'canceled', 'ended')),
  version INTEGER NOT NULL DEFAULT 1,
  timezone TEXT NOT NULL,
  config_json TEXT NOT NULL,
  source_action_key TEXT UNIQUE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  canceled_at INTEGER
);

CREATE TABLE acc_sessions (
  id TEXT PRIMARY KEY,
  policy_id TEXT NOT NULL REFERENCES acc_policies (id),
  policy_version INTEGER NOT NULL,
  occurrence_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('scheduled', 'awaiting_start', 'active', 'awaiting_checkpoint', 'paused', 'completed', 'canceled', 'expired', 'needs_attention')),
  intended_start INTEGER NOT NULL,
  intended_end INTEGER NOT NULL,
  actual_start INTEGER,
  actual_end INTEGER,
  task_id TEXT,
  alarm_occurrence_id TEXT,
  call_attempts INTEGER NOT NULL DEFAULT 0,
  call_cap INTEGER NOT NULL DEFAULT 2,
  paused_until INTEGER,
  photos_allowed INTEGER NOT NULL DEFAULT 1,
  reason TEXT,
  summary_enc TEXT,
  generation INTEGER NOT NULL DEFAULT 1,
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (policy_id, occurrence_key)
);
CREATE INDEX idx_acc_sessions_state ON acc_sessions (state, intended_start);

CREATE TABLE acc_checkpoints (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES acc_sessions (id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('call', 'device_checkin', 'evidence', 'text_check', 'later_check')),
  label TEXT NOT NULL,
  intended_at INTEGER NOT NULL,
  grace_until INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  evidence_kinds_json TEXT NOT NULL DEFAULT '[]',
  criterion_enc TEXT,
  nonce TEXT,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'requested', 'satisfied', 'missed', 'unverifiable', 'waived', 'canceled', 'needs_clarification')),
  status_label TEXT,
  evidence_ids_json TEXT NOT NULL DEFAULT '[]',
  escalate_call INTEGER NOT NULL DEFAULT 0,
  generation INTEGER NOT NULL DEFAULT 1,
  version INTEGER NOT NULL DEFAULT 1,
  satisfied_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (session_id, ordinal)
);
CREATE INDEX idx_acc_checkpoints_state ON acc_checkpoints (state, intended_at);

-- 13. Registered browser devices.
CREATE TABLE registered_devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  public_key_jwk TEXT NOT NULL,
  key_thumbprint TEXT NOT NULL UNIQUE,
  capabilities_json TEXT NOT NULL DEFAULT '{}',
  browser TEXT,
  epoch INTEGER NOT NULL DEFAULT 1,
  last_seq INTEGER NOT NULL DEFAULT 0,
  enrolled_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  last_state TEXT,
  revoked_at INTEGER,
  revoked_reason TEXT
);

CREATE TABLE device_pairing_codes (
  code_hash TEXT PRIMARY KEY,
  device_name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);

CREATE TABLE device_challenges (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES registered_devices (id) ON DELETE CASCADE,
  session_id TEXT,
  checkpoint_id TEXT,
  nonce TEXT NOT NULL UNIQUE,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
);

CREATE TABLE device_events (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES registered_devices (id) ON DELETE CASCADE,
  epoch INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  state TEXT,
  session_id TEXT,
  checkpoint_id TEXT,
  reported_at INTEGER,
  received_at INTEGER NOT NULL,
  accepted INTEGER NOT NULL,
  reason TEXT,
  expires_at INTEGER NOT NULL,
  UNIQUE (device_id, epoch, seq)
);
CREATE INDEX idx_device_events_expiry ON device_events (expires_at);

-- 14. Uploads, media objects, evidence.
CREATE TABLE upload_tokens (
  token_hash TEXT PRIMARY KEY,
  purpose TEXT NOT NULL CHECK (purpose IN ('accountability', 'knowledge')),
  session_id TEXT,
  checkpoint_id TEXT,
  entity_id TEXT,
  max_objects INTEGER NOT NULL,
  max_bytes INTEGER NOT NULL,
  allowed_types TEXT NOT NULL,
  used_objects INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'finalized', 'expired', 'revoked')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  finalized_at INTEGER
);

CREATE TABLE media_objects (
  id TEXT PRIMARY KEY,
  storage_key TEXT NOT NULL UNIQUE,
  purpose TEXT NOT NULL CHECK (purpose IN ('accountability', 'knowledge')),
  source TEXT NOT NULL CHECK (source IN ('upload', 'mms')),
  session_id TEXT,
  checkpoint_id TEXT,
  entity_id TEXT,
  sha256 TEXT NOT NULL,
  content_type TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  width INTEGER,
  height INTEGER,
  metadata_stripped INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER,
  deleted_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_media_expiry ON media_objects (expires_at, deleted_at);

CREATE TABLE evidence_submissions (
  id TEXT PRIMARY KEY,
  dedupe_key TEXT NOT NULL UNIQUE,
  session_id TEXT,
  checkpoint_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('photo', 'text', 'device_checkin', 'call_ack', 'owner_assertion', 'external_record')),
  media_ids_json TEXT NOT NULL DEFAULT '[]',
  text_enc TEXT,
  device_id TEXT,
  reported_capture_at INTEGER,
  received_at INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'received_unassessed' CHECK (state IN ('received_unassessed', 'assessed', 'not_assessable', 'rejected')),
  expires_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE evidence_assessments (
  id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL UNIQUE REFERENCES evidence_submissions (id) ON DELETE CASCADE,
  verdict TEXT NOT NULL CHECK (verdict IN ('consistent', 'inconsistent', 'unclear', 'unavailable')),
  detail_enc TEXT NOT NULL,
  model TEXT NOT NULL,
  assessor_version TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- 9. Optional read-only email and current-information sources.
CREATE TABLE email_connection (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  provider TEXT NOT NULL DEFAULT 'none',
  status TEXT NOT NULL DEFAULT 'disconnected' CHECK (status IN ('disconnected', 'connected', 'needs_reconnect')),
  account_email TEXT,
  scopes TEXT,
  access_token_enc TEXT,
  refresh_token_enc TEXT,
  access_expires_at INTEGER,
  last_sync_at INTEGER,
  last_error TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL DEFAULT 0
);
INSERT INTO email_connection (id) VALUES (1);

CREATE TABLE email_candidates (
  id TEXT PRIMARY KEY,
  waiting_id TEXT NOT NULL,
  message_ref TEXT NOT NULL,
  subject_enc TEXT,
  received_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'candidate' CHECK (status IN ('candidate', 'confirmed', 'rejected')),
  created_at INTEGER NOT NULL,
  UNIQUE (waiting_id, message_ref)
);

CREATE TABLE info_snapshots (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  query_key TEXT NOT NULL,
  data_enc TEXT,
  source_url TEXT,
  fetched_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ok', 'unavailable', 'error'))
);

-- Simulated fixtures and the local media store fake (development/test only).
CREATE TABLE sim_emails (
  id TEXT PRIMARY KEY,
  from_addr TEXT NOT NULL,
  subject TEXT NOT NULL,
  snippet TEXT NOT NULL,
  thread_id TEXT,
  received_at INTEGER NOT NULL
);

CREATE TABLE local_media_store (
  storage_key TEXT PRIMARY KEY,
  content_type TEXT NOT NULL,
  data_b64 TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
