import { env as baseEnv } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { Db } from "../../src/db/db";
import { InterpretationSchema } from "../../src/domain/actions";
import { formatDateTime } from "../../src/domain/time";
import { scriptSimOutcome } from "../../src/providers/simulated/common";
import { SIM_PRIMARY_CALENDAR, simMoveEvent, simSetRevoked, simUpsertExternalEvent } from "../../src/providers/simulated/calendar";
import type { Planner, PlannerResult } from "../../src/providers/types";
import { applyPostRestoreSafety, dumpDatabase, restoreDatabase, resumeAfterRestore } from "../../src/services/backup";
import { HOUR, MINUTE, T0, makeHarness, resetDatabase, type Harness } from "../helpers/harness";

declare module "vitest" {
  interface TaskMeta {
    evidence?: Record<string, unknown>;
  }
}

const LA = "America/Los_Angeles";
const at = (iso: string) => Date.parse(iso);

/** Transcript of owner/Della/provider messages since `from` (for evidence). */
async function transcript(h: Harness): Promise<string[]> {
  const rows = await h.db.all<{ direction: string; body: string }>("SELECT direction, body FROM sim_messages ORDER BY created_at, rowid");
  return rows.map((r) => `${r.direction === "from_owner" ? "OWNER" : r.direction === "provider_auto" ? "PROVIDER" : "DELLA"}: ${r.body}`);
}

async function sentBodies(h: Harness, pattern: RegExp): Promise<string[]> {
  return (await h.outbox()).filter((b) => pattern.test(b));
}

describe("Della acceptance scenarios (simulated providers, frozen clock 2026-11-08T18:00Z = Sun 10:00 PT)", () => {
  it("S1: reminder + follow-up from one message, accurate local date", async ({ task }) => {
    const h = await makeHarness();
    await h.send("Remind me tomorrow at 5 PM to finish the application, and ask at 8 PM if I have done it.");
    const reply = await h.lastReply();
    expect(reply).toMatch(/^Reminder set: Finish the application, Mon Nov 9, 5 PM PT\. I'll check at 8 PM if it's still open\. \[T[2-9A-Z]{3}\]$/);
    expect(await h.count("SELECT COUNT(*) AS n FROM tasks")).toBe(1);
    const rems = await h.db.all<{ kind: string; planned_at: number }>("SELECT kind, planned_at FROM reminders ORDER BY planned_at");
    expect(rems.map((r) => [r.kind, formatDateTime(r.planned_at, LA)])).toEqual([
      ["reminder", "Mon Nov 9, 5 PM PT"],
      ["followup", "Mon Nov 9, 8 PM PT"],
    ]);
    const task1 = await h.db.first<{ due_at: number }>("SELECT due_at FROM tasks");
    expect(formatDateTime(task1!.due_at, LA)).toBe("Mon Nov 9, 5 PM PT");
    task.meta.evidence = { transcript: await transcript(h), reminders: rems.map((r) => [r.kind, formatDateTime(r.planned_at, LA)]) };
  });

  it("S2: done [ID] after the reminder cancels the 8 PM follow-up", async ({ task }) => {
    const h = await makeHarness();
    await h.send("Remind me tomorrow at 5 PM to finish the application, and ask at 8 PM if I have done it.");
    const id = h.shortIdFrom(await h.lastReply());
    await h.advanceTo("2026-11-10T01:00:00Z", 30 * MINUTE); // Mon 5:00 PM PT
    expect(await h.lastReply()).toBe(`Reminder: Finish the application. Reply DONE when finished. [${id}]`);
    h.clock.advance(2 * MINUTE);
    await h.send(`done ${id}`);
    expect(await h.lastReply()).toBe(`Completed: Finish the application. Remaining checks canceled. [${id}]`);
    const before = (await h.outbox()).length;
    await h.advanceTo("2026-11-10T04:10:00Z", 10 * MINUTE); // past 8 PM
    expect((await h.outbox()).length).toBe(before);
    expect(await h.count("SELECT COUNT(*) AS n FROM reminders WHERE kind = 'followup' AND status = 'canceled'")).toBe(1);
    expect(await h.count("SELECT COUNT(*) AS n FROM jobs WHERE kind = 'send_reminder' AND status = 'pending'")).toBe(0);
    task.meta.evidence = { transcript: await transcript(h), followupSent: false };
  });

  it("S3: not yet → one-hour snooze; old jobs never fire", async ({ task }) => {
    const h = await makeHarness();
    await h.send("Remind me tomorrow at 5 PM to finish the application, and ask at 8 PM if I have done it.");
    const id = h.shortIdFrom(await h.lastReply());
    await h.advanceTo("2026-11-10T04:00:00Z", 30 * MINUTE); // Mon 8:00 PM
    expect(await h.lastReply()).toBe(`Did you finish: Finish the application? Reply DONE or NOT YET. [${id}]`);
    h.clock.advance(MINUTE);
    await h.send("not yet");
    expect(await h.lastReply()).toBe(`OK. 1) Snooze 1 hour 2) Check again in 2 hours 3) Stop checks. Reply 1, 2, or 3. [${id}]`);
    await h.send("1");
    expect(await h.lastReply()).toBe(`Snoozed: Finish the application until Mon Nov 9, 9:01 PM PT. Earlier checks canceled. [${id}]`);
    await h.advanceTo("2026-11-10T06:00:00Z", 5 * MINUTE); // 10 PM
    const reminders = await sentBodies(h, /^(Reminder:|Did you finish)/);
    expect(reminders).toEqual([
      `Reminder: Finish the application. Reply DONE when finished. [${id}]`,
      `Did you finish: Finish the application? Reply DONE or NOT YET. [${id}]`,
      `Reminder: Finish the application. Reply DONE when finished. [${id}]`,
    ]);
    const snoozed = await h.db.first<{ planned_at: number; status: string }>(
      "SELECT planned_at, status FROM reminders WHERE status_reason IS NULL OR status = 'sent' ORDER BY planned_at DESC LIMIT 1",
    );
    expect(formatDateTime(snoozed!.planned_at, LA)).toBe("Mon Nov 9, 9:01 PM PT");
    task.meta.evidence = { transcript: await transcript(h), proactiveSends: reminders.length };
  });

  it("S4: calendar event creation; duplicate inbound delivery creates nothing new", async ({ task }) => {
    const h = await makeHarness();
    const r = await h.send("Add badminton Tuesday from 7 PM to 9 PM.", { sid: "SMbadminton000000000000000000000001" });
    expect(await h.lastReply()).toBe("Added Badminton: Tue Nov 10, 7-9 PM PT.");
    const outboxBefore = (await h.outbox()).length;
    const dup = await h.send("Add badminton Tuesday from 7 PM to 9 PM.", { sid: r.messageSid });
    expect(dup.status).toBe(200);
    expect((await h.outbox()).length).toBe(outboxBefore);
    expect(await h.count("SELECT COUNT(*) AS n FROM sim_calendar_events")).toBe(1);
    expect(await h.count("SELECT COUNT(*) AS n FROM inbound_messages")).toBe(1);
    expect(await h.count("SELECT COUNT(*) AS n FROM plans")).toBe(1);
    task.meta.evidence = { transcript: await transcript(h), events: 1, duplicateAck: dup.status };
  });

  it("S5: move an ambiguous pre-existing appointment with confirmation and conditional update", async ({ task }) => {
    const h = await makeHarness();
    await simUpsertExternalEvent(h.db, h.clock, { eventId: "dentist1", summary: "Dentist appointment", startMs: at("2026-11-09T22:00:00Z"), endMs: at("2026-11-09T23:00:00Z") });
    await simUpsertExternalEvent(h.db, h.clock, { eventId: "advisor1", summary: "Advisor appointment", startMs: at("2026-11-09T18:00:00Z"), endMs: at("2026-11-09T18:30:00Z") });
    await h.send("Move my appointment tomorrow to 4 PM.");
    expect(await h.lastReply()).toBe("Which one to move: 1) Advisor appointment 10 AM 2) Dentist appointment 2 PM?");
    await h.send("2");
    const ask = await h.lastReply();
    expect(ask).toMatch(/^Move Dentist appointment from 2 PM to 4 PM Mon Nov 9\? Reply YES C[2-9A-Z]{3}\.$/);
    const etagBefore = (await h.db.first<{ etag_counter: number }>("SELECT etag_counter FROM sim_calendar_events WHERE event_id = 'dentist1'"))!.etag_counter;
    await h.send(`YES ${h.nonceFrom(ask)}`);
    expect(await h.lastReply()).toBe("Moved Dentist appointment: Mon Nov 9, 4-5 PM PT.");
    const ev = await h.db.first<{ etag_counter: number; data_json: string }>("SELECT etag_counter, data_json FROM sim_calendar_events WHERE event_id = 'dentist1'");
    expect(ev!.etag_counter).toBe(etagBefore + 1);
    expect(JSON.parse(ev!.data_json).startMs).toBe(at("2026-11-10T00:00:00Z"));
    // Reusing the consumed confirmation does nothing.
    await h.send(`YES ${h.nonceFrom(ask)}`);
    expect(await h.lastReply()).toMatch(/expired or was already used\. Nothing changed/);
    task.meta.evidence = { transcript: await transcript(h), etag: [etagBefore, ev!.etag_counter] };
  });

  it("S6: event moves shortly before its heads-up; reconciliation prevents the old-time message; one heads-up per instance", async ({ task }) => {
    const h = await makeHarness({ start: at("2026-11-09T21:50:00Z") }); // Mon 1:50 PM PT
    await h.settings({ calendar_headsup_enabled: 1, calendar_headsup_lead_minutes: 30 });
    await simUpsertExternalEvent(h.db, h.clock, { eventId: "sync1", summary: "Team sync", startMs: at("2026-11-09T23:00:00Z"), endMs: at("2026-11-09T23:30:00Z") });
    await h.advance(5 * MINUTE); // sync schedules the heads-up for 2:30 PM
    const scheduled = await h.db.first<{ planned_at: number }>("SELECT planned_at FROM calendar_headsups");
    expect(formatDateTime(scheduled!.planned_at, LA)).toBe("Mon Nov 9, 2:30 PM PT");
    await h.advanceTo("2026-11-09T22:22:00Z"); // 2:22 PM: someone moves it to 4 PM (between polls)
    await simMoveEvent(h.db, h.clock, SIM_PRIMARY_CALENDAR, "sync1", at("2026-11-10T00:00:00Z"), at("2026-11-10T00:30:00Z"));
    await h.advanceTo("2026-11-09T22:40:00Z");
    expect(await sentBodies(h, /^Heads-up/)).toEqual([]);
    await h.advanceTo("2026-11-09T23:35:00Z"); // past 3:30 PM
    expect(await sentBodies(h, /^Heads-up/)).toEqual(["Heads-up: Team sync at 4 PM (in 30 min)."]);
    await simMoveEvent(h.db, h.clock, SIM_PRIMARY_CALENDAR, "sync1", at("2026-11-10T01:00:00Z"), at("2026-11-10T01:30:00Z"));
    await h.advanceTo("2026-11-10T00:45:00Z", 5 * MINUTE);
    expect(await sentBodies(h, /^Heads-up/)).toHaveLength(1);
    task.meta.evidence = { headsups: await sentBodies(h, /^Heads-up/) };
  });

  it("S7: weekday wake-up calls need confirmation; keypad 1 acknowledges and cancels the retry", async ({ task }) => {
    const h = await makeHarness();
    await h.send("Call me at 7 AM on weekdays and retry once if I miss it.");
    const ask = await h.lastReply();
    expect(ask).toMatch(/^Set weekdays wake-up calls at 7 AM PT\? Press 1 on the call to confirm you're up, 2 to snooze\. One retry if missed\. Reply YES C[2-9A-Z]{3}\.$/);
    await h.send(`YES ${h.nonceFrom(ask)}`);
    expect(await h.lastReply()).toMatch(/^Wake-up calls set: weekdays at 7 AM, first Mon Nov 9, 7 AM PT\..*\[W[2-9A-Z]{3}\]$/);
    await h.advanceTo("2026-11-09T15:00:00Z", 30 * MINUTE); // Mon 7:00 AM
    const calls = await h.calls();
    expect(calls).toHaveLength(1);
    const t = await h.call(calls[0]!.sid, "press1");
    expect(t.instructions).toContain("This is your requested 7 AM wake-up call from Della. Press 1 to confirm you&apos;re awake, or 2 to snooze for ten minutes.");
    expect(t.gather).toEqual(['<?xml version="1.0" encoding="UTF-8"?><Response><Say>Confirmed. Have a good day.</Say><Hangup/></Response>']);
    await h.advanceTo("2026-11-09T15:30:00Z", 5 * MINUTE);
    expect(await h.calls()).toHaveLength(1);
    const occ = await h.db.first<{ status: string; acknowledged_via: string }>("SELECT status, acknowledged_via FROM alarm_occurrences ORDER BY intended_at LIMIT 1");
    expect(occ).toEqual({ status: "acknowledged", acknowledged_via: "keypad" });
    expect(await h.count("SELECT COUNT(*) AS n FROM jobs WHERE kind = 'alarm_call' AND status = 'pending' AND due_at < ?", at("2026-11-10T00:00:00Z"))).toBe(0);
    task.meta.evidence = { transcript: await transcript(h), calls: 1, occurrence: occ };
  });

  it("S8: missed call → one bounded retry → duplicate keypad 2 snoozes once → 'I'm awake' stops further calls", async ({ task }) => {
    const h = await makeHarness();
    await h.send("Call me at 7 AM on weekdays and retry once if I miss it.");
    await h.send(`YES ${h.nonceFrom(await h.lastReply())}`);
    await h.advanceTo("2026-11-09T15:00:00Z", 30 * MINUTE);
    const first = (await h.calls())[0]!;
    await h.call(first.sid, "no_answer");
    await h.advanceTo("2026-11-09T15:05:00Z");
    const calls = await h.calls();
    expect(calls).toHaveLength(2);
    const t = await h.call(calls[1]!.sid, "press2_duplicate");
    expect(t.gather).toEqual([
      '<?xml version="1.0" encoding="UTF-8"?><Response><Say>Snoozed. I&apos;ll call again in 10 minutes.</Say><Hangup/></Response>',
      '<?xml version="1.0" encoding="UTF-8"?><Response><Say>Already snoozed. Goodbye.</Say><Hangup/></Response>',
    ]);
    const occ = await h.db.first<{ snooze_count: number; status: string }>("SELECT snooze_count, status FROM alarm_occurrences ORDER BY intended_at LIMIT 1");
    expect(occ).toEqual({ snooze_count: 1, status: "snoozed" });
    h.clock.advance(MINUTE);
    await h.send("I'm awake");
    expect(await h.lastReply()).toBe("Got it, you're up. No more wake-up calls this morning.");
    await h.advanceTo("2026-11-09T15:45:00Z", 5 * MINUTE);
    expect(await h.calls()).toHaveLength(2);
    task.meta.evidence = { transcript: await transcript(h), calls: (await h.calls()).length };
  });

  it("S9: STOP while a reminder is queued suppresses all later SMS and calls", async ({ task }) => {
    const h = await makeHarness();
    await h.send("Remind me in 10 minutes to move the laundry");
    const before = (await h.outbox()).length;
    await h.send("Call me at 7 AM tomorrow");
    await h.send("STOP", { drain: false });
    await h.advance(20 * MINUTE);
    await h.advanceTo("2026-11-09T15:20:00Z", 30 * MINUTE);
    const after = await h.outbox();
    // Only the reply to the wake-up request (sent before STOP) was added; nothing after STOP.
    expect(after.length).toBe(before + 1);
    expect(await h.calls()).toHaveLength(0);
    expect(await h.count("SELECT COUNT(*) AS n FROM sim_messages WHERE direction = 'provider_auto'")).toBe(1);
    expect(await h.count("SELECT COUNT(*) AS n FROM suppressions WHERE state = 'opted_out'")).toBe(2);
    task.meta.evidence = {
      transcript: await transcript(h),
      note: "An SMS/call already accepted by the provider before STOP is processed cannot be recalled; Della stops initiating anything new once STOP is stored.",
    };
  });

  it("S10: AI down — stored reminders, explicit-ID completion, and STATUS still work; free text gets an honest limited reply", async ({ task }) => {
    const h = await makeHarness();
    await h.send("Remind me in 30 minutes to call the bank");
    const id = h.shortIdFrom(await h.lastReply());
    await scriptSimOutcome(h.db, "ai", "unavailable", h.clock, 5);
    await h.advance(30 * MINUTE);
    expect(await h.lastReply()).toBe(`Reminder: Call the bank. Reply DONE when finished. [${id}]`);
    await h.send("Remind me tomorrow at 9 AM to buy stamps");
    expect(await h.lastReply()).toBe("I can't interpret free-form requests right now. Simple commands still work: LIST, STATUS, DONE T4K8, PAUSE, RESUME.");
    await h.send(`done ${id}`);
    expect(await h.lastReply()).toBe(`Completed: Call the bank. [${id}]`);
    await h.send("STATUS");
    expect(await h.lastReply()).toMatch(/^Status: 0 open tasks\./);
    expect(await h.count("SELECT COUNT(*) AS n FROM ai_requests WHERE outcome = 'unavailable'")).toBe(1);
    task.meta.evidence = { transcript: await transcript(h) };
  });

  it("S11: queue send fails after durable ingestion; the minute tick recovers it exactly once", async ({ task }) => {
    const h = await makeHarness();
    h.dispatcher.fail = true;
    const r = await h.send("What can you do?", { drain: false });
    expect(r.status).toBe(200);
    expect(await h.count("SELECT COUNT(*) AS n FROM jobs WHERE kind = 'process_inbound' AND status = 'pending'")).toBe(1);
    h.dispatcher.fail = false;
    h.clock.advance(2 * MINUTE + 1000); // dispatch reservation expires
    await h.tick();
    const inboundJob = (await h.db.first<{ id: string }>("SELECT id FROM jobs WHERE kind = 'process_inbound'"))!.id;
    expect(h.dispatcher.published.filter((id) => id === inboundJob)).toHaveLength(1);
    for (const id of h.dispatcher.published) await h.processJob(id);
    await h.drain();
    expect((await h.outbox()).filter((b) => b.startsWith("I can:"))).toHaveLength(1);
    expect(await h.count("SELECT COUNT(*) AS n FROM plans")).toBe(1);
    task.meta.evidence = { recoveredBy: "cron tick", replies: 1 };
  });

  it("S12: provider timeout after possible acceptance → unknown, not resent; late callback reconciles", async ({ task }) => {
    const h = await makeHarness();
    await scriptSimOutcome(h.db, "sms_send", "unknown_but_accepted", h.clock);
    await h.send("What can you do?");
    const effect = await h.db.first<{ id: string; state: string }>("SELECT id, state FROM outbound_effects WHERE purpose = 'reply'");
    expect(effect!.state).toBe("unknown");
    await h.advance(10 * MINUTE);
    expect(await h.count("SELECT COUNT(*) AS n FROM sim_messages WHERE direction = 'to_owner'")).toBe(1);
    const sid = (await h.db.first<{ provider_sid: string }>("SELECT provider_sid FROM sim_messages WHERE direction = 'to_owner'"))!.provider_sid;
    expect(await h.deliver(sid, "delivered")).toBe(200);
    const after = await h.db.first<{ state: string; provider_id: string }>("SELECT state, provider_id FROM outbound_effects WHERE id = ?", effect!.id);
    expect(after).toEqual({ state: "delivered", provider_id: sid });
    task.meta.evidence = { states: ["unknown", after!.state], resent: false };
  });

  it("S13: Google consent revoked → calendar disconnected, task reminders continue", async ({ task }) => {
    const h = await makeHarness();
    await h.send("Remind me in 15 minutes to stretch");
    const id = h.shortIdFrom(await h.lastReply());
    await simSetRevoked(h.db, h.clock, true);
    await h.send("What's on my calendar today?");
    expect(await h.lastReply()).toBe("Calendar isn't connected, so I can't check it. Reconnect it in the admin dashboard.");
    expect((await h.db.first<{ status: string }>("SELECT status FROM calendar_connection"))!.status).toBe("needs_reconnect");
    await h.advance(16 * MINUTE);
    expect(await h.lastReply()).toBe(`Reminder: Stretch. Reply DONE when finished. [${id}]`);
    task.meta.evidence = { transcript: await transcript(h) };
  });

  it("S14: a daily 8 AM reminder stays at 8 AM local across the DST change", async ({ task }) => {
    const h = await makeHarness({ start: at("2027-03-12T18:00:00Z") }); // Fri Mar 12 2027 10:00 PST
    await h.send("Remind me every day at 8 AM to take vitamins");
    expect(await h.lastReply()).toMatch(/^Recurring reminder set: Take vitamins, daily at 8 AM PT, starting Sat Mar 13\. \[T[2-9A-Z]{3}\]$/);
    for (const day of ["2027-03-13T15:55:00Z", "2027-03-14T14:55:00Z", "2027-03-15T14:55:00Z"]) {
      h.clock.set(at(day));
      await h.tick();
      await h.advance(10 * MINUTE);
    }
    const sends = await h.db.all<{ requested_at: number }>("SELECT requested_at FROM outbound_effects WHERE purpose = 'reminder' ORDER BY requested_at");
    const times = sends.map((s) => formatDateTime(s.requested_at, LA));
    expect(times).toEqual(["Sat Mar 13, 8 AM PT", "Sun Mar 14, 8 AM PT", "Mon Mar 15, 8 AM PT"]);
    expect(sends.map((s) => new Date(s.requested_at).toISOString())).toEqual(["2027-03-13T16:00:00.000Z", "2027-03-14T15:00:00.000Z", "2027-03-15T15:00:00.000Z"]);
    task.meta.evidence = { sendTimesLocal: times, sendTimesUtc: sends.map((s) => new Date(s.requested_at).toISOString()) };
  });

  it("S15: prolonged outage recovers without expired wake-up calls or a reminder flood", async ({ task }) => {
    const h = await makeHarness();
    await h.send("Call me at 7 AM tomorrow");
    await h.send("Remind me tomorrow at 9 AM to submit the timesheet");
    await h.send("Remind me every day at 10 AM to water the plants");
    const before = (await h.outbox()).length;
    h.jump(27 * HOUR); // outage: Sun 10 AM → Mon 1 PM, no ticks ran
    await h.tick();
    await h.drain();
    await h.advance(5 * MINUTE);
    expect(await h.calls()).toHaveLength(0);
    expect((await h.db.first<{ status: string }>("SELECT status FROM alarm_occurrences"))!.status).toBe("expired");
    const after = (await h.outbox()).slice(before);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatch(/^I couldn't deliver 2 reminders on time: Submit the timesheet; Water the plants\. They're still open\./);
    expect(await h.count("SELECT COUNT(*) AS n FROM tasks WHERE series_id IS NOT NULL")).toBeLessThanOrEqual(2);
    task.meta.evidence = { afterOutage: after, callsPlaced: 0 };
  });

  it("S16: budget limits block additional live effects with one warning; the model cannot choose a destination", async ({ task }) => {
    const malicious: Planner = {
      name: "malicious-test",
      live: true,
      async interpret(): Promise<PlannerResult> {
        // Simulates a model emitting an extra destination field and a settings change it may not make.
        const raw = {
          intent: "exfiltrate",
          time_expressions: [],
          references: [],
          missing_fields: [],
          actions: [
            { type: "general_reply", text: "Sure.", to: "+19995550000", destination: "+19995550000" },
            {
              type: "update_allowed_settings",
              owner_phone: "+19995550000",
              display_name: null,
              timezone: null,
              quiet_start: null,
              quiet_end: null,
              morning_brief_enabled: null,
              morning_brief_time: null,
              followup_default_enabled: null,
              calendar_headsup_enabled: null,
              calendar_headsup_lead_minutes: null,
            },
          ],
        };
        return { kind: "ok", interpretation: InterpretationSchema.parse(raw), usage: { inputTokens: 10, outputTokens: 10 }, model: "test" };
      },
    };
    const h = await makeHarness({ planner: malicious });
    await h.settings({ limit_sms_segments_per_day: 3, limit_call_attempts_per_day: 1 });
    for (let i = 0; i < 5; i++) await h.send(`hello number ${i}`);
    const effects = await h.db.all<{ purpose: string; state: string; error_detail: string | null; destination: string; segments: number }>(
      "SELECT purpose, state, error_detail, destination, segments FROM outbound_effects ORDER BY created_at",
    );
    expect(effects.every((e) => e.destination === "owner")).toBe(true);
    const acceptedReplies = effects.filter((e) => e.purpose === "reply" && e.state === "accepted");
    expect(acceptedReplies.reduce((n, e) => n + e.segments, 0)).toBeLessThanOrEqual(3);
    expect(effects.filter((e) => e.error_detail === "budget:sms_segments").length).toBeGreaterThan(0);
    expect(await h.count("SELECT COUNT(*) AS n FROM outbound_effects WHERE purpose = 'warning'")).toBe(1);
    expect(await h.count("SELECT COUNT(*) AS n FROM sim_messages WHERE body LIKE '%+1999%'")).toBe(0);
    task.meta.evidence = { effects, ownerPhoneUnchanged: true };
  });

  it("S17: export/restore into a clean database keeps future schedules without immediate duplicate sends", async ({ task }) => {
    const h = await makeHarness();
    await h.send("Remind me tomorrow at 9 AM to renew the passport");
    await h.send("Remind me in 5 minutes to check the oven");
    await h.advance(6 * MINUTE);
    const sentBefore = await h.outbox();
    const dump = await dumpDatabase(h.db, h.clock.now());
    const restoreDb = (baseEnv as unknown as { DB_RESTORE: D1Database }).DB_RESTORE;
    await resetDatabase(restoreDb);
    await restoreDatabase(new Db(restoreDb), dump);
    const r = await makeHarness({ db: restoreDb, reset: false, connectCalendar: false, start: h.clock.now() });
    await applyPostRestoreSafety(r.ctx);
    await r.db.run("DELETE FROM sim_messages");
    await r.advance(10 * MINUTE);
    expect(await r.outbox()).toEqual([]);
    const res = await resumeAfterRestore(r.ctx);
    await r.advanceTo("2026-11-09T16:55:00Z", 30 * MINUTE);
    expect(await r.outbox()).toEqual([]);
    await r.advanceTo("2026-11-09T17:02:00Z");
    const after = await r.outbox();
    expect(after).toHaveLength(1);
    expect(after[0]).toMatch(/^Reminder: Renew the passport\./);
    expect(await r.count("SELECT COUNT(*) AS n FROM admin_sessions")).toBe(0);
    task.meta.evidence = { sentBeforeBackup: sentBefore.length, resume: res, afterRestore: after };
  });
});

export { T0 };
