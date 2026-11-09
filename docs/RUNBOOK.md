# Della runbook

Commands assume `--env production`. Swap in `staging` as needed.

## Pause everything now

- From your phone: text `pause everything` (reminders, briefs, heads-ups, and calls) or `pause reminders` (calls still ring). `resume` undoes it.
- Admin → Settings → Pause (scope + optional end time), or switch **SMS on** / **Calls on** off.
- Hard stop, independent of D1: set `DRY_RUN=true` (or the specific `*_LIVE_ENABLED=false`) in `wrangler.jsonc` and `npm run deploy:production`. Environment flags always override dashboard settings.
- The owner texting STOP suppresses SMS and calls immediately at the webhook.

## Health

- `/health` returns `{ok:true}`. Point an **independent** uptime monitor at it (for example a free external pinger). Della deliberately doesn't alert you over the same SMS path it's monitoring.
- Admin → Overview: scheduler heartbeat (last tick and lag), readiness cards, usage, failed jobs, unknown effects.
- Admin → Diagnostics: configuration issues (no values shown), every readiness check, migrations, scheduler gaps.
- Logs: `npx wrangler tail --env production` (structured JSON, redacted).

## Unknown effects (an SMS or call may or may not have gone out)

1. Admin → Activity → effects with state `unknown`.
2. Check the provider console (Twilio → Monitor → Messaging/Calls logs) for that time.
3. If a status callback arrives later, Della reconciles automatically (`delivered`/`failed`).
4. If you're sure it wasn't sent, use **Resend**. That creates a new effect, and the dialog warns about duplicate risk. Wake-up calls with unknown outcomes are never re-dialed automatically.

## Failed, blocked, or dead jobs

Admin → Activity → filter `failed`/`blocked`/`dead` → **Retry**. Retried jobs recheck current state (task open? generation current? alarm enabled? window expired?) before doing anything. `blocked` usually means bad credentials, a policy rejection, or an opt-out, so fix the cause first.

## Rotate secrets

- **ADMIN_BOOTSTRAP_SECRET:** `npx wrangler secret put ADMIN_BOOTSTRAP_SECRET --env production`. Existing sessions stay valid until they expire (12 h). To revoke them immediately, run `npx wrangler d1 execute DB --remote --env production --command "DELETE FROM admin_sessions"`.
- **DATA_ENCRYPTION_KEY** (no data loss):
  1. Generate a new key with a new id, for example `k2:<base64>`.
  2. Set `DATA_ENCRYPTION_KEY_PREVIOUS` to the **old** value (comma-separate if several), then set `DATA_ENCRYPTION_KEY` to the new value. Deploy.
  3. New writes use `k2`, and reads accept both. Old values naturally age out through retention. Keep the old key as `PREVIOUS` (and in your password manager) for as long as backups or rows encrypted with it exist.
  - Never just replace the key: old ciphertext would become unreadable.
- **TWILIO_AUTH_TOKEN:** rotate in the Twilio console (primary/secondary token), then `wrangler secret put`. Webhook signatures use the active token.
- **OPENAI_API_KEY / GOOGLE_CLIENT_SECRET:** rotate at the provider, then `wrangler secret put`.

## Recover Google OAuth

`needs_reconnect` appears on Calendar after revoked consent, `invalid_grant`, or the 7-day Testing-mode expiry. Go to Admin → Calendar → Disconnect (optional) → **Connect Google Calendar** → Activate. Task reminders keep working the whole time.

## Disconnect integrations

- Calendar: Admin → Calendar → Disconnect. This revokes the token at Google (best effort), deletes the stored tokens, cancels heads-ups, and clears the event projection.
- SMS/voice: set the provider var back to `simulated`, or the live flag to `false`, and deploy. Remove the Twilio webhook URL in the Twilio console.
- AI: `AI_LIVE_ENABLED=false`. Commands keep working without AI.

## Backup and restore

```sh
npm run backup -- --env production            # backups/della-production-<ts>.sql (git-ignored)
npm run restore:local -- backups/<file>.sql   # fresh local DB under .wrangler/restore-<ts>, automation on hold
npx wrangler dev --persist-to .wrangler/restore-<ts>
```

- Backups contain encrypted content plus readable scheduling metadata. Store them encrypted and access-controlled, never in git.
- A restored database starts with `restore_hold=1`: no proactive work runs, sessions and OAuth states are invalidated, and in-flight effects become `unknown`. A backup can predate messages or calls the provider already accepted, so **restoring alone can't prove those weren't sent**. Review Activity and provider logs, then Admin → Data → **Resume after restore**. Past-due occurrences are marked missed/expired, never replayed. Future schedules continue.
- To restore into a remote DB: create an empty D1, `wrangler d1 execute <db> --remote --file <backup>`, then `--file scripts/post-restore.sql`, and point the environment at it. Do this deliberately, during a pause.
- You need the matching `DATA_ENCRYPTION_KEY`, or that key configured as `DATA_ENCRYPTION_KEY_PREVIOUS`.

## Export or erase your data

Admin → Data: **Download export** (decrypted JSON), or **Erase** (type `ERASE ALL DATA`). Erase pauses everything and turns channels off *first*, then deletes content. It keeps hashed dedupe tombstones so a late provider retry can't recreate erased work. It can't erase carrier, Twilio, Google, or OpenAI records, or backups you already made.

## Remove the deployment

```sh
npx wrangler delete --env production
npx wrangler queues delete della-jobs-production
npx wrangler queues delete della-jobs-dlq-production
npx wrangler d1 delete della-production       # irreversible; back up first if needed
```

Then release the Twilio number, delete the Google OAuth client, and revoke the OpenAI key.
