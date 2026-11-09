// Integrated extension demo: runs tests/demo/extension-demo.test.ts (real Worker code in workerd,
// migrated local D1, simulated providers, fixed clock) and prints the resulting transcript.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

mkdirSync(new URL("../artifacts/", import.meta.url), { recursive: true });
const jsonPath = "artifacts/extension-demo-vitest.json";
const r = spawnSync("npx", ["vitest", "run", "--project", "demo", "--reporter=json", `--outputFile=${jsonPath}`], { stdio: ["ignore", "ignore", "inherit"] });
let report;
try {
  report = JSON.parse(readFileSync(jsonPath, "utf8"));
} catch {
  console.error("Demo produced no report.");
  process.exit(r.status ?? 1);
}
const test = report.testResults.flatMap((f) => f.assertionResults)[0];
const lines = test?.meta?.evidence?.transcript ?? [];
const out = [
  "# Della extension demo transcript",
  "",
  `Generated ${new Date().toISOString()} by \`npm run demo:extension\`. Simulated SMS, voice, calendar, browser device, vision, and embeddings; rule-based planner. No live provider was contacted.`,
  ...lines,
  "",
  test?.status === "passed" ? "Demo completed." : `Demo FAILED: ${(test?.failureMessages ?? []).join("\n").slice(0, 2000)}`,
].join("\n");
writeFileSync("artifacts/extension-demo.md", out);
console.log(out);
process.exit(test?.status === "passed" ? 0 : 1);
