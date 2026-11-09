import type { AppContext } from "../context";
import { formatDate } from "../domain/time";
import { createSuggestion } from "./suggestions";
import { listItems, updateItem } from "./secretary";
import { labelTokens } from "./store";

/**
 * Explicit, deterministic triggers. Future-self messages surface only when a recorded decision
 * contains every key word of the owner's trigger phrase (or on their date). The message is shown
 * verbatim and is never executed as an instruction.
 */
const TRIGGER_STOPWORDS = new Set([
  "before",
  "after",
  "when",
  "if",
  "i",
  "another",
  "any",
  "new",
  "decide",
  "decided",
  "deciding",
  "decision",
  "about",
  "the",
  "my",
  "whether",
  "choose",
  "make",
  "making",
  "on",
  "to",
]);

export async function surfaceFutureMessagesForDecision(ctx: AppContext, decisionText: string, tz: string): Promise<string[]> {
  const words = new Set(labelTokens(decisionText));
  const out: string[] = [];
  for (const m of await listItems(ctx, "future_message", { status: ["open"] })) {
    if (m.trigger_kind !== "decision_keyword" || typeof m.data.trigger !== "string") continue;
    const keys = labelTokens(m.data.trigger).filter((t) => !TRIGGER_STOPWORDS.has(t) && t.length > 2);
    if (keys.length === 0 || !keys.every((k) => words.has(k))) continue;
    await updateItem(ctx, m, { status: "delivered", resolved: true });
    out.push(`Message from your past self (${formatDate(Number(m.data.writtenAt), tz)}): "${m.title}" (shown because of this decision; nothing was changed).`);
  }
  return out;
}

/** Ideas parked "until <condition>": a keyword condition matched by a later message resurfaces once. */
export async function triggerIdeasForText(ctx: AppContext, text: string): Promise<string[]> {
  const words = new Set(labelTokens(text));
  for (const idea of await listItems(ctx, "idea", { status: ["open"] })) {
    if (idea.trigger_kind !== "keyword" || typeof idea.data.condition !== "string") continue;
    const keys = labelTokens(idea.data.condition).filter((t) => t.length > 3 && !["when", "after", "once", "until", "finish", "done"].includes(t));
    if (keys.length && keys.every((k) => words.has(k))) await resurfaceIdea(ctx, idea.id, idea.title, String(idea.data.condition));
  }
  return [];
}

export async function onTaskCompleted(ctx: AppContext, taskId: string): Promise<void> {
  for (const idea of await listItems(ctx, "idea", { status: ["open"] })) {
    if (idea.trigger_kind === "task_complete" && idea.task_id === taskId) await resurfaceIdea(ctx, idea.id, idea.title, String(idea.data.condition ?? "its prerequisite"));
  }
}

async function resurfaceIdea(ctx: AppContext, id: string, title: string, condition: string): Promise<void> {
  await createSuggestion(ctx, {
    kind: "idea_resurface",
    dedupeKey: `idea:${id}`,
    suppressionKey: `idea:${id}`,
    text: `Parked idea ready to revisit (${condition} happened): ${title}`,
    evidence: [id],
    action: null,
    delivery: "digest",
    ttlMs: 7 * 86_400_000,
  });
}
