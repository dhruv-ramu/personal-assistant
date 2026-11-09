import { describe, expect, it } from "vitest";
import { simSendFromOwner } from "../../src/services/simulator";
import { DAY, makeHarness } from "../helpers/harness";
import { enableExt, jpegWithExif } from "../helpers/ext";

const ORIGIN = "https://della.test";

describe("MMS evidence (simulated Twilio media)", () => {
  it("stores a stripped MMS photo for the open photo check only when MMS is enabled", async () => {
    const h = await makeHarness();
    await enableExt(h, { task_accountability_enabled: 1, mms_enabled: 0 });
    await h.ctx.ext.media.put("sim-mms/gym1", jpegWithExif(), "image/jpeg");
    await h.send("hold me accountable for Report from 10:30 AM to 11:30 AM, photo at start");
    await h.advanceTo("2026-11-08T18:30:30Z");
    await simSendFromOwner(h.ctx, h.fetchApp, "", { mediaKeys: ["gym1"] });
    await h.drain();
    expect(await h.lastReply()).toBe("I don't process MMS photos (that's off). Use the upload link from the check instead.");
    expect(await h.count("SELECT COUNT(*) AS n FROM media_objects")).toBe(0);
    await enableExt(h, { mms_enabled: 1 });
    await simSendFromOwner(h.ctx, h.fetchApp, "", { mediaKeys: ["gym1"] });
    await h.drain();
    expect(await h.lastReply()).toBe("Photo received for your check.");
    const m = await h.db.first<{ source: string; metadata_stripped: number }>("SELECT source, metadata_stripped FROM media_objects");
    expect(m).toEqual({ source: "mms", metadata_stripped: 1 });
    expect(await h.db.first("SELECT state, status_label FROM acc_checkpoints")).toEqual({ state: "satisfied", status_label: "photo_received_unassessed" });
  });

  it("an MMS photo with no open photo check is not kept", async () => {
    const h = await makeHarness();
    await enableExt(h, { mms_enabled: 1 });
    await h.ctx.ext.media.put("sim-mms/x", jpegWithExif(), "image/jpeg");
    await simSendFromOwner(h.ctx, h.fetchApp, "", { mediaKeys: ["x"] });
    await h.drain();
    expect(await h.lastReply()).toBe("Thanks, but no photo check is open, so I didn't keep that image.");
    expect(await h.count("SELECT COUNT(*) AS n FROM media_objects")).toBe(0);
  });
});

describe("Gmail OAuth start (read-only grant)", () => {
  it("redirects to Google with only gmail.readonly when configured, and refuses otherwise", async () => {
    const h = await makeHarness({
      env: { EMAIL_PROVIDER: "gmail", GOOGLE_CLIENT_ID: "cid", GOOGLE_CLIENT_SECRET: "csecret", GMAIL_REDIRECT_URI: `${ORIGIN}/oauth/gmail/callback` },
    });
    const login = await h.fetchApp(
      new Request(`${ORIGIN}/admin/login`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN, "cf-connecting-ip": "203.0.113.20" },
        body: new URLSearchParams({ secret: "test-admin-secret-0123456789abcdef" }).toString(),
        redirect: "manual",
      }),
    );
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const r = await h.fetchApp(new Request(`${ORIGIN}/oauth/gmail/start`, { headers: { cookie }, redirect: "manual" }));
    expect(r.status).toBe(302);
    const u = new URL(r.headers.get("location")!);
    expect(u.origin).toBe("https://accounts.google.com");
    expect(u.searchParams.get("scope")).toBe("openid email https://www.googleapis.com/auth/gmail.readonly");
    expect(u.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/oauth/gmail/callback`);
    const bad = await h.fetchApp(new Request(`${ORIGIN}/oauth/gmail/callback?state=forged&code=x`, { headers: { cookie }, redirect: "manual" }));
    expect(bad.headers.get("location")).toBe("/admin/privacy?err=oauth_error");
    const h2 = await makeHarness();
    const anon = await h2.fetchApp(new Request(`${ORIGIN}/oauth/gmail/start`, { redirect: "manual" }));
    expect(anon.headers.get("location")).toBe("/admin/login");
  });
});

describe("briefs, free time, relationships", () => {
  it("weather is labelled with source and time, cached, and absent without a location", async () => {
    const h = await makeHarness();
    await enableExt(h, { capture_enabled: 1, info_enabled: 1 });
    await h.send("I'm flying to Boston next Friday; pack charger and umbrella.");
    await h.send("trip brief");
    expect(await h.lastReply()).toBe("Trip: Boston. Packing you listed: charger, umbrella. Weather: no location configured (set one in the dashboard).");
    await enableExt(h, { location_label: "home", location_lat: 37.77, location_lon: -122.42 });
    await h.send("what should i pack for boston");
    const r = await h.lastReply();
    expect(r).toMatch(/Packing you listed: charger, umbrella\./);
    expect(r).toMatch(
      /Weather \(home, simulated, as of 10 AM\): Simulated Simulated forecast: light rain \(fixture, not real weather\), 54°F\. \(Home forecast only; I don't look up destinations\.\)/,
    );
    await h.send("trip brief");
    expect(await h.count("SELECT COUNT(*) AS n FROM info_snapshots")).toBe(1);
  });

  it("free time suggests only tasks with explicit estimates that fit", async () => {
    const h = await makeHarness();
    await enableExt(h, { capture_enabled: 1 });
    await h.send("Add task: water plants");
    await h.send("Add task: write essay");
    await h.send("Water plants takes 10 minutes on phone.");
    await h.send("i have 15 minutes free");
    const r = await h.lastReply();
    expect(r).toMatch(/Water plants/);
    expect(r).not.toMatch(/Write essay/);
  });

  it("a relationship follow-up becomes one digest suggestion when due", async () => {
    const h = await makeHarness();
    await enableExt(h, { capture_enabled: 1, suggestions_enabled: 1 });
    await h.send("I talked with Priya about the grant; follow up in 2 days.");
    h.clock.advance(2 * DAY + 60_000);
    await h.tick();
    await h.drain();
    const s = await h.db.first<{ kind: string; delivery: string; text_enc: string }>("SELECT kind, delivery, text_enc FROM suggestions");
    expect(s!.kind).toBe("relationship_followup");
    expect(s!.delivery).toBe("digest");
    expect(await h.ctx.crypto.decrypt(s!.text_enc, "suggestion")).toBe("Follow up with Priya? You talked Sun Nov 8 about the grant.");
  });
});
