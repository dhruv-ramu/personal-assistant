import { describe, expect, it } from "vitest";
import { makeHarness, type Harness } from "../helpers/harness";
import { enableExt } from "../helpers/ext";

const ORIGIN = "https://della.test";
const SECRET = "test-admin-secret-0123456789abcdef";

async function session(h: Harness): Promise<{ cookie: string; csrf: string }> {
  const res = await h.fetchApp(
    new Request(`${ORIGIN}/admin/login`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN, "cf-connecting-ip": "203.0.113.9" },
      body: new URLSearchParams({ secret: SECRET }).toString(),
      redirect: "manual",
    }),
  );
  const cookie = res.headers.get("set-cookie")!.split(";")[0]!;
  const page = await (await h.fetchApp(new Request(`${ORIGIN}/admin/privacy`, { headers: { cookie } }))).text();
  return { cookie, csrf: /name="_csrf" value="([^"]+)"/.exec(page)![1]! };
}

const get = async (h: Harness, path: string, cookie: string) => {
  const r = await h.fetchApp(new Request(`${ORIGIN}${path}`, { headers: { cookie }, redirect: "manual" }));
  return { status: r.status, body: await r.text() };
};

const post = (h: Harness, path: string, s: { cookie: string; csrf: string }, fields: Record<string, string> = {}) =>
  h.fetchApp(
    new Request(`${ORIGIN}${path}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: s.cookie, origin: ORIGIN },
      body: new URLSearchParams({ _csrf: s.csrf, ...fields }).toString(),
      redirect: "manual",
    }),
  );

describe("extension dashboard views", () => {
  it("requires the admin session for every new view", async () => {
    const h = await makeHarness();
    for (const p of ["/admin/knowledge", "/admin/items", "/admin/memory", "/admin/secretary", "/admin/accountability", "/admin/devices", "/admin/privacy"]) {
      const r = await h.fetchApp(new Request(`${ORIGIN}${p}`, { redirect: "manual" }));
      expect(r.status).toBe(303);
    }
    expect((await h.fetchApp(new Request(`${ORIGIN}/admin/devices/pair`, { method: "POST" }))).status).toBe(401);
  });

  it("renders each view with live data and escapes owner text", async () => {
    const h = await makeHarness();
    await enableExt(h, { capture_enabled: 1, task_accountability_enabled: 1 });
    await h.send("I put my <b>passport</b> in the blue folder in the desk.");
    await h.send("I promised Alex I'd send the slides by Friday.");
    await h.send("check on me once during the next hour");
    const s = await session(h);
    const k = await get(h, "/admin/knowledge?q=passport", s.cookie);
    expect(k.status).toBe(200);
    expect(k.body).toContain("&lt;b&gt;passport&lt;/b&gt;");
    expect(k.body).not.toContain("<b>passport</b>");
    expect((await get(h, "/admin/items", s.cookie)).body).toContain("blue folder");
    expect((await get(h, "/admin/memory", s.cookie)).body).toContain("What was learned, per message");
    expect((await get(h, "/admin/secretary", s.cookie)).body).toContain("send the slides");
    const acc = await get(h, "/admin/accountability", s.cookie);
    expect(acc.body).toContain("check_once");
    expect(acc.body).toContain("never prove work or wakefulness");
    expect((await get(h, "/admin/privacy", s.cookie)).body).toContain("This is not end-to-end encryption.");
    expect((await get(h, "/admin/diagnostics", s.cookie)).body).toContain("Extension health");
  });

  it("pairs (code shown once), revokes, merges, and toggles features through the same services", async () => {
    const h = await makeHarness();
    await enableExt(h, { capture_enabled: 1 });
    const s = await session(h);
    const paired = await post(h, "/admin/devices/pair", s, { name: "Laptop" });
    const html = await paired.text();
    expect(html).toMatch(/Pairing code: <strong><code>[2-9A-HJ-NP-Z]{10}<\/code><\/strong>/);
    expect(await h.count("SELECT COUNT(*) AS n FROM device_pairing_codes")).toBe(1);
    const row = await h.db.first<{ code_hash: string }>("SELECT code_hash FROM device_pairing_codes");
    expect(html).not.toContain(row!.code_hash);
    const r = await post(h, "/admin/ext-settings", s, { telemetry_enabled: "1", _back: "/admin/devices" });
    expect(r.headers.get("location")).toBe("/admin/devices?ok=saved");
    expect((await h.db.first<{ telemetry_enabled: number }>("SELECT telemetry_enabled FROM ext_settings"))!.telemetry_enabled).toBe(1);
    const evil = await post(h, "/admin/ext-settings", s, { digest_minute: "1080", _back: "https://evil.example" });
    expect(evil.headers.get("location")).toBe("/admin/privacy?ok=saved");
    await h.send("I put my spare key in the jar.");
    await h.send("I put my extra key in the jar.");
    const ids = await h.db.all<{ id: string }>("SELECT id FROM entities WHERE type = 'item' ORDER BY created_at, rowid");
    const m = await post(h, "/admin/items/merge", s, { into: ids[0]!.id, from: ids[1]!.id });
    expect(m.headers.get("location")).toBe("/admin/items?ok=merged");
    const noCsrf = await h.fetchApp(
      new Request(`${ORIGIN}/admin/items/merge`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", cookie: s.cookie, origin: ORIGIN },
        body: "into=a&from=b",
      }),
    );
    expect(noCsrf.status).toBe(403);
  });
});
