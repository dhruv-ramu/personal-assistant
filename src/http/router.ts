import { Hono } from "hono";
import { hasFatalCoreIssue } from "../config";
import { buildContext, type ContextOverrides } from "../context";
import type { Env } from "../env";
import { log } from "../observability/log";
import { safeErrorMessage } from "../security/redaction";
import { adminRoutes } from "./admin";
import { oauthRoutes } from "./oauth";
import { MAX_UPLOAD_BODY_BYTES, deviceRoutes, uploadRoutes } from "./ext-routes";
import type { AppEnvBindings } from "./types";
import { inboundSms, smsStatus, voiceGatherRoute, voiceInstructionsRoute, voiceStatusRoute } from "./webhooks";

export type OverridesFactory = (env: Env) => ContextOverrides | Promise<ContextOverrides>;

const MAX_BODY_BYTES = 64 * 1024;

export const SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy": "default-src 'none'; style-src 'self'; script-src 'self'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "same-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
  "cross-origin-opener-policy": "same-origin",
};

/**
 * Route policy (deny by default):
 *   GET  /health                       public, minimal
 *   POST /webhooks/sms/inbound|status  provider signature required
 *   POST /webhooks/voice/*             provider signature required
 *   GET  /admin/login, POST /admin/login  public (throttled)
 *   GET  /oauth/google/callback        admin session + valid one-time state
 *   everything else under /admin, /oauth  admin session (+ CSRF/Origin on POST)
 *   /admin/simulator/*                 additionally requires a non-production simulator
 *   GET/POST /u/:token                 one-time upload capability token (no session)
 *   POST /api/device/*                 signed device envelopes / one-time pairing code (no cookies)
 *   anything else                      404
 */
export function createApp(overrides?: OverridesFactory): Hono<AppEnvBindings> {
  const app = new Hono<AppEnvBindings>();

  app.use("*", async (c, next) => {
    const len = Number(c.req.header("content-length") ?? "0");
    if (len > (c.req.path.startsWith("/u/") ? MAX_UPLOAD_BODY_BYTES : MAX_BODY_BYTES)) return c.text("Payload too large", 413);
    const ctx = await buildContext(c.env, overrides ? await overrides(c.env) : {});
    c.set("app", ctx);
    c.set("session", null);
    c.set("sessionToken", null);
    c.set("selfFetch", (req: Request) => Promise.resolve(app.fetch(req, c.env, c.executionCtx)));
    if (hasFatalCoreIssue(ctx.config) && !c.req.path.startsWith("/health")) {
      log("error", "fatal_configuration", { path: c.req.path });
      return c.text("Service misconfigured; see diagnostics in logs.", 503);
    }
    await next();
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) c.res.headers.set(k, v);
    if (ctx.config.appEnv === "production" || ctx.config.appEnv === "staging") c.res.headers.set("strict-transport-security", "max-age=31536000; includeSubDomains");
    if (c.req.path.startsWith("/admin") || c.req.path.startsWith("/oauth")) c.res.headers.set("cache-control", c.res.headers.get("cache-control") ?? "no-store");
    if (c.req.path.startsWith("/u/")) {
      c.res.headers.set("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
      c.res.headers.set("referrer-policy", "no-referrer");
      c.res.headers.set("cache-control", "no-store");
    }
  });

  app.get("/health", (c) => c.json({ ok: true, service: "della" }));
  app.get("/", (c) => c.redirect("/admin", 302));

  app.post("/webhooks/sms/inbound", inboundSms);
  app.post("/webhooks/sms/status", smsStatus);
  app.post("/webhooks/voice/instructions", voiceInstructionsRoute);
  app.post("/webhooks/voice/gather", voiceGatherRoute);
  app.post("/webhooks/voice/status", voiceStatusRoute);

  app.route("/admin", adminRoutes());
  app.route("/oauth", oauthRoutes());
  app.route("/u", uploadRoutes());
  app.route("/api/device", deviceRoutes());

  app.notFound((c) => c.text("Not found", 404));
  app.onError((err, c) => {
    log("error", "unhandled_error", { path: c.req.path, error: safeErrorMessage(err) });
    return c.text("Internal error", 500);
  });
  return app;
}
