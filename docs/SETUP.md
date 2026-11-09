# Della setup guide

Verified against tool versions and provider docs on **2026-11-08**. Recheck provider documentation when you do this.

## Consolidated external checklist

Everything outside this repository that a person has to do, in order. Each step needs the owner (account creation, approval, billing, consent).

| # | What | Why | How to verify |
| --- | --- | --- | --- |
| 1 | Cloudflare account; **Workers Paid** plan recommended ($5/mo) | Free plan allows 10 ms CPU per invocation, tight for crypto + AI parsing; Paid has 30 s/invocation and larger D1/Queues allowances | Dashboard → Workers & Pages → Plans |
| 2 | `npx wrangler login` | Lets scripts create/list resources and set secrets | `npx wrangler whoami` |
| 3 | Staging resources (D1, 2 queues) via `npm run provision:staging -- --apply`; paste D1 id into `wrangler.jsonc` | Durable state + job queue + DLQ | `npm run doctor -- --env staging` |
| 4 | Staging secrets (§6) | Encryption, admin login, owner identity | `npx wrangler secret list --env staging` |
| 5 | **SMS eligibility answer from the provider** for this personal use case | Twilio error 30532 says personal self-reminders are ineligible; see [PROVIDER_ELIGIBILITY.md](PROVIDER_ELIGIBILITY.md) | Written answer + ticket ID recorded in admin attestation |
| 6 | Only if #5 is yes: Twilio account, sender, registration | Live SMS route | Twilio console shows registration approved |
| 7 | Twilio voice (optional) | Wake-up calls | Test call to your own number (§10) |
| 8 | Google Cloud project, Calendar API, OAuth client + consent screen | Calendar read/write | Connect in admin → Calendar shows the verified account |
| 9 | OpenAI API key + project budget limit | Free-form interpretation | Live AI eval (§8) |
| 10 | Admin dashboard: record SMS consent, call consent, operator attestation | Operator gates | Diagnostics shows each check passing |
| 11 | Production resources + secrets, deliberate live enablement (§9–§11) | Go live | Diagnostics has no blockers |

## 1. Versions

- Node **22.12+** (`.nvmrc` = 22; Node 24 also works), npm 10+.
- Pinned in `package-lock.json`: wrangler 4.158.0, @cloudflare/vitest-plugin 1.6.0, vitest 5.1.0, TypeScript 6.0.3, Hono 4.13.17, Zod 4.6.7, temporal-polyfill 1.0.8, rrule 2.8.1.
- `compatibility_date` = `2026-11-01` (supported by the bundled workerd 2026-11-04).

## 2. Local install and simulated run

```sh
npm ci
node scripts/bootstrap-dev-vars.mjs     # .dev.vars with random ADMIN_BOOTSTRAP_SECRET, DATA_ENCRYPTION_KEY, SIM_WEBHOOK_SECRET
npm run db:migrate:local
npm run seed:demo                       # optional: fictional simulated calendar events
npm run dev                             # http://localhost:8787/admin
npm run demo                            # acceptance scenarios → docs/ACCEPTANCE_RESULTS.md
```

Local mode uses simulated SMS, voice, calendar, and AI. `DRY_RUN=true`. No credentials are needed. In the dashboard, **Calendar → Connect simulated calendar**, then **Simulator**. Cron doesn't fire automatically under `wrangler dev`, so use the simulator's clock buttons or `curl "http://localhost:8787/cdn-cgi/local/scheduled"`.

## 3. Cloudflare resources (staging first)

```sh
npx wrangler login
npm run provision:staging               # dry run: shows what exists / would be created
npm run provision:staging -- --apply    # creates only missing: D1 della-staging, queues della-jobs-staging, della-jobs-dlq-staging
```

Copy the printed D1 `database_id` into `wrangler.jsonc` → `env.staging.d1_databases[0].database_id`. Re-running provisioning reuses existing resources and never creates duplicates. Every environment declares its own bindings explicitly, because Wrangler doesn't inherit them, and `npm run db:validate` enforces that.

## 4. Plans and limits

Check current limits and pricing before deploying: [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), [Queues pricing](https://developers.cloudflare.com/queues/platform/pricing/), [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/). Estimates are in [COSTS.md](COSTS.md). Not everything is free: the Workers Paid plan is $5/month minimum, and Twilio and OpenAI usage is billed separately.

## 5. Production SMS route: get approval first

Before buying or registering any sender you intend to keep, get a written answer to the question in [PROVIDER_ELIGIBILITY.md](PROVIDER_ELIGIBILITY.md). Twilio's own error 30532 page says personal self-reminder messaging is not eligible for A2P 10DLC or toll-free verification. Don't describe the traffic as a business. Della keeps live SMS off unless `SMS_ELIGIBILITY_CONFIRMED=true` **and** the operator attestation is recorded.

## 6. Secrets and callback URLs

Set secrets interactively so values stay out of shell history:

```sh
npx wrangler secret put ADMIN_BOOTSTRAP_SECRET --env staging   # ≥24 random chars
npx wrangler secret put DATA_ENCRYPTION_KEY --env staging      # k1:<base64 of 32 random bytes>
npx wrangler secret put OWNER_PHONE_E164 --env staging         # your real number, +1…
npx wrangler secret put PUBLIC_BASE_URL --env staging          # e.g. https://della-staging.<subdomain>.workers.dev
# Only for providers you select:
npx wrangler secret put TWILIO_ACCOUNT_SID --env staging
npx wrangler secret put TWILIO_AUTH_TOKEN --env staging
npx wrangler secret put TWILIO_PHONE_NUMBER --env staging
npx wrangler secret put GOOGLE_CLIENT_ID --env staging
npx wrangler secret put GOOGLE_CLIENT_SECRET --env staging
npx wrangler secret put GOOGLE_REDIRECT_URI --env staging      # <PUBLIC_BASE_URL>/oauth/google/callback
npx wrangler secret put OPENAI_API_KEY --env staging
```

Generate a key locally with `node -e "console.log('k1:'+require('crypto').randomBytes(32).toString('base64'))"`. **Back up `DATA_ENCRYPTION_KEY` securely (for example in a password manager).** Without it, encrypted data and backups can't be read.

Provider selection and safety flags are `vars` in `wrangler.jsonc` (`SMS_PROVIDER`, `DRY_RUN`, and so on). Change them there deliberately, per environment.

**Twilio console** (only after §5): phone number → Messaging → "A message comes in" → Webhook `POST <PUBLIC_BASE_URL>/webhooks/sms/inbound`. Della sets status and voice callback URLs on each request: `/webhooks/sms/status?e=…`, `/webhooks/voice/instructions?e=…`, `/webhooks/voice/gather?e=…`, and `/webhooks/voice/status?e=…`. Signatures are validated against `PUBLIC_BASE_URL` plus the exact path and query, so it must be exactly the public HTTPS origin Twilio calls. Keep Twilio's default STOP/START/HELP handling (Advanced Opt-Out) on. Della reconciles it and doesn't send duplicate keyword replies (`TWILIO_PROVIDER_MANAGED_KEYWORDS=true`).

## 7. Google Calendar

1. Create a Google Cloud project and enable the **Google Calendar API**.
2. OAuth consent screen: External (or Internal if you use Google Workspace). Add your account as a test user. Scopes: `openid`, `email`, `…/auth/calendar.calendarlist.readonly`, and `…/auth/calendar.events`. Together these let Della list your calendars, then read and write events on calendars you can access. They don't grant Drive, Gmail, Contacts, ACL changes, or calendar creation.
3. Create a "Web application" OAuth client with the authorized redirect URI **exactly** `<PUBLIC_BASE_URL>/oauth/google/callback`.
4. **Testing vs production publishing:** Google states that an External app in **Testing** status gets refresh tokens that **expire after 7 days**, so in that mode Della will show "needs_reconnect" weekly. Publishing to "In production" removes the Testing-mode expiry. `calendar.events` is a sensitive scope, so Google may show an unverified-app warning or require verification. Check Google's current policy for single-user apps.
5. Set `CALENDAR_PROVIDER=google` in `wrangler.jsonc` for the environment, deploy, then **Admin → Calendar → Connect Google Calendar**. Optionally set `GOOGLE_EXPECTED_ACCOUNT` to block connecting the wrong account. Otherwise, review the verified account and click **Activate**. Choose the write calendar and the read calendars.
6. Writes need `CALENDAR_WRITES_ENABLED=true` and `DRY_RUN=false`.

## 8. OpenAI

1. Create an API key in a dedicated OpenAI project and set a monthly budget limit there.
2. `npx wrangler secret put OPENAI_API_KEY --env staging`; set `AI_PROVIDER=openai`, `AI_LIVE_ENABLED=true`, and (optionally) `OPENAI_MODEL` (default `gpt-6-luna`).
3. Della's own cap is `limit_ai_requests_per_day` (default 100) in Settings.
4. Optional read-only evaluation (at most 12 requests, no SMS/calls/calendar changes): `LIVE_AI_EVAL=1 OPENAI_API_KEY=… npm run test:ai:live` → `artifacts/live-ai-eval.json`.

## 9. Deploy staging, then check

```sh
npm run check
npm run db:migrate:staging
npm run deploy:staging
npm run doctor -- --env staging --url https://della-staging.<subdomain>.workers.dev
```

Sign in at `/admin`, open **Diagnostics**, and work through every blocker. Staging defaults to simulated providers with the simulator enabled, so you can run the acceptance flows against the deployed Worker.

**Live enablement checklist (per channel, deliberately):**

1. Diagnostics shows no configuration errors.
2. Admin → Settings: record SMS consent and call consent.
3. (SMS) Provider approval received → `SMS_ELIGIBILITY_CONFIRMED=true` and an attestation recorded with status "approved".
4. Flip the specific flag(s) in `wrangler.jsonc` for that environment: `SMS_PROVIDER=twilio`, `SMS_LIVE_ENABLED=true`, `DRY_RUN=false`, and so on.
5. Redeploy and confirm each readiness card in Overview reads `LIVE (provider)`.

## 10. First live tests (owner opt-in only)

Do each one once, deliberately, and only with explicit consent for the expected destination (your own number):

- **SMS round trip:** text `STATUS` to the Twilio number. Expect one reply. Check Activity: `accepted`, then `delivered` after the callback.
- **Calendar:** in a dedicated test calendar, text `Add Della test tomorrow from 3 PM to 4 PM`, check it in Google Calendar, then text `cancel my Della test tomorrow`.
- **Call:** Admin → Wake-up calls → *One-time test call* (2 minutes). Press 1. Check the occurrence shows `acknowledged`.

## 11. Proactive features

Enable as wanted: morning brief, default check-ins, and calendar heads-ups (Settings or Calendar page, or by SMS: "turn on the morning brief at 8"). Wake-up calls are created by explicit request ("Call me at 7 AM on weekdays"), and recurring ones need a YES confirmation. Scheduling precision is about one minute plus provider/carrier delay. Calendar edits show up within about 5 minutes. Calls are best effort.

## 11b. Extension (optional)

1. **R2:** `npm run provision:staging -- --apply` also creates the private bucket `della-media-staging`. Keep it private (no public access, no custom domain). The Worker binding `MEDIA` is already declared in `wrangler.jsonc` with `MEDIA_STORE=r2`.
2. **Semantic index (optional):** the default `SEMANTIC_INDEX=d1` needs nothing. For Vectorize: `npx wrangler vectorize create della-memory-staging --dimensions=256 --metric=cosine`, add a `vectorize` binding named `VECTORS`, and set `SEMANTIC_INDEX=vectorize` and `EMBEDDING_PROVIDER=openai`.
3. **Live photo assessment / embeddings (optional):** `VISION_PROVIDER=openai`, `EMBEDDING_PROVIDER=openai` (uses `OPENAI_API_KEY`). The provider sees the image or text.
4. **Read-only Gmail (optional):** in the same Google Cloud project, add the redirect `https://<host>/oauth/gmail/callback`, set `GMAIL_REDIRECT_URI` and `EMAIL_PROVIDER=gmail`, then Privacy → *Connect Gmail (read-only)*. `gmail.readonly` is a restricted scope: fine in testing mode for your own account (7-day refresh tokens); broad distribution needs Google verification.
5. **Weather (optional):** `INFO_PROVIDER=nws`, `NWS_CONTACT=<your email or URL>`, then set a location (Privacy page). US locations only (api.weather.gov).
6. **MMS photos (optional):** needs a media-capable number and the same SMS eligibility as everything else; enable *MMS photo ingestion* in Privacy.
7. **Browser companion:** see [DELLA_BROWSER_SETUP.md](DELLA_BROWSER_SETUP.md).
8. Every feature stays off until enabled in the dashboard or by SMS (`ENABLE MEMORY`, `ENABLE ACCOUNTABILITY`, `ENABLE MORNING ROUTINES`, …). Deployment flags (`CAPTURE_ENABLED=false`, …) force a feature off regardless.

## 12. Operations

See [RUNBOOK.md](RUNBOOK.md): rotate secrets, recover OAuth, inspect unknown effects, retry failed jobs, pause everything, disconnect integrations, back up and restore, and remove the deployment.

Production uses the same steps with `--env production` and `npm run provision:production`. Production scripts refuse to run with placeholder resource IDs and require `CONFIRM_PRODUCTION=della` in the environment. CI never deploys automatically; `.github/workflows/deploy.yml` is a manual dispatch behind GitHub environment protection.
