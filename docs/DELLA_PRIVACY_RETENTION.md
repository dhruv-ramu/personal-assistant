# Della privacy and retention (extension)

Base Della policies still apply (see [SECURITY.md](SECURITY.md)). This document covers the data the extension adds.

## Separate consents (all off by default except private uploads)

Automatic memory capture, sensitive memory, the semantic index, private uploads, MMS photos, AI photo assessment, browser check-ins, morning routines, task accountability, read-only email, weather, suggestions, meeting prep, post-meeting check-ins, and evening reset. Each one has its own switch (dashboard → Privacy, or SMS `ENABLE …`). A deployment flag set to `"false"` overrides the owner switch.

## What is stored, for how long

| Data | Where | Retention (default) | Notes |
| --- | --- | --- | --- |
| Raw source text of captured messages | `source_records.content_enc` | message retention (30 days) | Sensitive spans are redacted unless sensitive memory is on. |
| Facts and secretary items with short supporting excerpts | `assertions`, `secretary_items` | until you delete them (`durable_memory_days` cap, 3650) | Excerpts survive raw-text expiry so "why?" still works. Erase removes them. |
| Extraction summaries | `extraction_runs` | summary text 30 days | What was saved or rejected per message. |
| Cached answer evidence | `retrieval_evidence` | 7 days | Dropped immediately when a cited fact is deleted. |
| Vectors | `semantic_vectors` or Vectorize | while the source fact exists | Derived. Deleted with the fact. Rebuilt after restore. Vectorize stores opaque IDs plus type only. |
| Raw evidence photos (metadata-stripped) | private R2 bucket (`MEDIA`) | **24 hours** (`raw_media_hours`) | Purged every minute tick. No public URL or listing. |
| Evidence records and assessments | `evidence_submissions`, `evidence_assessments` | accountability summary window (90 days) | Assessment detail is encrypted. |
| Accountability sessions and summaries | `acc_sessions`, `acc_checkpoints` | 90 days after they end | |
| Device events (telemetry) | `device_events` | **24 hours** (`telemetry_hours`) | Only kind, coarse idle state, and accept/reject reason. No URLs or page data. |
| Challenges, pairing codes, upload tokens | own tables | minutes to 24 hours | Stored as hashes or one-time nonces. Expired rows are deleted. |
| Weather snapshots | `info_snapshots` | 1 day | Labelled with source and time. Never stored as personal memory. |
| Email candidates (waiting-for) | `email_candidates` | 30 days | Message ID, encrypted subject, and time only. Della never sends, archives, or deletes email. |
| Undo log | `undo_log` | 30 days | |

## Encryption: who can read what

- Sensitive canonical text (labels, aliases, values, excerpts, secretary titles and data, summaries, assessment detail, email tokens) is encrypted at the application layer with AES-GCM and per-field AAD, under the same keys as the base app.
- **This is not end-to-end encryption.** The Worker decrypts data to process it. With assessment on, the vision provider sees the photo. With the live planner on, the AI provider sees the message text. Della sends `store:false` but can't control provider-side retention.
- Visible as plaintext metadata: entity types, predicates, timestamps, statuses, evidence types, blind-index HMACs (equality only), media sizes and dimensions, device names, and capability flags.
- R2 objects contain the stripped image bytes. They're private to the account but not encrypted by Della.

## Media handling

- Types are checked by magic bytes: JPEG, PNG, and WebP only. HEIC is rejected with instructions. SVG, HTML, and polyglots with markup are rejected.
- Size, dimension (≤ 12,000 px per side), and pixel-count (≤ 50 MP) limits apply. There's a per-checkpoint count limit and a single atomic finalization.
- EXIF, XMP, IPTC, and comment segments are removed from JPEG. `eXIf`/`tEXt`/`iTXt`/`zTXt`/`tIME` chunks are removed from PNG. EXIF and XMP chunks are removed from WebP. Only the stripped derivative is stored. Pixels are untouched.
- MMS photos are fetched with provider credentials only from `https://api.twilio.com/`, size-bounded, and only kept when a photo check is open and MMS is enabled.

## Deletion and erase

- "Forget that", "forget X", and the Memory-inbox delete tombstone first, then purge vectors, cached evidence, linked media, and jobs. Late extraction jobs can't resurrect anything (extraction keys stay reserved).
- **Erase all data** (dashboard → Data) deletes every extension table, deletes stored media objects and indexed vectors, disconnects email, and turns capture, telemetry, routines, and accountability off.
- Not reachable by Della: provider-held logs and copies (Twilio, OpenAI, Google, Cloudflare platform logs) and existing backups.

## Backup and restore

- Backups include canonical extension tables and the encryption key IDs used by their envelopes. Keys themselves are secrets: back them up through your secret manager, never in the dump.
- After restore (in-app `applyPostRestoreSafety`, or `scripts/post-restore.sql`): automation is held; devices are revoked and must re-pair; telemetry is off; open sessions and checkpoints are canceled and never resumed or replayed; challenges, codes, and tokens are gone; indexes are rebuilt.
- **Deletions after the backup still win.** The in-app restore path re-applies tombstones from the database being replaced (`carryDeletionsForward`). For the CLI path, export the live tombstones *before* restoring, then re-insert them and blank the matching rows:

  ```bash
  npx wrangler d1 execute DB --remote --env production --json --command "SELECT object_id, object_type, deleted_at FROM deletion_tombstones" > tombstones.json
  # restore, then for each row: INSERT OR IGNORE INTO deletion_tombstones …; UPDATE assertions/secretary_items/entities/source_records … (see carryDeletionsForward in src/services/backup.ts)
  ```

  This CLI step is documented, not automated.

## Third-party data

Calendar, email, and photo text are untrusted content. They're displayed or used as evidence only and can never act as instructions. Della records only what you tell it about other people. Meeting briefs use only names and questions you recorded, never invented attendees or agendas.
