import { describe, expect, it } from "vitest";
import { setLogSink } from "../../src/observability/log";
import { SIM_SIGNATURE_HEADER, signSimRequest } from "../../src/providers/simulated/common";
import { SIM_DELLA_NUMBER } from "../../src/providers/simulated/sms";
import { computeSignature, type FormParams } from "../../src/providers/twilio/signature";
import { FAKE_TWILIO_SID } from "../helpers/fixtures";
import { makeHarness, type Harness } from "../helpers/harness";
import { SpyPlanner } from "../helpers/planners";

const OWNER = "+15550100001";

function params(o: Record<string, string>): FormParams {
  return new Map(Object.entries(o).map(([k, v]) => [k, [v]]));
}

function body(p: FormParams): string {
  const u = new URLSearchParams();
  for (const [k, vs] of p) for (const v of vs) u.append(k, v);
  return u.toString();
}

async function simPost(h: Harness, p: FormParams, opts: { signature?: string | null; contentType?: string; path?: string } = {}) {
  const url = `https://della.test${opts.path ?? "/webhooks/sms/inbound"}`;
  const signature = opts.signature === undefined ? await signSimRequest("test-sim-secret", url, p) : opts.signature;
  const headers: Record<string, string> = { "content-type": opts.contentType ?? "application/x-www-form-urlencoded" };
  if (signature) headers[SIM_SIGNATURE_HEADER] = signature;
  return h.fetchApp(new Request(url, { method: "POST", headers, body: body(p) }));
}

const valid = (o: Record<string, string> = {}) =>
  params({ AccountSid: "ACsimulated", MessageSid: `SM${crypto.randomUUID().replace(/-/g, "")}`, From: OWNER, To: SIM_DELLA_NUMBER, Body: "STATUS", NumMedia: "0", ...o });

describe("ingress verification", () => {
  it("accepts a valid signed webhook with an empty TwiML acknowledgement", async () => {
    const h = await makeHarness();
    const res = await simPost(h, valid());
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  });

  it("rejects invalid or missing signatures", async () => {
    const h = await makeHarness();
    expect((await simPost(h, valid(), { signature: "bogus" })).status).toBe(403);
    expect((await simPost(h, valid(), { signature: null })).status).toBe(403);
    expect(await h.count("SELECT COUNT(*) AS n FROM inbound_messages")).toBe(0);
  });

  it("rejects a correctly signed request with the wrong account or destination", async () => {
    const h = await makeHarness();
    expect((await simPost(h, valid({ AccountSid: "ACother" }))).status).toBe(403);
    expect((await simPost(h, valid({ To: "+15550100777" }))).status).toBe(403);
  });

  it("a signed message from an unauthorized phone triggers no AI, action, storage, or reply", async () => {
    const spy = new SpyPlanner();
    const h = await makeHarness({ planner: spy });
    const res = await simPost(h, valid({ From: "+15550100777", Body: "Remind me to wire money tomorrow at 9am" }));
    expect(res.status).toBe(200);
    await h.drain();
    expect(spy.calls).toHaveLength(0);
    expect(await h.count("SELECT COUNT(*) AS n FROM inbound_messages")).toBe(0);
    expect(await h.count("SELECT COUNT(*) AS n FROM jobs")).toBe(0);
    expect(await h.count("SELECT COUNT(*) AS n FROM outbound_effects")).toBe(0);
  });

  it("rejects unsupported content types and oversized bodies", async () => {
    const h = await makeHarness();
    expect((await simPost(h, valid(), { contentType: "application/json" })).status).toBe(415);
    const big = valid({ Body: "x".repeat(40_000) });
    expect((await simPost(h, big)).status).toBe(413);
  });

  it("storage failure does not acknowledge dropped work", async () => {
    const h = await makeHarness();
    const real = h.env.DB;
    const failing = new Proxy(real, {
      get(target, prop) {
        if (prop === "batch")
          return async () => {
            throw new Error("D1 unavailable");
          };
        const v = Reflect.get(target, prop);
        return typeof v === "function" ? v.bind(target) : v;
      },
    }) as D1Database;
    const broken = await makeHarness({ db: failing, reset: false, connectCalendar: false });
    const res = await simPost(broken, valid());
    expect(res.status).toBe(503);
  });

  it("duplicate provider delivery creates one inbound, one plan, one reply", async () => {
    const h = await makeHarness();
    const p = valid({ MessageSid: "SMdup00000000000000000000000000001", Body: "What can you do?" });
    expect((await simPost(h, p)).status).toBe(200);
    expect((await simPost(h, p)).status).toBe(200);
    await h.drain();
    expect(await h.count("SELECT COUNT(*) AS n FROM inbound_messages")).toBe(1);
    expect(await h.count("SELECT COUNT(*) AS n FROM plans")).toBe(1);
    expect((await h.outbox()).length).toBe(1);
  });

  it("STOP takes precedence over earlier pending messages and is not double-answered", async () => {
    const h = await makeHarness();
    await h.send("What can you do?", { drain: false });
    await h.send("STOP", { drain: false });
    await h.drain();
    expect(await h.outbox()).toEqual([]);
    const effects = await h.db.all<{ state: string; error_detail: string }>("SELECT state, error_detail FROM outbound_effects");
    expect(effects).toEqual([{ state: "suppressed", error_detail: "opted_out" }]);
    expect(await h.count("SELECT COUNT(*) AS n FROM sim_messages WHERE direction = 'provider_auto'")).toBe(1);
    await h.send("START");
    expect(await h.count("SELECT COUNT(*) AS n FROM suppressions WHERE channel = 'sms' AND state = 'active'")).toBe(1);
    // START restores SMS only; calls stay paused until the administrator re-enables them.
    expect(await h.count("SELECT COUNT(*) AS n FROM suppressions WHERE channel = 'call' AND state = 'opted_out'")).toBe(1);
  });

  it("treats attachments as unsupported content", async () => {
    const h = await makeHarness();
    await h.send("", { numMedia: 1 });
    expect(await h.lastReply()).toBe("I can only read text messages; attachments aren't supported.");
  });

  it("processes dependent turns in ingress order even if queue delivery is reordered", async () => {
    const h = await makeHarness();
    await h.send("Remind me tomorrow at 5 to call mom", { drain: false });
    await h.send("PM", { drain: false });
    const jobs = await h.db.all<{ id: string; seq: number }>("SELECT id, seq FROM jobs WHERE kind = 'process_inbound' ORDER BY seq DESC");
    // Deliver the later message first: it must wait for the earlier one.
    const r = await h.processJob(jobs[0]!.id);
    expect(r.outcome?.status).toBe("reschedule");
    await h.drain();
    h.clock.advance(10_000);
    await h.drain();
    const out = await h.outbox();
    expect(out[0]).toBe("Tomorrow at 5 AM or 5 PM?");
    expect(out[1]).toMatch(/^Reminder set: Call mom, Mon Nov 9, 5 PM PT\./);
  });

  it("Twilio adapter: verifies the documented signature over the configured public URL", async () => {
    const twilioEnv = {
      SMS_PROVIDER: "twilio",
      TWILIO_ACCOUNT_SID: FAKE_TWILIO_SID,
      TWILIO_AUTH_TOKEN: "0123456789abcdef0123456789abcdef",
      TWILIO_PHONE_NUMBER: "+14155550199",
    };
    const h = await makeHarness({ env: twilioEnv });
    const p = params({
      AccountSid: twilioEnv.TWILIO_ACCOUNT_SID,
      MessageSid: "SM0123456789abcdef0123456789abcdef",
      From: OWNER,
      To: twilioEnv.TWILIO_PHONE_NUMBER,
      Body: "STATUS <Response>",
      NumMedia: "0",
    });
    const url = "https://della.test/webhooks/sms/inbound";
    const sig = await computeSignature(twilioEnv.TWILIO_AUTH_TOKEN, url, p);
    // The Host header is untrusted; the canonical URL comes from PUBLIC_BASE_URL.
    const req = (s: string, b: string) =>
      new Request("https://attacker.example/webhooks/sms/inbound", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": s },
        body: b,
      });
    const ok = await h.fetchApp(req(sig, body(p)));
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
    const tampered = new Map(p);
    tampered.set("Body", ["STATUS!"]);
    expect((await h.fetchApp(req(sig, body(tampered)))).status).toBe(403);
    expect(await h.count("SELECT COUNT(*) AS n FROM inbound_messages")).toBe(1);
  });

  it("production rejects simulated webhooks even when correctly signed (no injection route)", async () => {
    const h = await makeHarness({ env: { APP_ENV: "production", SIMULATOR_ENABLED: "true" } });
    expect((await simPost(h, valid())).status).toBe(403);
  });

  it("logs are structured and redacted (no phone numbers or message text)", async () => {
    const lines: string[] = [];
    setLogSink((l) => lines.push(l));
    try {
      const h = await makeHarness();
      await simPost(h, valid({ From: "+15550100777", Body: "my secret plan" }));
      await h.send("Remind me tomorrow at 5 PM to call +14155550123 about secret stuff");
    } finally {
      setLogSink(null);
    }
    const all = lines.join("\n");
    expect(all).not.toContain("+15550100777");
    expect(all).not.toContain("4155550123");
    expect(all).not.toContain("secret");
    expect(all).toContain("inbound_unauthorized_sender");
  });
});
