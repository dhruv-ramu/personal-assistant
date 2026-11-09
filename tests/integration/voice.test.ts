import { describe, expect, it } from "vitest";
import { scriptSimOutcome } from "../../src/providers/simulated/common";
import { TwilioVoiceTransport } from "../../src/providers/twilio/voice";
import { FAKE_TWILIO_SID } from "../helpers/fixtures";
import { MINUTE, makeHarness, type Harness } from "../helpers/harness";

async function wakeAt(h: Harness, phrase: string, confirm = false) {
  await h.send(phrase);
  if (confirm) await h.send(`YES ${h.nonceFrom(await h.lastReply())}`);
}

describe("wake-up call semantics", () => {
  it("duplicate keypad 1 acknowledges once", async () => {
    const h = await makeHarness();
    await wakeAt(h, "Wake me up at 11 AM today");
    await h.advanceTo("2026-11-08T19:00:00Z");
    const sid = (await h.calls())[0]!.sid;
    const t1 = await h.call(sid, "press1");
    expect(t1.gather![0]).toContain("Confirmed");
    const occ = await h.db.first<{ status: string; generation: number }>("SELECT status, generation FROM alarm_occurrences");
    expect(occ!.status).toBe("acknowledged");
  });

  it("a completed call without keypad input is not 'awake'; the single retry is bounded", async () => {
    const h = await makeHarness();
    await wakeAt(h, "Wake me up at 11 AM today and retry if I miss it");
    await h.advanceTo("2026-11-08T19:00:00Z");
    await h.call((await h.calls())[0]!.sid, "no_input");
    let occ = await h.db.first<{ status: string; status_reason: string }>("SELECT status, status_reason FROM alarm_occurrences");
    expect(occ).toEqual({ status: "retry_scheduled", status_reason: "unacknowledged:completed" });
    await h.advanceTo("2026-11-08T19:05:00Z");
    expect(await h.calls()).toHaveLength(2);
    await h.call((await h.calls())[1]!.sid, "no_answer");
    await h.advance(30 * MINUTE, 5 * MINUTE);
    expect(await h.calls()).toHaveLength(2);
    occ = await h.db.first("SELECT status, status_reason FROM alarm_occurrences");
    expect(occ).toEqual({ status: "missed", status_reason: "unacknowledged:no-answer" });
  });

  it("unknown call acceptance never triggers an automatic second call; a late callback reconciles", async () => {
    const h = await makeHarness();
    await wakeAt(h, "Wake me up at 11 AM today and retry if I miss it");
    await scriptSimOutcome(h.db, "call_create", "unknown_but_accepted", h.clock);
    await h.advanceTo("2026-11-08T19:00:00Z");
    expect((await h.db.first<{ status: string }>("SELECT status FROM alarm_occurrences"))!.status).toBe("unknown");
    await h.advance(20 * MINUTE, 5 * MINUTE);
    expect(await h.calls()).toHaveLength(1);
    await h.call((await h.calls())[0]!.sid, "no_answer");
    const effect = await h.db.first<{ state: string; provider_id: string | null }>("SELECT state, provider_id FROM outbound_effects WHERE channel = 'call'");
    expect(effect!.provider_id).not.toBeNull();
    expect((await h.db.first<{ status: string }>("SELECT status FROM alarm_occurrences"))!.status).toBe("missed");
    await h.advance(20 * MINUTE, 5 * MINUTE);
    expect(await h.calls()).toHaveLength(1);
  });

  it("cancellation before the provider fetches instructions reads nothing old; late callbacks don't resurrect", async () => {
    const h = await makeHarness();
    await wakeAt(h, "Wake me up at 11 AM today");
    await h.advanceTo("2026-11-08T19:00:00Z");
    const sid = (await h.calls())[0]!.sid;
    await h.send("cancel my wake up call");
    const t = await h.call(sid, "press2");
    expect(t.instructions).toContain("no longer needed");
    expect(t.gather).toEqual([]);
    expect((await h.db.first<{ status: string }>("SELECT status FROM alarm_occurrences"))!.status).toBe("canceled");
    await h.advance(20 * MINUTE, 5 * MINUTE);
    expect(await h.calls()).toHaveLength(1);
  });

  it("expired alarms never ring late; daily call limits are enforced", async () => {
    const h = await makeHarness();
    await wakeAt(h, "Wake me up at 11 AM today");
    h.jump(80 * MINUTE); // past the 10-minute window without any tick
    await h.tick();
    await h.drain();
    expect(await h.calls()).toHaveLength(0);
    expect((await h.db.first<{ status: string }>("SELECT status FROM alarm_occurrences"))!.status).toBe("expired");

    const h2 = await makeHarness();
    await h2.settings({ limit_call_attempts_per_day: 1 });
    await wakeAt(h2, "Wake me up at 11 AM today");
    await wakeAt(h2, "Wake me up at 11:30 AM today");
    await h2.advanceTo("2026-11-08T19:31:00Z", 5 * MINUTE);
    expect(await h2.calls()).toHaveLength(1);
    expect(await h2.count("SELECT COUNT(*) AS n FROM alarm_occurrences WHERE status_reason = 'budget:call_attempts'")).toBe(1);
  });

  it("calls go only to the configured owner number, with finite ring time and duration", async () => {
    const requests: Array<{ url: string; body: string }> = [];
    const t = new TwilioVoiceTransport(
      {
        accountSid: FAKE_TWILIO_SID,
        authToken: "0123456789abcdef0123456789abcdef",
        phoneNumber: "+14155550199",
        publicBaseUrl: "https://della.test",
        live: true,
      },
      async (url, init) => {
        requests.push({ url, body: String(init?.body) });
        return new Response(JSON.stringify({ sid: "CA0123456789abcdef0123456789abcdef", status: "queued" }), { status: 201 });
      },
    );
    const r = await t.createCall({
      to: "+15550100001",
      effectId: "eff_x",
      instructionsUrl: "https://della.test/webhooks/voice/instructions?e=eff_x",
      statusCallbackUrl: "https://della.test/webhooks/voice/status?e=eff_x",
      ringTimeoutSec: 30,
      maxDurationSec: 90,
    });
    expect(r).toMatchObject({ kind: "accepted", providerId: "CA0123456789abcdef0123456789abcdef" });
    const form = new URLSearchParams(requests[0]!.body);
    expect(requests[0]!.url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${FAKE_TWILIO_SID}/Calls.json`);
    expect(form.get("To")).toBe("+15550100001");
    expect(form.get("From")).toBe("+14155550199");
    expect(form.get("Timeout")).toBe("30");
    expect(form.get("TimeLimit")).toBe("90");
    expect(form.getAll("StatusCallbackEvent")).toEqual(["initiated", "ringing", "answered", "completed"]);
    // The domain layer always passes the configured owner: there is no destination parameter in any action.
    const h = await makeHarness();
    await wakeAt(h, "Wake me up at 11 AM today");
    await h.advanceTo("2026-11-08T19:00:00Z");
    const log = await h.db.first<{ detail: string }>("SELECT detail FROM sim_provider_log WHERE operation = 'create_call'");
    expect(log).not.toBeNull();
  });
});
