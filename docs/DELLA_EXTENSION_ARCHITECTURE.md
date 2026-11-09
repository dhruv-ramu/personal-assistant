# Della extension architecture

This document covers the second-brain, secretary, and accountability extension built on top of the base Della Worker (see [ARCHITECTURE.md](ARCHITECTURE.md)). Everything runs in the same Cloudflare Worker, D1 database, queue, and minute Cron. Nothing new is a separate service.

## Principles carried over

- One owner. Destinations are owner-only, STOP wins, and dry run gates every external mutation.
- Every external effect goes through the existing effect outbox and usage reservations. Unknown outcomes are never blindly resent.
- Deterministic paths come first. Exact item lookup, list queries, date triggers, and accountability prompts need no AI call.
- Extraction output is a *proposal*. Code validates it (spans quoted from the message, names and numbers present) before anything is stored, and memory content can never widen permissions, change destinations, or enable monitoring.
- Deployment flags override owner settings. Every optional adapter can be unavailable without breaking item recall or the original reminders.

## Modules

| Area | Files |
| --- | --- |
| Schema (additive) | `migrations/0003_extension.sql` |
| Settings and feature flags | `src/ext/settings.ts` (`featureOn`), `src/config.ts` (`ext`), `src/env.ts` |
| Optional adapters | `src/ext/providers.ts`: media store (R2 / local D1 fake), embeddings (OpenAI / hash fake), semantic index (D1 brute force / Vectorize), vision assessor (OpenAI / simulated), email (Gmail read-only / simulated), current info (NWS / simulated), MMS fetcher (Twilio / simulated). `src/ext/email.ts` (Gmail OAuth tokens) |
| Knowledge core | `src/knowledge/store.ts` (sources, entities, aliases, assertions, events, merge/split), `resolve.ts`, `schema.ts` (extraction candidates), `ingest.ts` (validation and application), `sensitive.ts` |
| Locations | `src/knowledge/locations.ts` (containment graph, tentative, late reports, lending, absence, cycles, history) |
| Retrieval | `src/knowledge/retrieval.ts` (hydrate, typed answers, keyword + semantic search, evidence packets, citation validation), `index-sync.ts` |
| Deletion | `src/knowledge/forget.ts` (tombstones, derived-data purge) |
| Secretary | `secretary.ts` (items), `checks.ts` (waiting-for, dated messages, relationship follow-ups), `meetings.ts`, `planning.ts`, `triggers.ts`, `briefs.ts` (free time, trip, weather), `suggestions.ts`, `undo.ts`, `jobs.ts` |
| Accountability | `src/accountability/machine.ts` (state machine), `sessions.ts` (policies, sessions, checkpoints, routines, calls), `devices.ts` (pairing, signed events, challenges) |
| Media | `src/media/images.ts` (magic bytes, dimensions, metadata stripping), `uploads.ts` (tokens, upload page, MMS, assessment job, retention) |
| SMS integration | `src/services/ext-commands.ts` (deterministic commands), `ext-executor.ts` (actions, clarifications, routine confirmation), `inbound.ts` (off-record, MMS, capture), `commands.ts` |
| HTTP | `src/http/ext-routes.ts` (`/u/:token`, `/api/device/*`), `oauth.ts` (`/oauth/gmail/*`), `admin-ext.ts` (dashboard views), `admin-helpers.ts` |
| Browser extension | `extension/src/*`, `scripts/build-extension.mjs` |
| Simulator rules | `src/providers/simulated/knowledge-rules.ts` (rule-based extraction for tests/demo only) |

## Message flow

1. The webhook stores the inbound message durably (unchanged). For MMS, provider media URLs are kept in the inbound metadata.
2. `process_inbound` checks for **off-record** phrasing ("don't store this"). The remainder is planned. For off-record messages, extraction output is never persisted, and the raw text and conversation-log entry are removed after the reply.
3. Planning: deterministic commands first (`commands.ts` → `ext-commands.ts`), otherwise the AI planner. One structured call returns both `actions` and a `knowledge` candidate array. When memory is off, candidates are dropped *before* the plan is stored.
4. Actions run through `runAction`. Extension actions route to `ext-executor.ts`.
5. **Memory capture** runs once per message as a resumable pseudo-action (`in:<inbound>:k`): `ingestKnowledge` validates each candidate and applies it, and writes an `extraction_runs` summary and an undo record.
6. One reply effect is composed (unchanged).

## Jobs (new kinds)

`secretary_check`, `index_sync`, `suggestion_digest`, `acc_checkpoint` (phases request → grace → expire), `acc_session_end`, `evidence_assess`, `meeting_prep`, `post_meeting`, `evening_reset`. All use logical keys and entity generations, so duplicate or out-of-order queue deliveries are no-ops. Proactive kinds are canceled by STOP alongside the original proactive jobs.

The minute tick also materializes morning-routine sessions for upcoming wake-call occurrences, ensures the daily digest, evening-reset, and index-sync jobs exist when their features are on, and purges expired media (so raw photos don't outlive their 24-hour window by a daily sweep's slack).

## HTTP surface (deny by default)

| Route | Auth |
| --- | --- |
| `GET/POST /u/:token` | one-time upload capability token (hash stored), strict CSP, `no-referrer`, `no-store`, 25 MB body cap on this path only |
| `OPTIONS/POST /api/device/pair` | one-time pairing code (10 min) |
| `POST /api/device/sync`, `/api/device/checkin` | ECDSA P-256 signed envelope from an enrolled key; credential-less CORS; no cookies |
| `GET /oauth/gmail/start`, `/oauth/gmail/callback` | admin session + namespaced one-time state + PKCE |
| `/admin/knowledge`, `/items`, `/memory`, `/secretary`, `/accountability`, `/devices`, `/privacy`, `/ext-settings`, `/email/disconnect` | existing admin session + CSRF + Origin |

Media is never served over HTTP. There is no listing route.

## Bindings and configuration

| Binding / var | Purpose |
| --- | --- |
| `MEDIA` (R2) | private bucket for stripped evidence images (`della-media-<env>`). Local dev uses the D1-backed fake (`MEDIA_STORE=local`) |
| `VECTORS` (Vectorize, optional) | only when `SEMANTIC_INDEX=vectorize`. Default is the bounded D1 index |
| `MEDIA_STORE`, `VISION_PROVIDER`, `EMBEDDING_PROVIDER`, `SEMANTIC_INDEX`, `EMAIL_PROVIDER`, `INFO_PROVIDER` | adapter selection. All default to local/simulated |
| `OPENAI_VISION_MODEL` (default `gpt-6-luna`), `OPENAI_EMBEDDING_MODEL` (default `text-embedding-3-small`, 256 dims) | live models |
| `GMAIL_REDIRECT_URI`, `NWS_CONTACT` | Gmail grant redirect; api.weather.gov User-Agent contact |
| `CAPTURE_ENABLED`, `SEMANTIC_INDEX_ENABLED`, `UPLOADS_ENABLED`, `MMS_INGEST_ENABLED`, `IMAGE_ASSESSMENT_ENABLED`, `BROWSER_TELEMETRY_ENABLED`, `MORNING_ROUTINES_ENABLED`, `TASK_ACCOUNTABILITY_ENABLED`, `EMAIL_READ_ENABLED`, `CURRENT_INFO_ENABLED`, `SUGGESTIONS_ENABLED` | deployment kill switches (default `true`). `"false"` overrides any owner setting |

The outbound allowlist gained `gmail.googleapis.com` and `api.weather.gov`.

## Migration and rollback

- `0003_extension.sql` is additive: new tables, indexes, and seed rows for `ext_settings` and `email_connection`. No existing table or column changes, so the base app runs unchanged against a migrated database.
- Rollback: redeploy the previous Worker. The extra tables are ignored by older code. Dropping them is a manual, destructive step: export first (`npm run backup`), then drop tables in reverse dependency order. No down-migration is shipped, by design.
- Backup and restore: canonical extension tables are included in the dump. Derived indexes, caches, challenges, upload tokens, pairing codes, and raw telemetry are excluded. After a restore: devices are revoked (re-pair), telemetry is turned off, open accountability work is canceled, indexes are marked for rebuild, and deletions made after the backup are re-applied (`carryDeletionsForward`). `scripts/post-restore.sql` mirrors the SQL parts for the CLI path. Carrying tombstones forward on the CLI path is a manual step (see [DELLA_PRIVACY_RETENTION.md](DELLA_PRIVACY_RETENTION.md)).
