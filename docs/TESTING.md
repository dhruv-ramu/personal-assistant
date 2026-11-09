# Della testing

| Command | What runs |
| --- | --- |
| `npm test` | unit + integration projects (Vitest 5 inside workerd via `@cloudflare/vitest-plugin`) |
| `npm run test:acceptance` / `npm run demo` | base S1–S17 and extension X1–X27; writes `artifacts/acceptance-results.json`, `docs/ACCEPTANCE_RESULTS.md`, `docs/DELLA_EXTENSION_ACCEPTANCE_RESULTS.md` |
| `npm run demo:extension` | integrated extension demo (`tests/demo/`); prints and writes `artifacts/extension-demo.md` |
| `npm run test:memory:live` | **Opt-in** (`LIVE_AI_EVAL=1` + key): ≤16 read-only calls over `tests/live/memory-corpus.json` (fictional); per-metric results, tokens, latency, cost in `artifacts/live-memory-eval.json` |
| `npm run test:e2e` | Playwright (desktop + mobile) against a real `wrangler dev` Worker with an isolated D1 |
| `npm run test:ai:live` | **Opt-in** (`LIVE_AI_EVAL=1` + key): ≤12 read-only model calls, results in `artifacts/live-ai-eval.json` |
| `npm run db:validate` | migrations applied to fresh SQLite + integrity/FK checks; Wrangler env config rules |
| `npm run check` | lint, typecheck (src + tests), db:validate, tests, acceptance, three bundle dry runs |

Design rules:

- Tests run in the real Workers runtime with the **real checked-in D1 migrations** (`tests/setup/apply-migrations.ts`). A second D1 binding (`DB_RESTORE`) is used for the restore test.
- The clock is frozen and injected: `2026-11-08T18:00Z` (Sunday 10:00 AM PT) unless a test says otherwise. Production code has no mock dates.
- Inbound traffic goes through the **actual HTTP routes** with signed requests (`tests/helpers/harness.ts`, `src/services/simulator.ts`). Jobs run through the real claim/finish code. The queue is replaced by a collecting dispatcher so delivery order (including reordering and failures) is controlled.
- External APIs are mocked at the HTTP boundary (Twilio REST, Google OAuth and Calendar, OpenAI Responses). No paid calls or messages are made in CI.
- **A mock passing is not evidence that a real provider account works.** No live integration has been exercised.

## Coverage of the specification's test list

| Area | Where |
| --- | --- |
| Valid/invalid/missing signature; wrong account or destination; unauthorized sender (no AI/action); query strings, repeated fields, ports; official Twilio vector | `tests/integration/ingress.test.ts`, `tests/unit/twilio-signature.test.ts` |
| Duplicate provider message → one plan/task/reply; storage failure → 503; queue failure recovered by Cron | ingress, acceptance S4, S11 |
| STOP precedence; provider-managed replies not duplicated; START scope | ingress, acceptance S9 |
| Admin auth, cookie flags, throttling, CSRF + Origin, OAuth state replay/expiry/session binding, fixed redirect, expected account, XSS escaping, CSP, redacted logs, no production simulator/injection routes | `tests/integration/admin.test.ts`, ingress |
| Task lifecycle, due vs reminder vs follow-up, bare/ambiguous DONE, explicit/invented IDs, clarification resume and interruption, expired/consumed confirmations, changed target, multi-action partial failure + resume, recurring occurrence vs series | `tests/integration/conversation.test.ts`, acceptance S1–S5 |
| Claim races, lost lease, duplicate cron/deliveries, restart-safe logical keys, crash before/during/after send, unknown never re-sent, retryable vs permanent, callback idempotency/ordering | `tests/integration/jobs.test.ts`, acceptance S12 |
| Expired calls, backlog coalescing, follow-up caps, quiet hours, pause/resume, usage reservations, recurrence from intended time | voice, conversation, acceptance S8, S14, S15, S16; `tests/unit/time.test.ts` |
| Local midnight/UTC boundary, tomorrow vs 24 h across DST, gap/fold, daily/weekday/weekly across DST and year boundary, AM/PM, next weekday, quiet hours across midnight, timezone change policy | `tests/unit/time.test.ts`, `tests/unit/recurrence.test.ts`, conversation |
| OAuth refresh keeps refresh token; revoked → reconnect while reminders continue; pagination, recurring instances, cancelled/declined/all-day; same-ID create retry; If-Match conflict; moved/cancelled heads-up; unavailable calendar; dry run never writes | `tests/integration/calendar.test.ts`, acceptance S6, S13 |
| Keypad 1 once + retry canceled; keypad 2 once despite duplicates; completed ≠ awake; bounded no-answer retry; unknown never auto-retries; cancellation before fetch; late callbacks; owner-only destination; rate limits; expired suppression | `tests/integration/voice.test.ts`, acceptance S7, S8, S15 |
| Valid output, refusal, truncation, invalid JSON + one repair, 429/5xx/timeout; prompt injection; commands and reminders don't call AI; budget exhaustion with one warning; segment counting; resume saved plan | `tests/unit/planning.test.ts`, `tests/unit/segments-crypto.test.ts`, `tests/integration/ai-cost-twilio.test.ts`, acceptance S10, S16 |
| Export/restore into a clean DB without duplicate sends; retention; erase | acceptance S17, ai-cost-twilio |
| Meaningful admin flows in a browser | `tests/e2e/admin.spec.ts` |
| Extension: memory, locations, grounding, deletion, retention, secretary, planning | `tests/acceptance/extension.test.ts` X1–X17, `tests/unit/extension.test.ts`, `tests/integration/extension-more.test.ts` |
| Extension: accountability, routines, shared call cap, device protocol, uploads, vision, restore | X18–X27, `tests/integration/extension.test.ts`, `tests/unit/ext-adapters.test.ts` (mocked HTTP for OpenAI, Gmail, NWS, Twilio MMS; fakes for R2/Vectorize) |
| Extension dashboard and real-browser extension pairing | `tests/integration/admin-ext.test.ts`, `tests/e2e/extension.spec.ts` (Chromium loads `dist-extension/chrome`) |

The extension's rule-based extraction (`src/providers/simulated/knowledge-rules.ts`) exists only to drive tests and the demo. It proves orchestration, validation, storage, and policy logic, not model extraction quality.
