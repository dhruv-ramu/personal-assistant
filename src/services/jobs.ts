import type { AppContext } from "../context";
import { log } from "../observability/log";
import { newId, randomToken } from "../security/crypto";
import { safeErrorMessage } from "../security/redaction";
import { MINUTE } from "../domain/time";

export type JobKind =
  | "process_inbound"
  | "deliver_effect"
  | "send_reminder"
  | "alarm_call"
  | "calendar_sync"
  | "calendar_headsup"
  | "morning_brief"
  | "missed_summary"
  | "retention_sweep"
  | "secretary_check"
  | "index_sync"
  | "suggestion_digest"
  | "acc_checkpoint"
  | "acc_session_end"
  | "evidence_assess"
  | "meeting_prep"
  | "post_meeting"
  | "evening_reset";

export type JobStatus = "pending" | "running" | "succeeded" | "skipped" | "canceled" | "failed" | "blocked" | "dead";

export interface JobRow {
  id: string;
  logical_key: string;
  kind: JobKind;
  entity_id: string | null;
  entity_generation: number | null;
  seq: number | null;
  payload_json: string;
  status: JobStatus;
  due_at: number;
  intended_at: number;
  expires_at: number | null;
  attempts: number;
  max_attempts: number;
  next_dispatch_at: number | null;
  dispatch_count: number;
  lease_token: string | null;
  lease_owner: string | null;
  lease_expires_at: number | null;
  last_error: string | null;
  result_json: string | null;
  created_at: number;
  updated_at: number;
  finished_at: number | null;
}

export type JobOutcome =
  | { status: "succeeded" | "skipped" | "canceled"; result?: Record<string, unknown> }
  /** Retry with backoff; counts as an attempt. */
  | { status: "retry"; error: string; delayMs?: number }
  /** Move the due time without consuming an attempt (quiet-hours deferral, sequencing wait). */
  | { status: "reschedule"; dueAt: number; reason: string }
  /** Actionable block (bad credentials, policy, registration) — no automatic retry. */
  | { status: "blocked"; error: string }
  | { status: "failed"; error: string };

/** Lease must exceed the bounded total work time of any handler (AI 25s + provider calls). */
export const LEASE_MS = 5 * MINUTE;
/** How long a dispatch reservation suppresses republishing the same pending job. */
export const DISPATCH_RESERVATION_MS = 2 * MINUTE;
export const TICK_BATCH_LIMIT = 50;

export interface NewJob {
  logicalKey: string;
  kind: JobKind;
  entityId?: string | null;
  entityGeneration?: number | null;
  seq?: number | null;
  dueAt: number;
  intendedAt?: number;
  expiresAt?: number | null;
  maxAttempts?: number;
  payload?: Record<string, unknown>;
}

/** Prepared INSERT for use inside an atomic batch. Duplicate logical keys are ignored. */
export function jobInsertStatement(ctx: AppContext, job: NewJob, id = newId("job")): D1PreparedStatement {
  const now = ctx.clock.now();
  return ctx.db.prepare(
    `INSERT INTO jobs (id, logical_key, kind, entity_id, entity_generation, seq, payload_json, status, due_at, intended_at, expires_at, max_attempts, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)
     ON CONFLICT (logical_key) DO NOTHING`,
    id,
    job.logicalKey,
    job.kind,
    job.entityId ?? null,
    job.entityGeneration ?? null,
    job.seq ?? null,
    JSON.stringify(job.payload ?? {}),
    job.dueAt,
    job.intendedAt ?? job.dueAt,
    job.expiresAt ?? null,
    job.maxAttempts ?? 5,
    now,
    now,
  );
}

export async function createJob(ctx: AppContext, job: NewJob): Promise<{ id: string; created: boolean }> {
  const id = newId("job");
  const [changes] = await ctx.db.batch([jobInsertStatement(ctx, job, id)]);
  if (changes === 1) return { id, created: true };
  const existing = await ctx.db.first<{ id: string }>("SELECT id FROM jobs WHERE logical_key = ?", job.logicalKey);
  return { id: existing!.id, created: false };
}

export async function getJob(ctx: AppContext, id: string): Promise<JobRow | null> {
  return ctx.db.first<JobRow>("SELECT * FROM jobs WHERE id = ?", id);
}

export interface Claim {
  job: JobRow;
  token: string;
  /** True when this claim took over an expired lease from a worker that may have crashed mid-run. */
  recovered: boolean;
}

/**
 * Conditional claim with a fresh fencing token. Only one claimant can win: the UPDATE matches a
 * pending job or a running job whose lease expired, and `meta.changes` tells us whether we won.
 */
export async function claimJob(ctx: AppContext, jobId: string, owner: string): Promise<Claim | null> {
  const now = ctx.clock.now();
  const before = await ctx.db.first<{ status: string }>("SELECT status FROM jobs WHERE id = ?", jobId);
  if (!before) return null;
  const token = randomToken(16);
  const changes = await ctx.db.run(
    `UPDATE jobs SET status = 'running', lease_token = ?, lease_owner = ?, lease_expires_at = ?, attempts = attempts + 1, updated_at = ?
     WHERE id = ? AND due_at <= ? AND (status = 'pending' OR (status = 'running' AND lease_expires_at < ?))`,
    token,
    owner,
    now + LEASE_MS,
    now,
    jobId,
    now,
    now,
  );
  if (changes !== 1) return null;
  const job = await ctx.db.first<JobRow>("SELECT * FROM jobs WHERE id = ? AND lease_token = ?", jobId, token);
  if (!job) return null;
  return { job, token, recovered: before.status === "running" };
}

function backoffMs(attempts: number): number {
  const base = Math.min(30 * MINUTE, 30_000 * 2 ** Math.max(0, attempts - 1));
  const jitter = base * (0.8 + Math.random() * 0.4);
  return Math.round(jitter);
}

/** Completes a claim. Every write is fenced on the lease token; a stale worker's write is a no-op. */
export async function finishJob(ctx: AppContext, claim: Claim, outcome: JobOutcome): Promise<boolean> {
  const now = ctx.clock.now();
  const { job, token } = claim;
  let changes = 0;
  switch (outcome.status) {
    case "succeeded":
    case "skipped":
    case "canceled":
      changes = await ctx.db.run(
        "UPDATE jobs SET status = ?, result_json = ?, lease_token = NULL, lease_expires_at = NULL, finished_at = ?, updated_at = ? WHERE id = ? AND lease_token = ?",
        outcome.status,
        JSON.stringify(outcome.result ?? {}),
        now,
        now,
        job.id,
        token,
      );
      break;
    case "retry": {
      const exhausted = job.attempts >= job.max_attempts;
      const nextDue = now + (outcome.delayMs ?? backoffMs(job.attempts));
      const expired = job.expires_at !== null && nextDue > job.expires_at;
      changes = await ctx.db.run(
        `UPDATE jobs SET status = ?, due_at = ?, next_dispatch_at = NULL, last_error = ?, lease_token = NULL, lease_expires_at = NULL, updated_at = ?,
         finished_at = CASE WHEN ? = 'pending' THEN NULL ELSE ? END WHERE id = ? AND lease_token = ?`,
        exhausted || expired ? "failed" : "pending",
        nextDue,
        outcome.error.slice(0, 500),
        now,
        exhausted || expired ? "failed" : "pending",
        now,
        job.id,
        token,
      );
      break;
    }
    case "reschedule":
      changes = await ctx.db.run(
        "UPDATE jobs SET status = 'pending', due_at = ?, attempts = MAX(0, attempts - 1), next_dispatch_at = NULL, last_error = ?, lease_token = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ? AND lease_token = ?",
        outcome.dueAt,
        outcome.reason.slice(0, 500),
        now,
        job.id,
        token,
      );
      break;
    case "blocked":
    case "failed":
      changes = await ctx.db.run(
        "UPDATE jobs SET status = ?, last_error = ?, lease_token = NULL, lease_expires_at = NULL, finished_at = ?, updated_at = ? WHERE id = ? AND lease_token = ?",
        outcome.status,
        outcome.error.slice(0, 500),
        now,
        now,
        job.id,
        token,
      );
      break;
  }
  if (changes !== 1) {
    log("warn", "job_finish_lost_lease", { jobId: job.id, kind: job.kind, outcome: outcome.status });
    return false;
  }
  return true;
}

/** Cancels pending jobs for an entity (generation bump makes running jobs stale too). */
export async function cancelPendingJobs(ctx: AppContext, entityId: string, reason: string, kinds?: JobKind[]): Promise<number> {
  const now = ctx.clock.now();
  if (kinds && kinds.length > 0) {
    const placeholders = kinds.map(() => "?").join(",");
    return ctx.db.run(
      `UPDATE jobs SET status = 'canceled', last_error = ?, finished_at = ?, updated_at = ? WHERE entity_id = ? AND status = 'pending' AND kind IN (${placeholders})`,
      reason,
      now,
      now,
      entityId,
      ...kinds,
    );
  }
  return ctx.db.run("UPDATE jobs SET status = 'canceled', last_error = ?, finished_at = ?, updated_at = ? WHERE entity_id = ? AND status = 'pending'", reason, now, now, entityId);
}

export function cancelJobsStatement(ctx: AppContext, entityId: string, reason: string): D1PreparedStatement {
  const now = ctx.clock.now();
  return ctx.db.prepare(
    "UPDATE jobs SET status = 'canceled', last_error = ?, finished_at = ?, updated_at = ? WHERE entity_id = ? AND status = 'pending'",
    reason,
    now,
    now,
    entityId,
  );
}

/**
 * Reserves jobs for dispatch, then publishes their IDs. A reservation (`next_dispatch_at`) stops
 * every tick from republishing the same pending job. If publishing fails or the Worker dies before
 * publishing, the reservation simply expires and the next tick retries. Duplicate deliveries are
 * harmless because claims are conditional.
 */
export async function dispatchJobs(ctx: AppContext, jobIds: string[]): Promise<{ published: number; error?: string }> {
  if (jobIds.length === 0) return { published: 0 };
  const now = ctx.clock.now();
  const reserved: string[] = [];
  for (const id of jobIds) {
    const changes = await ctx.db.run(
      `UPDATE jobs SET next_dispatch_at = ?, dispatch_count = dispatch_count + 1, updated_at = ?
       WHERE id = ? AND (status = 'pending' OR (status = 'running' AND lease_expires_at < ?)) AND (next_dispatch_at IS NULL OR next_dispatch_at <= ?)`,
      now + DISPATCH_RESERVATION_MS,
      now,
      id,
      now,
      now,
    );
    if (changes === 1) reserved.push(id);
  }
  if (reserved.length === 0) return { published: 0 };
  try {
    await ctx.dispatcher.publish(reserved);
    return { published: reserved.length };
  } catch (err) {
    log("warn", "queue_publish_failed", { count: reserved.length, error: safeErrorMessage(err) });
    return { published: 0, error: safeErrorMessage(err) };
  }
}

/**
 * Due jobs. The tick respects dispatch reservations; an in-process consumer (simulator drain)
 * passes `includeReserved` because it is the consumer the reservation was waiting for.
 */
export async function findDispatchableJobs(ctx: AppContext, limit = TICK_BATCH_LIMIT, opts: { includeReserved?: boolean } = {}): Promise<string[]> {
  const now = ctx.clock.now();
  const reservation = opts.includeReserved ? "" : "AND (next_dispatch_at IS NULL OR next_dispatch_at <= ?)";
  const params: number[] = opts.includeReserved ? [now, now, limit] : [now, now, now, limit];
  const rows = await ctx.db.all<{ id: string }>(
    `SELECT id FROM jobs
     WHERE ((status = 'pending' AND due_at <= ?) OR (status = 'running' AND lease_expires_at < ?))
       ${reservation}
     ORDER BY CASE WHEN kind = 'process_inbound' THEN 0 ELSE 1 END, COALESCE(seq, 0), due_at
     LIMIT ?`,
    ...params,
  );
  return rows.map((r) => r.id);
}

export function parsePayload<T>(job: JobRow): T {
  try {
    return JSON.parse(job.payload_json) as T;
  } catch {
    return {} as T;
  }
}
