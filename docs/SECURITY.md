# Della security

## Route policy (deny by default)

| Route | Method | Who can call it | Protection |
| --- | --- | --- | --- |
| `/health` | GET | anyone | Returns only `{ok, service}` |
| `/webhooks/sms/inbound` | POST | SMS provider | Signature (Twilio HMAC-SHA1/SHA-256 over `PUBLIC_BASE_URL` + path + query + sorted params), AccountSid, destination number, sender = owner, content type, 32 KB cap |
| `/webhooks/sms/status` | POST | SMS provider | Signature, AccountSid; effect correlated via signed `?e=` and SID; conflicting callbacks are rejected |
| `/webhooks/voice/instructions`, `/gather`, `/status` | POST | Voice provider | Signature, AccountSid, caller ID = Della number, callee = owner; per-effect correlation |
| `/admin/login` | GET, POST | anyone | POST-only secret; 5 attempts per 15 min per client; constant-time compare (hash both sides); Origin check |
| `/admin/**` | GET | admin session | Opaque random session (SHA-256 hash stored), 12 h, HttpOnly, SameSite=Lax, Secure in staging/production/HTTPS |
| `/admin/**` | POST | admin session | Plus per-session CSRF token **and** same-origin Origin/Referer |
| `/admin/simulator/**` | any | admin session, non-production only | Returns 404 in production; simulated webhooks are also rejected in production even when signed |
| `/oauth/google/start` | GET | admin session | Random state (hash stored, bound to session, 10 min, one-time), PKCE S256 |
| `/oauth/google/callback` | GET | admin session + valid state | Conditional single use; fixed redirect to `/admin/calendar` (no caller-controlled target) |
| anything else | any | nobody | 404 |

A provider signature is never an admin session, and an admin session never authorizes a webhook.

Headers on every response: a CSP with `default-src 'none'; script-src 'self'; style-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`, plus `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy`, and `Permissions-Policy`. HSTS is added in staging/production, and `Cache-Control: no-store` on admin/OAuth. All HTML is rendered with Hono's escaping `html` template. There's no inline script. TwiML text and attributes are XML-escaped.

## What SMS can and cannot do

SMS is a possession-based, lower-assurance channel (SIM swap or a compromised carrier account give an attacker the "owner"). By SMS you can create, change, and complete tasks and reminders, read and edit calendar events (with confirmations for risky changes), set wake-up calls, pause, and change a bounded set of preferences.

SMS **cannot**: change the owner phone number, change auth or secrets, enable providers or live flags, export data, message or call anyone else, pay for anything, or run code. None of these exist in the action schema, so the model can't propose them either. Opt-out, pause, channel switches, and usage limits are enforced in code.

## Encryption at rest

AES-256-GCM with a random 96-bit nonce per value, plus associated data per field type. The versioned envelope is `v1.<keyId>.<nonce>.<ciphertext>`. The key is `DATA_ENCRYPTION_KEY` (deployment secret, never in D1).

**Encrypted:** inbound message bodies, the conversation log, plans and action arguments/results, task titles and notes, series templates, outbound SMS bodies, confirmation actions and prompts, clarification state, OAuth access/refresh tokens and PKCE verifiers, calendar event titles and locations, and spoken agendas.

**Readable (needed for indexed scheduling and dedupe):** timestamps, statuses, short task IDs, job kinds and keys, provider SIDs, the owner and Della phone numbers on inbound rows, calendar and event IDs, the connected account email, usage counts and token counts, settings, and redacted audit actions. D1 access itself is protected by your Cloudflare account.

Key rotation is covered in [RUNBOOK.md](RUNBOOK.md#rotate-secrets): add a new key id and keep the old one as `DATA_ENCRYPTION_KEY_PREVIOUS`. Never discard an old key while backups encrypted with it exist. Lose the key and the encrypted content (and backups) are unrecoverable.

## Secrets and logging

- Secrets live only in Wrangler secrets (deployed) or the git-ignored `.dev.vars` (local), never in D1, logs, URLs, or browser assets. `npm run db:validate` fails if a `vars` entry looks like a secret.
- Logs are structured JSON. They pass through redaction for phone numbers, SIDs, API keys, Google tokens, `token=`/`code=` parameters, bearer/basic credentials, and emails. They never include message bodies or full numbers (`***01`). Tests assert this.
- Raw provider errors are redacted before storage and never sent to the phone.
- Outbound HTTP is restricted to an allowlist: `api.twilio.com`, `oauth2.googleapis.com`, `www.googleapis.com`, `openidconnect.googleapis.com`, `api.openai.com`. There's no user-supplied URL fetch.

## Prompt injection

Calendar text, task titles, and conversation history are passed to the model as labeled untrusted data. Even a malicious interpretation is limited to the typed action vocabulary, and every action is resolved and authorized in code: IDs come from repository lookups, destinations are fixed to the owner, and settings are bounded. Tests feed a "model" that emits destination and owner-phone fields and check they're stripped and that nothing reaches another number.

## Retention, export, erase

Defaults (configurable in Settings): message content 30 days, completed or canceled task text 90 days, redacted audit 90 days. Active series keep their template, dedupe rows keep no content, and tombstones (hashed provider IDs) outlive erase. Export is decrypted JSON for an authenticated admin. Erase needs the typed phrase `ERASE ALL DATA` and disables future work first. Provider-held records and existing backups are out of Della's reach.

## Backups and restore

`wrangler d1 export` output keeps content encrypted but metadata readable. Treat backups as sensitive: encrypt them, restrict access, never commit them. A restore starts in a held, live-effects-paused state with sessions and OAuth states invalidated. See [RUNBOOK.md](RUNBOOK.md#backup-and-restore).

## Known boundaries

- No database lease can revoke an HTTP request already sent. A crash mid-send leaves an effect `unknown` (not re-sent).
- There's a narrow race between the final revalidation and the provider accepting a message or call, and an accepted SMS or call can't be recalled.
- Sim-mode secrets and the development encryption key are rejected for staging/production.

## Extension additions

- **New unauthenticated-by-session routes, each with its own capability:** `/u/:token` (one-time upload token, hash stored, single checkpoint, strict CSP and `no-referrer`, 25 MB cap on this path only) and `/api/device/*` (one-time pairing code; afterwards ECDSA P-256 signed envelopes with epoch, strictly increasing sequence, ±2 min freshness, and single-use challenges; credential-less CORS; no cookies). Media is never served and there is no listing route.
- **Gmail** uses a separate read-only grant (`/oauth/gmail/*`) with namespaced one-time state and PKCE, rejects any send/modify/full-mail scope, and has no send/archive/delete code.
- **Untrusted content:** calendar text, email subjects/snippets, OCR or image text, and extracted memory are data only. They can't change destinations, permissions, owner identity, or monitoring. The vision prompt says so explicitly, and verdicts are constrained by a strict schema.
- **Encryption scope:** application-level AES-GCM for canonical text; the Worker and any enabled AI/vision provider can read content while processing (not end-to-end). Exact name lookup uses an HMAC blind index; there is no plaintext full-text index. See [DELLA_PRIVACY_RETENTION.md](DELLA_PRIVACY_RETENTION.md).
- **Device threat model:** a valid signature proves use of the enrolled key, not that a particular person is present or that the device is a laptop. A compromised browser or deliberate evasion remains possible; Della's labels say only "registered browser check-in received".
