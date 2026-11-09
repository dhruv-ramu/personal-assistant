// Guard for remote migrations/deploys: explicit target, real resource IDs, production confirmation.
import { readWranglerConfig } from "./lib.mjs";

const target = process.argv[2];
if (target !== "staging" && target !== "production") {
  console.error("Usage: node scripts/guard-env.mjs staging|production");
  process.exit(2);
}
const cfg = readWranglerConfig();
const env = cfg.env?.[target];
if (!env) {
  console.error(`wrangler.jsonc has no env.${target}`);
  process.exit(1);
}
const problems = [];
for (const d of env.d1_databases ?? [])
  if (/REPLACE|^0{8}-/.test(d.database_id)) problems.push(`D1 database_id for ${d.database_name} is a placeholder. Create it (see docs/SETUP.md) and paste the ID.`);
if (!env.d1_databases?.length) problems.push("No D1 binding declared for this environment.");
if (!env.queues?.consumers?.length || !env.queues?.producers?.length) problems.push("Queue producer/consumer bindings missing.");
if (!env.triggers?.crons?.length) problems.push("Cron trigger missing.");
if (target === "production" && env.vars?.SIMULATOR_ENABLED !== "false") problems.push("Production must set SIMULATOR_ENABLED=false.");
if (problems.length) {
  console.error(`Refusing to touch ${target}:\n - ${problems.join("\n - ")}`);
  process.exit(1);
}
if (target === "production" && process.env.CONFIRM_PRODUCTION !== "della") {
  console.error("Production changes require CONFIRM_PRODUCTION=della in the environment (deliberate, one-off).");
  process.exit(1);
}
console.log(`Target confirmed: ${target} (${env.name}).`);
