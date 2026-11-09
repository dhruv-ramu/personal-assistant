// Local/deployment readiness doctor. Never prints secret values.
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { bad, ok, parseDevVars, readWranglerConfig, warn } from "./lib.mjs";

const args = process.argv.slice(2);
const envName = args.includes("--env") ? args[args.indexOf("--env") + 1] : "development";
const url = args.includes("--url") ? args[args.indexOf("--url") + 1] : null;
let problems = 0;
const fail = (m) => {
  bad(m);
  problems++;
};
/** Prints a check; `blocking` failures count as problems, non-blocking ones are warnings. */
function report(passed, message, blocking = true) {
  if (passed) ok(message);
  else if (blocking) fail(message);
  else warn(message);
}

console.log(`Della doctor (${envName})\n`);
console.log("Toolchain");
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 12)) fail(`Node ${process.versions.node} < 22.12`);
else ok(`Node ${process.versions.node}`);
if (!existsSync(new URL("../node_modules/wrangler", import.meta.url))) fail("Dependencies not installed (run npm ci)");
else ok("dependencies installed");

console.log("\nConfiguration");
const cfg = readWranglerConfig();
const env = envName === "development" ? cfg : cfg.env?.[envName];
if (!env) fail(`No such environment: ${envName}`);
const vars = env?.vars ?? {};
ok(`providers: sms=${vars.SMS_PROVIDER} voice=${vars.VOICE_PROVIDER} calendar=${vars.CALENDAR_PROVIDER} ai=${vars.AI_PROVIDER}; DRY_RUN=${vars.DRY_RUN}`);
if (envName === "development") {
  const dv = parseDevVars();
  if (!dv) fail(".dev.vars missing (run node scripts/bootstrap-dev-vars.mjs)");
  else {
    for (const k of ["ADMIN_BOOTSTRAP_SECRET", "DATA_ENCRYPTION_KEY", "SIM_WEBHOOK_SECRET"]) report(Boolean(dv[k]), `${k} ${dv[k] ? "set" : "not set"}`, false);
    if (dv.DATA_ENCRYPTION_KEY) {
      const raw = dv.DATA_ENCRYPTION_KEY.includes(":") ? dv.DATA_ENCRYPTION_KEY.split(":")[1] : dv.DATA_ENCRYPTION_KEY;
      report(
        Buffer.from(raw, "base64").length === 32,
        Buffer.from(raw, "base64").length === 32 ? "DATA_ENCRYPTION_KEY decodes to 32 bytes" : "DATA_ENCRYPTION_KEY must be 32 bytes (base64)",
      );
    }
    report(Boolean(dv.OWNER_PHONE_E164), dv.OWNER_PHONE_E164 ? "OWNER_PHONE_E164 set" : "OWNER_PHONE_E164 not set (simulator uses a fictional owner number)", false);
  }
} else {
  for (const d of env?.d1_databases ?? [])
    (/REPLACE/.test(d.database_id) ? fail : ok)(`D1 ${d.database_name} id ${/REPLACE/.test(d.database_id) ? "is a placeholder" : "configured"}`);
  const r = spawnSync("npx", ["wrangler", "secret", "list", "--env", envName, "--format", "json"], { encoding: "utf8" });
  if (r.status === 0) {
    const names = new Set(JSON.parse(r.stdout || "[]").map((s) => s.name));
    for (const k of ["ADMIN_BOOTSTRAP_SECRET", "DATA_ENCRYPTION_KEY", "OWNER_PHONE_E164", "PUBLIC_BASE_URL"])
      (names.has(k) || vars[k] ? ok : fail)(`${k} ${names.has(k) ? "secret set" : vars[k] ? "var set" : "missing"}`);
    if (vars.SMS_PROVIDER === "twilio")
      for (const k of ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_PHONE_NUMBER"]) (names.has(k) ? ok : fail)(`${k} ${names.has(k) ? "set" : "missing"}`);
    if (vars.CALENDAR_PROVIDER === "google")
      for (const k of ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REDIRECT_URI"])
        (names.has(k) || vars[k] ? ok : fail)(`${k} ${names.has(k) || vars[k] ? "set" : "missing"}`);
    if (vars.AI_PROVIDER === "openai") (names.has("OPENAI_API_KEY") ? ok : fail)(`OPENAI_API_KEY ${names.has("OPENAI_API_KEY") ? "set" : "missing"}`);
  } else warn("Could not list secrets (are you logged in? run npx wrangler login)");
}

console.log("\nLaunch gates (each independent; see docs/PROVIDER_ELIGIBILITY.md)");
const gate = (name, on) => report(on, `${name}: ${on ? "on" : "off"}`, false);
gate("SMS_LIVE_ENABLED", vars.SMS_LIVE_ENABLED === "true");
gate("SMS_ELIGIBILITY_CONFIRMED (provider approval for this personal use case)", vars.SMS_ELIGIBILITY_CONFIRMED === "true");
gate("VOICE_LIVE_ENABLED", vars.VOICE_LIVE_ENABLED === "true");
gate("AI_LIVE_ENABLED", vars.AI_LIVE_ENABLED === "true");
gate("CALENDAR_WRITES_ENABLED", vars.CALENDAR_WRITES_ENABLED === "true");
gate("DRY_RUN disabled", vars.DRY_RUN === "false");
warn("Owner consent and the operator SMS attestation are recorded in the admin dashboard, not here.");

if (url) {
  console.log(`\nRemote health (${url})`);
  try {
    const res = await fetch(new URL("/health", url));
    report(res.ok, `/health ${res.status}`);
  } catch (e) {
    fail(`/health unreachable: ${e.message}`);
  }
}

console.log(problems ? `\n${problems} problem(s) found.` : "\nNo blocking problems found.");
process.exit(problems ? 1 : 0);
