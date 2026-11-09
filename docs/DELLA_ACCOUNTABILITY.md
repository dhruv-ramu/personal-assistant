# Della accountability

Accountability is **off by default** and runs **only when you ask**. It produces records of the checks you answered. It never proves work, effort, honesty, or wakefulness, and Della never says it does.

## Kinds

| Kind | How to start | What happens |
| --- | --- | --- |
| Task session | "hold me accountable for <task> from 9 AM to 10:30 AM, photo at start, progress halfway" | Checks at the times you named (start / halfway / end / offset), each with the evidence you chose (photo, text, browser, any). Optional single call if you said so. |
| Check once | "check on me once during the next hour" | One text check around the midpoint. |
| Morning routine | "morning routine at 7 AM weekdays, gym first, laptop check-in" → **YES Cxxx** | Wake call, then a browser (or text) check at +5 min, first-activity photo or note at +15, a later text check at +30, then it stops. Routines place calls, so they need the same explicit confirmation as wake-up calls. |

Enable with `ENABLE ACCOUNTABILITY` / `ENABLE MORNING ROUTINES` by SMS, or in the dashboard. Deployment flags can force them off.

## State machine (`src/accountability/machine.ts`)

```text
scheduled ─arm→ awaiting_start ─start→ active ⇄ awaiting_checkpoint (request / resolve)
    │                │                  │  ↘ pause → paused ─resume→ active
    └──── cancel / expire ──────────────┴──→ completed | canceled | expired | needs_attention
```

Transitions are conditional updates fenced on `version`. Terminal states accept nothing, except `needs_attention → canceled`. A session's state is independent of its task: completing a check never completes the task, and NO PHOTOS or cancel never touches the task or its reminders.

## Checkpoints

Each checkpoint has `intended_at`, `grace_until`, `expires_at`, allowed evidence kinds, an encrypted criterion, a session-specific code word (a nonce, not proof), and a generation. Jobs run in three phases:

1. **request**: send the prompt (upload link, browser challenge, or text question). Deferred while the session is paused. Waived (not missed) during a global pause or after STOP.
2. **grace**: one reminder, plus an escalation call if allowed and the shared budget remains.
3. **expire**: settle as `missed`, or `unverifiable` when the browser was offline, a photo couldn't be assessed, or the image stayed unclear.

| Status label | Meaning |
| --- | --- |
| call acknowledged (keypad) | You pressed 1 on the wake call. Satisfies only the call stage. |
| registered browser check-in received | You clicked a fresh, signed challenge in your enrolled browser. |
| text check-in received / self-report received / later check answered | You replied by SMS (self-report). |
| photo assessed as consistent | The vision assessor judged the photo visibly consistent with the criterion. |
| photo received (not assessed) | Assessment is off. Receipt only. |
| photo received; assessment unavailable | The assessor was down or over budget. The check closes as unverifiable. |
| photo unclear | You're asked to send another photo or a note. Never counted as done. |
| no response in the window / browser offline (unverifiable) | Observations, not judgments. |

Session summaries count satisfied, missed, unverifiable, and waived checks and list each one. They don't compute "productive minutes".

## Calls

- One **shared cap per morning occurrence** (default 2) covers the wake call, its single allowed snooze, and any escalation call. The cap is enforced in the alarm job itself (`routineCapReached`). Escalation calls can't be snoozed.
- Calls use the existing alarm infrastructure: voice gate, daily call budget, no blind redial of unknown outcomes, and the 10-minute expiry window, so nothing rings long after the window following an outage.
- STOP cancels every open session and pending checkpoint. Global pause waives checks. CANCEL ROUTINE cancels the routine and its alarm.

## Evidence

- **Photos**: a private one-time upload link per checkpoint (or MMS, if enabled). See [DELLA_PRIVACY_RETENTION.md](DELLA_PRIVACY_RETENTION.md) for validation, metadata stripping, and 24-hour expiry.
- **Vision assessment** (optional, off by default): OpenAI Responses API with a strict schema, `store:false`, low-detail images, and a prompt that treats text inside images as untrusted. Verdicts are consistent, inconsistent, unclear, or unavailable. "Inconsistent" asks for another photo or a note. It isn't a violation. The simulated assessor follows scripted outcomes for tests.
- **Browser check-ins**: see [DELLA_BROWSER_SETUP.md](DELLA_BROWSER_SETUP.md). A heartbeat or page-visibility ping never counts. Only a click answering a fresh, single-use challenge bound to that checkpoint does.
- **Text**: recorded as self-report.

## SMS controls

`PAUSE 10` (during a session), `RESUME SESSION`, `NO PHOTOS`, `SESSION STATUS`, `CANCEL ACCOUNTABILITY` / "stop this accountability session", `CANCEL ROUTINE`, and `HERE` (text alternative to a browser check).

## What this cannot tell you

- Whether you were awake. A keypad press, a browser click, or a text shows only that someone answered at that moment.
- Whether you worked. A photo shows what it shows, at some time, taken by someone.
- Anything between checks. Della doesn't monitor continuously, and there is no minute-by-minute AI analysis of telemetry.
