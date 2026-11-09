// D1 backup via `wrangler d1 export`. Content columns stay application-encrypted, but the file
// still contains scheduling metadata: store it encrypted/access-controlled and never commit it.
import { mkdirSync } from "node:fs";
import { run } from "./lib.mjs";

const args = process.argv.slice(2);
const local = args.includes("--local");
const envName = args.includes("--env") ? args[args.indexOf("--env") + 1] : null;
if (!local && envName !== "staging" && envName !== "production") {
  console.error("Usage: npm run backup -- --local | --env staging | --env production");
  process.exit(2);
}
mkdirSync("backups", { recursive: true, mode: 0o700 });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const file = `backups/della-${local ? "local" : envName}-${stamp}.sql`;
const wranglerArgs = ["wrangler", "d1", "export", "DB", "--output", file];
if (local) wranglerArgs.push("--local");
else wranglerArgs.push("--remote", "--env", envName);
run("npx", wranglerArgs);
console.log(`\nBackup written to ${file} (git-ignored).`);
console.log("Restoring requires the same DATA_ENCRYPTION_KEY (or it configured as DATA_ENCRYPTION_KEY_PREVIOUS).");
console.log("Test it with: npm run restore:local -- " + file);
