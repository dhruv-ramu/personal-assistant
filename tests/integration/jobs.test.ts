import { describe, expect, it } from "vitest";
import { scriptSimOutcome } from "../../src/providers/simulated/common";
import { smsEffectStatements } from "../../src/services/effects";
import { LEASE_MS, claimJob, createJob, finishJob, getJob } from "../../src/services/jobs";
import { processJob } from "../../src/services/queue-consumer";
import { MINUTE, makeHarness } from "../helpers/harness";

async function replyEffect(h: Awaited<ReturnType<typeof makeHarness>>, key: string, body = "hello") {
  const { effectId, statements } = await smsEffectStatements(h.ctx, { effectKey: key, purpose: "reply", body });
  await h.db.batch(statements);
  const job = (await h.db.first<{ id: string }>("SELECT id FROM jobs WHERE logical_key = ?", `deliver:${key}`))!;
  return { effectId, jobId: job.id };
}

describe("claims, leases, and fencing", () => {
  it("two consumers racing on one job yield exactly one claim", async () => {
    const h = await makeHarness();
    const { id } = await createJob(h.ctx, { logicalKey: "race:1", kind: "retention_sweep", dueAt: h.clock.now() });
    const [a, b] = await Promise.all([claimJob(h.ctx, id, "w1"), claimJob(h.ctx, id, "w2")]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
  });

  it("a worker that lost its lease cannot complete or overwrite the job", async () => {
    const h = await makeHarness();
    const { id } = await createJob(h.ctx, { logicalKey: "lease:1", kind: "retention_sweep", dueAt: h.clock.now() });
    const a = (await claimJob(h.ctx, id, "w1"))!;
    h.clock.advance(LEASE_MS + 1000);
    const b = (await claimJob(h.ctx, id, "w2"))!;
    expect(b.recovered).toBe(true);
    expect(await finishJob(h.ctx, a, { status: "failed", error: "stale worker" })).toBe(false);
    expect(await finishJob(h.ctx, b, { status: "succeeded" })).toBe(true);
    expect((await getJob(h.ctx, id))!.status).toBe("succeeded");
  });

  it("duplicate cron ticks and repeated queue deliveries are harmless", async () => {
    const h = await makeHarness();
    const { jobId } = await replyEffect(h, "dup:1");
    h.clock.advance(1000);
    await h.tick();
    await h.tick();
    expect(h.dispatcher.published.filter((x) => x === jobId)).toHaveLength(1);
    const first = await processJob(h.ctx, jobId);
    const second = await processJob(h.ctx, jobId);
    expect(first.claimed).toBe(true);
    expect(second.claimed).toBe(false);
    expect(await h.count("SELECT COUNT(*) AS n FROM sim_messages WHERE direction = 'to_owner'")).toBe(1);
  });

  it("logical-key uniqueness survives restarts (re-creating a job is a no-op)", async () => {
    const h = await makeHarness();
    const a = await createJob(h.ctx, { logicalKey: "same", kind: "retention_sweep", dueAt: h.clock.now() });
    const h2 = await makeHarness({ reset: false, start: h.clock.now() });
    const b = await createJob(h2.ctx, { logicalKey: "same", kind: "retention_sweep", dueAt: h.clock.now() });
    expect(b).toEqual({ id: a.id, created: false });
  });
});

describe("effect outbox crash windows", () => {
  it("crash after persisting the effect but before sending: the recovered job sends exactly once", async () => {
    const h = await makeHarness();
    const { jobId } = await replyEffect(h, "crash:before");
    const claim = (await claimJob(h.ctx, jobId, "dies"))!; // worker dies right after claiming
    void claim;
    h.clock.advance(LEASE_MS + 1000);
    await h.drain();
    expect(await h.count("SELECT COUNT(*) AS n FROM sim_messages WHERE direction = 'to_owner'")).toBe(1);
  });

  it("crash during sending: outcome is unknown and is never automatically re-sent", async () => {
    const h = await makeHarness();
    const { effectId, jobId } = await replyEffect(h, "crash:during");
    await claimJob(h.ctx, jobId, "dies");
    await h.db.run("UPDATE outbound_effects SET state = 'sending' WHERE id = ?", effectId); // request was in flight
    h.clock.advance(LEASE_MS + 1000);
    await h.drain();
    await h.advance(5 * MINUTE);
    expect((await h.db.first<{ state: string }>("SELECT state FROM outbound_effects WHERE id = ?", effectId))!.state).toBe("unknown");
    expect(await h.count("SELECT COUNT(*) AS n FROM sim_messages WHERE direction = 'to_owner'")).toBe(0);
  });

  it("retryable provider rejections retry within limits; permanent rejections block", async () => {
    const h = await makeHarness();
    await scriptSimOutcome(h.db, "sms_send", "reject_retryable", h.clock, 2);
    const { effectId, jobId } = await replyEffect(h, "retry:1");
    await h.drain();
    expect((await getJob(h.ctx, jobId))!.status).toBe("pending");
    await h.advance(2 * MINUTE, 30_000);
    expect((await h.db.first<{ state: string }>("SELECT state FROM outbound_effects WHERE id = ?", effectId))!.state).toBe("accepted");

    await scriptSimOutcome(h.db, "sms_send", "reject_permanent", h.clock);
    const p = await replyEffect(h, "perm:1");
    await h.drain();
    expect((await getJob(h.ctx, p.jobId))!.status).toBe("blocked");
    await h.advance(10 * MINUTE);
    expect((await getJob(h.ctx, p.jobId))!.attempts).toBe(1);
  });

  it("callbacks are idempotent, ordered monotonically, and conflicting ones are rejected", async () => {
    const h = await makeHarness();
    await h.send("What can you do?");
    const sid = (await h.db.first<{ provider_sid: string }>("SELECT provider_sid FROM sim_messages WHERE direction = 'to_owner'"))!.provider_sid;
    await h.deliver(sid, "delivered");
    await h.deliver(sid, "delivered");
    await h.deliver(sid, "sent"); // late, out of order
    const e = await h.db.first<{ state: string }>("SELECT state FROM outbound_effects WHERE provider_id = ?", sid);
    expect(e!.state).toBe("delivered");
    expect(await h.count("SELECT COUNT(*) AS n FROM provider_callbacks WHERE provider_id = ?", sid)).toBe(2);
  });
});

describe("invalidation and generations", () => {
  it("completing a task before its reminder job runs makes the job a no-op", async () => {
    const h = await makeHarness();
    await h.send("Remind me in 30 minutes to call the dentist");
    const id = h.shortIdFrom(await h.lastReply());
    const job = (await h.db.first<{ id: string }>("SELECT id FROM jobs WHERE kind = 'send_reminder'"))!;
    await h.send(`done ${id}`);
    // Even if a stale queue message arrives and the job is forced back to pending, nothing is sent.
    await h.db.run("UPDATE jobs SET status = 'pending', due_at = ? WHERE id = ?", h.clock.now(), job.id);
    const before = (await h.outbox()).length;
    await h.processJob(job.id);
    expect((await h.outbox()).length).toBe(before);
  });
});
