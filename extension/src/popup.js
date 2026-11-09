const api = globalThis.browser ?? globalThis.chrome;
const $ = (id) => document.getElementById(id);

async function render() {
  const s = await api.storage.local.get(["deviceId", "status", "challenge", "lastError", "server"]);
  $("unpaired").hidden = Boolean(s.deviceId);
  $("paired").hidden = !s.deviceId;
  $("status").textContent = s.deviceId ? `Paired with ${s.server}. ${s.status === "session" ? "A session is active." : "No active session."}` : "";
  $("checkin").hidden = !s.challenge;
  $("error").textContent = s.lastError ?? "";
}

async function send(msg) {
  $("error").textContent = "";
  const r = await api.runtime.sendMessage(msg);
  if (!r?.ok && r?.error) $("error").textContent = r.error;
  await render();
}

$("pair").addEventListener("click", () => send({ type: "pair", server: $("server").value.trim(), code: $("code").value.trim() }));
$("checkin").addEventListener("click", () => send({ type: "checkin" }));
$("refresh").addEventListener("click", () => send({ type: "refresh" }));
$("unpair").addEventListener("click", () => send({ type: "unpair" }));
render();
