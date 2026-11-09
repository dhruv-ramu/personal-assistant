import { InterpretationSchema, blankTimeSpec, type Action, type Interpretation, type WireTimeSpec } from "../../src/domain/actions";
import { RulePlanner } from "../../src/providers/simulated/planner";
import type { Planner, PlannerContext, PlannerResult } from "../../src/providers/types";

/** Counts interpretations; delegates to the rule planner unless fixed actions are queued. */
export class SpyPlanner implements Planner {
  readonly name = "spy";
  readonly live = false;
  calls: PlannerContext[] = [];
  queue: Action[][] = [];
  private readonly rules = new RulePlanner();

  async interpret(ctx: PlannerContext): Promise<PlannerResult> {
    this.calls.push(ctx);
    const next = this.queue.shift();
    if (next) {
      const interpretation: Interpretation = InterpretationSchema.parse({ intent: "fixed", time_expressions: [], references: [], missing_fields: [], actions: next });
      return { kind: "ok", interpretation, usage: { inputTokens: 0, outputTokens: 0 }, model: "spy" };
    }
    return this.rules.interpret(ctx);
  }
}

export function ts(p: Partial<WireTimeSpec>): WireTimeSpec {
  return { ...blankTimeSpec(), ...p };
}
