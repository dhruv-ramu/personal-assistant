import type { AppContext } from "../context";
import { createClarification } from "../domain/conversations";
import { DAY, HOUR, formatDate } from "../domain/time";
import { featureOn, getExtSettings } from "../ext/settings";
import { newId } from "../security/crypto";
import { deliverSmsEffect, ensureSmsEffect } from "../services/effects";
import type { JobOutcome, JobRow } from "../services/jobs";
import { getSettings, isPaused } from "../services/settings";
import { getItem, updateItem } from "./secretary";
import { createSuggestion } from "./suggestions";
import { getEntity, labelTokens } from "./store";

/**
 * Time-based secretary checks (owner-requested): waiting-for follow-ups, dated future-self
 * messages, and dated idea revisits. A waiting-for item is never resolved automatically: an email
 * from the same person is only a *candidate* the owner confirms; an unrelated reply resolves nothing.
 */
export async function handleSecretaryCheck(ctx: AppContext, job: JobRow): Promise<JobOutcome> {
  const item = await getItem(ctx, job.entity_id ?? "");
  if (!item || item.status !== "open") return { status: "skipped", result: { reason: "not_open" } };
  if (job.entity_generation !== null && job.entity_generation !== item.version) return { status: "skipped", result: { reason: "stale" } };
  const s = await getSettings(ctx.db);
  const ext = await getExtSettings(ctx.db);
  const now = ctx.clock.now();
  if (isPaused(s, now, "reminders")) return { status: "skipped", result: { reason: "paused" } };
  if (item.kind === "interaction") {
    // Relationship follow-ups are ordinary suggestions (digest), never standalone nudges.
    const who = item.person_id ? ((await getEntity(ctx, item.person_id))?.label ?? "them") : "them";
    const r = await createSuggestion(ctx, {
      kind: "relationship_followup",
      dedupeKey: `followup:${item.id}`,
      suppressionKey: `followup:${item.person_id ?? item.id}`,
      text: `Follow up with ${who}? You talked ${formatDate(Number(item.data.at ?? item.created_at), s.timezone)}${item.data.notes ? ` about ${String(item.data.notes)}` : ""}.`,
      evidence: [item.id],
      action: null,
      delivery: "digest",
      ttlMs: 7 * DAY,
    });
    await updateItem(ctx, item, { status: "resurfaced" });
    return { status: "succeeded", result: { suggestion: r } };
  }
  let body: string;
  if (item.kind === "waiting_for") {
    const who = item.person_id ? ((await getEntity(ctx, item.person_id))?.label ?? "them") : "them";
    let candidateNote: string;
    if (featureOn(ctx, ext, "email")) {
      try {
        const since = Number(item.data.sentAt ?? now - 14 * DAY);
        const mails = await ctx.ext.email.listSince(since, 25);
        const whoTokens = labelTokens(who);
        const itemTokens = labelTokens(item.title).filter((t) => t.length > 3);
        const fromMatch = mails.filter((m) => whoTokens.every((t) => labelTokens(m.from).includes(t)));
        const topical = fromMatch.filter((m) => itemTokens.some((t) => labelTokens(`${m.subject} ${m.snippet}`).includes(t)));
        for (const m of topical) {
          await ctx.db.run(
            "INSERT OR IGNORE INTO email_candidates (id, waiting_id, message_ref, subject_enc, received_at, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            newId("emc"),
            item.id,
            m.ref,
            await ctx.crypto.encrypt(m.subject.slice(0, 120), "email"),
            m.receivedAt,
            now,
          );
        }
        candidateNote = topical.length
          ? ` I see an email from ${who} that may be the reply ("${topical[0]!.subject.slice(0, 50)}"); I haven't marked it resolved.`
          : fromMatch.length
            ? ` ${who} emailed, but nothing looked related to this.`
            : ` No email from ${who} since ${formatDate(since, s.timezone)}.`;
      } catch {
        candidateNote = " (Email check unavailable.)";
      }
    } else candidateNote = " (Email isn't connected, so I can't check.)";
    body = `Did ${who} reply about ${item.title}?${candidateNote} Reply YES (resolved), NO, or a new check time.`;
    await createClarification(ctx, {
      type: "waiting_check",
      options: [
        { label: "yes", keywords: ["yes", "replied", "got it", "resolved"], value: "yes" },
        { label: "no", keywords: ["no", "not yet", "nope"], value: "no" },
      ],
      freeform: "time",
      pending: { action: { itemId: item.id }, slot: null, anchorMs: now, sourceInboundId: null },
      prompt: body,
      sourceActionKey: `waiting_q:${job.logical_key}`,
      ttlMs: 12 * HOUR,
    });
  } else if (item.kind === "future_message") {
    body = `Message from your past self (${formatDate(Number(item.data.writtenAt ?? item.created_at), s.timezone)}): "${item.title}"`;
    await updateItem(ctx, item, { status: "delivered", resolved: true });
  } else if (item.kind === "idea") {
    body = `Revisit parked idea: ${item.title}${item.data.reason ? ` (parked because: ${String(item.data.reason)})` : ""}.`;
    await updateItem(ctx, item, { status: "resurfaced" });
  } else {
    body = `Check-in: ${item.title}.`;
  }
  const effect = await ensureSmsEffect(ctx, { effectKey: `secretary:${job.logical_key}`, purpose: "reminder", body });
  const d = await deliverSmsEffect(ctx, effect.id, "proactive");
  if (d.state === "retry") return { status: "retry", error: d.reason };
  return { status: "succeeded", result: { delivery: d.state } };
}

export async function answerWaitingCheck(ctx: AppContext, itemId: string, answer: "yes" | "no" | number): Promise<string> {
  const item = await getItem(ctx, itemId);
  if (!item || item.status !== "open") return "That item is already closed.";
  const s = await getSettings(ctx.db);
  if (answer === "yes") {
    await updateItem(ctx, item, { status: "resolved", resolved: true, data: { ...item.data, resolvedBy: "owner_confirmed" } });
    await ctx.db.run("UPDATE email_candidates SET status = 'confirmed' WHERE waiting_id = ?", itemId);
    return `Marked resolved: ${item.title}.`;
  }
  if (answer === "no") return `OK, still waiting on ${item.title}. Tell me when to check again.`;
  await updateItem(ctx, item, { checkAt: answer });
  return `I'll check again ${formatDate(answer, s.timezone)}.`;
}
