import type { Action, TimeSpec } from "../../domain/actions";
import { parseTimePhrase } from "../../domain/timeparse";
import type { KnowledgeCandidate } from "../../knowledge/schema";
import type { RecurrenceSpec } from "../../domain/recurrence";

/**
 * Rule-based knowledge extraction for the simulated planner. It recognizes a bounded set of
 * phrasings so tests, the demo, and fixtures exercise the real ingest pipeline. Every candidate's
 * `evidence_span` is a verbatim substring of the message. This is NOT a model-quality claim.
 */

const ART = /^(?:the|my|a|an|our)\s+/i;
const clean = (s: string) =>
  s
    .replace(/[.!?]+$/, "")
    .replace(ART, "")
    .replace(/\s+/g, " ")
    .trim();

function when(text: string): { when: "now" | "earlier_today" | "yesterday"; rest: string } {
  if (/\byesterday\b/i.test(text)) return { when: "yesterday", rest: text.replace(/\s*\byesterday\b/i, "") };
  if (/\b(earlier today|this morning)\b/i.test(text)) return { when: "earlier_today", rest: text.replace(/\s*\b(earlier today|this morning)\b/i, "") };
  return { when: "now", rest: text };
}

function containerPath(phrase: string): string[] {
  return phrase
    .replace(/[.!?]+$/, "")
    .split(/\s*(?:,\s*)?\b(?:in|inside|on|of|within|under)\s+(?=(?:the|my|a|an|our)\b)/i)
    .map(clean)
    .filter(Boolean)
    .slice(0, 6);
}

function ts(phrase: string | undefined, year: number): TimeSpec | null {
  if (!phrase) return null;
  return parseTimePhrase(phrase, year)?.spec ?? null;
}

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+(?=[A-Z])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

type Rule = (s: string, year: number) => KnowledgeCandidate | null;

const RULES: Rule[] = [
  // Work checkpoint: "Stopping here on Thesis: done X; tried Y; next Z".
  (s) => {
    const m = /^stopping here(?: on ([^:,-]+?))?\s*[:,-]\s*(.+)$/i.exec(s);
    if (!m) return null;
    const body = m[2]!;
    const part = (k: RegExp) => k.exec(body)?.[1]?.trim().replace(/[;.]$/, "") ?? null;
    return {
      kind: "work_checkpoint",
      project: clean(m[1] ?? "current project"),
      completed: part(/\b(?:done|finished|completed)[: ]+([^;]+)/i),
      attempted: part(/\b(?:tried|attempted)[: ]+([^;]+)/i),
      remaining: part(/\b(?:open issue|remaining|stuck on|problem)[: ]+([^;]+)/i),
      next_action: part(/\bnext[: ]+([^;]+)/i),
      evidence_span: m[0],
    };
  },
  (s, year) => {
    const m = /^(?:message|note) (?:to|for) (?:my )?future self(?: (?:when|if) ([^:]+?))?(?: on ([^:]+?))?\s*:\s*(.+)$/i.exec(s);
    if (!m) return null;
    return { kind: "future_message", message: m[3]!.trim(), trigger: m[1] ? m[1].trim() : null, date: ts(m[2], year), evidence_span: m[0] };
  },
  (s) => {
    const m = /^(?:idea|park(?:ing)? (?:this )?idea)\s*:\s*(.+?)(?:\s+(?:after|when) ([^.]+))?\.?$/i.exec(s);
    return m ? { kind: "idea", text: m[1]!.trim(), reason_deferred: null, revisit_condition: m[2] ? m[2].trim() : null, project: null, evidence_span: m[0] } : null;
  },
  (s) => {
    const m = /^lesson(?: from ([^:]+))?\s*:\s*(.+)$/i.exec(s);
    return m ? { kind: "lesson", activity: clean(m[1] ?? "general"), lesson: m[2]!.trim(), evidence_span: m[0] } : null;
  },
  (s) => {
    const m = /^note(?: on ([^:]+))?\s*:\s*(.+)$/i.exec(s);
    return m ? { kind: "note", text: m[2]!.trim(), project: m[1] ? clean(m[1]) : null, evidence_span: m[0] } : null;
  },
  (s) => {
    const m = /^(?:win|accomplishment)\s*:\s*(.+)$/i.exec(s) ?? /^(?:i|we)\s+(?:reduced|improved|increased|cut|shipped|launched|won)\b.+$/i.exec(s);
    if (!m) return null;
    const desc = (m[1] ?? m[0]).trim();
    const metric = /(\d+(?:\.\d+)?)\s*(%|(?:percent|ms|seconds|hours|x)\b)/i.exec(desc);
    const base = /\bfrom\s+(\d+(?:\.\d+)?\s*\w*)/i.exec(desc);
    return {
      kind: "accomplishment",
      description: desc.replace(/[.!]$/, ""),
      role: null,
      metric_value: metric ? Number(metric[1]) : null,
      metric_unit: metric ? metric[2]! : null,
      baseline: base ? base[1]! : null,
      team_result: /^we\b|\b(team|we)\b/i.test(desc),
      confidential: /\bconfidential\b/i.test(desc),
      evidence_span: m[0],
    };
  },
  // Item location: "I put my passport in the blue folder in the bottom drawer of my desk".
  (s) => {
    const m = /^(?:(maybe|i think|probably)\s+)?(?:i\s+)?(?:put|left|placed|stored|moved|keep|hid)\s+(?:my|the|our)\s+(.+?)\s+(in|into|inside|on|at|under)\s+(.+)$/i.exec(s);
    if (!m) return null;
    const w = when(m[4]!);
    const at = m[3]!.toLowerCase() === "at";
    return {
      kind: "item_location",
      item: clean(m[2]!),
      container_path: at ? [] : containerPath(`${m[3]} ${w.rest}`.replace(/^(in|into|inside|on|under)\s+/i, "")),
      location_phrase: at ? clean(w.rest) : null,
      modality: m[1] || /\b(maybe|might|probably)\b/i.test(s) ? "possible" : "actual",
      when: w.when,
      when_date: null,
      temporary: /\bfor now\b|\btemporarily\b/i.test(s),
      evidence_span: m[0],
    };
  },
  (s) => {
    const m = /^(?:(maybe|i think)\s+)?(?:my|the)\s+(.+?)\s+(?:is|are)\s+(?:(?:probably|maybe|might be)\s+)?(in|inside|on|at|under)\s+(.+)$/i.exec(s);
    if (!m || /\b(not|no longer)\b/i.test(m[2]!)) return null;
    const w = when(m[4]!);
    const at = m[3]!.toLowerCase() === "at";
    return {
      kind: "item_location",
      item: clean(m[2]!),
      container_path: at ? [] : containerPath(w.rest),
      location_phrase: at ? clean(w.rest) : null,
      modality: m[1] || /\b(probably|maybe|might be)\b/i.test(s) ? "possible" : "actual",
      when: w.when,
      when_date: null,
      temporary: false,
      evidence_span: m[0],
    };
  },
  (s) => {
    const m = /^(?:my|the)\s+(.+?)\s+(?:is not|isn't|wasn't|is no longer|was not|are not|aren't|weren't|are no longer)\s+(?:in|on|at)\s+(.+)$/i.exec(s);
    return m ? { kind: "item_absent", item: clean(m[1]!), location: clean(m[2]!), evidence_span: m[0] } : null;
  },
  (s) => {
    const m = /^i\s+took\s+(?:my|the)\s+(.+?)\s+out\s+of\s+(.+)$/i.exec(s);
    return m ? { kind: "item_removed", item: clean(m[1]!), from: clean(m[2]!), evidence_span: m[0] } : null;
  },
  (s) => {
    const m = /^I\s+lent\s+(?:my|the)\s+(.+?)\s+to\s+([A-Z][a-z]+)\b.*$/.exec(s) ?? /^I\s+lent\s+([A-Z][a-z]+)\s+(?:my|the)\s+(.+)$/.exec(s);
    if (!m) return null;
    const swapped = /^I\s+lent\s+[A-Z]/.test(m[0]) && !/\bto\b/.test(m[0]);
    return { kind: "item_lent", item: clean(swapped ? m[2]! : m[1]!), person: swapped ? m[1]! : m[2]!, evidence_span: m[0] };
  },
  (s) => {
    const m = /^([A-Z][a-z]+)\s+(?:returned|gave back|gave me back)\s+(?:my|the)\s+(.+)$/.exec(s);
    return m ? { kind: "item_returned", item: clean(m[2]!), person: m[1]!, evidence_span: m[0] } : null;
  },
  (s, year) => {
    const m = /^I\s+(?:promised|told)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s+(?:I'd|I would|that I'd|that I would|I'll|I will)\s+(.+?)(?:\s+(by|before|on)\s+(.+?))?\.?$/.exec(s);
    return m ? { kind: "promise", person: m[1]!, deliverable: m[2]!.trim(), due: ts(m[4] ? `${m[3]} ${m[4]}` : undefined, year), evidence_span: m[0] } : null;
  },
  (s, year) => {
    const m = /^(?:I'm\s+|I am\s+)?waiting\s+(?:on|for)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s+to\s+(.+?)(?:[,;]?\s+check\s+(.+?))?\.?$/.exec(s);
    return m ? { kind: "waiting_for", person: m[1]!, item: m[2]!.trim(), check: ts(m[3], year), evidence_span: m[0] } : null;
  },
  (s) => {
    const m = /^([A-Z][a-z]+)\s+(?:replied|got back to me|sent (?:it|me the .+))\b.*$/.exec(s);
    return m ? { kind: "waiting_resolved", person: m[1]!, item: null, evidence_span: m[0] } : null;
  },
  (s) => {
    const m = /^I\s+(?:need to|want to|should)\s+ask\s+((?:Professor|Prof\.?|Dr\.?)\s+[A-Z][a-z]+|[A-Z][a-z]+)\s+(?:about|whether|if)\s+(.+?)\.?$/.exec(s);
    return m ? { kind: "question", text: m[2]!.trim(), about: m[1]!, evidence_span: m[0] } : null;
  },
  (s) => {
    const m = /^I\s+decided\s+(?:to\s+)?(.+?)(?:\s+instead of\s+(.+?))?(?:\s+because\s+(.+?))?(?:[;,]\s*assuming\s+(.+?))?\.?$/i.exec(s);
    return m
      ? {
          kind: "decision",
          choice: m[1]!.trim(),
          alternatives: m[2] ? [m[2].trim()] : [],
          rationale: m[3] ? m[3].trim() : null,
          assumptions: m[4] ? [m[4].trim()] : [],
          evidence_span: m[0],
        }
      : null;
  },
  (s) => {
    const m = /^I\s+(?:think|estimate|predict|bet)\s+(.+?)\s+will\s+take\s+(?:about\s+)?(\d+(?:\.\d+)?)\s+(minutes?|hours?|days?)\.?$/i.exec(s);
    return m ? { kind: "prediction", subject: clean(m[1]!), value: Number(m[2]), unit: m[3]!.toLowerCase(), evidence_span: m[0] } : null;
  },
  (s) => {
    const m = /^(.+?)\s+(?:actually\s+)?took\s+(?:me\s+)?(\d+(?:\.\d+)?)\s+(minutes?|hours?|days?)(?:\s+(of focused work|active|total|elapsed))?\.?$/i.exec(s);
    if (!m || /^i (think|estimate)/i.test(m[1]!)) return null;
    const meas = m[4] ? (/active|focused/i.test(m[4]) ? "active" : "elapsed") : "unspecified";
    return { kind: "actual", subject: clean(m[1]!), value: Number(m[2]), unit: m[3]!.toLowerCase(), measure: meas, evidence_span: m[0] };
  },
  (s, year) => {
    const m =
      /^(?:I\s+need\s+to\s+)?(return|get reimbursed for|renew|cancel my subscription to)\s+(?:the\s+|my\s+)?(.+?)(?:\s+(?:to|from|with)\s+([A-Z][\w&]+))?(?:\s+for\s+\$?(\d+(?:\.\d+)?))?\s+by\s+(.+?)\.?$/i.exec(
        s,
      );
    if (!m) return null;
    const verb = m[1]!.toLowerCase();
    const category = verb === "return" ? "return" : verb.startsWith("get reimbursed") ? "reimbursement" : verb === "renew" ? "renewal" : "subscription";
    return {
      kind: "admin_item",
      category,
      title: `${m[1]} ${clean(m[2]!)}`,
      counterpart: m[3] ?? null,
      amount: m[4] ? Number(m[4]) : null,
      due: ts(`by ${m[5]}`, year),
      evidence_span: m[0],
    };
  },
  (s) => {
    const m = /^I\s+(?:paid|sent)\s+([A-Z][a-z]+)\s+\$(\d+(?:\.\d{2})?)\b.*$/.exec(s);
    return m ? { kind: "payment", counterpart: m[1]!, amount: Number(m[2]), evidence_span: m[0] } : null;
  },
  (s, year) => {
    const m =
      /^I\s+(applied)\s+(?:to|at)\s+([A-Z][\w&.]+)(?:\s+for\s+(?:the\s+|a\s+)?(.+?))?(?:[;,]\s*deadline\s+(.+?))?\.?$/.exec(s) ??
      /^I\s+(?:have\s+an?\s+)?(interview(?:ing)?)\s+(?:with|at)\s+([A-Z][\w&.]+)(?:\s+for\s+(?:the\s+|a\s+)?(.+?))?(?:[;,]\s*deadline\s+(.+?))?\.?$/.exec(s) ??
      /^I\s+got\s+an?\s+(offer)\s+from\s+([A-Z][\w&.]+)(?:\s+for\s+(?:the\s+|a\s+)?(.+?))?(?:[;,]\s*deadline\s+(.+?))?\.?$/.exec(s);
    if (!m) return null;
    const stage = m[1]!.startsWith("interview") ? "interviewing" : m[1] === "offer" ? "offer" : "applied";
    return {
      kind: "recruiting",
      organization: m[2]!,
      role: m[3] ? m[3].trim() : null,
      stage,
      deadline: ts(m[4], year),
      deadline_kind: m[4] ? "external" : "none",
      evidence_span: m[0],
    };
  },
  (s) => {
    const m = /^I\s+can'?t\s+(.+?)\s+until\s+(?:I\s+)?(.+?)\.?$/i.exec(s);
    return m ? { kind: "dependency", task: clean(m[1]!), depends_on: clean(m[2]!), evidence_span: m[0] } : null;
  },
  (s) => {
    const m =
      /^(.+?)\s+(?:takes|will take|needs)\s+(?:about\s+)?(\d+)\s*min(?:ute)?s?(?:\s+(?:and needs|on|at|with)\s+(?:my\s+)?(phone|laptop|computer|home|office|car))?\.?$/i.exec(s);
    return m ? { kind: "task_context", task: clean(m[1]!), minutes: Number(m[2]), context_tags: m[3] ? [m[3].toLowerCase()] : [], evidence_span: m[0] } : null;
  },
  (s) => {
    const m = /^I(?:'m| am)\s+(?:interested in|into|curious about)\s+(.+?)\.?$/i.exec(s);
    return m ? { kind: "interest", topic: clean(m[1]!), evidence_span: m[0] } : null;
  },
  (s, year) => {
    const m =
      /^I(?:'m| am)\s+(?:going|flying|traveling|travelling|driving)\s+to\s+([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?)(?:\s+(on\s+\w+|next\s+\w+|tomorrow|this\s+\w+))?(?:[;,]\s*(?:pack|bring)\s+(.+?))?\.?$/.exec(
        s,
      );
    return m
      ? {
          kind: "trip",
          destination: m[1]!,
          date: ts(m[2], year),
          packing: m[3]
            ? m[3]
                .split(/\s*(?:,|and)\s*/)
                .map((x) => x.trim())
                .filter(Boolean)
                .slice(0, 15)
            : [],
          evidence_span: m[0],
        }
      : null;
  },
  (s) => {
    const m = /^I\s+(?:talked|spoke|met|had coffee|caught up)\s+(?:to|with)\s+([A-Z][a-z]+)(?:\s+(?:about|re)\s+(.+?))?(?:[;,]\s*follow up in (\d+) (days?|weeks?))?\.?$/.exec(s);
    if (!m) return null;
    const days = m[3] ? Number(m[3]) * (m[4]!.startsWith("week") ? 7 : 1) : null;
    return { kind: "interaction", person: m[1]!, notes: m[2] ? m[2].trim() : null, follow_up_days: days, evidence_span: m[0] };
  },
  (s) => {
    const m = /^([A-Z][a-z]+)'s\s+(birthday|email|phone|title|role|favorite \w+|partner|kid'?s? name)\s+is\s+(.+?)\.?$/.exec(s);
    return m
      ? { kind: "fact", subject: m[1]!, attribute: m[2]!, value: m[3]!.trim(), attributed_to: null, polarity: "affirmative", modality: "actual", evidence_span: m[0] }
      : null;
  },
  (s) => {
    const m = /^([A-Z][a-z]+)\s+said\s+(?:that\s+)?(.+?)\s+(is|isn't|is not|will be|won't be)\s+(.+?)\.?$/.exec(s);
    if (!m) return null;
    const neg = /n't|not/.test(m[3]!);
    return {
      kind: "fact",
      subject: clean(m[2]!),
      attribute: "status",
      value: m[4]!.trim(),
      attributed_to: m[1]!,
      polarity: neg ? "negated" : "affirmative",
      modality: /will/.test(m[3]!) ? "intended" : "actual",
      evidence_span: m[0],
    };
  },
  (s) => {
    const m = /^I(?:'m| am)\s+allergic\s+to\s+(.+?)\.?$/i.exec(s);
    return m
      ? { kind: "fact", subject: "me", attribute: "allergy", value: m[1]!.trim(), attributed_to: null, polarity: "affirmative", modality: "actual", evidence_span: m[0] }
      : null;
  },
  (s) => {
    const m = /^I\s+(prefer|like|love|hate|don'?t like|dislike)\s+(.+?)\.?$/i.exec(s);
    return m ? { kind: "preference", topic: clean(m[2]!), value: m[1]!.toLowerCase(), evidence_span: m[0] } : null;
  },
];

export function ruleKnowledge(text: string, year: number): KnowledgeCandidate[] {
  const out: KnowledgeCandidate[] = [];
  for (const raw of sentences(text)) {
    const s = raw.replace(/[.!]+$/, "");
    for (const r of RULES) {
      const c = r(s, year);
      if (c) {
        out.push(c);
        break;
      }
    }
    if (out.length >= 10) break;
  }
  return out;
}

const WEEKDAYS: RecurrenceSpec = { freq: "weekdays", weekdays: null, interval: null, count: null, until_date: null };

/** Extension phrasings the rule planner understands (accountability, routines, planning). */
export function ruleExtAction(clause: string, year: number): Action | null {
  const c = clause.trim();
  let m = /^(?:hold me accountable|accountability)\s+(?:for|on)\s+(.+?)\s+from\s+(.+?)\s+(?:to|until|-)\s+(.+?)(?:[;,]\s*(.+))?$/i.exec(c);
  if (m) {
    const rest = m[4] ?? "";
    const checkpoints: Array<{
      at: "start" | "halfway" | "end" | "offset";
      offset_minutes: number | null;
      evidence: "photo" | "text" | "device" | "any";
      criterion: string | null;
    }> = [];
    if (/\bphoto\b[^;,]*\bstart\b|\bstart\b[^;,]*\bphoto\b/i.test(rest)) checkpoints.push({ at: "start", offset_minutes: null, evidence: "photo", criterion: null });
    if (/\bhalfway\b|\bmidway\b|\bprogress\b/i.test(rest)) checkpoints.push({ at: "halfway", offset_minutes: null, evidence: "any", criterion: null });
    if (/\bbrowser\b|\blaptop\b|\bdevice\b/i.test(rest)) checkpoints.push({ at: "halfway", offset_minutes: null, evidence: "device", criterion: null });
    if (/\bat the end\b|\bend check\b/i.test(rest)) checkpoints.push({ at: "end", offset_minutes: null, evidence: "any", criterion: null });
    const dayOf = (sp: TimeSpec | null): TimeSpec | null => {
      if (!sp) return null;
      const d = [m![2]!, m![3]!].map((x) => parseTimePhrase(x, year)?.spec).find((x) => x && x.day_kind !== "none");
      return d ? { ...sp, day_kind: d.day_kind, weekday: d.weekday, weekday_qualifier: d.weekday_qualifier, date: d.date } : sp;
    };
    const start = dayOf(parseTimePhrase(`at ${m[2]!.replace(/^at\s+/i, "")}`, year)?.spec ?? null);
    const end = dayOf(parseTimePhrase(`at ${m[3]!.replace(/^at\s+/i, "")}`, year)?.spec ?? null);
    return { type: "accountability_start", task_ref: m[1]!.trim(), start, end, within_minutes: null, checkpoints: checkpoints.slice(0, 4), allow_call: /\bcall\b/i.test(rest) };
  }
  m = /^check on me once\s+(?:during|in|within)\s+the\s+next\s+(hour|(\d+)\s*min(?:ute)?s?|(\d+)\s*hours?)\b/i.exec(c);
  if (m) {
    const minutes = m[1] === "hour" ? 60 : m[2] ? Number(m[2]) : Number(m[3]) * 60;
    return { type: "accountability_start", task_ref: null, start: null, end: null, within_minutes: Math.max(5, Math.min(480, minutes)), checkpoints: [], allow_call: false };
  }
  m = /^(?:set (?:up )?a\s+)?morning routine\s+(?:at|for)\s+(.+?)(?:[;,]\s*(.+))?$/i.exec(c);
  if (m) {
    const p = parseTimePhrase(`at ${m[1]!.replace(/\b(on )?(weekdays|every day|daily)\b/i, "").trim()}`, year);
    const daily = /\b(every day|daily)\b/i.test(c);
    const rest = m[2] ?? "";
    const act = /(?:then|first activity|start with)\s+([a-z ]+?)(?:[;,]|$)/i.exec(rest) ?? /^([a-z ]+?)\s+first\b/i.exec(rest);
    return {
      type: "morning_routine",
      wake: p?.spec ?? { ...parseTimePhrase("at 7 am", year)!.spec, hour: null },
      recurrence: daily ? { freq: "daily", weekdays: null, interval: null, count: null, until_date: null } : WEEKDAYS,
      first_activity: act ? act[1]!.trim() : null,
      device_check: /\b(laptop|browser|computer|device)\b/i.test(rest),
    };
  }
  return null;
}
