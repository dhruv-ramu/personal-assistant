import { env } from "cloudflare:workers";
import { describe, it } from "vitest";
import { validateCandidate } from "../../src/knowledge/ingest";
import type { KnowledgeCandidate } from "../../src/knowledge/schema";
import { OpenAiPlanner } from "../../src/providers/ai/openai";
import { allowlistedFetch } from "../../src/providers/http";
import type { PlannerContext } from "../../src/providers/types";
import { estimateAiCostUsd } from "../../src/services/usage";
import corpus from "./memory-corpus.json";

/**
 * Opt-in real-model memory evaluation (MEMORY_EVAL=1 + LIVE_AI_EVAL=1 + OPENAI_API_KEY). Calls the
 * planner directly: no SMS, calls, calendar writes, or database changes. Hard request cap.
 * A small fictional corpus: the numbers are indicative, never a pass-rate claim.
 */
const MAX_REQUESTS = 16;
const vars = env as unknown as Record<string, string | undefined>;
const live = vars.LIVE_AI_EVAL === "1" && vars.MEMORY_EVAL === "1";
const key = vars.OPENAI_API_KEY;
const model = vars.OPENAI_MODEL ?? "gpt-6-luna";

declare module "vitest" {
  interface TaskMeta {
    evaluation?: Record<string, unknown>;
  }
}

interface Expect {
  kinds?: string[];
  notKinds?: string[];
  item?: string;
  containers?: string[];
  modality?: string;
  when?: string;
  attributed_to?: string;
  person?: string;
  actions?: string[];
  notActions?: string[];
  queryKind?: string;
  noTaskActions?: boolean;
  notValueContains?: string;
  team_result?: boolean;
  metric_value?: number | null;
}

const ctxBase: Omit<PlannerContext, "messageText"> = {
  nowUtcIso: "2026-11-08T18:00:00.000Z",
  localNow: "2026-11-08T10:00 Sunday (America/Los_Angeles, UTC-08:00)",
  timezone: "America/Los_Angeles",
  ownerName: "Sam",
  recentTurns: [],
  pendingQuestion: null,
  openTasks: [],
  upcomingEvents: [],
  capabilitiesNote: "tasks, reminders, calendar, wake-up calls, memory (items, promises, waiting-for, decisions, notes), planning, owner-requested accountability",
};

function check(e: Expect, actions: Array<Record<string, unknown>>, knowledge: KnowledgeCandidate[], text: string): { ok: boolean; failures: string[] } {
  const f: string[] = [];
  const kinds = knowledge.map((k) => k.kind);
  const types = actions.map((a) => String(a.type));
  for (const k of e.kinds ?? []) if (!kinds.includes(k as KnowledgeCandidate["kind"])) f.push(`missing kind ${k}`);
  if (e.kinds && e.kinds.length === 0 && kinds.length) f.push(`expected no candidates, got ${kinds.join(",")}`);
  for (const k of e.notKinds ?? []) if (kinds.includes(k as KnowledgeCandidate["kind"])) f.push(`unexpected kind ${k}`);
  for (const a of e.actions ?? []) if (!types.includes(a)) f.push(`missing action ${a}`);
  for (const a of e.notActions ?? []) if (types.includes(a)) f.push(`unexpected action ${a}`);
  if (e.noTaskActions && types.some((t) => ["create_task", "create_reminder", "create_calendar_event"].includes(t))) f.push("created a commitment from 'maybe'");
  const first = knowledge[0] as Record<string, unknown> | undefined;
  const norm = (s: unknown) =>
    String(s ?? "")
      .toLowerCase()
      .replace(/^(my|the)\s+/, "");
  if (e.item && norm(first?.item) !== e.item) f.push(`item ${String(first?.item)} != ${e.item}`);
  if (e.containers && JSON.stringify((first?.container_path as string[] | undefined)?.map(norm)) !== JSON.stringify(e.containers))
    f.push(`containers ${JSON.stringify(first?.container_path)}`);
  if (e.modality && first?.modality !== e.modality) f.push(`modality ${String(first?.modality)}`);
  if (e.when && first?.when !== e.when) f.push(`when ${String(first?.when)}`);
  if (e.attributed_to && first?.attributed_to !== e.attributed_to) f.push(`attributed_to ${String(first?.attributed_to)}`);
  if (e.person && first?.person !== e.person) f.push(`person ${String(first?.person)}`);
  if (e.team_result !== undefined && first?.team_result !== e.team_result) f.push(`team_result ${String(first?.team_result)}`);
  if (e.metric_value !== undefined && (first?.metric_value ?? null) !== e.metric_value) f.push(`metric_value ${String(first?.metric_value)}`);
  if (e.queryKind && !actions.some((a) => a.type === "memory_query" && a.query_kind === e.queryKind)) f.push(`query_kind != ${e.queryKind}`);
  if (e.notValueContains && JSON.stringify(knowledge).includes(e.notValueContains)) f.push("stored injected content");
  for (const k of knowledge) {
    const invalid = validateCandidate(k, text);
    if (invalid) f.push(`candidate rejected by validator: ${invalid}`);
  }
  return { ok: f.length === 0, failures: f };
}

describe.skipIf(!live || !key)("live memory extraction eval (opt-in, read-only, capped)", () => {
  let requests = 0;
  const counting = allowlistedFetch(async (input, init) => {
    requests++;
    if (requests > MAX_REQUESTS) throw new Error("memory eval request cap reached");
    return fetch(input, init);
  });
  const planner = new OpenAiPlanner({ apiKey: key ?? "", model, reasoningEffort: "low", enabled: true, timeoutMs: 30_000 }, counting);
  for (const c of corpus.cases as Array<{ id: string; metric: string; text: string; expect: Expect }>) {
    it(`${c.id}: ${c.text}`, async ({ task }) => {
      if (requests >= MAX_REQUESTS) return;
      const started = Date.now();
      const r = await planner.interpret({ ...ctxBase, messageText: c.text });
      const actions = r.kind === "ok" ? (r.interpretation.actions as unknown as Array<Record<string, unknown>>) : [];
      const knowledge = r.kind === "ok" ? (r.interpretation.knowledge ?? []) : [];
      const res = r.kind === "ok" ? check(c.expect, actions, knowledge, c.text) : { ok: false, failures: [`planner ${r.kind}`] };
      task.meta.evaluation = {
        id: c.id,
        metric: c.metric,
        ok: res.ok,
        failures: res.failures,
        kind: r.kind,
        inputTokens: r.usage.inputTokens,
        outputTokens: r.usage.outputTokens,
        latencyMs: Date.now() - started,
        estimatedCostUsd: estimateAiCostUsd(r.usage.inputTokens, r.usage.outputTokens),
      };
    });
  }
});
