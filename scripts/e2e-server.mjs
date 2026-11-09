// Starts an isolated local Worker for Playwright: fresh persisted D1 under .wrangler/e2e,
// simulated providers only, fixed test-only secrets. Never used outside local testing.
import { rmSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";

const dir = ".wrangler/e2e";
spawnSync("node", ["scripts/build-extension.mjs"], { stdio: "inherit" });
rmSync(dir, { recursive: true, force: true });
const migrate = spawnSync("npx", ["wrangler", "d1", "migrations", "apply", "DB", "--local", "--persist-to", dir], { stdio: "inherit" });
if (migrate.status !== 0) process.exit(migrate.status ?? 1);
const vars = {
  ADMIN_BOOTSTRAP_SECRET: "e2e-admin-secret-0123456789abcdef",
  DATA_ENCRYPTION_KEY: "k1:dGVzdC1rZXktMDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY=",
  SIM_WEBHOOK_SECRET: "e2e-sim-secret",
};
const args = ["wrangler", "dev", "--port", "8788", "--persist-to", dir, "--env-file", "/dev/null", ...Object.entries(vars).flatMap(([k, v]) => ["--var", `${k}:${v}`])];
const child = spawn("npx", args, { stdio: "inherit" });
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
child.on("exit", (code) => process.exit(code ?? 0));
