# Della architecture

One Cloudflare Worker (`src/index.ts`) with three entry points:

| Entry | Purpose |
| --- | --- |
| `fetch` | Hono router: provider webhooks, the admin dashboard, OAuth, `/health` |
| `scheduled` | Minute Cron: heartbeat, materialize the next recurring occurrence, ensure periodic jobs, publish due job IDs. No AI calls. |
| `queue` | Consumer for `della-jobs-*` (batch size 1, concurrency 1) and its dead-letter queue |

D1 is the source of truth. Queue messages carry `{ v: 1, jobId }` only.

```text
phone ──SMS──▶ provider ──signed webhook──▶ /webhooks/sms/inbound
                                              │ verify signature, account, destination, sender
                                              │ STOP/START applied here, deterministically
                                              ▼
                              D1 batch: inbound_messages + process_inbound job (+ seq)
                                              │ 200 empty TwiML; waitUntil(dispatch)
                                              ▼
 Cron (every minute) ──▶ due jobs ──▶ Queue ──▶ consumer: conditional claim (fencing token)
                                              │
   process_inbound: order by seq → plan once (deterministic | AI) → persist plan
     → per action: resolve (time/refs) → clarify | confirm | execute (idempotent keys)
     → one reply effect + deliver job (one batch)
   send_reminder / calendar_headsup / morning_brief: revalidate → template → effect → send
   alarm_call: revalidate → reserve → effect → create call → TwiML/DTMF/status callbacks
                                              ▼
              outbound_effects (pending → sending → accepted | failed | unknown → delivered)
                                              ▼
                    provider status callbacks (signed) → immutable facts → monotonic state
```

## Layout

```text
src/index.ts                 Worker entry points
src/config.ts                Typed env validation, production safety checks
src/context.ts               Builds AppContext: config, Db, clock, crypto, providers, dispatcher
src/http/                    router (route policy + security headers), webhooks, admin, oauth
src/domain/                  actions (typed vocabulary + strict JSON schema), time, recurrence,
                             timespec (deterministic time resolution), timeparse, tasks, alarms,
                             calendar, conversations (context, clarifications, confirmations)
src/services/                inbound, commands (deterministic), executor, jobs, queue-consumer,
                             scheduler, effects (outbox), reminders, series, usage, readiness,
                             settings, calendar-connection, retention, backup, simulator, audit
src/providers/               types (transport interfaces), twilio/, calendar/ (Google), ai/
                             (OpenAI), simulated/, unconfigured (fail-closed adapters)
src/security/                crypto (AES-GCM, HMAC, IDs), sessions + CSRF, redaction
src/ui/                      server-rendered layout, CSS, minimal JS (no inline script)
migrations/                  0001_init.sql (schema), 0002_simulator.sql (simulator tables)
```

## Data model (D1)

All `*_at` columns are **integer milliseconds UTC**. `*_enc` columns are AES-GCM envelopes.

| Concept | Tables |
| --- | --- |
| Owner/settings | `owner_settings` (single row), `system_state` |
| Inbound | `inbound_messages` (unique `(provider, provider_message_id)`, unique `seq`) |
| Conversation | `conversation_log`, `conversation_state` |
| Tasks | `tasks` (unique `short_id`, unique `(series_id, occurrence_key)`, `version`, `generation`), `reminders` |
| Series | `series` (rrule, `dtstart_local`, IANA `timezone`, next occurrence) |
| Jobs | `jobs` (unique `logical_key`, lease token/expiry, `next_dispatch_at`, attempts) |
| Plans/actions | `plans` (unique per inbound), `action_executions` (unique `action_key`) |
| Effects | `outbound_effects` (unique `effect_key`; destination is always `owner`), `provider_callbacks` (unique `dedupe_key`) |
| Calendar | `calendar_connection`, `calendar_events` (projection), `calendar_headsups` |
| Alarms | `alarm_schedules`, `alarm_occurrences` (unique `(alarm_id, occurrence_key)`) |
| Confirmations/clarifications | `confirmations` (nonce, action hash, targets, expiry), `clarifications` |
| Consent | `suppressions` (per channel), `consent_events` |
| Usage/audit | `usage_counters`, `usage_reservations`, `ai_requests`, `audit_log` |
| Sessions/OAuth | `admin_sessions` (token hash), `login_attempts`, `oauth_states` (state hash, PKCE verifier) |
| Erase | `dedupe_tombstones` (hashed provider message IDs) |

D1 `batch()` is one SQL transaction (all-or-nothing). Interactive transactions aren't available to Workers, so concurrency control uses conditional `UPDATE`/`INSERT … ON CONFLICT` with `meta.changes` checks, plus `changes()` guards inside batches. A batch does **not** abort when a conditional update matches zero rows. That's why state transitions are two-phase: a fenced update first, then dependent writes only if it won. A crash between the phases is caught by send-time revalidation.

## Jobs, leases, dispatch

- **Creation:** `INSERT … ON CONFLICT (logical_key) DO NOTHING`. Logical keys are derived from entity IDs, generations, and attempt labels, so they survive restarts and duplicate deliveries.
- **Dispatch reservation:** the tick sets `next_dispatch_at = now + 2 min` before publishing. Ticks don't republish reserved jobs. If publishing fails or the Worker dies first, the reservation expires and the next tick retries.
- **Claim:** `UPDATE … SET status='running', lease_token=<fresh>, lease_expires_at=now+5min WHERE id=? AND (status='pending' OR (status='running' AND lease_expires_at<now))`. Only one claimant wins. A claim that takes over an expired lease is flagged `recovered`.
- **Completion** is fenced on `lease_token`. A worker that lost its lease can't complete or overwrite the job. A database lease can't revoke a network request already in flight. That boundary is handled by the effect outbox (below).
- **Outcomes:** `succeeded | skipped | canceled | retry (backoff + jitter, bounded attempts and expiry) | reschedule (no attempt consumed: quiet hours, ordering waits) | blocked (actionable, never auto-retried) | failed`.
- **Dead letters:** the queue retries only if D1 itself fails. The DLQ consumer marks the job `dead`, and the admin can retry it. Handlers always revalidate current state, so a retry never blindly replays.

## Outbox and uncertain outcomes

1. The effect row is persisted (`pending`) **before** contacting the provider, together with its delivery job.
2. Gates are checked right before sending: opt-out, channel switch, readiness/live flags, pause (proactive only), and an atomic usage reservation.
3. `pending → sending` is a conditional transition, then the provider call happens.
4. On the result: accepted (SID saved, still **not** "delivered"), rejected-retryable (429, back to pending, reservation released), rejected-permanent (failed; 21610 records a provider opt-out), or **unknown** (timeout/5xx/connection reset: maybe accepted).
5. `unknown` and a leftover `sending` (crash mid-request) are **never re-sent automatically**. Status callbacks carry `?e=<effectId>` in the signed callback URL, so a late callback reconciles the effect even without a saved SID. The admin can resend explicitly, with a duplicate-risk warning, as a **new** effect key.
6. Callbacks are deduplicated immutable facts. State only moves forward (`delivered` is never regressed). A callback whose SID or destination conflicts with the effect is recorded as an error and not applied.

Twilio documents no idempotency key for the Messages or Calls create endpoints, so Della doesn't send one. There is an unavoidable narrow race between the final DB check and the provider accepting a request, and an accepted SMS or call can't be recalled.

## Inbound processing and conversation order

- Every accepted owner message gets a monotonic `seq` (assigned inside the insert). A message waits (`reschedule`, 5 s) while an earlier non-keyword message is unfinished. An earlier message whose job failed, or which has blocked for more than 10 minutes, is marked failed (poison policy) so it can't block later commands. STOP/START skip this ordering entirely: they are applied at the webhook.
- **Plan once:** the first run persists the plan (`plans`, unique per inbound). A retry resumes that plan. Each action has a stable key (`in:<inbound>:<index>`). Finished actions reuse their stored result, and only unfinished ones run again. Creates use deterministic IDs: task IDs come from the action key, and Google event IDs are base32hex digests of it.
- **Deterministic first** (`services/commands.ts`): STATUS, LIST, DONE `<id>`, bare DONE, YES/NO `<nonce>`, numeric and option answers, NOT YET, I'M AWAKE, PAUSE/RESUME, SNOOZE n. These need no AI.
- **AI second** (`providers/ai/openai.ts`): a bounded structured interpretation, then deterministic execution (below).

## AI boundary

- Model: **`gpt-6-luna`** (configurable `OPENAI_MODEL`). It's OpenAI's current cost-sensitive model (verified 2026-11-08: $0.10/M input, $0.50/M output tokens), and it supports Responses API structured outputs and function calling. Della does not upgrade models automatically, and there is no premium fallback.
- Request: `store: false` (this controls *response storage* only; it isn't a blanket retention promise), strict `json_schema` generated from the Zod action union (every object closed and fully required), `max_output_tokens: 2000`, low reasoning effort, a 20 s timeout, at most one transport retry (429/5xx/timeout), and at most one schema repair. Refusal, incomplete, missing, or invalid output executes nothing.
- The model receives the current UTC instant, local time and zone, bounded recent turns, the pending question, up to 15 open tasks, and up to 8 upcoming event titles. Task, calendar, and conversation text is explicitly labeled **untrusted data**.
- The model outputs **expressions**, never instants or IDs. Time phrases become `TimeSpec` fields that `domain/timespec.ts` resolves. Task references are short IDs or words that are resolved through repository lookups (invented IDs fail). Event references are resolved through provider reads. No action has a destination, phone, credential, or URL field. Unknown fields are stripped by Zod.
- If AI is unavailable or over budget, stored reminders, calls, explicit commands, STOP, and STATUS keep working, and free-form text gets one honest short reply.

## Time, DST, recurrence

- Execution happens in UTC. Interpretation and display use IANA zones via `temporal-polyfill`. The clock is injected everywhere (`Clock`), so tests and the simulator control time.
- Relative times anchor to the **inbound receipt time**. Durations chosen while answering a follow-up anchor to the answer's own receipt time.
- "Tomorrow" means the next *local* date. "In 24 hours" is a duration. A bare "at 5" asks AM/PM unless immediate context resolves it (for example "8" after a 5 PM reminder). A bare "tomorrow" or a part of day asks for a time. "Next Friday" asks which date. A past time asks before rolling forward.
- **New one-time actions:** a nonexistent spring-forward time asks to use the next valid time, and an ambiguous fall-back time asks which offset (shown with numeric offsets).
- **Established recurring rules (documented policy):** a nonexistent time moves to the next valid local instant (for example 2:30 → 3:00), and an ambiguous time uses the **earlier** occurrence only.
- Recurrence uses `rrule` in *floating* wall-clock mode, then converts each occurrence with the policy above. Daily 8 AM stays 8 AM local across DST. Supported: daily, weekdays, weekly on chosen days, every N days, COUNT or UNTIL.
- Only the next occurrence is materialized (12 h horizon for tasks, 36 h for alarms). Recurrence advances from the **intended** schedule. After an outage, missed occurrences are counted and skipped (coalesced), never generated as a backlog.
- Quiet hours (default 23:00–07:00) may cross midnight. *Routine* items (default follow-ups, briefs, heads-ups) defer to the end of quiet hours. Times you set explicitly fire as requested. Wake-up calls are exempt.
- Changing the timezone by SMS asks whether recurring schedules follow the new zone. One-time instants are always preserved.

## Lateness and outages

| Item | Policy |
| --- | --- |
| Routine reminder | Sent up to 2 h late (labeled "late" after 5 min); older is `missed` |
| Missed reminders | At most one summary SMS per 6 h, never a burst |
| Calendar heads-up | Stale once the event starts; re-read live before sending; defer within window if the read fails |
| Wake-up call | Expires 10 min after its intended attempt time; snooze creates a new intended time |
| Recurring series | Coalesced: no historical occurrences generated |
| Scheduler gap | Recorded (`last_scheduler_gap`) and shown in diagnostics; no SMS alert (would depend on the failed path). Use an independent uptime monitor on `/health` plus Cron analytics. |

## Confirmations and clarifications

- **Confirmation** = persistent row: nonce (`C` + 3 chars), canonical action JSON plus a SHA-256 hash (verified on load), target IDs and versions (etag/version), a 15-minute expiry, and single-use consumption via a conditional update. "YES C8P2" executes the **saved exact action**, never a new AI plan. Before executing, targets are re-read. If an etag changed, or a new overlap appeared for an inferred slot, nothing executes and the owner is told. A bare "yes" is only accepted when exactly one confirmation is pending.
- Confirmation is required when: moving or deleting an event Della didn't create (or one with guests), whole-series actions, inferred focus slots, overlaps, recurring wake-up calls, or cancelling several alarm schedules. Direct requests to create reminders or new events execute immediately.
- **Clarification** = persistent row with question type, options (and patches), the original proposed action, the slot being clarified, and the original anchor time. An answer patches the action and resumes it (action key `clar:<id>`). A new explicit command interrupts, and questions expire after 15 minutes (follow-up questions after 6 hours).

## Calendar

- Google OAuth uses the authorization code flow with PKCE (S256), offline access, `prompt=consent`, and a one-time state bound to the admin session. Scopes: `openid email calendar.calendarlist.readonly calendar.events`. Identity comes from ID-token claims (issuer, audience, expiry, `email_verified`) received directly from the token endpoint. An optional `GOOGLE_EXPECTED_ACCOUNT` blocks the wrong account; otherwise the owner activates the connection after seeing the verified account.
- Tokens are stored encrypted. A refresh keeps the existing refresh token when none is returned. `invalid_grant` sets the connection to `needs_reconnect`, and task reminders are unaffected.
- Reads: selected calendars, `singleEvents=true` (recurring instances expanded), paginated and bounded. All-day events are handled as dates. Declined, transparent, and cancelled events are excluded from busy and heads-up checks.
- Writes: deterministic event IDs, `sendUpdates=none`, private extended properties `dellaOwner=della` and `dellaAction=<key>`, and `If-Match` etags for patch and delete (412 means not overwritten). A 409 duplicate is reconciled by reading the existing Della-created event. Dry run and `CALENDAR_WRITES_ENABLED=false` never write.
- Heads-ups: the 7-day horizon is polled every 5 minutes (a deliberate trade-off over push channels). There is one heads-up per instance and lead time. A move before sending reschedules it, and a move after sending gets no second heads-up.

## Wake-up calls

Each attempt is bound to one occurrence, generation, and effect. Instructions are revalidated when the call is answered, so a cancelled alarm reads nothing old. TwiML is bounded: two `<Gather numDigits=1>` prompts, then hang up, with no redirects. Keypad 1 acknowledges the occurrence (conditional on the active effect and generation) and cancels retries. Keypad 2 snoozes once, because duplicate gathers are deduplicated by `(CallSid, digits)`, and snoozes are capped at 3. A `completed` call without input is **unacknowledged**. A failed, busy, no-answer, or unacknowledged attempt may schedule the one optional retry (maximum two attempts per intended time). An unknown creation outcome never triggers an automatic call, and late callbacks reconcile it to `missed`. An "I'm awake" text acknowledges the active occurrence.

## Configuration precedence

1. **Environment flags always win.** `DRY_RUN`, `SMS_LIVE_ENABLED`, `SMS_ELIGIBILITY_CONFIRMED`, `VOICE_LIVE_ENABLED`, `AI_LIVE_ENABLED`, and `CALENDAR_WRITES_ENABLED` are deployment variables. If any is "off", no D1 setting can turn the feature on.
2. D1 `owner_settings` holds mutable preferences (quiet hours, switches, limits, consent, attestation). It's edited in the admin UI, or a bounded subset by SMS.
3. **Owner identity** is `OWNER_PHONE_E164` (a deployment secret/var) and nothing else. Changing it is a deployment change. SMS can never change it or redirect messages or calls.
4. In production, invalid core config (encryption key, admin secret, base URL) returns 503 for everything but `/health`, and the Cron tick is skipped. If a live provider is selected but misconfigured, an *unconfigured* adapter fails closed instead of falling back to the simulator.

## Deviations from the specification (and why)

| Item | Decision |
| --- | --- |
| Product name | **Della** (the spec said Jarvis), per the owner's request |
| Test integration | `@cloudflare/vitest-plugin` 1.6 (`cloudflareTest()`), Cloudflare's current replacement for `vitest-pool-workers` |
| Vitest 5.1 / TypeScript 6.0 | TypeScript 7 isn't yet supported by typescript-eslint, and Vitest 5 avoids an npm resolver bug with v4 |
| En dash in ranges | SMS uses ASCII "7-9 PM PT"; an en dash would force UCS-2 (70 chars/segment) |
| Pause semantics | Paused routine items are **skipped** (recorded), not deferred, so resuming never bursts a backlog |
| STOP | Pauses calls too (conservative). START restores SMS only; calls need re-enabling in admin |
| Recurring calendar edits | Single instance or (for cancel) whole series with confirmation; "this and future" and whole-series *moves* by SMS return an honest unsupported response |
| Attendee invitations | Not implemented; requests to invite get an explicit limitation message |
| AI in dry run | AI interpretation may run in dry run if `AI_LIVE_ENABLED=true` (it's read-only; it costs tokens but changes nothing external) |
| Simulated planner | Rule-based; demonstrates the pipeline, not language-model quality |
