-- Applied after restoring a backup. Mirrors applyPostRestoreSafety() in src/services/backup.ts.
-- A backup can predate effects a provider already accepted; nothing is replayed automatically.
UPDATE owner_settings SET restore_hold = 1, version = version + 1 WHERE id = 1;
DELETE FROM admin_sessions;
DELETE FROM oauth_states;
UPDATE outbound_effects SET state = 'unknown', error_detail = 'In flight at backup time; outcome unknown after restore.' WHERE state = 'sending';
UPDATE jobs SET status = 'pending', lease_token = NULL, lease_expires_at = NULL, next_dispatch_at = NULL WHERE status = 'running';
INSERT INTO system_state (key, value, updated_at) VALUES ('restored_at', CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000)
  ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;
-- Extension: devices must re-enroll, telemetry stays off until the owner re-enables it, open
-- accountability work is canceled (never resumed or replayed), and derived indexes are rebuilt.
UPDATE registered_devices SET revoked_at = CAST(strftime('%s','now') AS INTEGER) * 1000, revoked_reason = 'restored_backup' WHERE revoked_at IS NULL;
DELETE FROM device_challenges;
DELETE FROM device_pairing_codes;
DELETE FROM device_events;
UPDATE upload_tokens SET state = 'revoked' WHERE state = 'open';
UPDATE ext_settings SET telemetry_enabled = 0, version = version + 1 WHERE id = 1;
UPDATE acc_checkpoints SET state = 'canceled', status_label = 'restored_backup', generation = generation + 1 WHERE state IN ('pending','requested','needs_clarification');
UPDATE acc_sessions SET state = 'canceled', reason = 'restored_backup', version = version + 1 WHERE state NOT IN ('completed','canceled','expired','needs_attention');
UPDATE jobs SET status = 'canceled', last_error = 'restored_backup' WHERE status = 'pending' AND kind IN ('acc_checkpoint','acc_session_end','evidence_assess');
DELETE FROM semantic_vectors;
DELETE FROM retrieval_evidence;
UPDATE index_state SET dirty = 1, indexed_version = NULL, retries = 0 WHERE deleted = 0;
