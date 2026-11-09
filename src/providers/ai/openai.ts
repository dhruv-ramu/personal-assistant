import { ALL_FEATURES, InterpretationSchema, interpretationJsonSchema, type SchemaFeatures } from "../../domain/actions";
import { redactText } from "../../security/redaction";
import type { Fetcher } from "../http";
import { isAbortOrNetworkError } from "../http";
import type { Planner, PlannerContext, PlannerResult } from "../types";
import { buildUserMessage, systemPrompt } from "./prompt";

export interface OpenAiPlannerConfig {
  apiKey: string;
  model: string;
  reasoningEffort: "none" | "low" | "medium";
  enabled: boolean;
  timeoutMs?: number;
  maxOutputTokens?: number;
  maxInputChars?: number;
}

const ENDPOINT = "https://api.openai.com/v1/responses";

interface ResponsesBody {
  status?: string;
  incomplete_details?: { reason?: string } | null;
  error?: { message?: string } | null;
  output?: Array<{ type: string; content?: Array<{ type: string; text?: string; refusal?: string }> }>;
  usage?: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } };
}

/**
 * OpenAI Responses API planner with strict structured outputs.
 *  - `store: false`: asks OpenAI not to store the response object for later retrieval. It is not
 *    a blanket statement about all provider-side retention (see OpenAI's data controls docs).
 *  - Bounded: request timeout, max_output_tokens, input size cap, at most one transport retry
 *    for 429/5xx/timeout, and at most one schema-repair attempt. No agent loop, no tools.
 *  - Never executes partially parsed output: anything that fails Zod validation is rejected.
 */
export class OpenAiPlanner implements Planner {
  readonly name = "openai";
  readonly live: boolean;
  constructor(
    private readonly cfg: OpenAiPlannerConfig,
    private readonly fetcher: Fetcher,
  ) {
    this.live = cfg.enabled;
  }

  private async call(
    input: Array<{ role: string; content: string }>,
    features: SchemaFeatures,
  ): Promise<{ ok: true; body: ResponsesBody } | { ok: false; kind: "timeout" | "rate_limited" | "unavailable"; detail: string }> {
    const body = {
      model: this.cfg.model,
      store: false,
      max_output_tokens: this.cfg.maxOutputTokens ?? 2000,
      reasoning: { effort: this.cfg.reasoningEffort },
      input,
      text: { format: { type: "json_schema", name: "della_interpretation", strict: true, schema: interpretationJsonSchema(features) } },
    };
    let res: Response;
    try {
      res = await this.fetcher(ENDPOINT, {
        method: "POST",
        headers: { authorization: `Bearer ${this.cfg.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 20_000),
      });
    } catch (err) {
      if (isAbortOrNetworkError(err)) return { ok: false, kind: "timeout", detail: "OpenAI request timed out" };
      return { ok: false, kind: "unavailable", detail: redactText(String(err)) };
    }
    if (res.status === 429) return { ok: false, kind: "rate_limited", detail: "OpenAI rate limited (429)" };
    if (res.status >= 500) return { ok: false, kind: "unavailable", detail: `OpenAI error ${res.status}` };
    const json = (await res.json().catch(() => ({}))) as ResponsesBody;
    if (!res.ok) return { ok: false, kind: "unavailable", detail: redactText(json.error?.message ?? `OpenAI HTTP ${res.status}`) };
    return { ok: true, body: json };
  }

  async interpret(ctx: PlannerContext): Promise<PlannerResult> {
    const usage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
    const model = this.cfg.model;
    if (!this.cfg.enabled) return { kind: "disabled", detail: "AI_LIVE_ENABLED is false", usage, model };
    const features = ctx.features ?? ALL_FEATURES;
    const userMessage = buildUserMessage(ctx).slice(0, this.cfg.maxInputChars ?? 12_000);
    const input = [
      { role: "developer", content: systemPrompt(features) },
      { role: "user", content: userMessage },
    ];
    let repaired = false;
    for (let transportAttempt = 0; transportAttempt < 2;) {
      const r = await this.call(input, features);
      if (!r.ok) {
        transportAttempt++;
        if (transportAttempt < 2) {
          await new Promise((resolve) => setTimeout(resolve, 400 + Math.random() * 400));
          continue;
        }
        return { kind: r.kind, detail: r.detail, usage, model };
      }
      usage.inputTokens += r.body.usage?.input_tokens ?? 0;
      usage.outputTokens += r.body.usage?.output_tokens ?? 0;
      usage.cachedInputTokens += r.body.usage?.input_tokens_details?.cached_tokens ?? 0;
      if (r.body.status === "incomplete") return { kind: "incomplete", detail: `Incomplete: ${r.body.incomplete_details?.reason ?? "unknown"}`, usage, model };
      if (r.body.status && r.body.status !== "completed") return { kind: "unavailable", detail: `Response status ${r.body.status}`, usage, model };
      const message = r.body.output?.find((o) => o.type === "message");
      const part = message?.content?.[0];
      if (!part) return { kind: "invalid", detail: "No output content", usage, model };
      if (part.type === "refusal") return { kind: "refused", detail: redactText(part.refusal ?? "refused"), usage, model };
      if (part.type !== "output_text" || typeof part.text !== "string") return { kind: "invalid", detail: "Unexpected output type", usage, model };
      let parsed: unknown;
      let problem: string | null = null;
      try {
        parsed = JSON.parse(part.text);
      } catch {
        problem = "Output was not valid JSON.";
      }
      if (!problem) {
        const v = InterpretationSchema.safeParse(parsed);
        if (v.success) return { kind: "ok", interpretation: v.data, usage, model };
        problem = v.error.issues
          .slice(0, 5)
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ");
      }
      if (repaired) return { kind: "invalid", detail: redactText(problem ?? "invalid"), usage, model };
      repaired = true;
      input.push({ role: "assistant", content: part.text.slice(0, 4000) });
      input.push({ role: "user", content: `That output was invalid (${problem}). Return a corrected interpretation for the same message.` });
    }
    return { kind: "unavailable", detail: "exhausted", usage, model };
  }
}
