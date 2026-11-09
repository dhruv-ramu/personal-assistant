import { describe, expect, it } from "vitest";
import { formatDateTime } from "../../src/domain/time";
import { simUpsertExternalEvent } from "../../src/providers/simulated/calendar";
import { MINUTE, makeHarness } from "../helpers/harness";
import { SpyPlanner, ts } from "../helpers/planners";

const LA = "America/Los_Angeles";

describe("task lifecycle over SMS", () => {
  it("create, list, change time, snooze, complete, reopen, cancel", async () => {
    const h = await makeHarness();
    await h.send("Remind me tomorrow at 5 PM to finish the application");
    const id = h.shortIdFrom(await h.lastReply());
    await h.send("LIST");
    expect(await h.lastReply()).toBe(`Open: 1) Finish the application (Mon Nov 9 5 PM) [${id}]`);
    await h.send(`${id} snooze 30 min`);
    expect(await h.lastReply()).toBe(`Snoozed: Finish the application until Sun Nov 8, 10:30 AM PT. Earlier checks canceled. [${id}]`);
    await h.send(`done ${id}`);
    expect(await h.lastReply()).toBe(`Completed: Finish the application. Remaining checks canceled. [${id}]`);
    await h.send(`reopen ${id}`);
    expect(await h.lastReply()).toBe(`Reopened: Finish the application. No reminders are scheduled; tell me a time to add one. [${id}]`);
    await h.send(`cancel ${id}`);
    expect(await h.lastReply()).toBe(`Canceled: Finish the application. [${id}]`);
    expect(await h.count("SELECT COUNT(*) AS n FROM reminders WHERE status = 'scheduled'")).toBe(0);
  });

  it("keeps task due time, reminder time, and follow-up time distinct", async () => {
    const spy = new SpyPlanner();
    spy.queue.push([
      {
        type: "create_task",
        title: "Tax return",
        notes: null,
        due: ts({ raw: "Friday 5pm", day_kind: "weekday", weekday: "fri", weekday_qualifier: "bare", hour: 5, minute: 0, meridiem: "pm" }),
        reminders: [ts({ raw: "Thursday 9am", day_kind: "weekday", weekday: "thu", weekday_qualifier: "bare", hour: 9, minute: 0, meridiem: "am" })],
        followups: [ts({ raw: "Thursday 6pm", day_kind: "weekday", weekday: "thu", weekday_qualifier: "bare", hour: 6, minute: 0, meridiem: "pm" })],
        recurrence: null,
        priority: "high",
      },
    ]);
    const h = await makeHarness({ planner: spy });
    await h.send("tax return due friday 5, remind me thursday 9am, check thursday 6pm");
    const t = await h.db.first<{ due_at: number }>("SELECT due_at FROM tasks");
    const r = await h.db.all<{ kind: string; planned_at: number }>("SELECT kind, planned_at FROM reminders ORDER BY planned_at");
    expect(formatDateTime(t!.due_at, LA)).toBe("Fri Nov 13, 5 PM PT");
    expect(r.map((x) => [x.kind, formatDateTime(x.planned_at, LA)])).toEqual([
      ["reminder", "Thu Nov 12, 9 AM PT"],
      ["followup", "Thu Nov 12, 6 PM PT"],
    ]);
  });

  it("bare DONE works with one recent task and asks when two could fit", async () => {
    const h = await makeHarness();
    await h.send("Remind me in 10 minutes to stretch");
    await h.advance(10 * MINUTE);
    await h.send("done");
    expect(await h.lastReply()).toMatch(/^Completed: Stretch\. \[T/);

    await h.send("Remind me in 10 minutes to call mom");
    const a = h.shortIdFrom(await h.lastReply());
    await h.send("Remind me in 10 minutes to pay rent");
    const b = h.shortIdFrom(await h.lastReply());
    await h.advance(10 * MINUTE);
    await h.send("done");
    const q = await h.lastReply();
    expect(q).toMatch(/^Which one to complete: 1\) .+ \[T...\] 2\) .+ \[T...\]\?$/);
    expect(q).toContain(a);
    expect(q).toContain(b);
    await h.send(b);
    expect(await h.lastReply()).toBe(`Completed: Pay rent. Remaining checks canceled. [${b}]`.replace(" Remaining checks canceled.", ""));
    expect((await h.db.first<{ status: string }>("SELECT status FROM tasks WHERE short_id = ?", a))!.status).toBe("open");
  });

  it("invented task IDs fail safely", async () => {
    const h = await makeHarness();
    await h.send("done TZZZ");
    expect(await h.lastReply()).toBe("I don't have a task TZZZ. Reply LIST to see open tasks.");
  });

  it("a clarification resumes the original action, and an explicit new command interrupts it", async () => {
    const h = await makeHarness();
    await h.send("Remind me tomorrow at 5 to call mom");
    expect(await h.lastReply()).toBe("Tomorrow at 5 AM or 5 PM?");
    await h.send("pm");
    expect(await h.lastReply()).toMatch(/^Reminder set: Call mom, Mon Nov 9, 5 PM PT\. \[T...\]$/);
    await h.send("Remind me tomorrow at 6 to water plants");
    expect(await h.lastReply()).toBe("Tomorrow at 6 AM or 6 PM?");
    await h.send("Add lunch with Sam tomorrow from 12 to 1 PM");
    expect(await h.lastReply()).toMatch(/^Added Lunch with Sam: Mon Nov 9, 12-1 PM PT/);
    expect(await h.count("SELECT COUNT(*) AS n FROM tasks")).toBe(1);
  });

  it("asks for a missing time instead of picking one", async () => {
    const h = await makeHarness();
    await h.send("Remind me tomorrow to buy stamps");
    expect(await h.lastReply()).toBe("What time tomorrow?");
    await h.send("9am");
    expect(await h.lastReply()).toMatch(/^Reminder set: Buy stamps, Mon Nov 9, 9 AM PT\./);
  });

  it("expired and already-consumed confirmations cannot execute", async () => {
    const h = await makeHarness();
    await h.send("Block 90 minutes for studying tomorrow afternoon");
    const ask = await h.lastReply();
    expect(ask).toMatch(/^Block Mon Nov 9, 12-1:30 PM PT for Studying\? Reply YES C...\.$/);
    h.clock.advance(16 * MINUTE);
    await h.send(`YES ${h.nonceFrom(ask)}`);
    expect(await h.lastReply()).toMatch(/expired or was already used\. Nothing changed/);
    expect(await h.count("SELECT COUNT(*) AS n FROM sim_calendar_events")).toBe(0);
    await h.send("Block 90 minutes for studying tomorrow afternoon");
    const again = await h.lastReply();
    await h.send(`yes ${h.nonceFrom(again)}`);
    expect(await h.lastReply()).toBe("Added Studying: Mon Nov 9, 12-1:30 PM PT.");
  });

  it("a target that changed after confirmation is re-validated, not overwritten", async () => {
    const h = await makeHarness();
    await simUpsertExternalEvent(h.db, h.clock, { eventId: "dent", summary: "Dentist", startMs: Date.parse("2026-11-09T22:00:00Z"), endMs: Date.parse("2026-11-09T23:00:00Z") });
    await h.send("Move my dentist tomorrow to 4 PM");
    const ask = await h.lastReply();
    await simUpsertExternalEvent(h.db, h.clock, { eventId: "dent", summary: "Dentist", startMs: Date.parse("2026-11-09T21:00:00Z"), endMs: Date.parse("2026-11-09T22:00:00Z") });
    await h.send(`YES ${h.nonceFrom(ask)}`);
    expect(await h.lastReply()).toBe("Dentist changed since I asked (now Mon Nov 9, 1-2 PM PT). Nothing changed; ask again if you still want it.");
  });

  it("multi-action partial failure reports per-action results; a retry resumes only unfinished work", async () => {
    const h = await makeHarness();
    const original = h.ctx.calendar.insertEvent.bind(h.ctx.calendar);
    let failures = 1;
    h.ctx.calendar.insertEvent = async (...args) => {
      if (failures-- > 0) throw new Error("transient bug");
      return original(...args);
    };
    await h.send("Remind me tomorrow at 9 AM to email Sam and add gym tomorrow from 6 PM to 7 PM", { drain: false });
    await h.drain(); // first attempt throws during action 2 → job retries
    expect(await h.count("SELECT COUNT(*) AS n FROM tasks")).toBe(1);
    h.clock.advance(2 * MINUTE);
    await h.drain();
    expect(await h.count("SELECT COUNT(*) AS n FROM tasks")).toBe(1);
    expect(await h.count("SELECT COUNT(*) AS n FROM sim_calendar_events")).toBe(1);
    const reply = await h.lastReply();
    expect(reply).toMatch(/^1\) Reminder set: Email Sam, Mon Nov 9, 9 AM PT\. \[T...\]\n2\) Added Gym: Mon Nov 9, 6-7 PM PT\.$/);

    await h.send("Remind me tomorrow at 10 AM to call Lee and move my unicorn meeting tomorrow to 3 PM");
    expect(await h.lastReply()).toMatch(/^1\) Reminder set: Call Lee, .*\n2\) I couldn't find "unicorn meeting" tomorrow\.$/);
  });

  it("recurring completion affects one occurrence; cancelling the series needs confirmation", async () => {
    const h = await makeHarness();
    await h.send("Remind me every day at 11 AM to drink water");
    const id = h.shortIdFrom(await h.lastReply());
    await h.advanceTo("2026-11-08T19:00:00Z");
    await h.send(`done ${id}`);
    expect(await h.lastReply()).toBe(`Completed: Drink water. This occurrence only; the recurring schedule continues. [${id}]`);
    await h.advanceTo("2026-11-09T19:00:00Z", 30 * MINUTE);
    const next = h.shortIdFrom(await h.lastReply());
    expect(next).not.toBe(id);
    const spy = new SpyPlanner();
    spy.queue.push([{ type: "cancel_task", task_ref: next, scope: "series" }]);
    const h2 = await makeHarness({ planner: spy, reset: false, start: h.clock.now(), connectCalendar: false });
    await h2.send("stop the water reminders entirely");
    const ask = await h2.lastReply();
    expect(ask).toMatch(/^Stop all future occurrences of "Drink water"\? Reply YES C...\.$/);
    await h2.send(`YES ${h2.nonceFrom(ask)}`);
    expect(await h2.lastReply()).toMatch(/^Stopped all future occurrences of Drink water/);
    expect((await h2.db.first<{ status: string }>("SELECT status FROM series"))!.status).toBe("canceled");
  });

  it("pause until Monday skips routine reminders; resume restores them", async () => {
    const h = await makeHarness();
    await h.send("Remind me in 30 minutes to stretch");
    await h.send("Pause reminders until Monday");
    expect(await h.lastReply()).toBe(
      "Reminders, check-ins, briefs, and heads-ups are paused (wake-up calls still ring) until Mon Nov 9, 12 AM PT. Replies to your texts still work.",
    );
    await h.advance(31 * MINUTE, 5 * MINUTE);
    expect((await h.outbox()).some((b) => b.startsWith("Reminder: Stretch"))).toBe(false);
    await h.send("resume");
    expect(await h.lastReply()).toMatch(/^Resumed\./);
  });

  it("help, status, and 'what have you scheduled' work", async () => {
    const h = await makeHarness();
    await h.send("What can you do?");
    expect(await h.lastReply()).toMatch(/^I can: set reminders/);
    await h.send("Remind me tomorrow at 9 AM to call the vet");
    await h.send("What have you scheduled?");
    expect(await h.lastReply()).toMatch(/^Scheduled: 1\) Call the vet \(Mon Nov 9 9 AM\) \[T...\]$/);
    await h.send("status");
    expect(await h.lastReply()).toMatch(/^Status: 1 open task\. Next reminder: Mon Nov 9, 9 AM PT\./);
  });

  it("timezone change asks whether recurring schedules follow; one-time instants are preserved", async () => {
    const h = await makeHarness();
    await h.send("Remind me every day at 8 AM to meditate");
    await h.send("Remind me tomorrow at 9 AM to call the bank");
    const oneTime = (await h.db.first<{ planned_at: number }>("SELECT planned_at FROM reminders r JOIN tasks t ON t.id = r.task_id WHERE t.series_id IS NULL"))!.planned_at;
    await h.send("My timezone is America/New_York");
    expect(await h.lastReply()).toMatch(/^Switching to America\/New_York\. Should your 1 recurring schedule 1\) follow the new timezone/);
    await h.send("2");
    expect(await h.lastReply()).toMatch(/keep their original timezone/);
    expect((await h.db.first<{ timezone: string }>("SELECT timezone FROM series"))!.timezone).toBe("America/Los_Angeles");
    expect((await h.db.first<{ planned_at: number }>("SELECT planned_at FROM reminders r JOIN tasks t ON t.id = r.task_id WHERE t.series_id IS NULL"))!.planned_at).toBe(oneTime);
  });

  it("states the attendee-invitation limitation instead of faking it", async () => {
    const h = await makeHarness();
    await h.send("Add dinner Friday at 7 PM and invite Priya");
    expect(await h.lastReply()).toBe("Calendar invitations aren't supported yet; I can add the event to your calendar without guests.");
  });
});
