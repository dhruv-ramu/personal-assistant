# Della costs

**Prices checked 2026-11-08** from the providers' public pages (links below). These are **estimates, not invoices**. Prices change, and Della's local limits don't cap provider billing (inbound traffic, number rental, registration, rounding, and failed-message fees can still accrue).

## Unit prices

| Item | Price | Status |
| --- | --- | --- |
| Cloudflare Workers Paid plan | $5.00/month minimum; 10M requests + 30M CPU-ms included | verified ([pricing](https://developers.cloudflare.com/workers/platform/pricing/)) |
| Workers Free plan | 100k requests/day, **10 ms CPU per invocation** | verified; tight for Della, so Paid is recommended |
| Cron Triggers | no separate charge (invocations count as requests) | verified (Workers pricing) |
| Queues | Free: 10k ops/day; Paid: 1M ops/month included, then $0.40/M; ~3 ops per message | verified ([pricing](https://developers.cloudflare.com/queues/platform/pricing/)) |
| D1 | Free: 5M rows read/day, 100k written/day, 5 GB; Paid: 25B reads + 50M writes/month included | verified ([pricing](https://developers.cloudflare.com/d1/platform/pricing/)) |
| Twilio SMS, US long code | $0.0083 per segment outbound **and** inbound | verified ([pricing](https://www.twilio.com/en-us/sms/pricing/us)) |
| Twilio carrier passthrough fees | varies by carrier and registration status | **assumption: ~$0.003–0.005/segment**; not listed as a single number |
| Twilio failed-message fee | $0.001 per failed message | verified |
| A2P 10DLC / toll-free registration fees | one-time and monthly fees exist for eligible programs | **not applicable / unconfirmed**: this personal use case appears ineligible (see [PROVIDER_ELIGIBILITY.md](PROVIDER_ELIGIBILITY.md)) |
| Twilio local number | $1.15/month | verified ([voice pricing](https://www.twilio.com/en-us/voice/pricing/us)) |
| Twilio outbound call (US local) | $0.0140/min | verified |
| OpenAI `gpt-6-luna` | $0.10/M input tokens, $0.50/M output tokens | verified ([model page](https://developers.openai.com/api/docs/models/gpt-6-luna)) |
| Google Calendar API | no charge for normal quota | assumption (verify quota in Google Cloud console) |
| Custom domain | optional; `*.workers.dev` is free | assumption: ~$10–15/year if you buy one |

## Formula

```text
monthly ≈ CF_plan
        + number_rental
        + (outbound_segments + inbound_segments) × (sms_rate + carrier_fee)
        + call_minutes × voice_rate
        + (ai_requests × (avg_input_tokens × 0.10 + avg_output_tokens × 0.50) / 1e6)
        + overages (Cloudflare usage beyond the included amounts; ≈ $0 at one-person scale)
```

Della's own background load: 43,200 Cron ticks/month (~3 D1 writes and ~30 rows read each), plus calendar polling every 5 minutes (~8,640 jobs/month at about 3 queue ops each). That's roughly 130k rows written, 1–2M rows read, and 30k queue ops per month, all inside the included amounts.

## Worksheet (illustrative)

Assumptions: ~2.5k input and ~300 output tokens per AI request, 1-segment messages, Workers Paid.

| | Low | Medium |
| --- | --- | --- |
| Inbound texts/day | 10 | 30 |
| Outbound segments/day | 20 | 60 |
| AI requests/day | 8 | 25 |
| Wake-up calls | 22/month × 1 min | 44/month × 1.5 min |
| Cloudflare | $5.00 | $5.00 |
| Twilio number | $1.15 | $1.15 |
| SMS (900 / 2,700 segments × $0.0083) | $7.47 | $22.41 |
| Carrier fees (assumed $0.004/segment) | $3.60 | $10.80 |
| Voice | $0.31 | $0.92 |
| OpenAI (240 / 750 requests) | $0.10 | $0.30 |
| **Estimated total** | **≈ $17.60/month** | **≈ $40.60/month** |

If SMS turns out to be ineligible, the SMS lines don't apply. Della still runs (simulated SMS plus calendar and calls) for about $5–7/month.

## Built-in controls

Defaults, adjustable in Settings: 100 inbound messages, 50 SMS segments, 5 call attempts, 10 call minutes, and 100 AI requests per day. Reservations are atomic, made before each effect, and idempotent per effect. Unknown outcomes keep their reservation. One budget warning is sent per metric per day, and it never triggers another. Cron ticks and stored reminders never call AI, and there's no premium-model fallback. Usage, token counts, and estimated AI cost are recorded (`usage_counters`, `ai_requests`) and shown in the Overview.

## Extension costs (memory, accountability, browser companion)

Prices checked 2026-11-08 (estimates, not invoices). Everything below is optional and off by default.

| Item | Price | Della default use |
| --- | --- | --- |
| R2 storage | $0.015/GB-month, 10 GB free; Class A ops $4.50/M, Class B $0.36/M (first 1M/10M free) | a few stripped photos/day, deleted after 24 h → effectively $0 |
| Vectorize (optional) | Paid plan includes 50M queried + 10M stored vector dimensions/month | 256-dim vectors: ~39k stored vectors and ~195k queries/month fit in the included amounts; default index is D1 (no extra charge) |
| OpenAI `text-embedding-3-small` (optional) | $0.02/M tokens | ~50 tokens per fact → 1,000 facts ≈ $0.001 |
| OpenAI vision via `gpt-6-luna` (optional) | image input billed as input tokens ($0.10/M) + output ($0.50/M); `detail: low` keeps images small | **assumption:** ~1k input + 200 output tokens per assessment ≈ $0.0002 → 20/day cap ≈ $0.12/month |
| Extraction | no extra request: knowledge candidates come back in the same planner call; output tokens grow by roughly 100–300 per memorable message | +$0.0001 per message at most |
| Gmail API, NWS API | no charge for normal use | NWS requires a contact User-Agent; Gmail `gmail.readonly` is a restricted scope (Google verification for broad distribution; testing mode for your own account) |
| Accountability calls | same voice rate as wake-up calls ($0.0140/min) | max 2 calls per morning occurrence (shared cap) |

Per-owner daily limits (Privacy page): embeddings 500, semantic queries 100, image assessments 20, media 50 MB, standalone suggestions 2. Reservations are made before each external effect and share the base budgets (calls, SMS, AI) rather than stacking new ones. Exact lookups, list queries, date triggers, and checkpoint prompts never call a model. Browser telemetry is aggregated deterministically with no AI.

## Measured AI request size (staging, `gpt-6-luna`, 2026-11-09)

Real requests, as reported by OpenAI usage:

| Message | Input tokens | Cached | Output | Est. cost (full input price) |
| --- | --- | --- | --- | --- |
| before the request-size work ("hi") | 16,637 | 0 | 66 | $0.0017 |
| "hi" | 3,364 | 0 | 26 | $0.00035 |
| free-form reminder request | 3,384 | 3,256 | 172 | $0.00042 |
| statement with memory extraction | 5,586 | 0 | 133 | $0.00063 |

How it stays small: only enabled feature groups are offered to the model; the memory-extraction schema is sent only when a message states something (`src/knowledge/gate.ts`); shared schema pieces are `$defs`; bookkeeping fields aren't generated by the model; the instruction text and conversation context are short. The fixed prefix is identical across requests, so OpenAI prompt caching applies (cached tokens are billed at a discount; the exact rate for this model wasn't verified). Deterministic commands make no AI request at all. At 30 free-form texts/day, expect roughly $0.30–0.60/month.
