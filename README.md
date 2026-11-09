# Della

Della is a single-owner personal assistant you text from your phone's ordinary Messages app. Named after Della Street, Perry Mason's secretary in Erle Stanley Gardner's novels, she remembers tasks, sends reminders, checks whether you finished things, reads and edits Google Calendar, and places wake-up calls. The extension adds an opt-in second brain (where things are, promises, waiting-for, decisions, handoffs), planning help, and owner-requested accountability with a browser companion. Della runs entirely on Cloudflare (Workers, D1, Queues, Cron), so it keeps working when every personal device is off.

**Status:** implemented and tested end to end against simulated providers. Live SMS is blocked on a real provider-eligibility question (see [docs/PROVIDER_ELIGIBILITY.md](docs/PROVIDER_ELIGIBILITY.md)). No live provider has been exercised. Nothing is deployed.

## Quick start (local, no accounts needed)

Requirements: Node 22.12+ (see `.nvmrc`), npm 10+.

```sh
npm ci
node scripts/bootstrap-dev-vars.mjs   # creates .dev.vars with generated local secrets (git-ignored)
npm run db:migrate:local
npm run demo                          # runs the 17 end-to-end acceptance scenarios and writes docs/ACCEPTANCE_RESULTS.md
npm run demo:extension                # integrated memory + accountability demo (prints a transcript)
npm run dev                           # http://localhost:8787/admin
```

Sign in with the `ADMIN_BOOTSTRAP_SECRET` value from `.dev.vars`, open **Calendar** and click **Connect simulated calendar**, then use **Simulator** to text Della as the owner. For example:

- `Remind me tomorrow at 5 PM to finish the application, and ask at 8 PM if I have done it.`
- `Add badminton Tuesday from 7 PM to 9 PM.`
- `Call me at 7 AM on weekdays and retry once if I miss it.`
- `enable memory`, then `I put my passport in the blue folder in the bottom drawer of my desk.` and `Where is my passport?`
- `enable accountability`, then `hold me accountable for the report from 9 AM to 10:30 AM, photo at start, progress halfway`

Use the simulator's clock buttons (+1m, +1h, +1d) to move time. Each press runs the scheduler and processes due jobs. `wrangler dev` does not fire Cron on its own. Trigger it manually with `curl "http://localhost:8787/cdn-cgi/local/scheduled"` or the **Run scheduler tick** button.

## Checks

```sh
npm run check        # lint, typecheck, migrations/config validation, unit+integration, acceptance, bundle dry runs
npm run test:e2e     # Playwright admin flows (after: npx playwright install chromium)
npm run doctor       # local readiness; --env staging|production for deployments
```

## Documentation

| Doc | Contents |
| --- | --- |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Design, event flow, data model, scheduling and failure semantics, DST policy, deviations |
| [docs/SETUP.md](docs/SETUP.md) | Full setup: Cloudflare, Twilio, Google, OpenAI, staging, live enablement, consolidated external checklist |
| [docs/PROVIDER_ELIGIBILITY.md](docs/PROVIDER_ELIGIBILITY.md) | The SMS eligibility dependency and the exact question to send a provider |
| [docs/RUNBOOK.md](docs/RUNBOOK.md) | Operations: pause, unknown effects, retries, secrets rotation, OAuth recovery, backup/restore, teardown |
| [docs/SECURITY.md](docs/SECURITY.md) | Route policy, auth, encryption, retention, SMS threat model, key rotation |
| [docs/COSTS.md](docs/COSTS.md) | Dated prices, quotas, and a cost worksheet |
| [docs/TESTING.md](docs/TESTING.md) | Test layout, what's mocked, coverage of the specification's test list |
| [docs/ACCEPTANCE_RESULTS.md](docs/ACCEPTANCE_RESULTS.md) | Generated transcripts/evidence from the acceptance run |
| [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md) | Checklist with evidence, limitations, next steps |
| [docs/DELLA_EXTENSION_STATUS.md](docs/DELLA_EXTENSION_STATUS.md) | Extension checklist: actual results, gaps, external blockers |
| [docs/DELLA_EXTENSION_ARCHITECTURE.md](docs/DELLA_EXTENSION_ARCHITECTURE.md) | Extension modules, flow, jobs, routes, bindings, migration/rollback |
| [docs/DELLA_MEMORY_MODEL.md](docs/DELLA_MEMORY_MODEL.md) | Records, locations, extraction validation, retrieval/grounding, deletion |
| [docs/DELLA_ACCOUNTABILITY.md](docs/DELLA_ACCOUNTABILITY.md) | Sessions, checkpoints, routines, shared call cap, evidence labels, limits |
| [docs/DELLA_BROWSER_SETUP.md](docs/DELLA_BROWSER_SETUP.md) | Build, install (Firefox/Chromium), pairing, protocol, tested targets |
| [docs/DELLA_PRIVACY_RETENTION.md](docs/DELLA_PRIVACY_RETENTION.md) | Consents, retention table, who can read what, media, deletion, restore |
| [docs/DELLA_EXTENSION_ACCEPTANCE_RESULTS.md](docs/DELLA_EXTENSION_ACCEPTANCE_RESULTS.md) | Generated X1–X27 transcripts/evidence |

## Important limits

- Scheduling is minute-scale (Cron every minute plus provider/carrier delay), not exact-second.
- Wake-up calls are best effort. Keep your phone's native alarm as the dependable backup.
- Calendar changes are polled every 5 minutes, so edits can take about 5 minutes to be reflected in heads-ups.
- Application budgets cap what Della initiates; they are not a provider billing cap.
- Accountability check-ins, photos, and browser clicks are observations of what you answered, never proof of work or wakefulness.
