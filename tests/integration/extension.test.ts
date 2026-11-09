import { describe, expect, it } from "vitest";
import { activeSession } from "../../src/accountability/sessions";
import { BACKUP_TABLES } from "../../src/services/backup";
import { processJob } from "../../src/services/queue-consumer";
import { HOUR, MINUTE, makeHarness } from "../helpers/harness";
import { enableExt, jpegWithExif, pairDevice, upload, uploadUrlFrom } from "../helpers/ext";

describe("device API surface", () => {
  it("answers CORS preflight without credentials and sets no cookies", async () => {
    const h = await makeHarness();
    const pre = await h.fetchApp(
      new Request("https://della.test/api/device/sync", { method: "OPTIONS", headers: { origin: "moz-extension://abc", "access-control-request-method": "POST" } }),
    );
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-origin")).toBe("*");
    expect(pre.headers.get("access-control-allow-credentials")).toBeNull();
    const dev = await pairDevice(h);
    const r = await h.fetchApp(
      new Request("https://della.test/api/device/sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(await dev.envelope({ kind: "poll" })),
      }),
    );
    expect(r.headers.get("set-cookie")).toBeNull();
    expect(((await r.json()) as { active: boolean }).active).toBe(false);
  });

  it("a pairing code is single-use and a public key can't be enrolled twice", async () => {
    const h = await makeHarness();
    const dev = await pairDevice(h);
    const reuse = await h.fetchApp(
      new Request("https://della.test/api/device/pair", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: dev.code, publicKeyJwk: { kty: "EC", crv: "P-256", x: "x", y: "y" } }),
      }),
    );
    expect(((await reuse.json()) as { error: string }).error).toBe("invalid_or_expired_code");
  });

  it("telemetry off means a paired browser gets no challenges even during a session", async () => {
    const h = await makeHarness();
    await enableExt(h, { task_accountability_enabled: 1, telemetry_enabled: 0 });
    const dev = await pairDevice(h);
    await h.send("hold me accountable for Report from 10:30 AM to 11:30 AM, browser check halfway");
    await h.advanceTo("2026-11-08T19:00:30Z");
    const s = await dev.sync();
    expect(s.json).toMatchObject({ active: false, challenge: null });
    expect(await h.lastReply()).toMatch(/no registered browser is available; reply HERE instead/);
  });
});

describe("upload page and headers", () => {
  it("serves the upload page with a strict CSP, no referrer, and no caching", async () => {
    const h = await makeHarness();
    await enableExt(h, { task_accountability_enabled: 1 });
    await h.send("hold me accountable for Report from 10:30 AM to 11:30 AM, photo at start");
    await h.advanceTo("2026-11-08T18:30:30Z");
    const res = await h.fetchApp(new Request(uploadUrlFrom(await h.lastReply())));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).toContain("Location and camera metadata are removed before storage");
  });

  it("uploads are refused once the checkpoint closes", async () => {
    const h = await makeHarness();
    await enableExt(h, { task_accountability_enabled: 1 });
    await h.send("hold me accountable for Report from 10:30 AM to 11:30 AM, photo at start");
    await h.advanceTo("2026-11-08T18:30:30Z");
    const url = uploadUrlFrom(await h.lastReply());
    await h.send("cancel accountability");
    const r = await upload(h, url, [{ bytes: jpegWithExif(), name: "a.jpg", type: "image/jpeg" }]);
    expect(r.status).toBe(410);
    expect(await h.count("SELECT COUNT(*) AS n FROM media_objects")).toBe(0);
  });
});

describe("accountability jobs are idempotent and fenced", () => {
  it("a duplicate checkpoint job delivery sends one prompt", async () => {
    const h = await makeHarness();
    await enableExt(h, { task_accountability_enabled: 1 });
    await h.send("check on me once during the next hour");
    const job = await h.db.first<{ id: string }>("SELECT id FROM jobs WHERE kind = 'acc_checkpoint'");
    h.clock.advance(31 * MINUTE);
    await processJob(h.ctx, job!.id);
    await processJob(h.ctx, job!.id);
    await h.drain();
    expect((await h.outbox()).filter((m) => /how's it going/.test(m))).toHaveLength(1);
  });

  it("a session pause defers checks without counting them missed, then resumes", async () => {
    const h = await makeHarness();
    await enableExt(h, { task_accountability_enabled: 1 });
    await h.send("hold me accountable for Report from 10:30 AM to 11:30 AM, progress halfway");
    await h.advanceTo("2026-11-08T18:55:00Z");
    expect(await activeSession(h.ctx)).toBeTruthy();
    expect(await (async () => (await h.send("pause 20"), h.lastReply()))()).toMatch(/^Paused for 20 minutes/);
    await h.advanceTo("2026-11-08T19:10:00Z", 5 * MINUTE);
    expect((await h.outbox()).filter((m) => /^Check 1\/1/.test(m))).toHaveLength(0);
    await h.advanceTo("2026-11-08T19:16:00Z");
    expect((await h.outbox()).filter((m) => /^Check 1\/1/.test(m))).toHaveLength(1);
  });

  it("global pause waives checks instead of sending them", async () => {
    const h = await makeHarness();
    await enableExt(h, { task_accountability_enabled: 1 });
    await h.send("check on me once during the next hour");
    await h.send("pause");
    await h.advance(HOUR, 10 * MINUTE);
    expect((await h.outbox()).filter((m) => /how's it going/.test(m))).toHaveLength(0);
    expect(await h.db.first("SELECT state, status_label FROM acc_checkpoints")).toEqual({ state: "waived", status_label: "paused_or_opted_out" });
  });
});

describe("feature flags", () => {
  it("a deployment-disabled flag overrides the owner's setting", async () => {
    const h = await makeHarness({ env: { CAPTURE_ENABLED: "false" } });
    await h.send("enable memory");
    expect(await h.lastReply()).toBe("Memory is turned on in your settings, but it's disabled for this deployment, so it stays off.");
    await h.send("I put my passport in the safe.");
    expect(await h.count("SELECT COUNT(*) AS n FROM entities")).toBe(0);
  });

  it("item recall works with every optional adapter unavailable", async () => {
    const h = await makeHarness({ env: { SEMANTIC_INDEX_ENABLED: "false", EMAIL_READ_ENABLED: "false", CURRENT_INFO_ENABLED: "false", IMAGE_ASSESSMENT_ENABLED: "false" } });
    await enableExt(h, { capture_enabled: 1 });
    await h.send("I put my passport in the safe.");
    await h.send("where is my passport");
    expect(await h.lastReply()).toBe("Passport: last reported in the safe (updated Sun Nov 8).");
  });
});

describe("backup coverage", () => {
  it("includes canonical extension tables and excludes derived/ephemeral ones", () => {
    for (const t of ["assertions", "entities", "secretary_items", "acc_sessions", "deletion_tombstones", "media_objects"]) expect(BACKUP_TABLES).toContain(t);
    for (const t of ["semantic_vectors", "retrieval_evidence", "device_challenges", "upload_tokens", "device_pairing_codes", "device_events"])
      expect(BACKUP_TABLES).not.toContain(t);
  });
});
