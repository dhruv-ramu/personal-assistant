/**
 * Accountability session state machine (pure). A session's state is independent of its task's
 * status: completing a check-in never completes the task, and a missed check is an observed
 * missed check — not an inference about the owner. Terminal: completed, canceled, expired,
 * needs_attention.
 */
export type SessionState = "scheduled" | "awaiting_start" | "active" | "awaiting_checkpoint" | "paused" | "completed" | "canceled" | "expired" | "needs_attention";
export type SessionEvent = "arm" | "start" | "request" | "resolve" | "pause" | "resume" | "finish" | "cancel" | "expire" | "attention";

const T: Record<SessionState, Partial<Record<SessionEvent, SessionState>>> = {
  scheduled: { arm: "awaiting_start", start: "active", request: "awaiting_checkpoint", cancel: "canceled", expire: "expired", pause: "paused" },
  awaiting_start: { start: "active", request: "awaiting_checkpoint", cancel: "canceled", expire: "expired", pause: "paused", attention: "needs_attention" },
  active: { request: "awaiting_checkpoint", pause: "paused", finish: "completed", cancel: "canceled", attention: "needs_attention", resolve: "active" },
  awaiting_checkpoint: { resolve: "active", request: "awaiting_checkpoint", pause: "paused", finish: "completed", cancel: "canceled", attention: "needs_attention" },
  paused: { resume: "active", cancel: "canceled", finish: "completed", expire: "expired" },
  completed: {},
  canceled: {},
  expired: {},
  needs_attention: { cancel: "canceled" },
};

export const TERMINAL: ReadonlySet<SessionState> = new Set(["completed", "canceled", "expired", "needs_attention"]);

export function transition(state: SessionState, event: SessionEvent): SessionState | null {
  return T[state][event] ?? null;
}

export type CheckpointState = "pending" | "requested" | "satisfied" | "missed" | "unverifiable" | "waived" | "canceled" | "needs_clarification";
export const CHECKPOINT_OPEN: ReadonlySet<CheckpointState> = new Set(["pending", "requested", "needs_clarification"]);
