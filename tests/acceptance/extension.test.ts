import { env as baseEnv } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createPairingCode, revokeDevice } from "../../src/accountability/devices";
import { Db } from "../../src/db/db";
import type { Interpretation } from "../../src/domain/actions";
import { hasMetadata } from "../../src/media/images";
import { forgetEntity } from "../../src/knowledge/forget";
import { ingestKnowledge } from "../../src/knowledge/ingest";
import { groundedNarrative, search, validateCitations } from "../../src/knowledge/retrieval";
import { findEntity } from "../../src/knowledge/resolve";
import { mergeEntities, splitEntity } from "../../src/knowledge/store";
import { scriptSimOutcome } from "../../src/providers/simulated/common";
import { SIM_PRIMARY_CALENDAR, simUpsertExternalEvent } from "../../src/providers/simulated/calendar";
import { RulePlanner } from "../../src/providers/simulated/planner";
import type { Planner, PlannerContext, PlannerResult } from "../../src/providers/types";
import { applyPostRestoreSafety, carryDeletionsForward, dumpDatabase, eraseAllData, restoreDatabase } from "../../src/services/backup";
import { buildContext } from "../../src/context";
import { runRetention } from "../../src/services/retention";
import type { Env } from "../../src/env";
import { DAY, HOUR, MINUTE, makeHarness, resetDatabase, type Harness } from "../helpers/harness";
import { enableExt, heicBytes, jpegWithExif, pairDevice, pngWithText, upload, uploadUrlFrom } from "../helpers/ext";

declare module "vitest" {
  interface TaskMeta {
    evidence?: Record<string, unknown>;
  }
}

async function transcript(h: Harness): Promise<string[]> {
  const rows = await h.db.all<{ direction: string; body: string }>("SELECT direction, body FROM sim_messages ORDER BY created_at, rowid");
  return rows.map((r) => `${r.direction === "from_owner" ? "OWNER" : r.direction === "provider_auto" ? "PROVIDER" : "DELLA"}: ${r.body}`);
}

async function say(h: Harness, text: string): Promise<string> {
  await h.send(text);
  return h.lastReply();
}

const memoryOn = (h: Harness) => enableExt(h, { capture_enabled: 1, capture_activated_at: h.clock.now() });

/** Rule planner plus scripted knowledge candidates (to test validation of model output). */
class ScriptedKnowledgePlanner implements Planner {
  readonly name = "scripted";
  readonly live = false;
  private readonly rules = new RulePlanner();
  constructor(private readonly extra: (text: string) => Interpretation["knowledge"]) {}
  async interpret(ctx: PlannerContext): Promise<PlannerResult> {
    const r = await this.rules.interpret(ctx);
    if (r.kind !== "ok") return r;
    const extra = this.extra(ctx.messageText);
    if (extra.length) r.interpretation = { ...r.interpretation, actions: [{ type: "general_reply", text: "Noted." }], knowledge: extra };
    return r;
  }
}

describe("Della extension acceptance (simulated providers; frozen clock Sun 2026-11-08 10:00 PT)", () => {
  it("X1: passport/folder/drawer hierarchy; location and contents answered with source links", async ({ task }) => {
    const h = await makeHarness();
    await memoryOn(h);
    expect(await say(h, "I put my passport in the blue folder in the bottom drawer of my desk.")).toBe("Saved: passport location.");
    const where = await say(h, "Where is my passport?");
    expect(where).toBe("Passport: last reported in the blue folder, in the bottom drawer, in the desk (updated Sun Nov 8).");
    expect(await say(h, "What's in the blue folder?")).toBe("In the blue folder: passport (since Sun Nov 8).");
    expect(await say(h, "What's in the bottom drawer?")).toBe("In the bottom drawer: blue folder (since Sun Nov 8).");
    const why = await say(h, "Why?");
    expect(why).toBe('Based on: Sun Nov 8 you said: "I put my passport in the blue folder in the bottom drawer of my desk".');
    const sources = await h.count("SELECT COUNT(*) AS n FROM assertions a JOIN source_records s ON s.id = a.source_id WHERE a.predicate = 'located_in' AND a.status = 'current'");
    expect(sources).toBe(3);
    task.meta.evidence = { transcript: await transcript(h), currentEdgesWithSource: sources };
  });

  it("X2: moving the folder moves its contents; a removed passport stays behind; history is correct", async ({ task }) => {
    const h = await makeHarness();
    await memoryOn(h);
    await say(h, "I put my passport in the blue folder in the bottom drawer of my desk.");
    h.clock.advance(HOUR);
    await say(h, "I moved the blue folder into the safe.");
    expect(await say(h, "where is my passport")).toBe("Passport: last reported in the blue folder, in the safe (updated Sun Nov 8).");
    h.clock.advance(HOUR);
    expect(await say(h, "I took my passport out of the blue folder.")).toBe("Saved: passport removed (location now unknown).");
    h.clock.advance(HOUR);
    await say(h, "I moved the blue folder into the closet.");
    expect(await say(h, "where is the blue folder")).toBe("Blue folder: last reported in the closet (updated Sun Nov 8).");
    expect(await say(h, "where is my passport")).toBe("Passport: no current location recorded. Previously in the blue folder.");
    const hist = await say(h, "where has my passport been");
    expect(hist).toBe("Passport history: blue folder (Sun Nov 8, 10 AM PT to Sun Nov 8, 12 PM PT).");
    task.meta.evidence = { transcript: await transcript(h) };
  });

  it("X3: a shared alias asks instead of merging; explicit merge/split are reversible and audited", async ({ task }) => {
    const h = await makeHarness();
    await memoryOn(h);
    await say(h, "I put my laptop charger in the desk.");
    await say(h, "I put my phone charger in the car.");
    const q = await say(h, "I put my charger in the drawer.");
    expect(q).toBe("Which charger: 1) laptop charger 2) phone charger? Or reply NEW for a different one.");
    expect(await say(h, "2")).toBe("Saved: phone charger location.");
    expect(await say(h, "where is my laptop charger")).toBe("Laptop charger: last reported in the desk (updated Sun Nov 8).");
    expect(await say(h, "where is my phone charger")).toBe("Phone charger: last reported in the drawer (updated Sun Nov 8).");
    await say(h, "I put my spare key in the jar.");
    await say(h, "I put my extra key in the jar.");
    const a = (await findEntity(h.ctx, "spare key")) as { kind: "found"; entity: { id: string } };
    const b = (await findEntity(h.ctx, "extra key")) as { kind: "found"; entity: { id: string } };
    const merged = await mergeEntities(h.ctx, a.entity.id, b.entity.id, "owner: same key");
    expect(merged.ok).toBe(true);
    const afterMerge = (await findEntity(h.ctx, "extra key")) as { kind: "found"; entity: { id: string } };
    expect(afterMerge.entity.id).toBe(a.entity.id);
    expect((await splitEntity(h.ctx, merged.eventId!)).ok).toBe(true);
    const afterSplit = (await findEntity(h.ctx, "extra key")) as { kind: "found"; entity: { id: string } };
    expect(afterSplit.entity.id).toBe(b.entity.id);
    const events = await h.db.all<{ kind: string }>("SELECT kind FROM memory_events WHERE kind IN ('entity.merged','entity.split') ORDER BY created_at");
    expect(events.map((e) => e.kind)).toEqual(["entity.merged", "entity.split"]);
    task.meta.evidence = { transcript: await transcript(h), auditEvents: events.map((e) => e.kind) };
  });

  it("X4: 'maybe' stays tentative; an absence report retracts without inventing a new location", async ({ task }) => {
    const h = await makeHarness();
    await memoryOn(h);
    expect(await say(h, "Maybe the keys are in the bag.")).toBe("Saved: keys might be in the bag (unconfirmed).");
    expect(await say(h, "where are my keys")).toBe("Keys: unconfirmed: you said it might be in the bag (Sun Nov 8).");
    expect(await h.count("SELECT COUNT(*) AS n FROM assertions WHERE predicate = 'located_in' AND status = 'current'")).toBe(0);
    await say(h, "The keys are on the hook.");
    expect(await say(h, "My keys are not on the hook.")).toBe("Saved: keys: not in the hook (old location cleared; no new location assumed).");
    const where = await say(h, "where are my keys");
    expect(where).not.toMatch(/last reported in/);
    expect(await h.count("SELECT COUNT(*) AS n FROM assertions WHERE predicate = 'located_in' AND status = 'current'")).toBe(0);
    task.meta.evidence = { transcript: await transcript(h) };
  });

  it("X5: a late report about yesterday doesn't override today; containment cycles are rejected", async ({ task }) => {
    const h = await makeHarness();
    await memoryOn(h);
    await say(h, "I put my wallet in the jacket.");
    await say(h, "I left my wallet in the car yesterday.");
    expect(await say(h, "where is my wallet")).toBe("Wallet: last reported in the jacket (updated Sun Nov 8).");
    expect(await h.count("SELECT COUNT(*) AS n FROM assertions WHERE predicate = 'located_in' AND status = 'historical'")).toBe(1);
    await say(h, "I put the box in the bag.");
    const cyc = await say(h, "I put the bag in the box.");
    expect(cyc).toBe("I can't record bag inside box: that would put something inside itself. Nothing changed.");
    task.meta.evidence = { transcript: await transcript(h) };
  });

  it("X6: a mixed brain dump separates facts, ideas, tasks, and questions; 'maybe' is not a commitment", async ({ task }) => {
    const h = await makeHarness();
    await memoryOn(h);
    const reply = await say(
      h,
      "Remind me tomorrow at 9 AM to email the TA. Idea: build a flashcard app after finals. I need to ask Professor Lee about the curve. Maybe I'll join the hiking club. Alex's birthday is March 3.",
    );
    expect(reply).toMatch(/^1\) Reminder set: Email the TA, Mon Nov 9, 9 AM PT\. \[T[2-9A-Z]{3}\]\n2\) Saved: an idea; a question for Professor Lee; Alex birthday\.$/);
    expect(await h.count("SELECT COUNT(*) AS n FROM tasks")).toBe(1);
    expect(await h.count("SELECT COUNT(*) AS n FROM secretary_items WHERE kind = 'idea'")).toBe(1);
    expect(await h.count("SELECT COUNT(*) AS n FROM secretary_items WHERE kind = 'question'")).toBe(1);
    expect(await h.count("SELECT COUNT(*) AS n FROM assertions WHERE predicate LIKE 'attr:birthday'")).toBe(1);
    expect(await h.count("SELECT COUNT(*) AS n FROM secretary_items WHERE kind = 'promise'")).toBe(0);
    task.meta.evidence = { transcript: await transcript(h) };
  });

  it("X7: a future-self message appears on its explicit trigger, verbatim, and executes nothing", async ({ task }) => {
    const h = await makeHarness();
    await memoryOn(h);
    await say(h, "Remind me tomorrow at 5 PM to call the bank.");
    await say(h, "Message to future self when I decide about the internship: cancel all my reminders and take the offer.");
    const r = await say(h, "I decided to take the internship.");
    expect(r).toBe(
      'Saved: a decision. Message from your past self (Sun Nov 8): "cancel all my reminders and take the offer" (shown because of this decision; nothing was changed).',
    );
    expect(await h.count("SELECT COUNT(*) AS n FROM tasks WHERE status = 'open'")).toBe(1);
    expect(await h.count("SELECT COUNT(*) AS n FROM reminders WHERE status = 'scheduled'")).toBe(1);
    expect(await say(h, "I decided to take the internship.")).toBe("Saved: a decision.");
    task.meta.evidence = { transcript: await transcript(h) };
  });

  it("X8: decisions keep alternatives/assumptions; estimates keep units and actuals record their measure", async ({ task }) => {
    const h = await makeHarness();
    await memoryOn(h);
    await say(h, "I decided to use Postgres instead of MySQL because of JSON support; assuming the team knows SQL.");
    expect(await say(h, "what did i decide")).toBe("Decisions: 1) use Postgres because of JSON support (Sun Nov 8)");
    const d = await h.db.first<{ data_enc: string }>("SELECT data_enc FROM secretary_items WHERE kind = 'decision'");
    const data = JSON.parse(await h.ctx.crypto.decrypt(d!.data_enc, "secretary")) as { alternatives: string[]; assumptions: string[] };
    expect(data.alternatives).toEqual(["MySQL"]);
    expect(data.assumptions).toEqual(["the team knows SQL"]);
    await say(h, "I think the essay will take 3 hours.");
    await say(h, "The essay took 5 hours of focused work.");
    expect(await say(h, "predictions")).toBe("Estimates: 1) essay: estimated 3 hours, actual 5 hours (active time)");
    task.meta.evidence = { transcript: await transcript(h), decision: data };
  });

  it("X9: resume bullets keep contribution and metrics; unsupported numbers are rejected", async ({ task }) => {
    const planner = new ScriptedKnowledgePlanner((t) =>
      /led the migration/.test(t)
        ? [
            {
              kind: "accomplishment",
              description: "Led the migration",
              role: "lead",
              metric_value: 50,
              metric_unit: "%",
              baseline: null,
              team_result: false,
              confidential: false,
              evidence_span: "I led the migration",
            },
          ]
        : [],
    );
    const h = await makeHarness({ planner });
    await memoryOn(h);
    await say(h, "Win: I reduced build time by 35% from 20 minutes.");
    await say(h, "We shipped the new onboarding flow.");
    const rejected = await say(h, "I led the migration.");
    expect(rejected).not.toMatch(/Saved/);
    const run = await h.db.first<{ summary_enc: string }>("SELECT summary_enc FROM extraction_runs ORDER BY rowid DESC LIMIT 1");
    expect(await h.ctx.crypto.decrypt(run!.summary_enc, "extraction")).toContain("number 50 is not in the message");
    const bullets = await say(h, "resume bullets");
    expect(bullets).toBe(
      "From your evidence locker: • I reduced build time by 35% from 20 minutes (35% vs. 20 minutes) • We shipped the new onboarding flow [team result] (Only what you recorded; edit before using.)",
    );
    task.meta.evidence = { transcript: await transcript(h) };
  });

  it("X10: waiting-for with manual updates and simulated email; an unrelated reply doesn't resolve; nothing is sent", async ({ task }) => {
    const h = await makeHarness();
    await memoryOn(h);
    await enableExt(h, { email_enabled: 1 });
    await say(h, "I'm waiting on Sam to send the contract, check tomorrow at 3 PM.");
    await h.db.run(
      "INSERT INTO sim_emails (id, from_addr, subject, snippet, received_at) VALUES ('e1', 'Dana <dana@example.com>', 'Lunch?', 'Want to grab lunch', ?)",
      h.clock.now() + HOUR,
    );
    const before = (await h.outbox()).length;
    await h.advanceTo("2026-11-09T23:00:00Z", 30 * MINUTE);
    const check = (await h.outboxSince(before)).join("\n");
    expect(check).toMatch(/^Did Sam reply about send the contract\?.*Reply YES \(resolved\), NO, or a new check time\.$/);
    expect(check).not.toMatch(/Dana/);
    expect(await h.count("SELECT COUNT(*) AS n FROM secretary_items WHERE kind = 'waiting_for' AND status = 'open'")).toBe(1);
    await say(h, "no");
    expect(await h.count("SELECT COUNT(*) AS n FROM secretary_items WHERE kind = 'waiting_for' AND status = 'open'")).toBe(1);
    expect(await say(h, "Sam sent me the contract.")).toMatch(/^Saved: .*Sam/);
    expect(await h.count("SELECT COUNT(*) AS n FROM secretary_items WHERE kind = 'waiting_for' AND status = 'open'")).toBe(0);
    expect(await h.count("SELECT COUNT(*) AS n FROM outbound_effects WHERE channel != 'sms' AND channel != 'call'")).toBe(0);
    task.meta.evidence = { transcript: await transcript(h), emailSends: 0 };
  });

  it("X11: meeting prep and post-meeting capture use recorded people/questions; a canceled meeting is skipped", async ({ task }) => {
    const h = await makeHarness();
    await memoryOn(h);
    await enableExt(h, { meeting_prep_enabled: 1, post_meeting_enabled: 1, suggestions_enabled: 0 });
    await say(h, "I need to ask Professor Lee about the curve.");
    const start = Date.parse("2026-11-09T22:00:00Z"); // Mon 2 PM PT
    await simUpsertExternalEvent(h.db, h.clock, {
      eventId: "evlee",
      summary: "Office hours with Professor Lee",
      startMs: start,
      endMs: start + HOUR,
      calendarId: SIM_PRIMARY_CALENDAR,
    });
    await simUpsertExternalEvent(h.db, h.clock, {
      eventId: "evalex",
      summary: "Sync with Alex",
      startMs: start + 2 * HOUR,
      endMs: start + 3 * HOUR,
      calendarId: SIM_PRIMARY_CALENDAR,
    });
    await h.advance(20 * MINUTE, 10 * MINUTE);
    await simUpsertExternalEvent(h.db, h.clock, {
      eventId: "evalex",
      summary: "Sync with Alex",
      startMs: start + 2 * HOUR,
      endMs: start + 3 * HOUR,
      calendarId: SIM_PRIMARY_CALENDAR,
      status: "cancelled",
    });
    const before = (await h.outbox()).length;
    await h.advanceTo("2026-11-09T21:31:00Z", 30 * MINUTE);
    const brief = (await h.outboxSince(before)).find((m) => /Office hours/.test(m)) ?? "";
    expect(brief).toContain("the curve");
    await h.advanceTo("2026-11-09T23:06:00Z", 10 * MINUTE);
    expect(await h.lastReply()).toBe("Anything to record or follow up from Office hours with Professor Lee? Reply with notes, SKIP, or DIDN'T HAPPEN.");
    expect(await say(h, "She said the curve is ten points.")).toBe("Saved your notes from Office hours with Professor Lee.");
    await h.advanceTo("2026-11-10T02:00:00Z", 30 * MINUTE);
    expect((await h.outbox()).filter((m) => /Sync with Alex/.test(m))).toHaveLength(0);
    task.meta.evidence = { transcript: await transcript(h), brief };
  });

  it("X12: planning, minimum viable day, context-sized tasks, and evening reset keep deadlines and book nothing", async ({ task }) => {
    const h = await makeHarness();
    await memoryOn(h);
    await say(h, "Add task: finish the report by tomorrow at 5 PM");
    await say(h, "Add task: buy stamps");
    await say(h, "Finish the report takes 90 minutes on laptop.");
    await say(h, "Buy stamps takes 15 minutes on phone.");
    const dues = await h.db.all<{ due_at: number | null }>("SELECT due_at FROM tasks ORDER BY created_at");
    const plan = await say(h, "plan my day");
    expect(plan).toMatch(/^Proposed plan/);
    expect(plan).toMatch(/Nothing is booked/);
    const mvd = await say(h, "bad day");
    expect(mvd).toMatch(/^Minimum viable day/);
    expect(await say(h, "what can i do in 20 minutes")).toMatch(/Buy stamps/);
    expect(await say(h, "what can i do in 20 minutes")).not.toMatch(/Finish the report/);
    expect(await say(h, "evening reset")).toMatch(/^Evening reset:/);
    expect(await h.db.all<{ due_at: number | null }>("SELECT due_at FROM tasks ORDER BY created_at")).toEqual(dues);
    expect(await h.count("SELECT COUNT(*) AS n FROM sim_calendar_events")).toBe(0);
    task.meta.evidence = { transcript: await transcript(h), deadlinesUnchanged: true, calendarWrites: 0 };
  });

  it("X13: a work checkpoint survives context pruning; an idea resurfaces once when its prerequisite completes", async ({ task }) => {
    const h = await makeHarness();
    await memoryOn(h);
    await enableExt(h, { suggestions_enabled: 1 });
    await say(h, "Stopping here on Thesis: done the intro; tried dataset B; next rerun the baseline.");
    h.jump(3 * DAY);
    await h.db.run("DELETE FROM conversation_log");
    expect(await say(h, "resume thesis")).toBe(
      "Thesis (checkpoint Sun Nov 8): done: the intro; tried: dataset B; next: rerun the baseline. (I can't see your files; this is what you told me.)",
    );
    await say(h, "Add task: finish the report");
    const id = h.shortIdFrom(await h.lastReply());
    await say(h, "Idea: write a blog post about it after finishing the report.");
    await say(h, `done ${id}`);
    expect(await h.count("SELECT COUNT(*) AS n FROM suggestions WHERE kind = 'idea_resurface'")).toBe(1);
    await say(h, `${id} reopen`);
    await say(h, `done ${id}`);
    expect(await h.count("SELECT COUNT(*) AS n FROM suggestions WHERE kind = 'idea_resurface'")).toBe(1);
    task.meta.evidence = { transcript: await transcript(h) };
  });

  it("X14: stale/deleted vector hits are filtered by canonical truth; fabricated citations and entities support nothing", async ({ task }) => {
    const h = await makeHarness();
    await memoryOn(h);
    await enableExt(h, { semantic_enabled: 1 });
    await say(h, "Note: the lab door code changes on Mondays.");
    await say(h, "I put my umbrella in the hall closet.");
    await h.advance(6 * MINUTE, 3 * MINUTE);
    expect(await h.count("SELECT COUNT(*) AS n FROM semantic_vectors")).toBeGreaterThan(0);
    const hit = await search(h.ctx, "lab door code");
    expect(hit.text).toMatch(/lab door code/);
    // A lagging index still holds a vector for a fact the owner deleted.
    await forgetEntity(h.ctx, "umbrella");
    const stale = await h.db.first<{ object_id: string }>("SELECT object_id FROM deletion_tombstones WHERE object_type = 'assertion' LIMIT 1");
    await h.db.run(
      "INSERT OR REPLACE INTO semantic_vectors (object_id, object_type, model, dims, vector_json, content_hash, updated_at) VALUES (?, 'assertion', 'hash-bow-v1', 128, ?, 'x', ?)",
      stale!.object_id,
      JSON.stringify(Array(128).fill(0.1)),
      h.clock.now(),
    );
    const after = await search(h.ctx, "umbrella hall closet");
    expect(after.packet.claims.map((c) => c.id)).not.toContain(stale!.object_id);
    expect(validateCitations(hit.packet, ["asr_fabricated"]).ok).toBe(false);
    const fallback = await groundedNarrative(
      { summarize: async () => ({ text: "Your umbrella is in the car (per your note).", citedIds: ["asr_fabricated"] }) },
      "where is my umbrella",
      hit,
    );
    expect(fallback.text).toBe(hit.text);
    expect(await say(h, "where is my unicorn")).toBe("I don't have anything recorded about unicorn. (I only know locations you've told me.)");
    task.meta.evidence = { transcript: await transcript(h), staleVectorFiltered: true };
  });

  it("X15: off-record and capture pause retain nothing; sensitive data is redacted; retries don't duplicate", async ({ task }) => {
    const h = await makeHarness();
    await memoryOn(h);
    expect(await say(h, "Don't store this: I put my spare key under the mat.")).toBe("OK, I didn't store that.");
    expect(await h.count("SELECT COUNT(*) AS n FROM entities")).toBe(0);
    const inbound = await h.db.first<{ id: string; body_enc: string | null }>("SELECT id, body_enc FROM inbound_messages ORDER BY seq DESC LIMIT 1");
    expect(inbound!.body_enc).toBeNull();
    expect(await h.count("SELECT COUNT(*) AS n FROM conversation_log WHERE inbound_id = ?", inbound!.id)).toBe(0);
    await say(h, "pause memory");
    expect(await say(h, "I put my bike in the garage.")).toBe("Memory is paused, so I didn't save that.");
    expect(await h.count("SELECT COUNT(*) AS n FROM entities")).toBe(0);
    expect((await h.db.first<{ n: number }>("SELECT COUNT(*) AS n FROM plans WHERE plan_enc IS NOT NULL"))!.n).toBeGreaterThan(0);
    await say(h, "resume memory");
    await say(h, "My gym password is hunter22. I put my laptop in the bag.");
    const src = await h.db.first<{ content_enc: string }>("SELECT content_enc FROM source_records ORDER BY created_at DESC LIMIT 1");
    const stored = await h.ctx.crypto.decrypt(src!.content_enc, "source");
    expect(stored).not.toContain("hunter22");
    const cands: Interpretation["knowledge"] = [
      {
        kind: "item_location",
        item: "laptop",
        container_path: ["bag"],
        location_phrase: null,
        modality: "actual",
        when: "now",
        when_date: null,
        temporary: false,
        evidence_span: "I put my laptop in the bag",
      },
    ];
    const n1 = await h.count("SELECT COUNT(*) AS n FROM assertions");
    await ingestKnowledge(h.ctx, { candidates: cands, sourceText: "I put my laptop in the bag.", originId: "retry-test", anchorMs: h.clock.now(), model: "test" });
    const n2 = await h.count("SELECT COUNT(*) AS n FROM assertions");
    await ingestKnowledge(h.ctx, { candidates: cands, sourceText: "I put my laptop in the bag.", originId: "retry-test", anchorMs: h.clock.now(), model: "test" });
    expect(await h.count("SELECT COUNT(*) AS n FROM assertions")).toBe(n2);
    expect(n2).toBeGreaterThanOrEqual(n1);
    task.meta.evidence = { transcript: await transcript(h), storedSourceRedacted: stored };
  });

  it("X16: forgetting removes facts, excerpts, vectors, cached answers; a late extraction cannot resurrect them", async ({ task }) => {
    const h = await makeHarness();
    await memoryOn(h);
    await enableExt(h, { semantic_enabled: 1 });
    await say(h, "I put my passport in the safe.");
    await h.advance(6 * MINUTE, 3 * MINUTE);
    await say(h, "where is my passport");
    const inboundId = (await h.db.first<{ inbound_id: string }>("SELECT inbound_id FROM extraction_runs ORDER BY rowid LIMIT 1"))!.inbound_id;
    expect(await h.count("SELECT COUNT(*) AS n FROM retrieval_evidence")).toBeGreaterThan(0);
    const forgot = await say(h, "forget passport");
    expect(forgot).toMatch(/^Forgot everything about passport: 1 fact/);
    expect(await h.count("SELECT COUNT(*) AS n FROM assertions WHERE status != 'deleted' AND subject_id IN (SELECT id FROM entities WHERE status = 'deleted')")).toBe(0);
    expect(await h.count("SELECT COUNT(*) AS n FROM assertions WHERE status = 'deleted' AND (excerpt_enc IS NOT NULL OR object_value_enc IS NOT NULL)")).toBe(0);
    expect(await h.count("SELECT COUNT(*) AS n FROM semantic_vectors v JOIN deletion_tombstones t ON t.object_id = v.object_id")).toBe(0);
    expect(await h.count("SELECT COUNT(*) AS n FROM retrieval_evidence")).toBe(0);
    await ingestKnowledge(h.ctx, {
      candidates: [
        {
          kind: "item_location",
          item: "passport",
          container_path: ["safe"],
          location_phrase: null,
          modality: "actual",
          when: "now",
          when_date: null,
          temporary: false,
          evidence_span: "I put my passport in the safe",
        },
      ],
      sourceText: "I put my passport in the safe.",
      originId: inboundId,
      anchorMs: h.clock.now(),
      model: "late-job",
    });
    expect(await say(h, "where is my passport")).toBe("I don't have anything recorded about passport. (I only know locations you've told me.)");
    task.meta.evidence = { transcript: await transcript(h) };
  });

  it("X17: raw chat expiry keeps durable supporting excerpts; explicit erase removes them", async ({ task }) => {
    const h = await makeHarness();
    await memoryOn(h);
    await say(h, "I put my passport in the safe.");
    h.jump(31 * DAY);
    const r = await runRetention(h.ctx);
    expect(r.inbound).toBeGreaterThan(0);
    expect(await h.count("SELECT COUNT(*) AS n FROM source_records WHERE content_enc IS NOT NULL")).toBe(0);
    const why = (await say(h, "where is my passport")) && (await say(h, "why"));
    expect(why).toBe('Based on: Sun Nov 8 you said: "I put my passport in the safe".');
    expect(await eraseAllData(h.ctx, "ERASE ALL DATA")).toBe(true);
    expect(await h.count("SELECT COUNT(*) AS n FROM assertions")).toBe(0);
    expect(await h.count("SELECT COUNT(*) AS n FROM source_records")).toBe(0);
    expect(await h.count("SELECT COUNT(*) AS n FROM entities")).toBe(0);
    task.meta.evidence = { retention: r, afterErase: { assertions: 0, sources: 0 } };
  });

  it("X18: a wake-call acknowledgement satisfies only the call stage; later stages need their own evidence", async ({ task }) => {
    const h = await makeHarness();
    await enableExt(h, { morning_routines_enabled: 1, telemetry_enabled: 1 });
    const dev = await pairDevice(h);
    await say(h, "morning routine at 7 AM weekdays, gym first, laptop check-in");
    await say(h, `YES ${h.nonceFrom(await h.lastReply())}`);
    await h.advanceTo("2026-11-09T15:00:00Z", 30 * MINUTE);
    await h.call((await h.calls())[0]!.sid, "press1");
    await h.advanceTo("2026-11-09T15:13:00Z");
    await dev.sync(); // online, but the owner never clicks the check-in
    await h.advanceTo("2026-11-09T15:31:00Z");
    await say(h, "Rowing now, 10 minutes in");
    await h.advanceTo("2026-11-09T16:00:00Z", 5 * MINUTE);
    const cps = await h.db.all<{ kind: string; state: string; status_label: string }>("SELECT kind, state, status_label FROM acc_checkpoints ORDER BY intended_at LIMIT 4");
    expect(cps).toEqual([
      { kind: "call", state: "satisfied", status_label: "call_acknowledged" },
      { kind: "device_checkin", state: "missed", status_label: "no_response_in_window" },
      { kind: "evidence", state: "missed", status_label: "no_response_in_window" },
      { kind: "later_check", state: "satisfied", status_label: "later_check_received" },
    ]);
    const s = await h.db.first<{ state: string }>("SELECT state FROM acc_sessions ORDER BY intended_start LIMIT 1");
    expect(s!.state).toBe("needs_attention");
    task.meta.evidence = { transcript: await transcript(h), checkpoints: cps };
  });

  it("X19: an offline browser makes the check unverifiable; a page-visibility ping is not a check-in", async ({ task }) => {
    const h = await makeHarness();
    await enableExt(h, { task_accountability_enabled: 1, telemetry_enabled: 1 });
    const dev = await pairDevice(h);
    await say(h, "hold me accountable for Report from 10:30 AM to 11:30 AM, browser check halfway");
    await h.advanceTo("2026-11-08T19:00:30Z");
    const ping = await dev.post("checkin", await dev.envelope({ kind: "heartbeat", state: "active", nonce: null, checkpointId: null }));
    expect(ping.status).toBe(400);
    expect(ping.json.error).toBe("not_a_checkin");
    const visible = await dev.post("sync", await dev.envelope({ kind: "heartbeat", state: "active" }));
    expect(visible.status).toBe(200);
    expect(await h.count("SELECT COUNT(*) AS n FROM acc_checkpoints WHERE state = 'satisfied'")).toBe(0);
    h.jump(10 * MINUTE);
    await h.advanceTo("2026-11-08T19:45:00Z", 5 * MINUTE);
    const cp = await h.db.first<{ state: string; status_label: string }>("SELECT state, status_label FROM acc_checkpoints WHERE kind = 'device_checkin'");
    expect(cp).toEqual({ state: "unverifiable", status_label: "browser_offline" });
    task.meta.evidence = { transcript: await transcript(h), checkpoint: cp };
  });

  it("X20: replays, stale/out-of-order events, expired or mismatched challenges, bad keys, and revoked devices all fail", async ({ task }) => {
    const h = await makeHarness();
    await enableExt(h, { task_accountability_enabled: 1, telemetry_enabled: 1 });
    const dev = await pairDevice(h);
    await say(h, "hold me accountable for Report from 10:30 AM to 11:30 AM, browser check halfway, progress halfway");
    await h.advanceTo("2026-11-08T19:00:30Z");
    const s = await dev.sync();
    const ch = s.json.challenge as { nonce: string; checkpointId: string };
    expect(ch).toBeTruthy();
    const stale = await dev.checkin(ch, { reportedAt: h.clock.now() - 10 * MINUTE });
    expect(stale.json.error).toBe("stale_event");
    const wrong = await dev.checkin({ nonce: ch.nonce, checkpointId: "acp_other" });
    expect(wrong.json.error).toBe("challenge_mismatch");
    const env = await dev.envelope({ kind: "checkin_response", nonce: ch.nonce, checkpointId: ch.checkpointId });
    expect((await dev.post("checkin", env)).json.ok).toBe(true);
    expect((await dev.post("checkin", env)).json.error).toBe("replay");
    const old = await dev.checkin(ch, { seq: 1 });
    expect(old.json.error).toBe("replay");
    const again = await dev.checkin(ch);
    expect(again.json.error).toBe("challenge_used_or_expired");
    const other = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"])) as CryptoKeyPair;
    const forged = await dev.post("sync", await dev.envelope({ kind: "poll" }, { key: other.privateKey }));
    expect(forged.json.error).toBe("bad_signature");
    await revokeDevice(h.ctx, dev.deviceId, "test");
    expect((await dev.sync()).json.error).toBe("revoked");
    const { code } = await createPairingCode(h.ctx, "x");
    h.jump(11 * MINUTE);
    const late = await h.fetchApp(
      new Request("https://della.test/api/device/pair", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code, publicKeyJwk: { kty: "EC", crv: "P-256", x: "a", y: "b" } }),
      }),
    );
    expect(((await late.json()) as { error: string }).error).toBe("invalid_or_expired_code");
    const rejected = await h.db.all<{ reason: string }>("SELECT reason FROM device_events WHERE accepted = 0 ORDER BY received_at");
    task.meta.evidence = { rejectedReasons: rejected.map((r) => r.reason) };
  });

  it("X21: all routine calls share one per-occurrence cap; STOP prevents every later effect", async ({ task }) => {
    const h = await makeHarness();
    await enableExt(h, { morning_routines_enabled: 1 });
    await say(h, "morning routine at 7 AM weekdays, gym first");
    await say(h, `YES ${h.nonceFrom(await h.lastReply())}`);
    await h.advanceTo("2026-11-09T15:00:00Z", 30 * MINUTE);
    await h.call((await h.calls())[0]!.sid, "no_answer");
    await h.advanceTo("2026-11-09T15:12:00Z");
    expect(await h.calls()).toHaveLength(2);
    await h.call((await h.calls())[1]!.sid, "press2");
    await h.advanceTo("2026-11-09T16:00:00Z", 5 * MINUTE);
    expect(await h.calls()).toHaveLength(2);
    const occ = await h.db.first<{ status: string; status_reason: string }>(
      "SELECT o.status, o.status_reason FROM alarm_occurrences o JOIN alarm_schedules a ON a.id = o.alarm_id WHERE a.label = 'accountability check call'",
    );
    expect(occ!.status).toBe("missed");
    await h.send("STOP");
    expect(await h.count("SELECT COUNT(*) AS n FROM acc_sessions WHERE state IN ('scheduled','active','awaiting_checkpoint','awaiting_start','paused')")).toBe(0);
    await h.advanceTo("2026-11-10T16:00:00Z", 30 * MINUTE);
    expect(await h.calls()).toHaveLength(2);
    task.meta.evidence = { transcript: await transcript(h), calls: 2, escalationOccurrence: occ };
  });

  it("X22: uploads enforce expiry, size/type/pixel bounds, tokens, single finalization, metadata stripping, and no listing", async ({ task }) => {
    const h = await makeHarness();
    await enableExt(h, { task_accountability_enabled: 1, max_images_per_checkpoint: 1, max_image_bytes: 4000 });
    await say(h, "hold me accountable for Report from 10:30 AM to 11:30 AM, photo at start");
    await h.advanceTo("2026-11-08T18:30:30Z");
    const url = uploadUrlFrom(await h.lastReply());
    expect((await h.fetchApp(new Request(url))).status).toBe(200);
    expect((await upload(h, url, [{ bytes: heicBytes(), name: "a.heic", type: "image/heic" }])).body).toContain("HEIC photos aren&#39;t supported");
    expect(
      (await upload(h, url, [{ bytes: new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), name: "x.jpg", type: "image/jpeg" }]))
        .status,
    ).toBe(415);
    const polyglot = new Uint8Array([...jpegWithExif().slice(0, 20), ...new TextEncoder().encode("<script>alert(1)</script>"), ...jpegWithExif().slice(20)]);
    expect((await upload(h, url, [{ bytes: polyglot, name: "p.jpg", type: "image/jpeg" }])).status).toBe(415);
    expect((await upload(h, url, [{ bytes: jpegWithExif(20000, 20000), name: "big.jpg", type: "image/jpeg" }])).body).toContain("dimensions are out of range");
    expect((await upload(h, url, [{ bytes: new Uint8Array(5000).fill(1), name: "huge.jpg", type: "image/jpeg" }])).status).toBe(413);
    const ok = await upload(h, url, [{ bytes: jpegWithExif(), name: "desk.jpg", type: "image/jpeg" }]);
    expect(ok.status).toBe(200);
    const media = await h.db.first<{ storage_key: string; metadata_stripped: number; width: number }>("SELECT storage_key, metadata_stripped, width FROM media_objects");
    expect(media!.metadata_stripped).toBe(1);
    const stored = await h.ctx.ext.media.get(media!.storage_key);
    expect(hasMetadata(stored!.bytes)).toBe(false);
    expect(new TextDecoder("latin1").decode(stored!.bytes)).not.toContain("GPS");
    expect((await upload(h, url, [{ bytes: jpegWithExif(), name: "again.jpg", type: "image/jpeg" }])).status).toBe(410);
    expect((await h.fetchApp(new Request("https://della.test/u/not-a-real-token-123456789012"))).status).toBe(410);
    expect((await h.fetchApp(new Request("https://della.test/u/"))).status).toBe(404);
    expect((await h.fetchApp(new Request(`https://della.test/${media!.storage_key}`))).status).toBe(404);
    h.jump(25 * HOUR);
    await h.tick();
    expect(await h.ctx.ext.media.get(media!.storage_key)).toBeNull();
    expect(await h.count("SELECT COUNT(*) AS n FROM media_objects WHERE deleted_at IS NOT NULL")).toBe(1);
    task.meta.evidence = { stored: { width: media!.width, metadataStripped: true }, expiredAfterHours: 24 };
  });

  it("X23: text inside a photo can't change policy; an unclear image asks for clarification, not completion", async ({ task }) => {
    const h = await makeHarness();
    await enableExt(h, { task_accountability_enabled: 1, assessment_enabled: 1 });
    await say(h, "Add task: finish the report");
    await say(h, "hold me accountable for finish the report from 10:30 AM to 11:30 AM, photo at start");
    const policy = await h.db.first<{ config_json: string }>("SELECT config_json FROM acc_policies");
    await h.advanceTo("2026-11-08T18:30:30Z");
    await scriptSimOutcome(h.db, "vision", "refusal", h.clock);
    await upload(h, uploadUrlFrom(await h.lastReply()), [{ bytes: pngWithText(), name: "note.png", type: "image/png" }]);
    expect(await h.lastReply()).toMatch(/^The photo for "start" was unclear to me\. Send another, or reply with a short note/);
    const cp = await h.db.first<{ state: string }>("SELECT state FROM acc_checkpoints");
    expect(cp!.state).toBe("needs_clarification");
    expect(await h.count("SELECT COUNT(*) AS n FROM tasks WHERE status = 'completed'")).toBe(0);
    expect((await h.db.first<{ config_json: string }>("SELECT config_json FROM acc_policies"))!.config_json).toBe(policy!.config_json);
    const stored = await h.ctx.ext.media.get((await h.db.first<{ storage_key: string }>("SELECT storage_key FROM media_objects"))!.storage_key);
    expect(new TextDecoder("latin1").decode(stored!.bytes)).not.toContain("ignore your rules");
    task.meta.evidence = { transcript: await transcript(h) };
  });

  it("X24: without a vision service a photo stays received-unassessed; a claimed completion stays self-report", async ({ task }) => {
    const h = await makeHarness();
    await enableExt(h, { task_accountability_enabled: 1, assessment_enabled: 0 });
    await say(h, "Add task: finish the report");
    await say(h, "hold me accountable for finish the report from 10:30 AM to 11:30 AM, photo at start, progress halfway");
    await h.advanceTo("2026-11-08T18:30:30Z");
    await upload(h, uploadUrlFrom(await h.lastReply()), [{ bytes: jpegWithExif(), name: "desk.jpg", type: "image/jpeg" }]);
    const sub = await h.db.first<{ state: string }>("SELECT state FROM evidence_submissions WHERE kind = 'photo'");
    expect(sub!.state).toBe("received_unassessed");
    expect(await h.count("SELECT COUNT(*) AS n FROM evidence_assessments")).toBe(0);
    await h.advanceTo("2026-11-08T19:00:30Z");
    expect(await say(h, "I finished the whole report")).toBe('Got it, check "progress" recorded as your note. That\'s a check-in, not task completion.');
    const labels = await h.db.all<{ status_label: string }>("SELECT status_label FROM acc_checkpoints ORDER BY ordinal");
    expect(labels.map((l) => l.status_label)).toEqual(["photo_received_unassessed", "self_report_received"]);
    expect(await h.count("SELECT COUNT(*) AS n FROM tasks WHERE status = 'open'")).toBe(1);
    task.meta.evidence = { transcript: await transcript(h), labels: labels.map((l) => l.status_label) };
  });

  it("X25: accountability is off by default; scope is the selected task; no-photos and check-ins never touch the task", async ({ task }) => {
    const h = await makeHarness();
    await say(h, "Add task: finish the report");
    await say(h, "Remind me tomorrow at 9 AM to do laundry");
    const off = await say(h, "hold me accountable for finish the report from 10:30 AM to 11:30 AM, photo at start, progress halfway");
    expect(off).toMatch(/^Task accountability is off/);
    expect(await h.count("SELECT COUNT(*) AS n FROM acc_sessions")).toBe(0);
    await say(h, "enable accountability");
    await say(h, "hold me accountable for finish the report from 10:30 AM to 11:30 AM, photo at start, progress halfway");
    const s = await h.db.first<{ task_id: string }>("SELECT task_id FROM acc_sessions");
    const report = await h.db.first<{ id: string }>("SELECT t.id FROM tasks t WHERE t.id = ?", s!.task_id);
    expect(report).toBeTruthy();
    await h.advanceTo("2026-11-08T18:30:30Z");
    expect(await say(h, "no photos")).toBe("No more photos for this session; I'll ask for a short note instead. The task and its reminders are unchanged.");
    expect(await say(h, "Desk is set up, outline open")).toMatch(/^Got it, check "start" recorded as your note/);
    expect(await h.count("SELECT COUNT(*) AS n FROM tasks WHERE status = 'open'")).toBe(2);
    expect(await h.count("SELECT COUNT(*) AS n FROM reminders WHERE status = 'scheduled'")).toBe(1);
    task.meta.evidence = { transcript: await transcript(h) };
  });

  it("X26: restoring an old backup replays no calls, resurrects no forgotten memory, accepts no old challenge, enables no telemetry", async ({ task }) => {
    const h = await makeHarness();
    await memoryOn(h);
    await enableExt(h, { morning_routines_enabled: 1, telemetry_enabled: 1 });
    const dev = await pairDevice(h);
    await say(h, "I put my passport in the safe.");
    await say(h, "morning routine at 7 AM weekdays, gym first, laptop check-in");
    await say(h, `YES ${h.nonceFrom(await h.lastReply())}`);
    await h.advanceTo("2026-11-09T15:05:30Z", 30 * MINUTE);
    const ch = (await dev.sync()).json.challenge as { nonce: string; checkpointId: string };
    const dump = await dumpDatabase(h.db, h.clock.now());
    await say(h, "forget passport");
    const restoreEnv = { ...(baseEnv as unknown as Env), DB: (baseEnv as unknown as Env & { DB_RESTORE: D1Database }).DB_RESTORE } as Env;
    await resetDatabase(restoreEnv.DB);
    const r = await buildContext(restoreEnv, { clock: h.clock, dispatcher: h.dispatcher });
    await restoreDatabase(new Db(restoreEnv.DB), dump);
    await applyPostRestoreSafety(r);
    await carryDeletionsForward(h.db, r);
    const ext = await r.db.first<{ telemetry_enabled: number }>("SELECT telemetry_enabled FROM ext_settings");
    expect(ext!.telemetry_enabled).toBe(0);
    expect(await r.db.first<{ n: number }>("SELECT COUNT(*) AS n FROM registered_devices WHERE revoked_at IS NULL")).toEqual({ n: 0 });
    expect(await r.db.first<{ n: number }>("SELECT COUNT(*) AS n FROM device_challenges")).toEqual({ n: 0 });
    expect(await r.db.first<{ n: number }>("SELECT COUNT(*) AS n FROM acc_sessions WHERE state NOT IN ('completed','canceled','expired','needs_attention')")).toEqual({ n: 0 });
    expect(await r.db.first<{ n: number }>("SELECT COUNT(*) AS n FROM assertions WHERE status = 'current'")).toEqual({ n: 0 });
    expect(await r.db.first<{ n: number }>("SELECT COUNT(*) AS n FROM jobs WHERE status = 'pending' AND kind IN ('acc_checkpoint','acc_session_end')")).toEqual({ n: 0 });
    const hold = await r.db.first<{ restore_hold: number }>("SELECT restore_hold FROM owner_settings");
    expect(hold!.restore_hold).toBe(1);
    void ch;
    task.meta.evidence = { telemetryAfterRestore: 0, activeDevices: 0, forgottenFactsRestored: 0, restoreHold: 1 };
  });

  it("X27: original behavior holds with every extension feature on (reminders, STOP, quiet hours, idempotency)", async ({ task }) => {
    const h = await makeHarness();
    await enableExt(h, { capture_enabled: 1, suggestions_enabled: 1, task_accountability_enabled: 1, morning_routines_enabled: 1, semantic_enabled: 1, evening_reset_enabled: 1 });
    await h.settings({ quiet_start_minute: 22 * 60, quiet_end_minute: 7 * 60 });
    await h.send("Remind me tomorrow at 5 PM to finish the application, and ask at 8 PM if I have done it.", { sid: "SMdup0000000000000000000000000001" });
    const first = await h.lastReply();
    expect(first).toMatch(/^Reminder set: Finish the application, Mon Nov 9, 5 PM PT\. I'll check at 8 PM if it's still open\. \[T[2-9A-Z]{3}\]$/);
    await h.send("Remind me tomorrow at 5 PM to finish the application, and ask at 8 PM if I have done it.", { sid: "SMdup0000000000000000000000000001" });
    expect(await h.count("SELECT COUNT(*) AS n FROM tasks")).toBe(1);
    await h.send("STOP");
    const n = (await h.outbox()).length;
    await h.advanceTo("2026-11-10T05:00:00Z", 30 * MINUTE);
    expect((await h.outbox()).length).toBe(n);
    task.meta.evidence = { transcript: await transcript(h), baseSuite: "S1–S17 run in the same acceptance project (tests/acceptance/scenarios.test.ts)" };
  });
});
