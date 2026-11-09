import { configErrors, isFakeNumber } from "../config";
import type { AppContext } from "../context";
import { getSettings, isPaused, type OwnerSettings } from "./settings";

export interface ReadinessCheck {
  name: string;
  ok: boolean;
  detail: string;
  /** technical = credentials/config; approval = provider registration; operator = attestation/consent; policy = local switch. */
  kind: "technical" | "approval" | "operator" | "policy";
}

export interface ChannelReadiness {
  channel: "sms" | "voice" | "calendar" | "ai";
  provider: string;
  mode: "simulated" | "live" | "dry_run" | "blocked";
  ready: boolean;
  checks: ReadinessCheck[];
}

export async function suppressionState(ctx: AppContext, channel: "sms" | "call"): Promise<"active" | "opted_out"> {
  const row = await ctx.db.first<{ state: "active" | "opted_out" }>("SELECT state FROM suppressions WHERE channel = ?", channel);
  return row?.state ?? "active";
}

/**
 * Production SMS readiness: each item is independent and all must pass. Provider approval
 * (SMS_ELIGIBILITY_CONFIRMED + operator attestation) is separate from technical credential
 * validation. The attestation is operator-confirmed, never independently verified by Della.
 */
export async function smsReadiness(ctx: AppContext, settings?: OwnerSettings): Promise<ChannelReadiness> {
  const s = settings ?? (await getSettings(ctx.db));
  const c = ctx.config;
  const optedOut = (await suppressionState(ctx, "sms")) === "opted_out";
  if (c.providers.sms === "simulated") {
    const checks: ReadinessCheck[] = [
      { name: "provider", ok: true, detail: "Simulated SMS (no real messages are sent).", kind: "technical" },
      { name: "sms_enabled", ok: s.sms_enabled === 1, detail: s.sms_enabled === 1 ? "SMS switch on." : "SMS switch off in settings.", kind: "policy" },
      { name: "not_opted_out", ok: !optedOut, detail: optedOut ? "Owner replied STOP." : "No opt-out.", kind: "policy" },
    ];
    return { channel: "sms", provider: "simulated", mode: "simulated", ready: checks.every((x) => x.ok), checks };
  }
  const errors = configErrors(c, "sms").filter((e) => e.code !== "sms_eligibility_unconfirmed");
  const owner = c.ownerPhone;
  const checks: ReadinessCheck[] = [
    {
      name: "credentials",
      ok: errors.length === 0,
      detail: errors.length === 0 ? "Twilio credentials and sender are syntactically valid." : errors.map((e) => e.message).join(" "),
      kind: "technical",
    },
    {
      name: "sender_configured",
      ok: Boolean(c.twilio.phoneNumber),
      detail: c.twilio.messagingServiceSid
        ? "Messaging Service selects the sender from its pool."
        : c.twilio.phoneNumber
          ? "Sending from TWILIO_PHONE_NUMBER."
          : "No sender configured.",
      kind: "technical",
    },
    {
      name: "destination_allowlisted",
      ok: Boolean(owner) && !isFakeNumber(owner ?? ""),
      detail: owner ? "Only OWNER_PHONE_E164 can receive messages." : "OWNER_PHONE_E164 missing.",
      kind: "technical",
    },
    {
      name: "provider_eligibility",
      ok: c.flags.smsEligibilityConfirmed,
      detail: c.flags.smsEligibilityConfirmed
        ? "SMS_ELIGIBILITY_CONFIRMED=true (set by the operator)."
        : "Provider approval for this personal use case is not confirmed. See docs/PROVIDER_ELIGIBILITY.md.",
      kind: "approval",
    },
    {
      name: "operator_attestation",
      ok: Boolean(s.sms_attestation_provider && s.sms_attestation_date && s.sms_attestation_sender_status === "approved"),
      detail: s.sms_attestation_provider
        ? `Operator-confirmed (not independently verified): ${s.sms_attestation_provider}, ${s.sms_attestation_date ?? "?"}, sender ${s.sms_attestation_sender_status ?? "?"}.`
        : "No operator attestation recorded.",
      kind: "operator",
    },
    {
      name: "owner_consent",
      ok: s.sms_consent_at !== null,
      detail: s.sms_consent_at ? `Consent recorded (${s.sms_consent_source ?? "admin"}).` : "Owner SMS consent not recorded.",
      kind: "operator",
    },
    { name: "live_flag", ok: c.flags.smsLive, detail: c.flags.smsLive ? "SMS_LIVE_ENABLED=true." : "SMS_LIVE_ENABLED=false.", kind: "policy" },
    { name: "dry_run_off", ok: !c.flags.dryRun, detail: c.flags.dryRun ? "DRY_RUN=true suppresses all external effects." : "DRY_RUN=false.", kind: "policy" },
    { name: "sms_enabled", ok: s.sms_enabled === 1, detail: s.sms_enabled === 1 ? "SMS switch on." : "SMS switch off in settings.", kind: "policy" },
    { name: "not_opted_out", ok: !optedOut, detail: optedOut ? "Owner replied STOP." : "No opt-out.", kind: "policy" },
  ];
  const ready = checks.every((x) => x.ok);
  return { channel: "sms", provider: "twilio", mode: ready ? "live" : c.flags.dryRun ? "dry_run" : "blocked", ready, checks };
}

/** Voice readiness is independent of SMS: SMS registration does not authorize calls. */
export async function voiceReadiness(ctx: AppContext, settings?: OwnerSettings): Promise<ChannelReadiness> {
  const s = settings ?? (await getSettings(ctx.db));
  const c = ctx.config;
  const optedOut = (await suppressionState(ctx, "call")) === "opted_out";
  if (c.providers.voice === "simulated") {
    const checks: ReadinessCheck[] = [
      { name: "provider", ok: true, detail: "Simulated voice (no real calls are placed).", kind: "technical" },
      { name: "calls_enabled", ok: s.calls_enabled === 1, detail: s.calls_enabled === 1 ? "Call switch on." : "Call switch off.", kind: "policy" },
      { name: "not_opted_out", ok: !optedOut, detail: optedOut ? "Calls paused after STOP." : "No opt-out.", kind: "policy" },
    ];
    return { channel: "voice", provider: "simulated", mode: "simulated", ready: checks.every((x) => x.ok), checks };
  }
  const errors = configErrors(c, "voice");
  const owner = c.ownerPhone;
  const checks: ReadinessCheck[] = [
    { name: "credentials", ok: errors.length === 0, detail: errors.length === 0 ? "Twilio voice credentials valid." : errors.map((e) => e.message).join(" "), kind: "technical" },
    { name: "destination_allowlisted", ok: Boolean(owner) && !isFakeNumber(owner ?? ""), detail: "Calls go only to OWNER_PHONE_E164.", kind: "technical" },
    {
      name: "owner_consent",
      ok: s.call_consent_at !== null,
      detail: s.call_consent_at ? `Call consent recorded (${s.call_consent_source ?? "admin"}).` : "Owner call consent not recorded.",
      kind: "operator",
    },
    { name: "live_flag", ok: c.flags.voiceLive, detail: c.flags.voiceLive ? "VOICE_LIVE_ENABLED=true." : "VOICE_LIVE_ENABLED=false.", kind: "policy" },
    { name: "dry_run_off", ok: !c.flags.dryRun, detail: c.flags.dryRun ? "DRY_RUN=true." : "DRY_RUN=false.", kind: "policy" },
    { name: "calls_enabled", ok: s.calls_enabled === 1, detail: s.calls_enabled === 1 ? "Call switch on." : "Call switch off.", kind: "policy" },
    { name: "not_opted_out", ok: !optedOut, detail: optedOut ? "Calls paused after STOP." : "No opt-out.", kind: "policy" },
  ];
  const ready = checks.every((x) => x.ok);
  return { channel: "voice", provider: "twilio", mode: ready ? "live" : c.flags.dryRun ? "dry_run" : "blocked", ready, checks };
}

export async function calendarReadiness(ctx: AppContext): Promise<ChannelReadiness> {
  const c = ctx.config;
  const conn = await ctx.db.first<{ status: string; account_email: string | null }>("SELECT status, account_email FROM calendar_connection WHERE id = 1");
  const connected = conn?.status === "connected";
  const sim = c.providers.calendar === "simulated";
  const errors = configErrors(c, "calendar");
  const checks: ReadinessCheck[] = [
    {
      name: "provider",
      ok: sim || errors.length === 0,
      detail: sim ? "Simulated calendar." : errors.length === 0 ? "Google OAuth client configured." : errors.map((e) => e.message).join(" "),
      kind: "technical",
    },
    {
      name: "connected",
      ok: connected,
      detail: connected ? `Connected${conn?.account_email ? ` as ${conn.account_email}` : ""}.` : `Status: ${conn?.status ?? "disconnected"}.`,
      kind: "operator",
    },
  ];
  if (!sim) {
    checks.push({
      name: "writes_enabled",
      ok: c.flags.calendarWrites && !c.flags.dryRun,
      detail: c.flags.dryRun ? "DRY_RUN=true: no calendar writes." : c.flags.calendarWrites ? "CALENDAR_WRITES_ENABLED=true." : "CALENDAR_WRITES_ENABLED=false (read-only).",
      kind: "policy",
    });
  }
  const ready = checks.every((x) => x.ok);
  return { channel: "calendar", provider: c.providers.calendar, mode: sim ? "simulated" : ready ? "live" : c.flags.dryRun ? "dry_run" : "blocked", ready, checks };
}

export function calendarWritesAllowed(ctx: AppContext): boolean {
  if (ctx.config.providers.calendar === "simulated") return true;
  return ctx.config.flags.calendarWrites && !ctx.config.flags.dryRun;
}

export async function aiReadiness(ctx: AppContext): Promise<ChannelReadiness> {
  const c = ctx.config;
  if (c.providers.ai === "simulated") {
    return {
      channel: "ai",
      provider: "simulated",
      mode: "simulated",
      ready: true,
      checks: [{ name: "provider", ok: true, detail: "Rule-based simulated planner (does not demonstrate real model quality).", kind: "technical" }],
    };
  }
  const errors = configErrors(c, "ai");
  const checks: ReadinessCheck[] = [
    { name: "credentials", ok: errors.length === 0, detail: errors.length === 0 ? `Model ${c.openai.model}.` : errors.map((e) => e.message).join(" "), kind: "technical" },
    { name: "live_flag", ok: c.flags.aiLive, detail: c.flags.aiLive ? "AI_LIVE_ENABLED=true." : "AI_LIVE_ENABLED=false.", kind: "policy" },
  ];
  const ready = checks.every((x) => x.ok);
  return { channel: "ai", provider: "openai", mode: ready ? "live" : "blocked", ready, checks };
}

export type SendPurpose = "reply" | "proactive" | "warning";

export type GateResult = { allowed: true } | { allowed: false; reason: string };

/** Final SMS gate, checked immediately before contacting the provider. */
export async function smsGate(ctx: AppContext, purpose: SendPurpose): Promise<GateResult> {
  const s = await getSettings(ctx.db);
  const r = await smsReadiness(ctx, s);
  if (!r.ready) {
    const failed = r.checks.find((c) => !c.ok)!;
    return { allowed: false, reason: failed.name === "not_opted_out" ? "opted_out" : `not_ready:${failed.name}` };
  }
  if (purpose === "proactive" && isPaused(s, ctx.clock.now(), "reminders")) return { allowed: false, reason: "paused" };
  return { allowed: true };
}

export async function voiceGate(ctx: AppContext): Promise<GateResult> {
  const s = await getSettings(ctx.db);
  const r = await voiceReadiness(ctx, s);
  if (!r.ready) {
    const failed = r.checks.find((c) => !c.ok)!;
    return { allowed: false, reason: failed.name === "not_opted_out" ? "opted_out" : `not_ready:${failed.name}` };
  }
  if (isPaused(s, ctx.clock.now(), "calls")) return { allowed: false, reason: "paused" };
  return { allowed: true };
}
