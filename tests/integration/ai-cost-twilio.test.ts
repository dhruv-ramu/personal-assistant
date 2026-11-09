import { describe, expect, it } from "vitest";
import { TwilioSmsTransport } from "../../src/providers/twilio/sms";
import { ERASE_CONFIRMATION_PHRASE, eraseAllData } from "../../src/services/backup";
import { runRetention } from "../../src/services/retention";
import { FAKE_TWILIO_SID } from "../helpers/fixtures";
import { DAY, MINUTE, makeHarness } from "../helpers/harness";
import { SpyPlanner } from "../helpers/planners";

describe("AI usage boundaries", () => {
  it("simple commands and stored scheduled reminders never call the AI", async () => {
    const spy = new SpyPlanner();
    const h = await makeHarness({ planner: spy });
    await h.send("Remind me in 15 minutes to take the bread out");
    expect(spy.calls).toHaveLength(1);
    const id = h.shortIdFrom(await h.lastReply());
    await h.send("STATUS");
    await h.send("LIST");
    await h.advance(15 * MINUTE);
    await h.send(`done ${id}`);
    await h.send("STOP");
    expect(spy.calls).toHaveLength(1);
    expect(await h.count("SELECT COUNT(*) AS n FROM ai_requests")).toBe(1);
  });

  it("an empty minute tick does no AI work", async () => {
    const spy = new SpyPlanner();
    const h = await makeHarness({ planner: spy });
    await h.advance(30 * MINUTE);
    expect(spy.calls).toHaveLength(0);
  });

  it("the daily AI request cap blocks interpretation with an honest reply", async () => {
    const spy = new SpyPlanner();
    const h = await makeHarness({ planner: spy });
    await h.settings({ limit_ai_requests_per_day: 1 });
    await h.send("Remind me in 10 minutes to call Al");
    await h.send("Remind me in 20 minutes to call Bo");
    expect(spy.calls).toHaveLength(1);
    expect(await h.lastReply()).toBe("I've hit today's limit for interpreting messages. Simple commands still work: LIST, STATUS, DONE T4K8.");
  });

  it("an inbound retry resumes the saved plan instead of asking the AI again", async () => {
    const spy = new SpyPlanner();
    const h = await makeHarness({ planner: spy });
    const original = h.ctx.calendar.insertEvent.bind(h.ctx.calendar);
    let fail = true;
    h.ctx.calendar.insertEvent = async (...a) => {
      if (fail) {
        fail = false;
        throw new Error("crash mid-execution");
      }
      return original(...a);
    };
    await h.send("Add yoga tomorrow from 6 PM to 7 PM", { drain: false });
    await h.drain();
    h.clock.advance(2 * MINUTE);
    await h.drain();
    expect(spy.calls).toHaveLength(1);
    expect(await h.count("SELECT COUNT(*) AS n FROM plans")).toBe(1);
    expect(await h.count("SELECT COUNT(*) AS n FROM sim_calendar_events")).toBe(1);
    expect(await h.lastReply()).toBe("Added Yoga: Mon Nov 9, 6-7 PM PT.");
  });

  it("budget exhaustion sends at most one warning, never a loop", async () => {
    const h = await makeHarness();
    await h.settings({ limit_sms_segments_per_day: 1 });
    for (let i = 0; i < 4; i++) await h.send("STATUS");
    expect(await h.count("SELECT COUNT(*) AS n FROM outbound_effects WHERE purpose = 'warning'")).toBe(1);
    expect((await h.outbox()).filter((b) => b.startsWith("Daily text limit"))).toHaveLength(1);
  });
});

describe("Twilio SMS adapter (mocked REST)", () => {
  const cfg = {
    accountSid: FAKE_TWILIO_SID,
    authToken: "0123456789abcdef0123456789abcdef",
    phoneNumber: "+14155550199",
    messagingServiceSid: null,
    publicBaseUrl: "https://della.test",
    providerManagedKeywords: true,
    live: true,
  };
  const input = { to: "+15550100001", body: "Reminder: x [T4K8]", effectId: "eff_1", statusCallbackUrl: "https://della.test/webhooks/sms/status?e=eff_1", validitySeconds: 7200 };

  it("sends the documented request and treats a SID as acceptance, not delivery", async () => {
    let seen: { url: string; init?: RequestInit } | null = null;
    const t = new TwilioSmsTransport(cfg, async (url, init) => {
      seen = { url, init };
      return new Response(JSON.stringify({ sid: "SM0123456789abcdef0123456789abcdef", status: "queued", num_segments: "1" }), { status: 201 });
    });
    const r = await t.send(input);
    expect(r).toEqual({ kind: "accepted", providerId: "SM0123456789abcdef0123456789abcdef", providerStatus: "queued", segments: 1 });
    expect(seen!.url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${FAKE_TWILIO_SID}/Messages.json`);
    const headers = new Headers(seen!.init!.headers);
    expect(headers.get("authorization")).toBe(`Basic ${btoa(`${cfg.accountSid}:${cfg.authToken}`)}`);
    const form = new URLSearchParams(String(seen!.init!.body));
    expect(Object.fromEntries(form)).toEqual({ To: input.to, From: cfg.phoneNumber, Body: input.body, StatusCallback: input.statusCallbackUrl, ValidityPeriod: "7200" });
    expect(headers.get("idempotency-key")).toBeNull();
  });

  it("classifies rejections and uncertain outcomes", async () => {
    const make = (res: Response | Error) =>
      new TwilioSmsTransport(cfg, async () => {
        if (res instanceof Error) throw res;
        return res;
      });
    expect(await make(new Response(JSON.stringify({ code: 21610, message: "Attempt to send to unsubscribed recipient" }), { status: 400 })).send(input)).toMatchObject({
      kind: "rejected",
      retryable: false,
      code: "21610",
    });
    expect(await make(new Response(JSON.stringify({ code: 20429 }), { status: 429 })).send(input)).toMatchObject({ kind: "rejected", retryable: true });
    expect((await make(new Response("oops", { status: 502 })).send(input)).kind).toBe("unknown");
    expect((await make(Object.assign(new Error("t"), { name: "TimeoutError" })).send(input)).kind).toBe("unknown");
    expect((await make(new Response(JSON.stringify({ code: 20003 }), { status: 401 })).send(input)).kind).toBe("rejected");
  });

  it("uses the Messaging Service sender pool when configured", async () => {
    let body = "";
    const t = new TwilioSmsTransport({ ...cfg, messagingServiceSid: "MG0123456789abcdef0123456789abcdef" }, async (_u, init) => {
      body = String(init?.body);
      return new Response(JSON.stringify({ sid: "SM0123456789abcdef0123456789abcdee", status: "accepted" }), { status: 201 });
    });
    await t.send(input);
    const form = new URLSearchParams(body);
    expect(form.get("MessagingServiceSid")).toBe("MG0123456789abcdef0123456789abcdef");
    expect(form.get("From")).toBeNull();
  });
});

describe("retention and erase", () => {
  it("purges old message content but keeps active schedules and dedupe keys", async () => {
    const h = await makeHarness();
    await h.send("Remind me every day at 9 AM to stretch");
    await h.send("Remind me in 5 minutes to call Al");
    const id = h.shortIdFrom(await h.lastReply());
    await h.send(`done ${id}`);
    h.clock.advance(100 * DAY);
    await runRetention(h.ctx);
    expect(await h.count("SELECT COUNT(*) AS n FROM inbound_messages WHERE body_enc IS NOT NULL")).toBe(0);
    expect(await h.count("SELECT COUNT(*) AS n FROM inbound_messages")).toBe(3);
    expect(await h.count("SELECT COUNT(*) AS n FROM series WHERE status = 'active'")).toBe(1);
    const t = await h.db.first<{ title_enc: string }>("SELECT title_enc FROM tasks WHERE short_id = ?", id);
    expect(await h.ctx.crypto.decrypt(t!.title_enc, "task")).toBe("(content removed by retention)");
  });

  it("erase requires the typed phrase, disables future work first, and keeps tombstones", async () => {
    const h = await makeHarness();
    const r = await h.send("Remind me in 30 minutes to call Bo");
    expect(await eraseAllData(h.ctx, "erase")).toBe(false);
    expect(await eraseAllData(h.ctx, ERASE_CONFIRMATION_PHRASE)).toBe(true);
    expect(await h.count("SELECT COUNT(*) AS n FROM tasks")).toBe(0);
    expect(await h.count("SELECT COUNT(*) AS n FROM jobs")).toBe(0);
    const s = await h.db.first<{ sms_enabled: number; calls_enabled: number; automation_pause_scope: string }>(
      "SELECT sms_enabled, calls_enabled, automation_pause_scope FROM owner_settings",
    );
    expect(s).toEqual({ sms_enabled: 0, calls_enabled: 0, automation_pause_scope: "all" });
    // A late provider retry of an erased message is recognized and ignored.
    await h.send("Remind me in 30 minutes to call Bo", { sid: r.messageSid });
    expect(await h.count("SELECT COUNT(*) AS n FROM inbound_messages")).toBe(0);
    await h.advance(40 * MINUTE, 10 * MINUTE);
    expect((await h.outbox()).filter((b) => b.startsWith("Reminder: Call Bo"))).toEqual([]);
  });
});
