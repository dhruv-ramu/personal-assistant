# Della browser companion

An optional WebExtension that lets you answer accountability check-ins from your laptop browser. Firefox is the primary target, with a Chromium build too.

## What it can and cannot do

- **Permissions:** `storage`, `alarms`, `notifications`, `idle`. No `tabs`, `history`, `webRequest`, `scripting`, `cookies`, or host permissions.
- **Never reads** tabs, page URLs, titles, page content, browsing history, or cookies. It never receives admin cookies or provider secrets.
- **Sends** a signed poll only while paired (every 5 minutes, or every minute during a session), with a coarse idle state (active/idle/locked) from the `idle` API. When you click the check-in notification or button, it sends a signed check-in response.
- **A check-in means only** "the enrolled browser answered this challenge". It does not mean you were awake, working, or present.

## Build

```bash
npm run build:extension
# → dist-extension/firefox/  (MV3, background.scripts event page, gecko id della-companion@della.local, Firefox ≥ 128)
# → dist-extension/chrome/   (MV3, background.service_worker, Chrome ≥ 120)
```

## Install

**Firefox (primary)**

- For development or a personal install, open `about:debugging#/runtime/this-firefox`, choose **Load Temporary Add-on**, and select `dist-extension/firefox/manifest.json`. Temporary add-ons are removed when Firefox restarts.
- For a persistent install, Firefox requires a signed add-on. Sign it as an **unlisted** add-on through addons.mozilla.org (AMO) with your own developer account, for example `npx web-ext sign --channel=unlisted` with your AMO API credentials. That is an external handoff step and hasn't been done here.

**Chromium / Chrome**

- Open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select `dist-extension/chrome/`.

## Pair

1. In the dashboard, go to **Devices**, enter a name, and choose **Create pairing code**. The code is shown once and expires in 10 minutes.
2. Open the extension popup, enter your Della server URL (`https://…`, or `http://localhost:8788` locally) and the code, then choose **Pair**.
3. The extension generates a **non-extractable ECDSA P-256 key pair** (WebCrypto, stored in IndexedDB) and sends only the public key. The server stores its RFC 7638 thumbprint and refuses a second enrollment of the same key.
4. Enable **Browser check-ins** (Accountability or Privacy page) or text `ENABLE …` as needed. With telemetry off, the extension gets no challenges.

## Protocol

Every request after pairing is `{ payload, signature }`. `payload` is canonical JSON `{ deviceId, epoch, seq, kind, state?, nonce?, checkpointId?, reportedAt }`, and `signature` is ECDSA-SHA-256 (IEEE P1363) in base64url. The server checks, in order:

1. the device exists and isn't revoked
2. the signature (before any state changes, so unsigned noise can't advance anything)
3. the epoch matches
4. freshness: `reportedAt` within ±2 minutes, so old buffered events are rejected
5. `seq` strictly greater than the last accepted, advanced atomically (replays are rejected)
6. for check-ins: the nonce is unconsumed, unexpired, issued to this device, and bound to the same checkpoint and session, and it is consumed with a conditional update

Rejected events are logged with a reason (`bad_signature`, `replay`, `stale_or_future`, `challenge_mismatch`, `challenge_used_or_expired`, `revoked`) and expire with telemetry retention (24 hours by default).

## Revoke and re-pair

Revoke from **Devices**. The device's later events fail with `revoked`, and the extension clears its key and state when it sees that. After a backup restore, all devices are revoked and must pair again.

## Browser targets tested

- **Chromium** (Playwright's Chromium build, desktop): automated end to end in `tests/e2e/extension.spec.ts`. It loads `dist-extension/chrome`, pairs with a code created in the dashboard, polls with signed envelopes, and confirms the device in the dashboard.
- **Firefox**: the build is generated and manifest-checked, but it **was not driven in a real Firefox** in this environment, because Playwright can't load unpacked Firefox extensions. Manual verification steps: load the temporary add-on, pair, start a session with a browser check, and click the notification.
- The challenge and check-in protocol (signatures, replay, freshness, expiry, mismatch, revocation) is also covered at the HTTP level by acceptance X19 and X20, using a simulated device with real WebCrypto keys.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `invalid_or_expired_code` | Create a new code (it expires after 10 minutes and is single-use). |
| `stale_event` | The computer clock is more than 2 minutes off. Sync system time. |
| `revoked` / `unknown_device` | Pair again. |
| No notification | Allow notifications for the browser at the OS level. The popup's **Check in** button also works. |
