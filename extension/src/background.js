/*
 * Della companion (background). Privacy contract:
 * - Reads no tabs, URLs, titles, page content, history, or cookies (no such permissions).
 * - Talks only to the Della server URL the owner entered at pairing, with signed envelopes.
 * - Holds a non-extractable ECDSA P-256 key in IndexedDB; the private key never leaves the browser.
 * - Reports only: a poll during sessions, coarse idle state (active/idle/locked), and explicit
 *   owner check-in clicks answering a server challenge. A heartbeat is not a check-in, and nothing
 *   here means "awake" — only "the registered browser answered".
 */
const api = globalThis.browser ?? globalThis.chrome;
const DB_NAME = "della-companion";
const ALARM = "della-poll";

function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore("keys");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(key) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const r = db.transaction("keys").objectStore("keys").get(key);
    r.onsuccess = () => resolve(r.result ?? null);
    r.onerror = () => reject(r.error);
  });
}

async function idbPut(key, value) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("keys", "readwrite");
    tx.objectStore("keys").put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbClear() {
  const db = await idb();
  return new Promise((resolve) => {
    const tx = db.transaction("keys", "readwrite");
    tx.objectStore("keys").clear();
    tx.oncomplete = () => resolve();
  });
}

const b64url = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

async function state() {
  return (await api.storage.local.get(["server", "deviceId", "epoch", "seq", "status", "challenge", "lastError"])) ?? {};
}

async function setState(patch) {
  await api.storage.local.set(patch);
}

async function nextSeq() {
  const s = await state();
  const seq = (s.seq ?? 0) + 1;
  await setState({ seq });
  return seq;
}

async function signedPost(path, fields) {
  const s = await state();
  if (!s.server || !s.deviceId) throw new Error("not paired");
  const key = await idbGet("signing");
  if (!key) throw new Error("missing key");
  const payload = JSON.stringify({ deviceId: s.deviceId, epoch: s.epoch, seq: await nextSeq(), reportedAt: Date.now(), ...fields });
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key.privateKey, new TextEncoder().encode(payload));
  const res = await fetch(`${s.server}${path}`, {
    method: "POST",
    credentials: "omit",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ payload, signature: b64url(sig) }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}

async function pair(server, code) {
  const origin = new URL(server).origin;
  if (!/^https:\/\//.test(origin) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) throw new Error("Server must be https");
  const keyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  const res = await fetch(`${origin}/api/device/pair`, {
    method: "POST",
    credentials: "omit",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      code: code.trim(),
      publicKeyJwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y },
      browser: navigator.userAgent.includes("Firefox") ? "firefox" : "chromium",
      capabilities: { idle: true, notifications: true },
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  await idbPut("signing", keyPair);
  await setState({ server: origin, deviceId: body.deviceId, epoch: body.epoch, seq: 0, status: "paired", challenge: null, lastError: null });
  await schedule(5);
  await poll();
}

async function unpair() {
  await idbClear();
  await api.storage.local.clear();
  await api.alarms.clear(ALARM);
}

async function schedule(minutes) {
  await api.alarms.create(ALARM, { periodInMinutes: Math.max(1, minutes) });
}

async function poll() {
  const s = await state();
  if (!s.deviceId) return;
  try {
    const idle = api.idle ? await api.idle.queryState(120) : null;
    const r = await signedPost("/api/device/sync", { kind: "poll", state: idle });
    await setState({ status: r.active ? "session" : "idle", challenge: r.challenge ?? null, lastError: null });
    // Visible indicator whenever an accountability session is active.
    await api.action.setBadgeText({ text: r.active ? "ON" : "" });
    if (r.active) await api.action.setBadgeBackgroundColor?.({ color: "#b45309" });
    if (r.challenge && r.challenge.nonce !== s.challenge?.nonce) {
      await api.notifications.create("della-checkin", {
        type: "basic",
        iconUrl: "icon.png",
        title: "Della check-in",
        message: "Click to check in from this browser (this only records that you clicked).",
      });
    }
    await schedule(Math.round((r.pollSeconds ?? 300) / 60));
  } catch (err) {
    await setState({ lastError: String(err.message ?? err) });
    if (/revoked|unknown_device/.test(String(err.message))) await unpair();
  }
}

async function checkIn() {
  const s = await state();
  if (!s.challenge) return { ok: false, error: "No check-in requested right now." };
  try {
    await signedPost("/api/device/checkin", { kind: "checkin_response", nonce: s.challenge.nonce, checkpointId: s.challenge.checkpointId });
    await setState({ challenge: null });
    await api.notifications.clear("della-checkin");
    return { ok: true };
  } catch (err) {
    await setState({ challenge: null, lastError: String(err.message ?? err) });
    return { ok: false, error: String(err.message ?? err) };
  }
}

api.alarms.onAlarm.addListener((a) => {
  if (a.name === ALARM) poll();
});
api.notifications.onClicked.addListener((id) => {
  if (id === "della-checkin") checkIn();
});
api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const run = async () => {
    if (msg?.type === "pair") return pair(msg.server, msg.code).then(() => ({ ok: true }));
    if (msg?.type === "checkin") return checkIn();
    if (msg?.type === "unpair") return unpair().then(() => ({ ok: true }));
    if (msg?.type === "refresh") return poll().then(() => ({ ok: true }));
    return { ok: false };
  };
  run()
    .then(sendResponse)
    .catch((e) => sendResponse({ ok: false, error: String(e.message ?? e) }));
  return true;
});
api.runtime.onStartup?.addListener(() => poll());
