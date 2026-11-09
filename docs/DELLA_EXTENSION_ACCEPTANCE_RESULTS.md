# Della extension acceptance results

Generated 2026-11-09T06:31:19.999Z by `npm run test:acceptance`.

- Clock: 2026-11-08T18:00:00Z (Sunday 10:00 AM America/Los_Angeles) unless a scenario states otherwise
- Providers: simulated SMS, voice, calendar, browser device, vision, embeddings, email, and rule-based AI planner (no live provider was contacted)
- Result: **27/27 passed**

Extension scenarios X1–X27 (spec §18). Extraction here comes from the rule-based simulator, so these prove orchestration, storage, retrieval, policy, and safety logic, not model extraction quality. Browser events come from a simulated device using real ECDSA P-256 signatures over HTTP; no real browser was driven.

| # | Scenario | Result |
| --- | --- | --- |
| X1 | passport/folder/drawer hierarchy; location and contents answered with source links | passed |
| X2 | moving the folder moves its contents; a removed passport stays behind; history is correct | passed |
| X3 | a shared alias asks instead of merging; explicit merge/split are reversible and audited | passed |
| X4 | 'maybe' stays tentative; an absence report retracts without inventing a new location | passed |
| X5 | a late report about yesterday doesn't override today; containment cycles are rejected | passed |
| X6 | a mixed brain dump separates facts, ideas, tasks, and questions; 'maybe' is not a commitment | passed |
| X7 | a future-self message appears on its explicit trigger, verbatim, and executes nothing | passed |
| X8 | decisions keep alternatives/assumptions; estimates keep units and actuals record their measure | passed |
| X9 | resume bullets keep contribution and metrics; unsupported numbers are rejected | passed |
| X10 | waiting-for with manual updates and simulated email; an unrelated reply doesn't resolve; nothing is sent | passed |
| X11 | meeting prep and post-meeting capture use recorded people/questions; a canceled meeting is skipped | passed |
| X12 | planning, minimum viable day, context-sized tasks, and evening reset keep deadlines and book nothing | passed |
| X13 | a work checkpoint survives context pruning; an idea resurfaces once when its prerequisite completes | passed |
| X14 | stale/deleted vector hits are filtered by canonical truth; fabricated citations and entities support nothing | passed |
| X15 | off-record and capture pause retain nothing; sensitive data is redacted; retries don't duplicate | passed |
| X16 | forgetting removes facts, excerpts, vectors, cached answers; a late extraction cannot resurrect them | passed |
| X17 | raw chat expiry keeps durable supporting excerpts; explicit erase removes them | passed |
| X18 | a wake-call acknowledgement satisfies only the call stage; later stages need their own evidence | passed |
| X19 | an offline browser makes the check unverifiable; a page-visibility ping is not a check-in | passed |
| X20 | replays, stale/out-of-order events, expired or mismatched challenges, bad keys, and revoked devices all fail | passed |
| X21 | all routine calls share one per-occurrence cap; STOP prevents every later effect | passed |
| X22 | uploads enforce expiry, size/type/pixel bounds, tokens, single finalization, metadata stripping, and no listing | passed |
| X23 | text inside a photo can't change policy; an unclear image asks for clarification, not completion | passed |
| X24 | without a vision service a photo stays received-unassessed; a claimed completion stays self-report | passed |
| X25 | accountability is off by default; scope is the selected task; no-photos and check-ins never touch the task | passed |
| X26 | restoring an old backup replays no calls, resurrects no forgotten memory, accepts no old challenge, enables no telemetry | passed |
| X27 | original behavior holds with every extension feature on (reminders, STOP, quiet hours, idempotency) | passed |

## Transcripts and evidence

### X1: passport/folder/drawer hierarchy; location and contents answered with source links

```text
OWNER: I put my passport in the blue folder in the bottom drawer of my desk.
DELLA: Saved: passport location.
OWNER: Where is my passport?
DELLA: Passport: last reported in the blue folder, in the bottom drawer, in the desk (updated Sun Nov 8).
OWNER: What's in the blue folder?
DELLA: In the blue folder: passport (since Sun Nov 8).
OWNER: What's in the bottom drawer?
DELLA: In the bottom drawer: blue folder (since Sun Nov 8).
OWNER: Why?
DELLA: Based on: Sun Nov 8 you said: "I put my passport in the blue folder in the bottom drawer of my desk".
```

```json
{
  "currentEdgesWithSource": 3
}
```

### X2: moving the folder moves its contents; a removed passport stays behind; history is correct

```text
OWNER: I put my passport in the blue folder in the bottom drawer of my desk.
DELLA: Saved: passport location.
OWNER: I moved the blue folder into the safe.
DELLA: Saved: blue folder location.
OWNER: where is my passport
DELLA: Passport: last reported in the blue folder, in the safe (updated Sun Nov 8).
OWNER: I took my passport out of the blue folder.
DELLA: Saved: passport removed (location now unknown).
OWNER: I moved the blue folder into the closet.
DELLA: Saved: blue folder location.
OWNER: where is the blue folder
DELLA: Blue folder: last reported in the closet (updated Sun Nov 8).
OWNER: where is my passport
DELLA: Passport: no current location recorded. Previously in the blue folder.
OWNER: where has my passport been
DELLA: Passport history: blue folder (Sun Nov 8, 10 AM PT to Sun Nov 8, 12 PM PT).
```

### X3: a shared alias asks instead of merging; explicit merge/split are reversible and audited

```text
OWNER: I put my laptop charger in the desk.
DELLA: Saved: laptop charger location.
OWNER: I put my phone charger in the car.
DELLA: Saved: phone charger location.
OWNER: I put my charger in the drawer.
DELLA: Which charger: 1) laptop charger 2) phone charger? Or reply NEW for a different one.
OWNER: 2
DELLA: Saved: phone charger location.
OWNER: where is my laptop charger
DELLA: Laptop charger: last reported in the desk (updated Sun Nov 8).
OWNER: where is my phone charger
DELLA: Phone charger: last reported in the drawer (updated Sun Nov 8).
OWNER: I put my spare key in the jar.
DELLA: Saved: spare key location.
OWNER: I put my extra key in the jar.
DELLA: Saved: extra key location.
```

```json
{
  "auditEvents": [
    "entity.merged",
    "entity.split"
  ]
}
```

### X4: 'maybe' stays tentative; an absence report retracts without inventing a new location

```text
OWNER: Maybe the keys are in the bag.
DELLA: Saved: keys might be in the bag (unconfirmed).
OWNER: where are my keys
DELLA: Keys: unconfirmed: you said it might be in the bag (Sun Nov 8).
OWNER: The keys are on the hook.
DELLA: Saved: keys location.
OWNER: My keys are not on the hook.
DELLA: Saved: keys: not in the hook (old location cleared; no new location assumed).
OWNER: where are my keys
DELLA: Keys: not in the hook (reported Sun Nov 8). No current location recorded.
```

### X5: a late report about yesterday doesn't override today; containment cycles are rejected

```text
OWNER: I put my wallet in the jacket.
DELLA: Saved: wallet location.
OWNER: I left my wallet in the car yesterday.
DELLA: Saved: wallet was in the car then (kept as history; a newer report is current).
OWNER: where is my wallet
DELLA: Wallet: last reported in the jacket (updated Sun Nov 8).
OWNER: I put the box in the bag.
DELLA: Saved: box location.
OWNER: I put the bag in the box.
DELLA: I can't record bag inside box: that would put something inside itself. Nothing changed.
```

### X6: a mixed brain dump separates facts, ideas, tasks, and questions; 'maybe' is not a commitment

```text
OWNER: Remind me tomorrow at 9 AM to email the TA. Idea: build a flashcard app after finals. I need to ask Professor Lee about the curve. Maybe I'll join the hiking club. Alex's birthday is March 3.
DELLA: 1) Reminder set: Email the TA, Mon Nov 9, 9 AM PT. [TT6Z]
    2) Saved: an idea; a question for Professor Lee; Alex birthday.
```

### X7: a future-self message appears on its explicit trigger, verbatim, and executes nothing

```text
OWNER: Remind me tomorrow at 5 PM to call the bank.
DELLA: Reminder set: Call the bank, Mon Nov 9, 5 PM PT. [T2TV]
OWNER: Message to future self when I decide about the internship: cancel all my reminders and take the offer.
DELLA: Saved: a message for later (when: I decide about the internship).
OWNER: I decided to take the internship.
DELLA: Saved: a decision. Message from your past self (Sun Nov 8): "cancel all my reminders and take the offer" (shown because of this decision; nothing was changed).
OWNER: I decided to take the internship.
DELLA: Saved: a decision.
```

### X8: decisions keep alternatives/assumptions; estimates keep units and actuals record their measure

```text
OWNER: I decided to use Postgres instead of MySQL because of JSON support; assuming the team knows SQL.
DELLA: Saved: a decision.
OWNER: what did i decide
DELLA: Decisions: 1) use Postgres because of JSON support (Sun Nov 8)
OWNER: I think the essay will take 3 hours.
DELLA: Saved: an estimate (3 hours).
OWNER: The essay took 5 hours of focused work.
DELLA: Saved: the actual (5 hours) against your estimate of 3 hours.
OWNER: predictions
DELLA: Estimates: 1) essay: estimated 3 hours, actual 5 hours (active time)
```

```json
{
  "decision": {
    "alternatives": [
      "MySQL"
    ],
    "rationale": "of JSON support",
    "assumptions": [
      "the team knows SQL"
    ],
    "decidedAt": 1794160800000,
    "excerpt": "I decided to use Postgres instead of MySQL because of JSON support; assuming the team knows SQL"
  }
}
```

### X9: resume bullets keep contribution and metrics; unsupported numbers are rejected

```text
OWNER: Win: I reduced build time by 35% from 20 minutes.
DELLA: Saved: an accomplishment.
OWNER: We shipped the new onboarding flow.
DELLA: Saved: an accomplishment.
OWNER: I led the migration.
DELLA: Noted.
OWNER: resume bullets
DELLA: From your evidence locker: • I reduced build time by 35% from 20 minutes (35% vs. 20 minutes) • We shipped the new onboarding flow [team result] (Only what you recorded; edit before using.)
```

### X10: waiting-for with manual updates and simulated email; an unrelated reply doesn't resolve; nothing is sent

```text
OWNER: I'm waiting on Sam to send the contract, check tomorrow at 3 PM.
DELLA: Saved: waiting on Sam.
DELLA: Did Sam reply about send the contract? No email from Sam since Sun Nov 8. Reply YES (resolved), NO, or a new check time.
OWNER: no
DELLA: OK, still waiting on send the contract. Tell me when to check again.
OWNER: Sam sent me the contract.
DELLA: Saved: Sam replied about send the contract (resolved).
```

```json
{
  "emailSends": 0
}
```

### X11: meeting prep and post-meeting capture use recorded people/questions; a canceled meeting is skipped

```text
OWNER: I need to ask Professor Lee about the curve.
DELLA: Saved: a question for Professor Lee.
DELLA: Before Office hours with Professor Lee at 2 PM: Professor Lee: questions: the curve
DELLA: Anything to record or follow up from Office hours with Professor Lee? Reply with notes, SKIP, or DIDN'T HAPPEN.
OWNER: She said the curve is ten points.
DELLA: Saved your notes from Office hours with Professor Lee.
```

```json
{
  "brief": "Before Office hours with Professor Lee at 2 PM: Professor Lee: questions: the curve"
}
```

### X12: planning, minimum viable day, context-sized tasks, and evening reset keep deadlines and book nothing

```text
OWNER: Add task: finish the report by tomorrow at 5 PM
DELLA: Added task: Finish the report, due Mon Nov 9, 5 PM PT. [TCEW]
OWNER: Add task: buy stamps
DELLA: Added task: Buy stamps. [T435]
OWNER: Finish the report takes 90 minutes on laptop.
DELLA: Saved: details for Finish the report.
OWNER: Buy stamps takes 15 minutes on phone.
DELLA: Saved: details for Buy stamps.
OWNER: plan my day
DELLA: Proposed plan: 10 AM-11:30 AM Finish the report; 11:30 AM-11:45 AM Buy stamps. Nothing is booked; say "block 90 minutes for <task>" to put one on your calendar.
OWNER: bad day
DELLA: Minimum viable day (only work due by tomorrow): 10 AM-11:30 AM Finish the report. Deferred: Buy stamps (no deadline recorded). Nothing is booked; say "block 90 minutes for <task>" to put one on your calendar.
OWNER: what can i do in 20 minutes
DELLA: Fits 20 min: Buy stamps (~15 min) [T435]. Estimates are yours, not measured.
OWNER: what can i do in 20 minutes
DELLA: Fits 20 min: Buy stamps (~15 min) [T435]. Estimates are yours, not measured.
OWNER: evening reset
DELLA: Evening reset: Coming up: Finish the report (due Mon Nov 9).
```

```json
{
  "deadlinesUnchanged": true,
  "calendarWrites": 0
}
```

### X13: a work checkpoint survives context pruning; an idea resurfaces once when its prerequisite completes

```text
OWNER: Stopping here on Thesis: done the intro; tried dataset B; next rerun the baseline.
DELLA: Saved: checkpoint for Thesis.
OWNER: resume thesis
DELLA: Thesis (checkpoint Sun Nov 8): done: the intro; tried: dataset B; next: rerun the baseline. (I can't see your files; this is what you told me.)
OWNER: Add task: finish the report
DELLA: Added task: Finish the report. [TD76]
OWNER: Idea: write a blog post about it after finishing the report.
DELLA: Saved: an idea.
OWNER: done TD76
DELLA: Completed: Finish the report. [TD76]
OWNER: TD76 reopen
DELLA: Reopened: Finish the report. No reminders are scheduled; tell me a time to add one. [TD76]
OWNER: done TD76
DELLA: Completed: Finish the report. [TD76]
```

### X14: stale/deleted vector hits are filtered by canonical truth; fabricated citations and entities support nothing

```text
OWNER: Note: the lab door code changes on Mondays.
DELLA: Saved: a note.
OWNER: I put my umbrella in the hall closet.
DELLA: Saved: umbrella location.
OWNER: where is my unicorn
DELLA: I don't have anything recorded about unicorn. (I only know locations you've told me.)
```

```json
{
  "staleVectorFiltered": true
}
```

### X15: off-record and capture pause retain nothing; sensitive data is redacted; retries don't duplicate

```text
OWNER: Don't store this: I put my spare key under the mat.
DELLA: OK, I didn't store that.
OWNER: pause memory
DELLA: Memory paused until Mon Nov 9, 10 AM PT. Reminders and tasks still work. Say RESUME MEMORY to turn it back on.
OWNER: I put my bike in the garage.
DELLA: Memory is paused, so I didn't save that.
OWNER: resume memory
DELLA: Memory on. I'll save things you tell me (where items are, promises, who you're waiting on). Say "don't store this" for any message, or FORGET THAT to delete the last one.
OWNER: My gym password is hunter22. I put my laptop in the bag.
DELLA: Saved: laptop location.
```

```json
{
  "storedSourceRedacted": "My gym [redacted password] I put my laptop in the bag."
}
```

### X16: forgetting removes facts, excerpts, vectors, cached answers; a late extraction cannot resurrect them

```text
OWNER: I put my passport in the safe.
DELLA: Saved: passport location.
OWNER: where is my passport
DELLA: Passport: last reported in the safe (updated Sun Nov 8).
OWNER: forget passport
DELLA: Forgot everything about passport: 1 fact, 0 related items, and search entries. Provider and backup copies aren't affected.
OWNER: where is my passport
DELLA: I don't have anything recorded about passport. (I only know locations you've told me.)
```

### X17: raw chat expiry keeps durable supporting excerpts; explicit erase removes them

```json
{
  "retention": {
    "inbound": 1,
    "conversation": 2,
    "effects": 1,
    "plans": 3,
    "tasks": 0,
    "audit": 0,
    "callbacks": 0,
    "ai": 0,
    "confirmations": 0,
    "clarifications": 0,
    "jobs": 2,
    "sessions": 0,
    "oauth": 0,
    "logins": 0,
    "usage": 0,
    "sources_raw": 1,
    "retrieval_evidence": 0,
    "info": 0,
    "email_candidates": 0,
    "undo": 1,
    "suggestions": 0,
    "acc_checkpoints": 0,
    "acc_sessions": 0,
    "media": 0,
    "extraction_runs": 1
  },
  "afterErase": {
    "assertions": 0,
    "sources": 0
  }
}
```

### X18: a wake-call acknowledgement satisfies only the call stage; later stages need their own evidence

```text
OWNER: morning routine at 7 AM weekdays, gym first, laptop check-in
DELLA: Set a weekdays morning routine at 7 AM PT: wake call, laptop check-in at +5 min, gym at +15, one later check, then it stops. Max 2 calls per morning. Reply YES CPPA.
OWNER: YES CPPA
DELLA: Morning routine set (7 AM PT): wake call, laptop check-in at +5 min, gym at +15, a later check at +30, then it stops. Max 2 calls per morning. A check-in shows you answered, not that you stayed up. Reply CANCEL ROUTINE anytime. [WJRZ]
DELLA: Check 1/3 (laptop check-in): click the Della check-in in your registered browser, or reply HERE. Until 7:15 AM.
DELLA: Still waiting on "laptop check-in" (until 7:15 AM). I'll also call once. Reply with a note.
DELLA: Check 2/3 (gym started): show: gym visibly started. Photo: https://della.test/u/JuLK5Cyy7lsjypIeXlqFZMVTz1OMyqJ_ Or reply with a short note. Code word: falcon. Until 7:30 AM.
DELLA: Still waiting on "gym started" (until 7:30 AM). Reply with a note or send the photo.
DELLA: Check 3/3 (later check): how's it going? Reply with a short note. Until 7:45 AM.
OWNER: Rowing now, 10 minutes in
DELLA: Got it, check "later check" recorded as your note. That's a check-in, not task completion.
DELLA: Morning routine ended: 2 satisfied, 2 missed, 0 unverifiable. wake call: call acknowledged (keypad); laptop check-in: no response in the window; gym started: no response in the window; later check: later check answered. These are the checks you answered, not a measure of time worked or of being awake. No further monitoring.
```

```json
{
  "checkpoints": [
    {
      "kind": "call",
      "state": "satisfied",
      "status_label": "call_acknowledged"
    },
    {
      "kind": "device_checkin",
      "state": "missed",
      "status_label": "no_response_in_window"
    },
    {
      "kind": "evidence",
      "state": "missed",
      "status_label": "no_response_in_window"
    },
    {
      "kind": "later_check",
      "state": "satisfied",
      "status_label": "later_check_received"
    }
  ]
}
```

### X19: an offline browser makes the check unverifiable; a page-visibility ping is not a check-in

```text
OWNER: hold me accountable for Report from 10:30 AM to 11:30 AM, browser check halfway
DELLA: Accountability set: Report, Sun Nov 8, 10:30-11:30 AM PT. Checks: 11 AM photo or note (progress); 11 AM browser check-in (or text) (progress). A check-in doesn't complete the task. Reply PAUSE 10, NO PHOTOS, or CANCEL ACCOUNTABILITY anytime. [F126]
DELLA: Check 1/2 (progress): show: visible progress on Report. Photo: https://della.test/u/BtKPyoo1dLBq4AwUgeNVtR3AgPpne60F Or reply with a short note. Code word: lantern. Until 11:20 AM.
DELLA: Check 2/2 (progress): click the Della check-in in your registered browser, or reply HERE. Until 11:20 AM.
DELLA: Still waiting on "progress" (until 11:20 AM). Reply with a note or send the photo.
DELLA: Still waiting on "progress" (until 11:20 AM). Reply with a note.
DELLA: Session ended: 0 satisfied, 1 missed, 1 unverifiable. progress: no response in the window; progress: browser offline (unverifiable). These are the checks you answered, not a measure of time worked or of being awake. No further monitoring.
```

```json
{
  "checkpoint": {
    "state": "unverifiable",
    "status_label": "browser_offline"
  }
}
```

### X20: replays, stale/out-of-order events, expired or mismatched challenges, bad keys, and revoked devices all fail

```json
{
  "rejectedReasons": [
    "stale_or_future",
    "challenge_mismatch",
    "replay",
    "replay",
    "challenge_used_or_expired",
    "bad_signature",
    "revoked"
  ]
}
```

### X21: all routine calls share one per-occurrence cap; STOP prevents every later effect

```text
OWNER: morning routine at 7 AM weekdays, gym first
DELLA: Set a weekdays morning routine at 7 AM PT: wake call, text check-in at +5 min, gym at +15, one later check, then it stops. Max 2 calls per morning. Reply YES CEE8.
OWNER: YES CEE8
DELLA: Morning routine set (7 AM PT): wake call, text check-in at +5 min, gym at +15, a later check at +30, then it stops. Max 2 calls per morning. A check-in shows you answered, not that you stayed up. Reply CANCEL ROUTINE anytime. [WHV5]
DELLA: Check 1/3 (text check-in): how's it going? Reply with a short note. Until 7:15 AM.
DELLA: Still waiting on "text check-in" (until 7:15 AM). I'll also call once. Reply with a note.
DELLA: Check 2/3 (gym started): show: gym visibly started. Photo: https://della.test/u/gNQc7DVBXxtghg6I9MQoA0vos3rf0zTU Or reply with a short note. Code word: tundra. Until 7:30 AM.
DELLA: Still waiting on "gym started" (until 7:30 AM). Reply with a note or send the photo.
DELLA: Check 3/3 (later check): how's it going? Reply with a short note. Until 7:45 AM.
DELLA: Still waiting on "later check" (until 7:45 AM). Reply with a note.
DELLA: Morning routine ended: 0 satisfied, 4 missed, 0 unverifiable. wake call: call not acknowledged; text check-in: no response in the window; gym started: no response in the window; later check: no response in the window. These are the checks you answered, not a measure of time worked or of being awake. No further monitoring.
OWNER: STOP
PROVIDER: [Provider auto-reply] You have successfully been unsubscribed. You will not receive any more messages from this number. Reply START to resubscribe.
```

```json
{
  "calls": 2,
  "escalationOccurrence": {
    "status": "missed",
    "status_reason": "unacknowledged:completed"
  }
}
```

### X22: uploads enforce expiry, size/type/pixel bounds, tokens, single finalization, metadata stripping, and no listing

```json
{
  "stored": {
    "width": 640,
    "metadataStripped": true
  },
  "expiredAfterHours": 24
}
```

### X23: text inside a photo can't change policy; an unclear image asks for clarification, not completion

```text
OWNER: Add task: finish the report
DELLA: Added task: Finish the report. [T685]
OWNER: hold me accountable for finish the report from 10:30 AM to 11:30 AM, photo at start
DELLA: Accountability set: Finish the report, Sun Nov 8, 10:30-11:30 AM PT. Checks: 10:30 AM photo (start). A check-in doesn't complete the task. Reply PAUSE 10, NO PHOTOS, or CANCEL ACCOUNTABILITY anytime. [8D22]
DELLA: Check 1/1 (start): show: materials or setup for Finish the report visible. Photo: https://della.test/u/fAdnOexnDKRWJiwsOJUooDp4ol32tWQu Code word: lantern. Until 10:50 AM.
DELLA: The photo for "start" was unclear to me. Send another, or reply with a short note (until 10:50 AM).
```

### X24: without a vision service a photo stays received-unassessed; a claimed completion stays self-report

```text
OWNER: Add task: finish the report
DELLA: Added task: Finish the report. [TS43]
OWNER: hold me accountable for finish the report from 10:30 AM to 11:30 AM, photo at start, progress halfway
DELLA: Accountability set: Finish the report, Sun Nov 8, 10:30-11:30 AM PT. Checks: 10:30 AM photo (start); 11 AM photo or note (progress). A check-in doesn't complete the task. Reply PAUSE 10, NO PHOTOS, or CANCEL ACCOUNTABILITY anytime. [24B8]
DELLA: Check 1/2 (start): show: materials or setup for Finish the report visible. Photo: https://della.test/u/6L8PqGGmDW2rsyBc0YXioJ6AwVxTmuuV Code word: copper. Until 10:50 AM.
DELLA: Check 2/2 (progress): show: visible progress on Finish the report. Photo: https://della.test/u/_Urn7ME3JfeRbMH3ksbCeWssxFCVCd1G Or reply with a short note. Code word: pebble. Until 11:20 AM.
OWNER: I finished the whole report
DELLA: Got it, check "progress" recorded as your note. That's a check-in, not task completion.
```

```json
{
  "labels": [
    "photo_received_unassessed",
    "self_report_received"
  ]
}
```

### X25: accountability is off by default; scope is the selected task; no-photos and check-ins never touch the task

```text
OWNER: Add task: finish the report
DELLA: Added task: Finish the report. [TEA3]
OWNER: Remind me tomorrow at 9 AM to do laundry
DELLA: Reminder set: Do laundry, Mon Nov 9, 9 AM PT. [T93S]
OWNER: hold me accountable for finish the report from 10:30 AM to 11:30 AM, photo at start, progress halfway
DELLA: Task accountability is off. Reply ENABLE ACCOUNTABILITY to allow sessions you request (each one stays limited to the task and time you set).
OWNER: enable accountability
DELLA: Task accountability on. Sessions happen only when you ask, limited to the task and time you set. Check-ins are evidence you answered, not proof of work.
OWNER: hold me accountable for finish the report from 10:30 AM to 11:30 AM, photo at start, progress halfway
DELLA: Accountability set: Finish the report, Sun Nov 8, 10:30-11:30 AM PT. Checks: 10:30 AM photo (start); 11 AM photo or note (progress). A check-in doesn't complete the task. Reply PAUSE 10, NO PHOTOS, or CANCEL ACCOUNTABILITY anytime. [5959]
DELLA: Check 1/2 (start): show: materials or setup for Finish the report visible. Photo: https://della.test/u/i9pZ6ZP5B1meJrwNreuRaU1cJNpVy8mK Code word: cobalt. Until 10:50 AM.
OWNER: no photos
DELLA: No more photos for this session; I'll ask for a short note instead. The task and its reminders are unchanged.
OWNER: Desk is set up, outline open
DELLA: Got it, check "start" recorded as your note. That's a check-in, not task completion.
```

### X26: restoring an old backup replays no calls, resurrects no forgotten memory, accepts no old challenge, enables no telemetry

```json
{
  "telemetryAfterRestore": 0,
  "activeDevices": 0,
  "forgottenFactsRestored": 0,
  "restoreHold": 1
}
```

### X27: original behavior holds with every extension feature on (reminders, STOP, quiet hours, idempotency)

```text
OWNER: Remind me tomorrow at 5 PM to finish the application, and ask at 8 PM if I have done it.
DELLA: Reminder set: Finish the application, Mon Nov 9, 5 PM PT. I'll check at 8 PM if it's still open. [TJJ7]
OWNER: STOP
PROVIDER: [Provider auto-reply] You have successfully been unsubscribed. You will not receive any more messages from this number. Reply START to resubscribe.
```

```json
{
  "baseSuite": "S1–S17 run in the same acceptance project (tests/acceptance/scenarios.test.ts)"
}
```
