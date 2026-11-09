import type { Action, Interpretation } from "../domain/actions";
import { matchOption, type PendingClarification } from "../domain/conversations";
import { parseTimePhrase } from "../domain/timeparse";
import { parseExtCommand } from "./ext-commands";

/**
 * Deterministic handling for short, exact commands. These never spend an AI request and keep
 * working when the AI provider is down: STATUS, DONE <id>, bare DONE, YES/NO <nonce>, numeric
 * clarification answers, NOT YET, I'M AWAKE, PAUSE/RESUME, SNOOZE <n>, LIST, HELP-like questions.
 * (STOP/START/HELP keywords are handled earlier, at the webhook.)
 */

const STOP_WORDS = new Set(["stop", "stopall", "unsubscribe", "cancel", "end", "quit", "optout", "opt-out", "revoke"]);
const START_WORDS = new Set(["start", "unstop", "subscribe"]);
const HELP_WORDS = new Set(["help", "info"]);

export type Keyword = "stop" | "start" | "help" | "none";

/** Carrier/provider-style keyword classification: the whole message must be the keyword. */
export function classifyKeyword(body: string, optedOut: boolean): Keyword {
  const w = body
    .trim()
    .toLowerCase()
    .replace(/[.!]+$/, "");
  if (STOP_WORDS.has(w)) return "stop";
  if (START_WORDS.has(w) || (optedOut && w === "yes")) return "start";
  if (HELP_WORDS.has(w)) return "help";
  return "none";
}

function interp(intent: string, actions: Action[], refs: string[] = []): Interpretation {
  return { intent, time_expressions: [], references: refs, missing_fields: [], actions, knowledge: [] };
}

const SHORT_TASK = /\[?\b(t[2-9a-hj-km-np-z]{3})\b\]?/i;
const NONCE = /\b(c[2-9a-hj-km-np-z]{3})\b/i;
const COMMAND_VERBS = /^(remind|add|schedule|put|move|reschedule|cancel|delete|call|wake|block|what|when|list|show|pause|resume|set|create|make|book|tell|give|every)\b/i;

export interface DeterministicState {
  clarification: PendingClarification | null;
  pendingConfirmations: number;
  anchorYear: number;
  accountabilityActive?: boolean;
}

export function parseDeterministic(raw: string, state: DeterministicState): Interpretation | null {
  const text = raw.trim();
  const t = text
    .toLowerCase()
    .replace(/[.!?]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return interp("empty", [{ type: "unsupported", reason: "empty_message" }]);

  if (t === "status") return interp("status", [{ type: "get_status" }]);
  if (/^(what can you do|what do you do|commands|menu|how do i use this)$/.test(t)) return interp("help", [{ type: "help" }]);
  if (/^(list|tasks|todo|to do|my tasks|open tasks|list tasks)$/.test(t)) return interp("list", [{ type: "list_tasks", filter: "open" }]);
  if (/^(what have you scheduled|what'?s scheduled|scheduled|upcoming)$/.test(t)) return interp("scheduled", [{ type: "list_tasks", filter: "scheduled" }]);

  // Explicit task-ID commands.
  const idMatch = SHORT_TASK.exec(t);
  if (idMatch) {
    const id = idMatch[1]!.toUpperCase();
    const rest = t.replace(idMatch[0], " ").replace(/\s+/g, " ").trim();
    if (/^(done|complete|completed|finished|did it|mark done)$/.test(rest)) return interp("complete", [{ type: "complete_task", task_ref: id }], [id]);
    if (/^(reopen|undo|undone|not done)$/.test(rest)) return interp("reopen", [{ type: "reopen_task", task_ref: id }], [id]);
    if (/^(cancel|delete|remove|drop)$/.test(rest)) return interp("cancel", [{ type: "cancel_task", task_ref: id, scope: "occurrence" }], [id]);
    if (/^(status|show|details|info)$/.test(rest)) return interp("get", [{ type: "get_task", task_ref: id }], [id]);
    if (/^(stop checking|no more checks|don'?t ask again|stop asking)$/.test(rest)) {
      return interp("checks_off", [{ type: "set_followup_policy", task_ref: id, applies_to: "task", enabled: false, at: null }], [id]);
    }
    const snooze = /^snooze(?: for)? (\d+) ?(m|min|mins|minutes?|h|hr|hrs|hours?)$/.exec(rest);
    if (snooze) {
      const n = Number(snooze[1]) * (snooze[2]!.startsWith("h") ? 60 : 1);
      return interp("snooze", [{ type: "snooze_reminder", task_ref: id, minutes: n, until: null }], [id]);
    }
  }

  // Confirmation replies.
  const nonceMatch = NONCE.exec(t);
  const yes = /^(yes|y|yep|yeah|yup|confirm|confirmed|ok|okay|sure|do it|go ahead)\b/.test(t);
  const no = /^(no|n|nope|nah|don'?t|do not|cancel that|never mind|nevermind)\b/.test(t);
  if (
    (yes || no) &&
    nonceMatch &&
    t
      .replace(nonceMatch[0], "")
      .replace(/^(yes|y|yep|yeah|yup|confirm|confirmed|ok|okay|sure|no|n|nope|nah)/, "")
      .trim() === ""
  ) {
    return interp("confirmation", [{ type: "answer_confirmation", nonce: nonceMatch[1]!.toUpperCase(), accept: yes }]);
  }

  // Answers to an active clarification take precedence for short replies.
  const c = state.clarification;
  if (c && !COMMAND_VERBS.test(t)) {
    if (c.question_type === "followup" || c.question_type === "not_yet") {
      if (/^(not yet|nope not yet|no not yet|not done|no|nope|still working|working on it)$/.test(t))
        return interp("not_yet", [{ type: "answer_clarification", answer: "not yet" }]);
    }
    if (matchOption(c.options, t)) return interp("clarification_answer", [{ type: "answer_clarification", answer: text }]);
    if (c.freeform === "time" && text.length <= 60 && parseTimePhrase(text, state.anchorYear))
      return interp("clarification_answer", [{ type: "answer_clarification", answer: text }]);
    if (c.freeform === "time" && /^\d{1,2}(:\d{2})?\s*(am|pm)?$/i.test(t)) return interp("clarification_answer", [{ type: "answer_clarification", answer: text }]);
  }

  if ((yes || no) && state.pendingConfirmations > 0 && /^(yes|y|yep|yeah|yup|confirm|ok|okay|sure|no|n|nope|nah|do it|go ahead)$/.test(t)) {
    return interp("confirmation", [{ type: "answer_confirmation", nonce: null, accept: yes }]);
  }

  if (/^(done|finished|completed|complete|did it|i did it|i'?m done|all done|done with it|finished it)$/.test(t))
    return interp("complete", [{ type: "complete_task", task_ref: null }]);
  if (/^(not yet|nope not yet|no not yet|not done yet)$/.test(t)) return interp("not_yet", [{ type: "answer_clarification", answer: "not yet" }]);
  if (/^(i'?m awake|im awake|i am awake|awake|i'?m up|im up|i am up|up)$/.test(t)) return interp("awake", [{ type: "acknowledge_awake" }]);
  if (/^(resume|resume reminders|unpause|resume everything|resume all)$/.test(t)) return interp("resume", [{ type: "resume_automation" }]);
  if (/^(pause|pause reminders)$/.test(t)) return interp("pause", [{ type: "pause_automation", scope: "reminders", until: null }]);
  if (/^(pause everything|pause all|pause all automation)$/.test(t)) return interp("pause", [{ type: "pause_automation", scope: "all", until: null }]);
  if (/^(don'?t ask again( about this)?|stop checking|no more checks|stop asking)$/.test(t)) {
    return interp("checks_off", [{ type: "set_followup_policy", task_ref: null, applies_to: "task", enabled: false, at: null }]);
  }
  const snooze = /^snooze(?: (?:it|this|that))?(?: for)?(?: (\d+|an?|one) ?(m|min|mins|minutes?|h|hr|hrs|hours?))?$/.exec(t);
  if (snooze) {
    const qty = snooze[1] ? (/^\d+$/.test(snooze[1]) ? Number(snooze[1]) : 1) : null;
    const minutes = qty === null ? null : qty * (snooze[2]!.startsWith("h") ? 60 : 1);
    return interp("snooze", [{ type: "snooze_reminder", task_ref: null, minutes, until: null }]);
  }
  const ext = parseExtCommand(t, { accountabilityActive: state.accountabilityActive ?? false });
  if (ext) return interp(ext.type, [ext]);
  // Free-text answers: an open accountability check or post-meeting prompt takes the reply as-is.
  if (c && (c.question_type === "acc_check" || c.question_type === "post_meeting") && !COMMAND_VERBS.test(t) && text.length <= 300)
    return interp("clarification_answer", [{ type: "answer_clarification", answer: text }]);
  return null;
}
