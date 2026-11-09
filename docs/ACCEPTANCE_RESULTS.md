# Acceptance results

Generated 2026-11-09T06:31:19.998Z by `npm run test:acceptance`.

- Clock: 2026-11-08T18:00:00Z (Sunday 10:00 AM America/Los_Angeles) unless a scenario states otherwise
- Providers: simulated SMS, voice, calendar, browser device, vision, embeddings, email, and rule-based AI planner (no live provider was contacted)
- Result: **17/17 passed**

The simulated planner is rule-based. These scenarios prove the application logic (ingress, persistence, scheduling, idempotency, callbacks, policies), not real language-model quality or live provider behaviour.

| # | Scenario | Result |
| --- | --- | --- |
| S1 | reminder + follow-up from one message, accurate local date | passed |
| S2 | done [ID] after the reminder cancels the 8 PM follow-up | passed |
| S3 | not yet → one-hour snooze; old jobs never fire | passed |
| S4 | calendar event creation; duplicate inbound delivery creates nothing new | passed |
| S5 | move an ambiguous pre-existing appointment with confirmation and conditional update | passed |
| S6 | event moves shortly before its heads-up; reconciliation prevents the old-time message; one heads-up per instance | passed |
| S7 | weekday wake-up calls need confirmation; keypad 1 acknowledges and cancels the retry | passed |
| S8 | missed call → one bounded retry → duplicate keypad 2 snoozes once → 'I'm awake' stops further calls | passed |
| S9 | STOP while a reminder is queued suppresses all later SMS and calls | passed |
| S10 | AI down — stored reminders, explicit-ID completion, and STATUS still work; free text gets an honest limited reply | passed |
| S11 | queue send fails after durable ingestion; the minute tick recovers it exactly once | passed |
| S12 | provider timeout after possible acceptance → unknown, not resent; late callback reconciles | passed |
| S13 | Google consent revoked → calendar disconnected, task reminders continue | passed |
| S14 | a daily 8 AM reminder stays at 8 AM local across the DST change | passed |
| S15 | prolonged outage recovers without expired wake-up calls or a reminder flood | passed |
| S16 | budget limits block additional live effects with one warning; the model cannot choose a destination | passed |
| S17 | export/restore into a clean database keeps future schedules without immediate duplicate sends | passed |

## Transcripts and evidence

### S1: reminder + follow-up from one message, accurate local date

```text
OWNER: Remind me tomorrow at 5 PM to finish the application, and ask at 8 PM if I have done it.
DELLA: Reminder set: Finish the application, Mon Nov 9, 5 PM PT. I'll check at 8 PM if it's still open. [TMFR]
```

```json
{
  "reminders": [
    [
      "reminder",
      "Mon Nov 9, 5 PM PT"
    ],
    [
      "followup",
      "Mon Nov 9, 8 PM PT"
    ]
  ]
}
```

### S2: done [ID] after the reminder cancels the 8 PM follow-up

```text
OWNER: Remind me tomorrow at 5 PM to finish the application, and ask at 8 PM if I have done it.
DELLA: Reminder set: Finish the application, Mon Nov 9, 5 PM PT. I'll check at 8 PM if it's still open. [T2C3]
DELLA: Reminder: Finish the application. Reply DONE when finished. [T2C3]
OWNER: done T2C3
DELLA: Completed: Finish the application. Remaining checks canceled. [T2C3]
```

```json
{
  "followupSent": false
}
```

### S3: not yet → one-hour snooze; old jobs never fire

```text
OWNER: Remind me tomorrow at 5 PM to finish the application, and ask at 8 PM if I have done it.
DELLA: Reminder set: Finish the application, Mon Nov 9, 5 PM PT. I'll check at 8 PM if it's still open. [THUK]
DELLA: Reminder: Finish the application. Reply DONE when finished. [THUK]
DELLA: Did you finish: Finish the application? Reply DONE or NOT YET. [THUK]
OWNER: not yet
DELLA: OK. 1) Snooze 1 hour 2) Check again in 2 hours 3) Stop checks. Reply 1, 2, or 3. [THUK]
OWNER: 1
DELLA: Snoozed: Finish the application until Mon Nov 9, 9:01 PM PT. Earlier checks canceled. [THUK]
DELLA: Reminder: Finish the application. Reply DONE when finished. [THUK]
```

```json
{
  "proactiveSends": 3
}
```

### S4: calendar event creation; duplicate inbound delivery creates nothing new

```text
OWNER: Add badminton Tuesday from 7 PM to 9 PM.
DELLA: Added Badminton: Tue Nov 10, 7-9 PM PT.
```

```json
{
  "events": 1,
  "duplicateAck": 200
}
```

### S5: move an ambiguous pre-existing appointment with confirmation and conditional update

```text
OWNER: Move my appointment tomorrow to 4 PM.
DELLA: Which one to move: 1) Advisor appointment 10 AM 2) Dentist appointment 2 PM?
OWNER: 2
DELLA: Move Dentist appointment from 2 PM to 4 PM Mon Nov 9? Reply YES CVCC.
OWNER: YES CVCC
DELLA: Moved Dentist appointment: Mon Nov 9, 4-5 PM PT.
OWNER: YES CVCC
DELLA: CVCC expired or was already used. Nothing changed; ask again if needed.
```

```json
{
  "etag": [
    1,
    2
  ]
}
```

### S6: event moves shortly before its heads-up; reconciliation prevents the old-time message; one heads-up per instance

```json
{
  "headsups": [
    "Heads-up: Team sync at 4 PM (in 30 min)."
  ]
}
```

### S7: weekday wake-up calls need confirmation; keypad 1 acknowledges and cancels the retry

```text
OWNER: Call me at 7 AM on weekdays and retry once if I miss it.
DELLA: Set weekdays wake-up calls at 7 AM PT? Press 1 on the call to confirm you're up, 2 to snooze. One retry if missed. Reply YES CMTS.
OWNER: YES CMTS
DELLA: Wake-up calls set: weekdays at 7 AM, first Mon Nov 9, 7 AM PT. Keep your phone's alarm as a backup. [WFQJ]
```

```json
{
  "calls": 1,
  "occurrence": {
    "status": "acknowledged",
    "acknowledged_via": "keypad"
  }
}
```

### S8: missed call → one bounded retry → duplicate keypad 2 snoozes once → 'I'm awake' stops further calls

```text
OWNER: Call me at 7 AM on weekdays and retry once if I miss it.
DELLA: Set weekdays wake-up calls at 7 AM PT? Press 1 on the call to confirm you're up, 2 to snooze. One retry if missed. Reply YES CZTA.
OWNER: YES CZTA
DELLA: Wake-up calls set: weekdays at 7 AM, first Mon Nov 9, 7 AM PT. Keep your phone's alarm as a backup. [WNXD]
OWNER: I'm awake
DELLA: Got it, you're up. No more wake-up calls this morning.
```

```json
{
  "calls": 2
}
```

### S9: STOP while a reminder is queued suppresses all later SMS and calls

```text
OWNER: Remind me in 10 minutes to move the laundry
DELLA: Reminder set: Move the laundry, Sun Nov 8, 10:10 AM PT. [TEDC]
OWNER: Call me at 7 AM tomorrow
DELLA: Wake-up call set: Mon Nov 9, 7 AM PT. Press 1 to confirm you're up, 2 to snooze. Calls are best effort; keep your phone's alarm as a backup. [WMV9]
OWNER: STOP
PROVIDER: [Provider auto-reply] You have successfully been unsubscribed. You will not receive any more messages from this number. Reply START to resubscribe.
```

```json
{
  "note": "An SMS/call already accepted by the provider before STOP is processed cannot be recalled; Della stops initiating anything new once STOP is stored."
}
```

### S10: AI down — stored reminders, explicit-ID completion, and STATUS still work; free text gets an honest limited reply

```text
OWNER: Remind me in 30 minutes to call the bank
DELLA: Reminder set: Call the bank, Sun Nov 8, 10:30 AM PT. [TMBV]
DELLA: Reminder: Call the bank. Reply DONE when finished. [TMBV]
OWNER: Remind me tomorrow at 9 AM to buy stamps
DELLA: I can't interpret free-form requests right now. Simple commands still work: LIST, STATUS, DONE T4K8, PAUSE, RESUME.
OWNER: done TMBV
DELLA: Completed: Call the bank. [TMBV]
OWNER: STATUS
DELLA: Status: 0 open tasks. Next reminder: none. Next wake-up call: none. Calendar: connected (simulated). SMS: simulated.
```

### S11: queue send fails after durable ingestion; the minute tick recovers it exactly once

```json
{
  "recoveredBy": "cron tick",
  "replies": 1
}
```

### S12: provider timeout after possible acceptance → unknown, not resent; late callback reconciles

```json
{
  "states": [
    "unknown",
    "delivered"
  ],
  "resent": false
}
```

### S13: Google consent revoked → calendar disconnected, task reminders continue

```text
OWNER: Remind me in 15 minutes to stretch
DELLA: Reminder set: Stretch, Sun Nov 8, 10:15 AM PT. [T3DR]
OWNER: What's on my calendar today?
DELLA: Calendar isn't connected, so I can't check it. Reconnect it in the admin dashboard.
DELLA: Reminder: Stretch. Reply DONE when finished. [T3DR]
```

### S14: a daily 8 AM reminder stays at 8 AM local across the DST change

```json
{
  "sendTimesLocal": [
    "Sat Mar 13, 8 AM PT",
    "Sun Mar 14, 8 AM PT",
    "Mon Mar 15, 8 AM PT"
  ],
  "sendTimesUtc": [
    "2027-03-13T16:00:00.000Z",
    "2027-03-14T15:00:00.000Z",
    "2027-03-15T15:00:00.000Z"
  ]
}
```

### S15: prolonged outage recovers without expired wake-up calls or a reminder flood

```json
{
  "afterOutage": [
    "I couldn't deliver 2 reminders on time: Submit the timesheet; Water the plants. They're still open. Reply LIST to see tasks."
  ],
  "callsPlaced": 0
}
```

### S16: budget limits block additional live effects with one warning; the model cannot choose a destination

```json
{
  "effects": [
    {
      "purpose": "reply",
      "state": "accepted",
      "error_detail": null,
      "destination": "owner",
      "segments": 1
    },
    {
      "purpose": "reply",
      "state": "accepted",
      "error_detail": null,
      "destination": "owner",
      "segments": 1
    },
    {
      "purpose": "reply",
      "state": "accepted",
      "error_detail": null,
      "destination": "owner",
      "segments": 1
    },
    {
      "purpose": "reply",
      "state": "suppressed",
      "error_detail": "budget:sms_segments",
      "destination": "owner",
      "segments": 1
    },
    {
      "purpose": "warning",
      "state": "accepted",
      "error_detail": null,
      "destination": "owner",
      "segments": 1
    },
    {
      "purpose": "reply",
      "state": "suppressed",
      "error_detail": "budget:sms_segments",
      "destination": "owner",
      "segments": 1
    }
  ],
  "ownerPhoneUnchanged": true
}
```

### S17: export/restore into a clean database keeps future schedules without immediate duplicate sends

```json
{
  "sentBeforeBackup": 3,
  "resume": {
    "expiredReminders": 0,
    "expiredCalls": 0,
    "expiredHeadsups": 0
  },
  "afterRestore": [
    "Reminder: Renew the passport. Reply DONE when finished. [TZ2G]"
  ]
}
```
