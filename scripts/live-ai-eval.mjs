// Opt-in live AI evaluations. Read-only (planner only), hard request caps (12 interpretation,
// 16 memory). Usage: LIVE_AI_EVAL=1 OPENAI_API_KEY=... npm run test:ai:live  |  npm run test:memory:live
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

if (process.env.LIVE_AI_EVAL !== "1" || !process.env.OPENAI_API_KEY) {
  console.error("Live AI eval is opt-in. Set LIVE_AI_EVAL=1 and OPENAI_API_KEY (prefer a shell prompt, not history) to run it.");
  console.error("It sends at most 12 small requests to the configured model and makes no SMS, call, or calendar changes.");
  process.exit(2);
}
mkdirSync("artifacts", { recursive: true });
const memory = process.argv.includes("--memory");
const out = memory ? "artifacts/live-memory-vitest.json" : "artifacts/live-ai-vitest.json";
const r = spawnSync(
  "npx",
  [
    "vitest",
    "run",
    "--project",
    "live-ai",
    memory ? "tests/live/memory-eval.test.ts" : "tests/live/ai-eval.test.ts",
    "--reporter=json",
    `--outputFile=${out}`,
    "--reporter=default",
  ],
  { stdio: ["ignore", "inherit", "inherit"], env: { ...process.env, ...(memory ? { MEMORY_EVAL: "1" } : {}) } },
);
if (memory) {
  const rep = JSON.parse(readFileSync(out, "utf8"));
  const cases = rep.testResults
    .flatMap((f) => f.assertionResults)
    .filter((a) => a.meta?.evaluation)
    .map((a) => a.meta.evaluation);
  const byMetric = {};
  for (const c of cases) {
    byMetric[c.metric] ??= { cases: 0, ok: 0 };
    byMetric[c.metric].cases++;
    if (c.ok) byMetric[c.metric].ok++;
  }
  const summary = {
    generatedAt: new Date().toISOString(),
    model: process.env.OPENAI_MODEL ?? "gpt-6-luna",
    note: "Small fictional corpus; indicative only. Not a pass rate and not evidence of zero hallucinations.",
    cases: cases.length,
    byMetric,
    totalInputTokens: cases.reduce((n, c) => n + c.inputTokens, 0),
    totalOutputTokens: cases.reduce((n, c) => n + c.outputTokens, 0),
    meanLatencyMs: cases.length ? Math.round(cases.reduce((n, c) => n + c.latencyMs, 0) / cases.length) : null,
    estimatedCostUsd: cases.reduce((n, c) => n + c.estimatedCostUsd, 0),
    results: cases,
  };
  writeFileSync("artifacts/live-memory-eval.json", JSON.stringify(summary, null, 2));
  console.log(`\nLive memory eval: ${cases.length} cases. Wrote artifacts/live-memory-eval.json`);
  process.exit(r.status ?? 0);
}
const report = JSON.parse(readFileSync(out, "utf8"));
const cases = report.testResults
  .flatMap((f) => f.assertionResults)
  .filter((a) => a.meta?.evaluation)
  .map((a) => ({ text: a.title, ...a.meta.evaluation }));
const summary = {
  generatedAt: new Date().toISOString(),
  model: process.env.OPENAI_MODEL ?? "gpt-6-luna",
  cases: cases.length,
  typeAccuracy: cases.length ? cases.filter((c) => c.typeOk).length / cases.length : null,
  fieldAccuracy: cases.length ? cases.filter((c) => c.fieldsOk).length / cases.length : null,
  totalInputTokens: cases.reduce((n, c) => n + c.inputTokens, 0),
  totalOutputTokens: cases.reduce((n, c) => n + c.outputTokens, 0),
  estimatedCostUsd: cases.reduce((n, c) => n + c.estimatedCostUsd, 0),
  results: cases,
};
writeFileSync("artifacts/live-ai-eval.json", JSON.stringify(summary, null, 2));
console.log(
  `\nLive AI eval: ${cases.length} cases, intent accuracy ${summary.typeAccuracy}, field accuracy ${summary.fieldAccuracy}, est. $${summary.estimatedCostUsd.toFixed(5)}. Wrote artifacts/live-ai-eval.json`,
);
process.exit(r.status ?? 0);
