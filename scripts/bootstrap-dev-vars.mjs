// Creates .dev.vars from .dev.vars.example with freshly generated local secrets (never overwrites).
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const target = new URL("../.dev.vars", import.meta.url);
if (existsSync(target)) {
  console.log(".dev.vars already exists; leaving it unchanged.");
  process.exit(0);
}
const template = readFileSync(new URL("../.dev.vars.example", import.meta.url), "utf8");
const filled = template
  .replace(/^ADMIN_BOOTSTRAP_SECRET=.*$/m, `ADMIN_BOOTSTRAP_SECRET=${randomBytes(24).toString("base64url")}`)
  .replace(/^DATA_ENCRYPTION_KEY=.*$/m, `DATA_ENCRYPTION_KEY=k1:${randomBytes(32).toString("base64")}`)
  .replace(/^SIM_WEBHOOK_SECRET=.*$/m, `SIM_WEBHOOK_SECRET=${randomBytes(24).toString("base64url")}`);
writeFileSync(target, filled, { mode: 0o600 });
console.log("Created .dev.vars with generated local secrets (git-ignored).");
console.log("Your admin login secret is the ADMIN_BOOTSTRAP_SECRET value in .dev.vars.");
