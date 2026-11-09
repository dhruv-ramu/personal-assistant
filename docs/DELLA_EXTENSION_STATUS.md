# Della extension status

Checklist for `Della_Cursor_Extension_Prompt.md`. Updated 2026-11-08 after the full verification run.

**Status labels.** *Implemented and tested* means code plus automated tests with simulated or mocked providers. *Partial* means the core exists and the named gaps remain. *Not implemented* means no code exists. Nothing in the extension is configured for a real account, live tested, or deployed. Simulator results are not production readiness.

## Verification (actual results)

| Check | Result |
| --- | --- |
| `npm run lint` (ESLint + Prettier) | pass |
| `npm run typecheck` (src + tests) | pass |
| `npm run db:validate` | pass |
| `npm test` (unit + integration, workerd, real D1 migrations) | 19 files, 174 tests pass (base 130 + extension 44) |
| `npm run test:acceptance` | base S1–S17 **17/17**, extension X1–X27 **27/27** → [DELLA_EXTENSION_ACCEPTANCE_RESULTS.md](DELLA_EXTENSION_ACCEPTANCE_RESULTS.md) |
| `npm run demo:extension` | completes; transcript in `artifacts/extension-demo.md` |
| `npm run test:e2e` (Playwright) | 8 pass, 2 intentionally skipped (extension tests run on desktop only), including **real Chromium loading the built extension and pairing** |
| `npm run build`, `build:staging`, `build:production` (wrangler dry runs) | pass; R2 `MEDIA` binding present in each environment |
| `npm run build:extension` | Firefox and Chromium bundles built |
| Live model evaluations | **not run** (no API key in this environment): `npm run test:memory:live` and `npm run test:ai:live` exist and are opt-in and capped |
| Real integrations exercised | **none**: OpenAI vision and embeddings, Gmail, NWS, Twilio MMS, R2, and Vectorize adapters are tested with mocked HTTP or binding fakes only |
| Browser targets actually tested | Chromium (Playwright build) automated. **Firefox not driven** (Playwright can't load unpacked Firefox extensions). Manual steps are in [DELLA_BROWSER_SETUP.md](DELLA_BROWSER_SETUP.md). |
| Deployment | none. No Cloudflare resources were created; `wrangler.jsonc` still has placeholder D1 IDs for staging/production. |

## Requirements

| Spec area | State | Evidence / gaps |
| --- | --- | --- |
| §1 Preserve foundation, additive migration | implemented and tested | `0003_extension.sql` additive; base S1–S17 and all base tests unchanged and passing; X27 |
| §2 Consent boundaries, off by default, deployment flags win | implemented and tested | `featureOn`; integration "deployment-disabled flag overrides"; X25 |
| §3 Canonical D1 records, R2 + local fake, EmbeddingProvider/SemanticIndex with fakes | implemented and tested | `src/ext/providers.ts`; adapter unit tests; X14 |
| §4 Extraction pipeline (off-record first, one combined call, span/name/number validation, idempotent keys, concise acks) | implemented and tested | `inbound.ts`, `ingest.ts`; X6, X9, X15, X16. **Gaps:** no review queue for uncertain candidates (`memory_proposals` table unused); oversized messages are truncated, not split. |
| §5 Items/locations (nesting, move, remove, cycles, lending, ambiguity, merge/split, tentative, late reports, absence, freshness) | implemented and tested | X1–X5. **Gap:** item photos are not linked to entities. |
| §6 Schema, history, deletion with tombstones, retention reconciliation | implemented and tested | X16, X17, X26; `memory_events` audit |
| §7 Retrieval and grounding (exact → typed → keyword/semantic → hydrate → evidence packet → deterministic templates; citation validation; blind index, no plaintext FTS) | implemented and tested | X1, X14. **Gap:** no reranker. The narrative summarizer interface exists (`groundedNarrative`) but no live summarizer is wired. |
| §8A Brain dump, promises, waiting-for, questions, admin | implemented and tested (core) | X6, X10. **Gaps:** no bundled clarification for missing deadlines; questions resolve only via the dashboard; no receipt attachments for reimbursements. |
| §8B Meeting prep, post-meeting, relationships, recruiting | partial | X11, relationship follow-up test. **Gaps:** attendees come only from names in the event title; post-meeting replies become notes, not proposed actions; no reconnection draft; recruiting has stage and deadline kind but no interview-prep stories. |
| §8C Planning, MVD, context tasks, avoidance, evening reset, dependencies | partial | X12, free-time test; avoidance offer (`bumpPostpone`) has no dedicated test. **Not implemented:** plan repair on calendar changes (`detectPlanConflicts` exists but isn't wired; plans are proposals only) and the "planning exit" behavior. |
| §8D Decisions, predictions, evidence locker, last-time briefings, handoffs, idea parking, operating manual, future-self | partial | X7, X8, X9, X13. **Gaps:** no assumption-change reconsider suggestions; lessons surface only in trip briefs; no inferred operating-manual patterns (explicit preferences only); no interview stories. |
| §8E Packing, free time, opportunities, history and undo | partial | trip/weather and free-time tests, X13. **Gaps:** weather for the home location only (no destination geocoding); opportunities are stored but no feeds; undo covers task create/complete and memory saves, not calendar events. |
| §9 Gmail read-only + NWS adapters, simulated fixtures | implemented and tested (mocked) | adapter unit tests; Gmail OAuth start/callback test; X10. Requires Google OAuth client, `gmail.readonly` verification for broad use, and an NWS contact. |
| §10 Shared suggestion service (digest, cap, quiet hours, pause, accept/dismiss/snooze/never) | implemented and tested | X13, relationship test. **Gap:** no "edit" response. |
| §11 Accountability state machine, sessions, checkpoints, SMS controls | implemented and tested | machine unit tests; X18–X25; pause, global-pause, and duplicate-job tests |
| §12 Morning routine, shared 2-call cap, no-ring-late, offline → alternative | implemented and tested | X18, X19, X21; demo |
| §13 WebExtension (Firefox + Chromium), pairing, keypair, challenges, seq/epoch, freshness, revocation, 24 h telemetry | implemented and tested (Chromium real; Firefox build only) | X19, X20, e2e. **Gap:** no Della session-page visibility events (no session page exists). The extension shows an "ON" badge during sessions. |
| §14 Uploads (tokens, bounds, magic bytes, polyglots, HEIC instruction, metadata stripping, 24 h expiry), MMS, VisionEvidenceAssessor | implemented and tested | X22–X24, MMS tests, adapter tests. **Gaps:** no SMS command to re-issue a fresh upload link after a failed upload; no knowledge-photo upload flow (the token purpose exists). |
| §15 Evidence-to-memory boundaries | implemented | accountability never writes memory facts; summaries list observed checks only |
| §16 Dashboard views 1–8 | partial | `tests/integration/admin-ext.test.ts`, e2e. **Gaps:** knowledge view has no relationship-path or graph display; items view doesn't show aliases or photos; the memory inbox has no proposal review or inline correction form; there are no longitudinal ("which routine works best") summaries. |
| §17 Costs, encryption, flags, backup/restore | implemented and tested | [COSTS.md](COSTS.md); flags; X26. **Gap:** CLI restore needs a manual tombstone carry-forward step (documented). |
| §18 Tests, 27 scenarios, demo, eval corpus | implemented; live eval not run | see Verification above |

## External setup blockers (handoff)

- Cloudflare: create D1, queues, the R2 bucket (`npm run provision:staging -- --apply`), and optionally a Vectorize index. Set secrets.
- Twilio: the live-SMS eligibility dependency (error 30532, personal use) still applies. MMS also needs a media-capable number.
- Google: an OAuth client for the read-only Gmail grant, with redirect `/oauth/gmail/callback`. `gmail.readonly` is restricted (testing mode for your own account).
- OpenAI: API key for the live planner, vision, and embeddings (each separately switchable).
- Firefox: an AMO developer account to sign an unlisted build for persistent installs.

## Limits of the evidence

A keypad press, a browser click, a photo, or a text shows only that something answered or was sent at that moment. Della records these as observations and never as proof of wakefulness, work, or honesty.
