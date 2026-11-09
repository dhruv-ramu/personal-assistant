import type { AppContext } from "../context";
import { FixedClock, SimClock } from "../domain/time";
import { SIM_SIGNATURE_HEADER, signSimRequest, simSid } from "../providers/simulated/common";
import { SIM_DELLA_NUMBER } from "../providers/simulated/sms";
import type { FormParams } from "../providers/twilio/signature";
import { newId } from "../security/crypto";
import { classifyKeyword } from "./commands";
import { findDispatchableJobs } from "./jobs";
import { processJob } from "./queue-consumer";
import { suppressionState } from "./readiness";
import { effectiveOwnerPhone } from "./inbound";
import { setSystemState } from "./settings";

/**
 * Simulator driver: plays the role of the phone network and provider. Every interaction goes
 * through Della's real HTTP webhook routes with signed requests, so the simulator exercises the
 * same ingress, persistence, jobs, and callbacks as production. Disabled in production.
 */
export type AppFetch = (req: Request) => Promise<Response>;

function form(entries: Record<string, string | string[]>): FormParams {
  const m: FormParams = new Map();
  for (const [k, v] of Object.entries(entries)) m.set(k, Array.isArray(v) ? v : [v]);
  return m;
}

function encode(params: FormParams): string {
  const u = new URLSearchParams();
  for (const [k, vs] of params) for (const v of vs) u.append(k, v);
  return u.toString();
}

export async function signedPost(ctx: AppContext, fetchFn: AppFetch, base: string, pathAndQuery: string, params: FormParams): Promise<Response> {
  const url = `${base}${pathAndQuery}`;
  const signature = await signSimRequest(ctx.config.simWebhookSecret, url, params);
  return fetchFn(
    new Request(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", [SIM_SIGNATURE_HEADER]: signature },
      body: encode(params),
    }),
  );
}

export function simBase(ctx: AppContext, requestOrigin?: string): string {
  return ctx.config.publicBaseUrl ?? requestOrigin ?? ctx.baseUrl;
}

export async function simSendFromOwner(
  ctx: AppContext,
  fetchFn: AppFetch,
  text: string,
  opts: { base?: string; messageSid?: string; numMedia?: number; from?: string; mediaKeys?: string[] } = {},
): Promise<{ status: number; messageSid: string; body: string }> {
  const messageSid = opts.messageSid ?? simSid("SM");
  const optedOut = (await suppressionState(ctx, "sms")) === "opted_out";
  const kw = classifyKeyword(text, optedOut);
  const params: Record<string, string> = {
    AccountSid: "ACsimulated",
    MessageSid: messageSid,
    From: opts.from ?? effectiveOwnerPhone(ctx) ?? "+15550100001",
    To: SIM_DELLA_NUMBER,
    Body: text,
    NumMedia: String(opts.mediaKeys?.length ?? opts.numMedia ?? 0),
  };
  (opts.mediaKeys ?? []).forEach((k, i) => {
    params[`MediaUrl${i}`] = `sim-media:${k}`;
    params[`MediaContentType${i}`] = "image/jpeg";
  });
  // Emulates a provider's advanced opt-out handling, which tags keyword messages.
  if (kw !== "none") params.OptOutType = kw.toUpperCase();
  const res = await signedPost(ctx, fetchFn, opts.base ?? simBase(ctx), "/webhooks/sms/inbound", form(params));
  const body = await res.text();
  if (res.status === 200) {
    await ctx.db.run(
      "INSERT OR IGNORE INTO sim_messages (id, direction, body, provider_sid, status, created_at) VALUES (?, 'from_owner', ?, ?, 'received', ?)",
      `simmsg_${messageSid}`,
      text,
      messageSid,
      ctx.clock.now(),
    );
    if (kw === "stop" || kw === "start" || kw === "help") {
      const auto =
        kw === "stop"
          ? "[Provider auto-reply] You have successfully been unsubscribed. You will not receive any more messages from this number. Reply START to resubscribe."
          : kw === "start"
            ? "[Provider auto-reply] You have successfully been re-subscribed to messages from this number. Reply HELP for help. Reply STOP to unsubscribe."
            : "[Provider auto-reply] Reply STOP to unsubscribe. Msg&Data Rates May Apply.";
      await ctx.db.run("INSERT INTO sim_messages (id, direction, body, status, created_at) VALUES (?, 'provider_auto', ?, 'sent', ?)", newId("simmsg"), auto, ctx.clock.now());
    }
  }
  return { status: res.status, messageSid, body };
}

export async function simDeliveryCallback(
  ctx: AppContext,
  fetchFn: AppFetch,
  providerSid: string,
  status: "sent" | "delivered" | "failed" | "undelivered",
  opts: { base?: string; errorCode?: string } = {},
): Promise<number> {
  const msg = await ctx.db.first<{ status_callback_url: string | null }>("SELECT status_callback_url FROM sim_messages WHERE provider_sid = ?", providerSid);
  if (!msg?.status_callback_url) return 404;
  const u = new URL(msg.status_callback_url);
  const params: Record<string, string> = { AccountSid: "ACsimulated", MessageSid: providerSid, MessageStatus: status, To: effectiveOwnerPhone(ctx) ?? "", From: SIM_DELLA_NUMBER };
  if (opts.errorCode) params.ErrorCode = opts.errorCode;
  const res = await signedPost(ctx, fetchFn, opts.base ?? simBase(ctx), `${u.pathname}${u.search}`, form(params));
  await ctx.db.run("UPDATE sim_messages SET status = ? WHERE provider_sid = ?", status, providerSid);
  return res.status;
}

export type CallScript = "press1" | "press2" | "no_input" | "no_answer" | "busy" | "failed" | "press2_duplicate" | "out_of_order";

export interface CallTranscript {
  instructions?: string;
  gather?: string[];
  statuses: number[];
}

export async function simCall(ctx: AppContext, fetchFn: AppFetch, sid: string, script: CallScript, opts: { base?: string; durationSec?: number } = {}): Promise<CallTranscript> {
  const call = await ctx.db.first<{ instructions_url: string; status_callback_url: string }>("SELECT instructions_url, status_callback_url FROM sim_calls WHERE sid = ?", sid);
  if (!call) throw new Error("No such simulated call");
  const base = opts.base ?? simBase(ctx);
  const owner = effectiveOwnerPhone(ctx) ?? "";
  const common = { AccountSid: "ACsimulated", CallSid: sid, To: owner, From: SIM_DELLA_NUMBER };
  const path = (u: string) => {
    const x = new URL(u);
    return `${x.pathname}${x.search}`;
  };
  const transcript: CallTranscript = { statuses: [] };
  const status = async (s: string, duration?: number) => {
    const p: Record<string, string> = { ...common, CallStatus: s };
    if (duration !== undefined) p.CallDuration = String(duration);
    transcript.statuses.push((await signedPost(ctx, fetchFn, base, path(call.status_callback_url), form(p))).status);
  };
  if (script === "no_answer" || script === "busy" || script === "failed") {
    await status("ringing");
    await status(script === "no_answer" ? "no-answer" : script, 0);
    await ctx.db.run("UPDATE sim_calls SET status = ? WHERE sid = ?", script, sid);
    return transcript;
  }
  await status("in-progress");
  const ins = await signedPost(ctx, fetchFn, base, path(call.instructions_url), form({ ...common, CallStatus: "in-progress" }));
  transcript.instructions = await ins.text();
  const action = /action="([^"]+)"/.exec(transcript.instructions)?.[1]?.replace(/&amp;/g, "&");
  transcript.gather = [];
  const press = async (d: string) => {
    if (!action) return;
    const r = await signedPost(ctx, fetchFn, base, path(action), form({ ...common, CallStatus: "in-progress", Digits: d }));
    transcript.gather!.push(await r.text());
  };
  if (script === "press1") await press("1");
  if (script === "press2") await press("2");
  if (script === "press2_duplicate") {
    await press("2");
    await press("2");
  }
  if (script === "out_of_order") {
    await status("completed", opts.durationSec ?? 20);
    await status("ringing");
  } else {
    await status("completed", opts.durationSec ?? 25);
  }
  await ctx.db.run("UPDATE sim_calls SET status = 'completed' WHERE sid = ?", sid);
  return transcript;
}

/** Runs due jobs inline until none remain (bounded). Used by the simulator and tests. */
export async function drainJobs(ctx: AppContext, maxIterations = 100): Promise<number> {
  let processed = 0;
  for (let i = 0; i < maxIterations; i++) {
    const ids = await findDispatchableJobs(ctx, 20, { includeReserved: true });
    if (ids.length === 0) break;
    let progressed = false;
    for (const id of ids) {
      const r = await processJob(ctx, id);
      if (r.claimed) {
        processed++;
        if (r.outcome?.status !== "reschedule") progressed = true;
      }
    }
    if (!progressed) break;
  }
  return processed;
}

export async function setSimClock(ctx: AppContext, ms: number): Promise<void> {
  if (!ctx.config.simulatorEnabled) throw new Error("Simulator disabled");
  await setSystemState(ctx.db, "sim_now", String(Math.floor(ms)), ms);
  if (ctx.clock instanceof FixedClock || ctx.clock instanceof SimClock) ctx.clock.set(ms);
}

export async function clearSimClock(ctx: AppContext): Promise<void> {
  await ctx.db.run("DELETE FROM system_state WHERE key = 'sim_now'");
  if (ctx.clock instanceof SimClock) ctx.clock.set(null);
}
