// Validates migrations (apply in order to a fresh SQLite DB, integrity + FK checks) and the
// Wrangler deployment configuration (explicit per-environment bindings, safe defaults).
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { bad, ok, readWranglerConfig } from "./lib.mjs";

let failed = false;
const fail = (m) => {
  bad(m);
  failed = true;
};

console.log("Migrations");
const dir = new URL("../migrations/", import.meta.url);
const files = readdirSync(dir)
  .filter((f) => f.endsWith(".sql"))
  .sort();
files.forEach((f, i) => {
  if (!new RegExp(`^${String(i + 1).padStart(4, "0")}_[a-z0-9_]+\\.sql$`).test(f)) fail(`Migration ${f} is out of sequence or misnamed`);
});
const db = new DatabaseSync(":memory:");
db.exec("PRAGMA foreign_keys = ON");
for (const f of files) {
  try {
    db.exec(readFileSync(new URL(f, dir), "utf8"));
    ok(`applied ${f}`);
  } catch (e) {
    fail(`${f}: ${e.message}`);
  }
}
const integrity = db.prepare("PRAGMA integrity_check").get();
if (integrity.integrity_check !== "ok") fail(`integrity_check: ${JSON.stringify(integrity)}`);
else ok("integrity_check ok");
if (db.prepare("PRAGMA foreign_key_check").all().length) fail("foreign_key_check reported violations");
else ok("foreign_key_check ok");
for (const t of ["owner_settings", "conversation_state", "calendar_connection"]) {
  if (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n !== 1) fail(`singleton row missing in ${t}`);
}
const required = [
  "inbound_messages",
  "jobs",
  "outbound_effects",
  "tasks",
  "reminders",
  "series",
  "alarm_occurrences",
  "confirmations",
  "clarifications",
  "usage_counters",
  "admin_sessions",
  "oauth_states",
];
const tables = new Set(
  db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((r) => r.name),
);
for (const t of required) if (!tables.has(t)) fail(`missing table ${t}`);
ok(`${tables.size} tables present`);

console.log("Wrangler configuration");
const cfg = readWranglerConfig();
const compat = cfg.compatibility_date;
if (!/^\d{4}-\d{2}-\d{2}$/.test(compat) || Number.isNaN(Date.parse(compat)) || Date.parse(compat) > Date.now()) fail(`compatibility_date ${compat} must be a real past date`);
else ok(`compatibility_date ${compat}`);
const envs = { development: cfg, staging: cfg.env?.staging, production: cfg.env?.production };
const names = new Set();
const resources = new Set();
for (const [name, e] of Object.entries(envs)) {
  if (!e) {
    fail(`environment ${name} missing`);
    continue;
  }
  for (const key of ["d1_databases", "queues", "vars", "triggers"]) if (!e[key]) fail(`${name}: ${key} must be declared explicitly (not inherited)`);
  if (names.has(e.name)) fail(`${name}: worker name ${e.name} reused`);
  names.add(e.name);
  for (const d of e.d1_databases ?? []) {
    if (resources.has(d.database_name)) fail(`${name}: D1 ${d.database_name} shared between environments`);
    resources.add(d.database_name);
    if (d.binding !== "DB") fail(`${name}: D1 binding must be DB`);
  }
  for (const q of e.queues?.producers ?? []) {
    if (resources.has(q.queue)) fail(`${name}: queue ${q.queue} shared between environments`);
    resources.add(q.queue);
  }
  const consumer = e.queues?.consumers?.[0];
  if (!consumer || consumer.max_batch_size !== 1 || consumer.max_concurrency !== 1 || !consumer.dead_letter_queue)
    fail(`${name}: main consumer must use batch size 1, concurrency 1, and a DLQ`);
  if (!(e.queues?.consumers ?? []).some((c) => c.queue === consumer?.dead_letter_queue)) fail(`${name}: DLQ has no consumer`);
  if (JSON.stringify(e.triggers?.crons) !== JSON.stringify(["* * * * *"])) fail(`${name}: expected a single every-minute cron`);
  const vars = e.vars ?? {};
  if (vars.DRY_RUN !== "true") fail(`${name}: DRY_RUN must default to "true" in checked-in config`);
  for (const flag of ["SMS_LIVE_ENABLED", "VOICE_LIVE_ENABLED", "AI_LIVE_ENABLED", "SMS_ELIGIBILITY_CONFIRMED", "CALENDAR_WRITES_ENABLED"])
    if (vars[flag] !== "false") fail(`${name}: ${flag} must default to "false"`);
  for (const k of Object.keys(vars)) if (/SECRET|TOKEN|KEY|PASSWORD/.test(k) && k !== "OPENAI_MODEL") fail(`${name}: ${k} looks like a secret; use wrangler secret put`);
  if (name === "production" && vars.SIMULATOR_ENABLED !== "false") fail("production: SIMULATOR_ENABLED must be false");
  if (name === "production" && vars.APP_ENV !== "production") fail("production: APP_ENV must be production");
  ok(`${name}: bindings explicit and safe defaults`);
}

if (failed) process.exit(1);
console.log("All migration and configuration checks passed.");
