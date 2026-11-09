import { Hono } from "hono";
import { deviceCheckin, deviceSync, pairDevice, type SignedEnvelope } from "../accountability/devices";
import { featureOn, getExtSettings } from "../ext/settings";
import { handleUpload, lookupToken, uploadPage } from "../media/uploads";
import type { AppEnvBindings } from "./types";

export const MAX_UPLOAD_BODY_BYTES = 25 * 1024 * 1024;

/**
 * Private upload page for one checkpoint. No admin session (the owner opens it from an SMS link);
 * the unguessable single-purpose token is the capability. Nothing here lists or serves media.
 */
export function uploadRoutes(): Hono<AppEnvBindings> {
  const app = new Hono<AppEnvBindings>();
  app.get("/:token", async (c) => {
    const ctx = c.get("app");
    const ext = await getExtSettings(ctx.db);
    if (!featureOn(ctx, ext, "uploads")) return c.html(uploadPage("Uploads are turned off.", false, 0), 404);
    const t = await lookupToken(ctx, c.req.param("token"));
    if (!t || t.state !== "open") return c.html(uploadPage("This upload link has expired or was already used.", false, 0), 410);
    return c.html(uploadPage(null, true, t.max_objects - t.used_objects));
  });
  app.post("/:token", async (c) => {
    const ctx = c.get("app");
    let files: File[];
    try {
      const form = await c.req.formData();
      files = form.getAll("photo").filter((f): f is File => typeof f !== "string");
    } catch {
      return c.html(uploadPage("That upload couldn't be read.", false, 0), 400);
    }
    const r = await handleUpload(ctx, c.req.param("token"), files);
    const t = await lookupToken(ctx, c.req.param("token"));
    const open = r.status !== 200 && !!t && t.state === "open";
    return c.html(uploadPage(r.message, open, t ? t.max_objects - t.used_objects : 0), r.status as 200);
  });
  return app;
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-max-age": "600",
};

/**
 * Browser-extension API. No cookies are read or set (CORS without credentials); every request is
 * a signed envelope from an enrolled key, except pairing, which consumes a one-time code.
 */
export function deviceRoutes(): Hono<AppEnvBindings> {
  const app = new Hono<AppEnvBindings>();
  app.use("*", async (c, next) => {
    if (c.req.method === "OPTIONS") return c.body(null, 204, CORS);
    await next();
    for (const [k, v] of Object.entries(CORS)) c.res.headers.set(k, v);
    c.res.headers.set("cache-control", "no-store");
  });
  const json = async (req: Request): Promise<Record<string, unknown> | null> => {
    try {
      const v = (await req.json()) as unknown;
      return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };
  app.post("/pair", async (c) => {
    const body = await json(c.req.raw);
    if (!body) return c.json({ ok: false, error: "invalid_request" }, 400);
    const r = await pairDevice(c.get("app"), body);
    return c.json(r, r.ok ? 200 : 400);
  });
  app.post("/sync", async (c) => {
    const body = await json(c.req.raw);
    if (!body) return c.json({ error: "invalid_request" }, 400);
    const r = await deviceSync(c.get("app"), body as unknown as SignedEnvelope);
    return c.json(r.body, r.status as 200);
  });
  app.post("/checkin", async (c) => {
    const body = await json(c.req.raw);
    if (!body) return c.json({ ok: false, error: "invalid_request" }, 400);
    const r = await deviceCheckin(c.get("app"), body as unknown as SignedEnvelope);
    return c.json(r.body, r.status as 200);
  });
  return app;
}
