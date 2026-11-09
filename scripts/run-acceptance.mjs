// Runs the end-to-end acceptance scenarios (simulated providers, real HTTP ingress, D1, jobs,
// scheduler, callbacks; frozen clock) and writes machine-readable + human-readable results.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

mkdirSync(new URL("../artifacts/", import.meta.url), { recursive: true });
mkdirSync(new URL("../docs/", import.meta.url), { recursive: true });
const jsonPath = "artifacts/acceptance-vitest.json";
const r = spawnSync("npx", ["vitest", "run", "--project", "acceptance", "--reporter=json", `--outputFile=${jsonPath}`, "--reporter=default"], {
  stdio: ["ignore", "inherit", "inherit"],
});

let report;
try {
  report = JSON.parse(readFileSync(jsonPath, "utf8"));
} catch {
  console.error("No acceptance report produced.");
  process.exit(r.status ?? 1);
}

const scenarios = [];
for (const file of report.testResults) {
  const suite = /extension\.test\.ts$/.test(file.name) ? "extension" : "base";
  for (const a of file.assertionResults) {
    scenarios.push({
      suite,
      id: a.title.split(":")[0],
      title: a.title,
      status: a.status,
      durationMs: Math.round(a.duration ?? 0),
      evidence: a.meta?.evidence ?? null,
      failure: a.failureMessages?.length ? a.failureMessages.join("\n").slice(0, 2000) : null,
    });
  }
}

function writeReport(suite, title, path, note) {
  const list = scenarios.filter((s) => s.suite === suite);
  const summary = {
    generatedAt: new Date().toISOString(),
    frozenClock: "2026-11-08T18:00:00Z (Sunday 10:00 AM America/Los_Angeles) unless a scenario states otherwise",
    providers: "simulated SMS, voice, calendar, browser device, vision, embeddings, email, and rule-based AI planner (no live provider was contacted)",
    passed: list.filter((s) => s.status === "passed").length,
    failed: list.filter((s) => s.status !== "passed").length,
    total: list.length,
    scenarios: list,
  };
  const lines = [
    `# ${title}`,
    "",
    `Generated ${summary.generatedAt} by \`npm run test:acceptance\`.`,
    "",
    `- Clock: ${summary.frozenClock}`,
    `- Providers: ${summary.providers}`,
    `- Result: **${summary.passed}/${summary.total} passed**${summary.failed ? `, ${summary.failed} not passed` : ""}`,
    "",
    note,
    "",
    "| # | Scenario | Result |",
    "| --- | --- | --- |",
    ...list.map((s) => `| ${s.id} | ${s.title.replace(/^[SX]\d+:\s*/, "").replace(/\|/g, "\\|")} | ${s.status === "passed" ? "passed" : `**${s.status}**`} |`),
    "",
    "## Transcripts and evidence",
    "",
  ];
  for (const s of list) {
    lines.push(`### ${s.title}`, "");
    const ev = s.evidence ?? {};
    if (Array.isArray(ev.transcript)) lines.push("```text", ...ev.transcript.map((t) => t.replace(/\n/g, "\n    ")), "```", "");
    const rest = Object.fromEntries(Object.entries(ev).filter(([k]) => k !== "transcript"));
    if (Object.keys(rest).length) lines.push("```json", JSON.stringify(rest, null, 2), "```", "");
    if (s.failure) lines.push("Failure:", "```text", s.failure, "```", "");
  }
  writeFileSync(path, lines.join("\n"));
  return summary;
}

const base = writeReport(
  "base",
  "Acceptance results",
  "docs/ACCEPTANCE_RESULTS.md",
  "The simulated planner is rule-based. These scenarios prove the application logic (ingress, persistence, scheduling, idempotency, callbacks, policies), not real language-model quality or live provider behaviour.",
);
const ext = writeReport(
  "extension",
  "Della extension acceptance results",
  "docs/DELLA_EXTENSION_ACCEPTANCE_RESULTS.md",
  "Extension scenarios X1–X27 (spec §18). Extraction here comes from the rule-based simulator, so these prove orchestration, storage, retrieval, policy, and safety logic, not model extraction quality. Browser events come from a simulated device using real ECDSA P-256 signatures over HTTP; no real browser was driven.",
);
writeFileSync("artifacts/acceptance-results.json", JSON.stringify({ base, extension: ext }, null, 2));
const failed = base.failed + ext.failed;
console.log(
  `\nAcceptance: base ${base.passed}/${base.total}, extension ${ext.passed}/${ext.total}. Wrote docs/ACCEPTANCE_RESULTS.md, docs/DELLA_EXTENSION_ACCEPTANCE_RESULTS.md, artifacts/acceptance-results.json`,
);
process.exit(failed ? 1 : (r.status ?? 0));
