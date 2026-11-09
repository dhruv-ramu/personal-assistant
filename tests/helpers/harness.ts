import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env as baseEnv } from "cloudflare:workers";
import { buildContext, type AppContext, type JobDispatcher } from "../../src/context";
import { Db } from "../../src/db/db";
import { DAY, FixedClock, HOUR, MINUTE } from "../../src/domain/time";
import type { Env } from "../../src/env";
import { createApp } from "../../src/http/router";
import type { Fetcher } from "../../src/providers/http";
import type { Planner } from "../../src/providers/types";
import { connectSimulatedCalendar } from "../../src/services/calendar-connection";
import { processJob } from "../../src/services/queue-consumer";
import { runTick } from "../../src/services/scheduler";
import { drainJobs, simCall, simDeliveryCallback, simSendFromOwner, type CallScript } from "../../src/services/simulator";
import { updateSettings } from "../../src/services/settings";

/** Frozen acceptance/test instant: Sunday 2026-11-08 10:00 PT (PST, UTC-8) = 18:00Z. */
export const T0 = Date.parse("2026-11-08T18:00:00Z");

export class CollectingDispatcher implements JobDispatcher {
  published: string[] = [];
  fail = false;
  async publish(ids: string[]): Promise<void> {
    if (this.fail) throw new Error("queue unavailable (simulated)");
    this.published.push(...ids);
  }
}

const DATA_TABLES = [
  // Extension tables first (children before parents).
  "evidence_assessments",
  "evidence_submissions",
  "media_objects",
  "upload_tokens",
  "device_events",
  "device_challenges",
  "device_pairing_codes",
  "registered_devices",
  "acc_checkpoints",
  "acc_sessions",
  "acc_policies",
  "email_candidates",
  "info_snapshots",
  "sim_emails",
  "local_media_store",
  "undo_log",
  "suggestion_suppressions",
  "suggestions",
  "task_dependencies",
  "task_meta",
  "secretary_items",
  "retrieval_evidence",
  "semantic_vectors",
  "index_state",
  "deletion_tombstones",
  "memory_events",
  "memory_proposals",
  "extraction_runs",
  "entity_aliases",
  "assertions",
  "entities",
  "source_records",
  "action_executions",
  "plans",
  "conversation_log",
  "reminders",
  "tasks",
  "alarm_occurrences",
  "alarm_schedules",
  "series",
  "calendar_headsups",
  "calendar_events",
  "confirmations",
  "clarifications",
  "provider_callbacks",
  "outbound_effects",
  "inbound_messages",
  "jobs",
  "suppressions",
  "consent_events",
  "audit_log",
  "usage_counters",
  "usage_reservations",
  "ai_requests",
  "admin_sessions",
  "login_attempts",
  "oauth_states",
  "dedupe_tombstones",
  "system_state",
  "sim_messages",
  "sim_calls",
  "sim_calendar_events",
  "sim_calendars",
  "sim_behaviors",
  "sim_provider_log",
];

export async function resetDatabase(d1: D1Database): Promise<void> {
  const db = new Db(d1);
  for (const t of DATA_TABLES) await db.run(`DELETE FROM ${t}`);
  await db.run("DELETE FROM owner_settings");
  await db.run("INSERT INTO owner_settings (id) VALUES (1)");
  await db.run("DELETE FROM conversation_state");
  await db.run("INSERT INTO conversation_state (id) VALUES (1)");
  await db.run("DELETE FROM calendar_connection");
  await db.run("INSERT INTO calendar_connection (id) VALUES (1)");
  await db.run("DELETE FROM ext_settings");
  await db.run("INSERT INTO ext_settings (id) VALUES (1)");
  await db.run("DELETE FROM email_connection");
  await db.run("INSERT INTO email_connection (id) VALUES (1)");
}

export interface HarnessOptions {
  start?: number;
  env?: Partial<Env>;
  planner?: Planner;
  fetcher?: Fetcher;
  db?: D1Database;
  reset?: boolean;
  connectCalendar?: boolean;
}

export type Harness = Awaited<ReturnType<typeof makeHarness>>;

export async function makeHarness(opts: HarnessOptions = {}) {
  const clock = new FixedClock(opts.start ?? T0);
  const dispatcher = new CollectingDispatcher();
  const env = { ...(baseEnv as unknown as Env), ...(opts.env ?? {}), ...(opts.db ? { DB: opts.db } : {}) } as Env;
  if (opts.reset !== false) await resetDatabase(env.DB);
  const overrides = () => ({ clock, dispatcher, planner: opts.planner, fetcher: opts.fetcher });
  const app = createApp(overrides);
  const ctx: AppContext = await buildContext(env, overrides());

  const fetchApp = async (req: Request): Promise<Response> => {
    const ec = createExecutionContext();
    const res = await app.fetch(req, env, ec);
    await waitOnExecutionContext(ec);
    return res;
  };

  if (opts.connectCalendar !== false) await connectSimulatedCalendar(ctx);

  const h = {
    env,
    ctx,
    clock,
    dispatcher,
    app,
    fetchApp,
    db: ctx.db,
    /** Owner texts Della through the real signed webhook, then queued work runs. */
    async send(text: string, o: { sid?: string; drain?: boolean; numMedia?: number } = {}) {
      const r = await simSendFromOwner(ctx, fetchApp, text, { messageSid: o.sid, numMedia: o.numMedia });
      if (o.drain !== false) await h.drain();
      return r;
    },
    async drain() {
      return drainJobs(ctx, 100);
    },
    async tick() {
      return runTick(ctx, clock.now());
    },
    /** Advances the frozen clock minute by minute (Cron semantics), ticking and draining each minute. */
    async advance(ms: number, stepMs = MINUTE) {
      const end = clock.now() + ms;
      while (clock.now() < end) {
        clock.set(Math.min(end, clock.now() + stepMs));
        await h.tick();
        await h.drain();
      }
    },
    async advanceTo(iso: string | number, stepMs = MINUTE) {
      const target = typeof iso === "number" ? iso : Date.parse(iso);
      await h.advance(Math.max(0, target - clock.now()), stepMs);
    },
    /** Jump without running intermediate ticks (simulates an outage). */
    jump(ms: number) {
      clock.set(clock.now() + ms);
    },
    async outbox(): Promise<string[]> {
      const rows = await ctx.db.all<{ body: string }>("SELECT body FROM sim_messages WHERE direction = 'to_owner' ORDER BY created_at, rowid");
      return rows.map((r) => r.body);
    },
    async outboxSince(index: number): Promise<string[]> {
      return (await h.outbox()).slice(index);
    },
    async lastReply(): Promise<string> {
      const all = await h.outbox();
      return all[all.length - 1] ?? "";
    },
    async calls() {
      return ctx.db.all<{ sid: string; status: string; created_at: number }>("SELECT sid, status, created_at FROM sim_calls ORDER BY created_at, rowid");
    },
    async call(sid: string, script: CallScript) {
      const t = await simCall(ctx, fetchApp, sid, script);
      await h.drain();
      return t;
    },
    async deliver(sid: string, status: "delivered" | "failed" | "sent" = "delivered") {
      return simDeliveryCallback(ctx, fetchApp, sid, status);
    },
    async processJob(id: string) {
      return processJob(ctx, id);
    },
    async settings(patch: Record<string, string | number | null>) {
      await updateSettings(ctx.db, patch, clock.now());
    },
    async count(sql: string, ...params: Array<string | number>): Promise<number> {
      return (await ctx.db.first<{ n: number }>(sql, ...params))?.n ?? 0;
    },
    shortIdFrom(text: string): string {
      const m = /\[(T[2-9A-HJ-NP-Z]{3})\]/.exec(text);
      if (!m) throw new Error(`No task ID in: ${text}`);
      return m[1]!;
    },
    nonceFrom(text: string): string {
      const m = /\bYES (C[2-9A-HJ-NP-Z]{3})\b/.exec(text);
      if (!m) throw new Error(`No confirmation code in: ${text}`);
      return m[1]!;
    },
  };
  return h;
}

export { DAY, HOUR, MINUTE };
