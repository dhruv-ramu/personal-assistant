import { describe, expect, it } from "vitest";
import { formatDateTime } from "../../src/domain/time";
import { simSetRevoked, simUpsertExternalEvent } from "../../src/providers/simulated/calendar";
import { HOUR, MINUTE, makeHarness } from "../helpers/harness";

const LA = "America/Los_Angeles";

describe("proactive policies", () => {
  it("morning brief lists real calendar events and due tasks; never fabricates an agenda", async () => {
    const h = await makeHarness({ start: Date.parse("2026-11-09T07:00:00Z") }); // Sun 11 PM PT
    await h.settings({ morning_brief_enabled: 1, morning_brief_minute: 8 * 60 });
    await simUpsertExternalEvent(h.db, h.clock, { eventId: "m1", summary: "Standup", startMs: Date.parse("2026-11-09T17:00:00Z"), endMs: Date.parse("2026-11-09T17:15:00Z") });
    await h.send("Remind me at 5 PM tomorrow to send the invoice");
    await h.advanceTo("2026-11-09T16:01:00Z", 30 * MINUTE); // Mon 8:01 AM
    const brief = (await h.outbox()).find((b) => b.startsWith("Today"));
    expect(brief).toMatch(/^Today \(Mon Nov 9\): 9 AM Standup\. Due today: Send the invoice \[T...\]\.$/);

    const h2 = await makeHarness({ start: Date.parse("2026-11-09T07:00:00Z") });
    await h2.settings({ morning_brief_enabled: 1, morning_brief_minute: 8 * 60 });
    await simSetRevoked(h2.db, h2.clock, true);
    await h2.advanceTo("2026-11-09T16:01:00Z", 30 * MINUTE);
    expect((await h2.outbox()).find((b) => b.includes("Calendar"))).toMatch(/^Calendar isn't connected, so I can't check it\..* No tasks due today\.$/);
  });

  it("routine (default) follow-ups defer out of quiet hours; explicit times are honoured", async () => {
    const h = await makeHarness();
    await h.settings({ followup_default_enabled: 1, followup_default_delay_minutes: 120 });
    await h.send("Remind me tonight at 9:30 PM to lock the door");
    const fu = await h.db.first<{ planned_at: number; quiet_policy: string }>("SELECT planned_at, quiet_policy FROM reminders WHERE kind = 'followup'");
    expect(fu!.quiet_policy).toBe("defer");
    expect(formatDateTime(fu!.planned_at, LA)).toBe("Sun Nov 8, 11:30 PM PT");
    await h.advanceTo("2026-11-09T07:35:00Z", 30 * MINUTE); // 11:35 PM: inside quiet hours
    expect((await h.outbox()).some((b) => b.startsWith("Did you finish"))).toBe(false);
    await h.advanceTo("2026-11-09T15:00:00Z", 60 * MINUTE); // 7:00 AM: quiet hours end
    expect((await h.outbox()).filter((b) => b.startsWith("Did you finish"))).toHaveLength(1);

    const h2 = await makeHarness();
    await h2.send("Remind me tonight at 11:45 PM to take medication");
    await h2.advanceTo("2026-11-09T07:45:00Z", 15 * MINUTE);
    expect(await h2.lastReply()).toMatch(/^Reminder: Take medication\./);
  });

  it("caps routine follow-ups at two per occurrence with at least two hours between", async () => {
    const h = await makeHarness();
    await h.settings({ followup_default_enabled: 1, followup_default_delay_minutes: 60, quiet_start_minute: 0, quiet_end_minute: 0 });
    await h.send("Remind me in 10 minutes to file the report");
    await h.advance(12 * HOUR, 30 * MINUTE);
    const asks = (await h.outbox()).filter((b) => b.startsWith("Did you finish"));
    expect(asks).toHaveLength(2);
    const times = await h.db.all<{ updated_at: number }>("SELECT updated_at FROM reminders WHERE kind = 'followup' AND status = 'sent' ORDER BY updated_at");
    expect(times[1]!.updated_at - times[0]!.updated_at).toBeGreaterThanOrEqual(2 * HOUR);
  });

  it("busy and out-of-order call callbacks never regress or duplicate state", async () => {
    const h = await makeHarness();
    await h.send("Wake me up at 11 AM today and retry if I miss it");
    await h.advanceTo("2026-11-08T19:00:00Z");
    await h.call((await h.calls())[0]!.sid, "busy");
    expect((await h.db.first<{ status: string }>("SELECT status FROM alarm_occurrences"))!.status).toBe("retry_scheduled");
    await h.advanceTo("2026-11-08T19:05:00Z");
    await h.call((await h.calls())[1]!.sid, "out_of_order");
    const effects = await h.db.all<{ provider_status: string; state: string }>("SELECT provider_status, state FROM outbound_effects WHERE channel = 'call' ORDER BY created_at");
    expect(effects.map((e) => e.provider_status)).toEqual(["busy", "completed"]);
    expect((await h.db.first<{ status: string }>("SELECT status FROM alarm_occurrences"))!.status).toBe("missed");
    await h.advance(30 * MINUTE, 5 * MINUTE);
    expect(await h.calls()).toHaveLength(2);
  });
});
