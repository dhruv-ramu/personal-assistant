// Idempotent Cloudflare provisioning for one environment: reuses existing named resources,
// creates only missing ones, and never creates duplicates. Dry run unless --apply is passed.
// Usage: node scripts/provision.mjs --env staging [--apply]
import { spawnSync } from "node:child_process";
import { readWranglerConfig } from "./lib.mjs";

const args = process.argv.slice(2);
const envName = args[args.indexOf("--env") + 1];
const apply = args.includes("--apply");
if (envName !== "staging" && envName !== "production") {
  console.error("Usage: node scripts/provision.mjs --env staging|production [--apply]");
  process.exit(2);
}
if (envName === "production" && apply && process.env.CONFIRM_PRODUCTION !== "della") {
  console.error("Creating production resources requires CONFIRM_PRODUCTION=della.");
  process.exit(1);
}
const env = readWranglerConfig().env[envName];
const wr = (...a) => spawnSync("npx", ["wrangler", ...a], { encoding: "utf8" });

const d1 = wr("d1", "list", "--json");
if (d1.status !== 0) {
  console.error("Could not list D1 databases. Run `npx wrangler login` first.\n" + d1.stderr);
  process.exit(1);
}
const databases = JSON.parse(d1.stdout);
for (const db of env.d1_databases) {
  const existing = databases.find((d) => d.name === db.database_name);
  if (existing) {
    console.log(`✓ D1 ${db.database_name} exists (id ${existing.uuid})${db.database_id === existing.uuid ? "" : " — copy this id into wrangler.jsonc"}`);
  } else if (apply) {
    const r = wr("d1", "create", db.database_name);
    process.stdout.write(r.stdout);
    if (r.status !== 0) process.exit(1);
    console.log("→ Copy the database_id above into wrangler.jsonc for this environment.");
  } else console.log(`• would create D1 ${db.database_name}`);
}

const q = wr("queues", "list");
const queueText = q.stdout ?? "";
const queues = [...new Set([...env.queues.producers.map((p) => p.queue), ...env.queues.consumers.map((c) => c.queue)])];
for (const name of queues) {
  if (new RegExp(`\\b${name.replace(/[-]/g, "\\-")}\\b`).test(queueText)) console.log(`✓ queue ${name} exists`);
  else if (apply) {
    const r = wr("queues", "create", name);
    process.stdout.write(r.stdout);
    if (r.status !== 0) {
      console.error(r.stderr);
      process.exit(1);
    }
  } else console.log(`• would create queue ${name}`);
}
const r2 = wr("r2", "bucket", "list");
const r2Text = r2.stdout ?? "";
for (const b of env.r2_buckets ?? []) {
  if (new RegExp(`\\b${b.bucket_name.replace(/[-]/g, "\\-")}\\b`).test(r2Text))
    console.log(`✓ R2 bucket ${b.bucket_name} exists (keep it private: no public access or custom domain)`);
  else if (apply) {
    const r = wr("r2", "bucket", "create", b.bucket_name);
    process.stdout.write(r.stdout);
    if (r.status !== 0) {
      console.error(r.stderr);
      process.exit(1);
    }
  } else console.log(`• would create private R2 bucket ${b.bucket_name}`);
}
console.log(
  "• Vectorize is optional (SEMANTIC_INDEX=vectorize): npx wrangler vectorize create della-memory-" + envName + " --dimensions=256 --metric=cosine, then add a VECTORS binding.",
);

console.log(apply ? "\nDone. Next: set secrets (docs/SETUP.md §6), then npm run db:migrate:" + envName : "\nDry run only. Re-run with --apply to create missing resources.");
