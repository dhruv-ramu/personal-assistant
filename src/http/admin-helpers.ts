import type { Context } from "hono";
import type { AppContext } from "../context";
import { formatDateTime } from "../domain/time";
import { ERASE_CONFIRMATION_PHRASE } from "../services/backup";
import { aiReadiness, calendarReadiness, smsReadiness, voiceReadiness } from "../services/readiness";
import { layout, type Html } from "../ui/layout";
import type { AppEnvBindings } from "./types";

/** Shared admin page helpers (one login, one layout, one CSRF policy for every dashboard view). */
export type C = Context<AppEnvBindings>;

export const FLASH: Record<string, string> = {
  saved: "Saved.",
  sent: "Message sent through the simulated provider.",
  tick: "Scheduler tick ran.",
  drained: "Due jobs processed.",
  clock: "Simulator clock updated.",
  done: "Done.",
  retry: "Retry queued. Current state will be rechecked before anything is sent.",
  retry_dup: "Retry queued. The original may also have been delivered (duplicate risk).",
  csrf: "Security check failed; reload the page and try again.",
  invalid: "That input wasn't valid.",
  erased: "All Della data erased. Automation is paused and channels are off.",
  erase_phrase: `Type ${ERASE_CONFIRMATION_PHRASE} exactly to erase.`,
  resumed: "Resumed after restore. Expired occurrences were marked missed/expired, not replayed.",
  connected: "Calendar connected.",
  activated: "Calendar activated.",
  disconnected: "Calendar disconnected and tokens deleted.",
  oauth_error: "Google connection failed. Nothing was saved.",
  wrong_account: "That Google account doesn't match GOOGLE_EXPECTED_ACCOUNT; it was not connected.",
  test_call: "Test call scheduled.",
  not_found: "Not found.",
  conflict: "That item changed; reload and try again.",
  email_connected: "Email connected (read-only).",
  email_disconnected: "Email disconnected and its tokens deleted.",
  revoked: "Device revoked. It must pair again to be used.",
  merged: "Merged. You can split it again from the Items page.",
  split: "Split restored the original entities.",
  forgot: "Deleted, including search entries and cached answers.",
  moved: "Location updated.",
  retracted: "Marked as not there; no new location was assumed.",
  resolved: "Marked resolved.",
  session_canceled: "Session canceled. The task itself is unchanged.",
};

export function flashFrom(c: C): { kind: "ok" | "error"; text: string } | null {
  const ok = c.req.query("ok");
  const err = c.req.query("err");
  if (ok && FLASH[ok]) return { kind: "ok", text: FLASH[ok]! };
  if (err) return { kind: "error", text: FLASH[err] ?? "Something went wrong." };
  return null;
}

export function back(c: C, path: string, kind: "ok" | "err", code: string): Response {
  return c.redirect(`${path}${path.includes("?") ? "&" : "?"}${kind}=${encodeURIComponent(code)}`, 303);
}

export function expectedOrigin(c: C): string {
  const ctx = c.get("app");
  return ctx.config.publicBaseUrl ?? new URL(c.req.url).origin;
}

export function secureCookies(c: C): boolean {
  const env = c.get("app").config.appEnv;
  return env === "staging" || env === "production" || new URL(c.req.url).protocol === "https:";
}

export async function modes(ctx: AppContext): Promise<Array<{ label: string; value: string; live: boolean }>> {
  const [sms, voice, cal, ai] = await Promise.all([smsReadiness(ctx), voiceReadiness(ctx), calendarReadiness(ctx), aiReadiness(ctx)]);
  const out = [sms, voice, cal, ai].map((r) => ({ label: r.channel.toUpperCase(), value: r.mode === "live" ? `LIVE (${r.provider})` : r.mode, live: r.mode === "live" }));
  if (ctx.config.flags.dryRun) out.push({ label: "DRY RUN", value: "on", live: false });
  return out;
}

export async function page(c: C, title: string, active: string, body: Html): Promise<Response> {
  const ctx = c.get("app");
  const s = c.get("session");
  return c.html(layout({ title, active, csrf: s?.csrf_token ?? null, simulatorEnabled: ctx.config.simulatorEnabled, modes: await modes(ctx), flash: flashFrom(c) }, body));
}

export function ts(ms: number | null | undefined, tz: string): string {
  return ms ? formatDateTime(ms, tz) : "—";
}

export async function form(c: C): Promise<Record<string, string>> {
  const body = await c.req.parseBody();
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(body)) if (typeof v === "string") out[k] = v.slice(0, 2000);
  return out;
}
