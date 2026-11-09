// Restores a D1 export into a FRESH local database directory, then applies post-restore safety
// (global hold, sessions invalidated, in-flight effects marked unknown). Never touches remote DBs.
import { existsSync } from "node:fs";
import { run } from "./lib.mjs";

const file = process.argv[2];
if (!file || !existsSync(file)) {
  console.error("Usage: npm run restore:local -- backups/<file>.sql");
  process.exit(2);
}
const dir = `.wrangler/restore-${new Date().toISOString().replace(/[:.]/g, "-")}`;
run("npx", ["wrangler", "d1", "execute", "DB", "--local", "--persist-to", dir, "--file", file, "--yes"]);
run("npx", ["wrangler", "d1", "execute", "DB", "--local", "--persist-to", dir, "--file", "scripts/post-restore.sql", "--yes"]);
console.log(`\nRestored into ${dir} with automation on hold.`);
console.log(`Inspect it with: npx wrangler dev --persist-to ${dir}`);
console.log("Review Activity for unknown effects, then use Data → 'Resume after restore'. Nothing old is replayed.");
