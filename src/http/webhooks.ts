import type { Context } from "hono";
import type { AppContext } from "../context";
import { voiceGather, voiceInstructions, voiceStatus } from "../domain/alarms";
import { log } from "../observability/log";
import { WebhookVerificationError } from "../providers/types";
import { safeErrorMessage } from "../security/redaction";
import { applySmsStatus } from "../services/effects";
import { ingestInbound } from "../services/inbound";
import { dispatchJobs } from "../services/jobs";
import type { AppEnvBindings } from "./types";

function verificationFailure(err: unknown): Response {
  if (err instanceof WebhookVerificationError) {
    log("warn", "webhook_rejected", { reason: err.message, status: err.status });
    return new Response("Forbidden", { status: err.status });
  }
  throw err;
}

/**
 * Inbound SMS: verify -> durably store message + job (one transaction) -> acknowledge.
 * Storage failure returns 503 so the provider can retry; we never acknowledge dropped work.
 * Queue dispatch is attempted via waitUntil for responsiveness; Cron recovers it if that fails.
 */
export async function inboundSms(c: Context<AppEnvBindings>): Promise<Response> {
  const ctx: AppContext = c.get("app");
  let verified;
  try {
    verified = await ctx.sms.verifyInbound(c.req.raw);
  } catch (err) {
    return verificationFailure(err);
  }
  let result;
  try {
    result = await ingestInbound(ctx, verified);
  } catch (err) {
    log("error", "inbound_storage_failed", { error: safeErrorMessage(err) });
    return new Response("Temporarily unavailable", { status: 503 });
  }
  if (result.status === "stored" && result.jobId) {
    const jobId = result.jobId;
    c.executionCtx.waitUntil(dispatchJobs(ctx, [jobId]).catch((err) => log("warn", "inbound_dispatch_failed", { error: safeErrorMessage(err) })));
  }
  return ctx.sms.inboundAck();
}

export async function smsStatus(c: Context<AppEnvBindings>): Promise<Response> {
  const ctx: AppContext = c.get("app");
  let status;
  try {
    status = await ctx.sms.verifyStatusCallback(c.req.raw);
  } catch (err) {
    return verificationFailure(err);
  }
  try {
    const outcome = await applySmsStatus(ctx, status);
    return new Response(outcome, { status: 200 });
  } catch (err) {
    log("error", "sms_status_failed", { error: safeErrorMessage(err) });
    return new Response("Temporarily unavailable", { status: 503 });
  }
}

export async function voiceInstructionsRoute(c: Context<AppEnvBindings>): Promise<Response> {
  const ctx: AppContext = c.get("app");
  let req;
  try {
    req = await ctx.voice.verifyVoiceRequest(c.req.raw, "instructions");
  } catch (err) {
    return verificationFailure(err);
  }
  return ctx.voice.render(await voiceInstructions(ctx, req));
}

export async function voiceGatherRoute(c: Context<AppEnvBindings>): Promise<Response> {
  const ctx: AppContext = c.get("app");
  let req;
  try {
    req = await ctx.voice.verifyVoiceRequest(c.req.raw, "gather");
  } catch (err) {
    return verificationFailure(err);
  }
  return ctx.voice.render(await voiceGather(ctx, req));
}

export async function voiceStatusRoute(c: Context<AppEnvBindings>): Promise<Response> {
  const ctx: AppContext = c.get("app");
  let req;
  try {
    req = await ctx.voice.verifyVoiceRequest(c.req.raw, "status");
  } catch (err) {
    return verificationFailure(err);
  }
  try {
    return new Response(await voiceStatus(ctx, req), { status: 200 });
  } catch (err) {
    log("error", "voice_status_failed", { error: safeErrorMessage(err) });
    return new Response("Temporarily unavailable", { status: 503 });
  }
}
