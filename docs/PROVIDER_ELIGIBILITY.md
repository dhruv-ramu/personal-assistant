# Production SMS eligibility (a real dependency)

Della's product is ordinary SMS. The code for live Twilio SMS is complete and tested against mocks, but **whether any US sender is allowed to carry this traffic is an open question for the provider and carriers, not something Della can solve in code.**

## What was verified (2026-11-08)

- Twilio error **30532 "Personal use cases are not supported"** ([twilio.com/docs/api/errors/30532](https://www.twilio.com/docs/api/errors/30532)) applies to both **A2P 10DLC** and **Toll-Free Verification**. It reads: *"Messaging programs used only for personal purposes, such as reaching yourself, family members, or friends, are not eligible"*. It also lists *"The number was requested to send reminders to yourself"* as a cause, and says *"changing only the description does not make it eligible."*
- US application-to-person SMS from Twilio long codes requires A2P 10DLC registration, and toll-free numbers require Toll-Free Verification. Unregistered traffic is filtered or blocked by carriers.
- Older Twilio pages describe sole-proprietor/hobbyist registration. Given 30532's explicit wording, treat that as unresolved for this exact use case, not as permission.

**Conclusion:** buying a Twilio number does not make live Della SMS legitimate. Do **not** describe the traffic as a business, invent a business, or attempt unverified toll-free sending. Della keeps live SMS off until both the technical checks and the provider approval are recorded.

## Ask the provider directly

Send this (edit the bracketed parts) to Twilio Support or any provider you consider:

> I'm building a personal assistant for my own use only. A single person (me) texts one phone number, and the application replies and sends me reminders, task follow-ups, and calendar notices. It messages exactly one destination: my own US mobile number [+1…], which has opted in. There is no business, no customers, and no other recipients. Expected volume is about [20–60] messages per day.
>
> 1. Is there any registration program (A2P 10DLC sole proprietor, toll-free verification, or other) under which this single-owner self-notification traffic is eligible on your platform for US delivery?
> 2. If yes, which sender type, what registration steps and fees, and what message content and opt-in evidence do you need?
> 3. If no, please confirm that this use case is not supported, so I don't buy or register a number for it.

Record the answer (provider, date, ticket/reference number) in the admin dashboard under **Settings → SMS provider attestation**. It is labeled *operator-confirmed, not independently verified*.

## Independent gates before live SMS

All of these must pass. Diagnostics shows each one separately.

| Gate | Where | Kind |
| --- | --- | --- |
| Twilio credentials and sender syntactically valid | deployment secrets | technical |
| `OWNER_PHONE_E164` is real (not a 555/test number) | deployment secret | technical |
| `SMS_ELIGIBILITY_CONFIRMED=true` | deployment var | provider approval |
| Operator attestation recorded, sender status "approved" | admin Settings | operator |
| Owner SMS consent recorded | admin Settings | operator |
| `SMS_LIVE_ENABLED=true` and `DRY_RUN=false` | deployment vars | policy |
| SMS switch on, not opted out (STOP) | admin Settings / phone | policy |

A checkbox alone can't bypass provider registration. If `SMS_LIVE_ENABLED` is set without `SMS_ELIGIBILITY_CONFIRMED`, configuration validation flags an error and live SMS stays off.

## Alternatives

- **Other SMS APIs:** eligibility is **unconfirmed** for every alternative. US carrier rules (10DLC/toll-free verification) apply industry-wide, so another API is not evidence of acceptance. Ask the same question above before switching. Della's `SmsTransport` interface is the only thing a new provider adapter must implement, and conversation, reminder, and task logic don't change.
- **Other channels** (Telegram, WhatsApp, email, iMessage) would change the product and were deliberately not implemented. Della won't hide a different channel behind the SMS interface without your decision.

## Voice is separate

Voice readiness is checked independently (`VOICE_LIVE_ENABLED`, call consent, credentials, destination). SMS registration does not authorize calls, and voice readiness doesn't imply SMS eligibility. Before enabling calls, verify with Twilio: account standing (trial accounts can only call verified numbers), caller-ID/number requirements, and acceptable use for automated calls to your own number.
