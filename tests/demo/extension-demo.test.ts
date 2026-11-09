import { it } from "vitest";
import { scriptSimOutcome } from "../../src/providers/simulated/common";
import { SIM_PRIMARY_CALENDAR, simUpsertExternalEvent } from "../../src/providers/simulated/calendar";
import { HOUR, MINUTE, makeHarness } from "../helpers/harness";
import { enableExt, jpegWithExif, pairDevice, upload, uploadUrlFrom } from "../helpers/ext";

declare module "vitest" {
  interface TaskMeta {
    evidence?: Record<string, unknown>;
  }
}

/**
 * Integrated demo (simulated providers, fixed clock starting Sun 2026-11-08 10:00 PT). One
 * continuous story: household locations, a mixed project note, memory retrieval and update,
 * promise and decision, meeting brief, revised day, morning routine with device events, photo
 * accountability with simulated assessment, uncertainty, deletion, and source-backed summaries.
 */
it("extension demo", async ({ task }) => {
  const h = await makeHarness();
  const log: string[] = [];
  const step = (title: string) => log.push("", `## ${title}`);
  const say = async (text: string) => {
    await h.send(text);
    log.push(`OWNER: ${text}`, `DELLA: ${await h.lastReply()}`);
  };
  const newMessages = async (from: number) => {
    for (const m of await h.outboxSince(from)) log.push(`DELLA (proactive): ${m}`);
  };

  step("Setup: owner enables features by SMS (all off by default)");
  for (const f of ["enable memory", "enable accountability", "enable morning routines", "enable meeting prep"]) await say(f);
  await enableExt(h, { telemetry_enabled: 1, assessment_enabled: 1, semantic_enabled: 1 });
  log.push("(dashboard) Browser check-ins, AI photo assessment (simulated), and semantic search (local hash index) turned on.");

  step("Household locations");
  await say("I put my passport in the blue folder in the bottom drawer of my desk.");
  await say("Maybe the car keys are in my backpack.");
  await say("I lent my bike pump to Sam.");
  await say("I'm waiting on Sam to return the bike pump, check Friday at 6 PM.");
  await say("I prefer morning workouts.");
  await say("Where is my passport?");
  await say("What's in the bottom drawer?");
  await say("Why?");

  step("Mixed project note");
  await say(
    "Remind me tomorrow at 9 AM to email the TA. Idea: build a flashcard app after finals. I need to ask Professor Lee about the curve. Maybe I'll join the hiking club. Stopping here on Thesis: done the intro; tried dataset B; next rerun the baseline.",
  );

  step("Update memories");
  await say("I moved the blue folder into the safe.");
  await say("Where is my passport?");
  await say("My car keys are not in my backpack.");
  await say("Where are my car keys?");

  step("Promise and decision");
  await say("I promised Alex I'd send the slides by Friday.");
  await say("I decided to use Postgres instead of MySQL because of JSON support; assuming the team knows SQL.");
  await say("What did I promise Alex?");

  step("Meeting on the (simulated) calendar: Office hours with Professor Lee, Mon 2 PM");
  const start = Date.parse("2026-11-09T22:00:00Z");
  await simUpsertExternalEvent(h.db, h.clock, {
    eventId: "demo-lee",
    summary: "Office hours with Professor Lee",
    startMs: start,
    endMs: start + HOUR,
    calendarId: SIM_PRIMARY_CALENDAR,
  });
  await h.advance(10 * MINUTE, 10 * MINUTE);
  log.push("(calendar sync scheduled a prep brief for 1:30 PM Monday)");

  step("Revised day");
  await say("Add task: finish the report by tomorrow at 5 PM");
  await say("Finish the report takes 90 minutes on laptop.");
  await say("plan my day");
  await say("bad day");

  step("Morning routine with simulated device events (Mon Nov 9)");
  const dev = await pairDevice(h, "Laptop Firefox (simulated)");
  log.push(`(dashboard) Paired simulated browser ${dev.deviceId} with a one-time code.`);
  await say("morning routine at 7 AM weekdays, gym first, laptop check-in");
  await say(`YES ${h.nonceFrom(await h.lastReply())}`);
  let mark = (await h.outbox()).length;
  await h.advanceTo("2026-11-09T15:00:00Z", 30 * MINUTE);
  await newMessages(mark);
  const call = (await h.calls()).at(-1)!;
  await h.call(call.sid, "press1");
  log.push("CALL: wake call answered; keypad 1 (acknowledgement satisfies only the call stage).");
  mark = (await h.outbox()).length;
  await h.advanceTo("2026-11-09T15:05:30Z");
  await newMessages(mark);
  const sync = await dev.sync();
  const ch = sync.json.challenge as { nonce: string; checkpointId: string };
  log.push(`BROWSER: poll → challenge for checkpoint ${ch.checkpointId.slice(0, 12)}…; owner clicks → ${JSON.stringify((await dev.checkin(ch)).json)}`);
  mark = (await h.outbox()).length;
  await h.advanceTo("2026-11-09T15:15:30Z");
  await newMessages(mark);
  const gymLink = uploadUrlFrom(await h.lastReply());
  const up = await upload(h, gymLink, [{ bytes: jpegWithExif(), name: "gym.jpg", type: "image/jpeg" }]);
  log.push(`UPLOAD: gym photo → HTTP ${up.status}; metadata stripped; simulated assessor runs.`);
  mark = (await h.outbox()).length;
  await h.advanceTo("2026-11-09T15:31:00Z");
  await newMessages(mark);
  await say("On the rower, 15 minutes in");
  mark = (await h.outbox()).length;
  await h.advanceTo("2026-11-09T16:00:00Z", 5 * MINUTE);
  await newMessages(mark);

  step("Photo accountability session with simulated assessment (Mon Nov 9, 10:30)");
  await h.advanceTo("2026-11-09T18:00:00Z", 30 * MINUTE);
  await say("hold me accountable for finish the report from 10:30 AM to 11:30 AM, photo at start, progress halfway");
  mark = (await h.outbox()).length;
  await h.advanceTo("2026-11-09T18:30:30Z");
  await newMessages(mark);
  await scriptSimOutcome(h.db, "vision", "refusal", h.clock);
  mark = (await h.outbox()).length;
  await upload(h, uploadUrlFrom(await h.lastReply()), [{ bytes: jpegWithExif(), name: "blurry.jpg", type: "image/jpeg" }]);
  log.push("UPLOAD: blurry desk photo (assessor scripted to 'unclear').");
  await newMessages(mark);
  await say("Desk is set up and the outline is open");
  mark = (await h.outbox()).length;
  await h.advanceTo("2026-11-09T19:00:30Z");
  await newMessages(mark);
  await say("Intro and methods drafted");
  mark = (await h.outbox()).length;
  await h.advanceTo("2026-11-09T19:45:00Z", 5 * MINUTE);
  await newMessages(mark);

  step("Meeting brief arrives (Mon 1:30 PM)");
  mark = (await h.outbox()).length;
  await h.advanceTo("2026-11-09T21:31:00Z", 15 * MINUTE);
  await newMessages(mark);

  step("Uncertainty and deletion");
  await say("What have you learned about me?");
  await say("Where is my unicorn?");
  await say("Don't store this: I put my spare key under the mat.");
  await say("forget bike pump");
  await say("What did you change today?");

  step("Source-backed summaries");
  await say("Where has my passport been?");
  await say("Why?");
  await say("resume thesis");
  await say("Who am I waiting on?");
  await say("what did i decide");

  const counts = {
    entities: await h.count("SELECT COUNT(*) AS n FROM entities WHERE status = 'active'"),
    currentFacts: await h.count("SELECT COUNT(*) AS n FROM assertions WHERE status = 'current'"),
    tentative: await h.count("SELECT COUNT(*) AS n FROM assertions WHERE status = 'tentative'"),
    deletedFacts: await h.count("SELECT COUNT(*) AS n FROM assertions WHERE status = 'deleted'"),
    secretaryItems: await h.count("SELECT COUNT(*) AS n FROM secretary_items WHERE deleted_at IS NULL"),
    sessions: await h.db.all("SELECT kind, state FROM acc_sessions ORDER BY intended_start"),
    calls: (await h.calls()).length,
    vectors: await h.count("SELECT COUNT(*) AS n FROM semantic_vectors"),
  };
  log.push("", "## Final state", "```json", JSON.stringify(counts, null, 2), "```");
  task.meta.evidence = { transcript: log };
});
