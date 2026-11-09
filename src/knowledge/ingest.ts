import type { AppContext } from "../context";
import { createClarification } from "../domain/conversations";
import { findOpenTasksByText } from "../domain/tasks";
import { addDays, formatDate, formatDateTime, localDayBounds, resolveLocalForRecurrence, todayLocal } from "../domain/time";
import { resolveTimeSpec } from "../domain/timespec";
import type { TimeSpec } from "../domain/actions";
import { newId } from "../security/crypto";
import { getExtSettings, featureOn } from "../ext/settings";
import { getSettings } from "../services/settings";
import { reportAbsent, lendItem, placeItem, removeItem, returnItem } from "./locations";
import { cleanLabel, findEntity, resolveOrCreate } from "./resolve";
import type { KnowledgeCandidate } from "./schema";
import { createItem, listItems, updateItem } from "./secretary";
import { detectSensitive, redactSensitive } from "./sensitive";
import { PHYSICAL, addAlias, assertionsFor, closeAssertion, createEntity, decryptValue, getEntity, insertAssertion, labelTokens, recordSource, type EntityType } from "./store";
import type { ResolveOrCreate } from "./resolve";
import { addDependency, upsertTaskMeta } from "./planning";
import { surfaceFutureMessagesForDecision, triggerIdeasForText } from "./triggers";

export interface IngestInput {
  candidates: KnowledgeCandidate[];
  sourceText: string;
  originId: string;
  sourceKind?: "sms" | "note" | "meeting" | "admin";
  anchorMs: number;
  model: string;
  /** Pre-resolved entity choices from a clarification answer: candidate index → entity id. */
  forcedEntities?: Record<string, string>;
}

export interface IngestResult {
  status: "applied" | "capture_off" | "nothing";
  lines: string[];
  question: { text: string } | null;
  rejected: Array<{ kind: string; reason: string }>;
  sourceId: string | null;
  saved: string[];
}

function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/** Evidence must be quoted from the actual message; names and numbers must appear in it. */
export function validateCandidate(c: KnowledgeCandidate, source: string): string | null {
  const src = norm(source);
  if (!src.includes(norm(c.evidence_span))) return "evidence span not found in message";
  const words = (s: string | null | undefined) => (s ? labelTokens(s).filter((t) => t.length > 2) : []);
  const mustAppear: string[] = [];
  switch (c.kind) {
    case "item_location":
    case "item_absent":
    case "item_removed":
      mustAppear.push(...words(c.item));
      break;
    case "item_lent":
      mustAppear.push(...words(c.item), ...words(c.person));
      break;
    case "promise":
    case "waiting_for":
    case "interaction":
      mustAppear.push(...words(c.person));
      break;
    case "recruiting":
      mustAppear.push(...words(c.organization));
      break;
  }
  for (const t of mustAppear) if (!labelTokens(source).some((w) => w === t || w.startsWith(t) || t.startsWith(w))) return `"${t}" does not appear in the message`;
  const numbers: Array<number | null> = [];
  if (c.kind === "accomplishment") numbers.push(c.metric_value);
  if (c.kind === "prediction" || c.kind === "actual") numbers.push(c.value);
  if (c.kind === "admin_item") numbers.push(c.amount);
  if (c.kind === "payment") numbers.push(c.amount);
  for (const n of numbers) {
    if (n === null) continue;
    const digits = String(n).replace(/\.0+$/, "");
    if (!source.replace(/,/g, "").includes(digits)) return `number ${digits} is not in the message`;
  }
  return null;
}

function effectiveTime(c: { when: string; when_date: string | null }, anchorMs: number, tz: string): number {
  const today = todayLocal(anchorMs, tz);
  if (c.when === "yesterday") return resolveLocalForRecurrence(addDays(today, -1), 12, 0, tz);
  if (c.when === "earlier_today") return Math.max(localDayBounds(today, tz).start, anchorMs - 3600_000);
  if (c.when === "date" && c.when_date && /^\d{4}-\d{2}-\d{2}$/.test(c.when_date)) return Math.min(anchorMs, resolveLocalForRecurrence(c.when_date, 12, 0, tz));
  return anchorMs;
}

function resolveDue(spec: TimeSpec | null, anchorMs: number, tz: string): { at: number | null; dateOnly: boolean; label: string | null } {
  if (!spec) return { at: null, dateOnly: false, label: null };
  const hasTime = spec.hour !== null || spec.relative_minutes !== null;
  const r = resolveTimeSpec(hasTime ? spec : { ...spec, hour: null, minute: null, meridiem: null }, { anchorMs, tz, purpose: hasTime ? "due" : "day" });
  if (!r.ok) return { at: null, dateOnly: false, label: spec.raw || null };
  if (hasTime) return { at: r.ms, dateOnly: false, label: formatDateTime(r.ms, tz) };
  const end = localDayBounds(r.localDate, tz).end - 60_000;
  return { at: end, dateOnly: true, label: formatDate(end, tz) };
}

const PERSON_HINT = /\b(ta|professor|prof|dr|advisor|adviser|manager|boss|mom|dad|mother|father|sister|brother|recruiter|coach|doctor|landlord)\b/i;

function guessAboutType(about: string, source: string): EntityType {
  if (PERSON_HINT.test(about)) return "person";
  const first = about.trim().split(/\s+/)[0] ?? "";
  if (/^[A-Z][a-z]+$/.test(first) && new RegExp(`\\b${first}\\b`).test(source)) return "person";
  return "topic";
}

/** Physical entity resolution that honours a clarification answer (an entity id or "__new__"). */
async function physical(ctx: AppContext, input: IngestInput, field: string, label: string, type: EntityType, key: string, sourceId: string): Promise<ResolveOrCreate> {
  const forced = input.forcedEntities?.[field];
  if (forced === "__new__") return { kind: "created", entity: await createEntity(ctx, { key: `${key}:${field}:new`, type, label: cleanLabel(label), sourceId }) };
  if (forced) {
    const e = await getEntity(ctx, forced);
    if (e) return { kind: "found", entity: e };
  }
  return resolveOrCreate(ctx, cleanLabel(label), type, key, sourceId);
}

async function person(ctx: AppContext, label: string, keyBase: string, sourceId: string) {
  return resolveOrCreate(ctx, cleanLabel(label), "person", keyBase, sourceId);
}

/**
 * Applies validated knowledge candidates for one source message. Idempotent: extraction keys are
 * `<source>:<index>:<kind>`, so a retried job (or a re-extraction after deletion) adds nothing.
 */
/** One-time explanation when the owner says something memorable while memory is off. */
export async function captureOffNotice(ctx: AppContext): Promise<string | null> {
  const ext = await getExtSettings(ctx.db);
  if (ext.capture_enabled === 1 && ext.capture_paused_until && ext.capture_paused_until > ctx.clock.now()) return "Memory is paused, so I didn't save that.";
  if (ext.capture_explained_at || !ctx.config.ext.flags.capture) return null;
  await ctx.db.run("UPDATE ext_settings SET capture_explained_at = ? WHERE id = 1", ctx.clock.now());
  return "Memory is off, so I didn't save that. Text ENABLE MEMORY to let me remember things like where you put items.";
}

export async function ingestKnowledge(ctx: AppContext, input: IngestInput): Promise<IngestResult> {
  const ext = await getExtSettings(ctx.db);
  const s = await getSettings(ctx.db);
  const tz = s.timezone;
  const result: IngestResult = { status: "nothing", lines: [], question: null, rejected: [], sourceId: null, saved: [] };
  if (input.candidates.length === 0) return result;
  if (!featureOn(ctx, ext, "capture")) {
    result.status = "capture_off";
    const notice = await captureOffNotice(ctx);
    if (notice) result.lines.push(notice);
    return result;
  }
  const sensitiveAllowed = ext.sensitive_memory_enabled === 1;
  const sourceText = sensitiveAllowed ? input.sourceText : redactSensitive(input.sourceText);
  const sourceId = await recordSource(ctx, {
    kind: input.sourceKind ?? "sms",
    originId: input.originId,
    content: sourceText,
    eventAt: input.anchorMs,
    rawRetentionDays: s.retention_message_days,
  });
  result.sourceId = sourceId;
  const skippedSensitive = new Set<string>();
  const now = input.anchorMs;

  for (let i = 0; i < input.candidates.length; i++) {
    const c = input.candidates[i]!;
    const key = `${sourceId}:${i}:${c.kind}`;
    const invalid = validateCandidate(c, input.sourceText);
    if (invalid) {
      result.rejected.push({ kind: c.kind, reason: invalid });
      continue;
    }
    const sens = detectSensitive(c.evidence_span);
    if (sens.length && !sensitiveAllowed) {
      sens.forEach((k) => skippedSensitive.add(k));
      result.rejected.push({ kind: c.kind, reason: `sensitive:${sens.join(",")}` });
      continue;
    }
    const excerpt = sensitiveAllowed ? c.evidence_span : redactSensitive(c.evidence_span);
    try {
      switch (c.kind) {
        case "item_location": {
          const item = await physical(ctx, input, `${i}:item`, c.item, "item", key, sourceId);
          if (item.kind === "ambiguous") {
            result.question = await askWhichEntity(ctx, input, i, "item", c.item, item.candidates);
            continue;
          }
          const at = effectiveTime(c, input.anchorMs, tz);
          // Build the container chain innermost → outermost.
          const chain = [];
          for (let j = 0; j < c.container_path.length; j++) {
            const label = cleanLabel(c.container_path[j]!);
            const r = await physical(ctx, input, `${i}:c${j}`, label, "container", `${key}:c${j}`, sourceId);
            if (r.kind === "ambiguous") {
              result.question = await askWhichEntity(ctx, input, i, `c${j}`, label, r.candidates);
              break;
            }
            chain.push(r.entity);
          }
          if (result.question) continue;
          const first = chain[0] ?? null;
          const r = await placeItem(ctx, {
            itemId: item.entity.id,
            containerId: first?.id ?? null,
            phrase: first ? null : c.location_phrase,
            modality: c.modality,
            effectiveFrom: at,
            sourceId,
            excerpt,
            extractionKey: key,
            temporary: c.temporary,
          });
          if (r.kind === "rejected") {
            result.lines.push(`I can't record ${item.entity.label} inside ${first?.label ?? "itself"}: that would put something inside itself. Nothing changed.`);
            continue;
          }
          if (c.modality === "actual") {
            for (let j = 0; j + 1 < chain.length; j++) {
              const pr = await placeItem(ctx, {
                itemId: chain[j]!.id,
                containerId: chain[j + 1]!.id,
                phrase: null,
                modality: "actual",
                effectiveFrom: at,
                sourceId,
                excerpt,
                extractionKey: `${key}:link${j}`,
              });
              if (pr.kind === "rejected") result.lines.push(`Skipped "${chain[j]!.label} in ${chain[j + 1]!.label}": it would create a containment loop.`);
            }
          }
          const where = first ? chain.map((e) => e.label).join(", in the ") : (c.location_phrase ?? "that place");
          if (r.kind === "tentative") result.saved.push(`${item.entity.label} might be in the ${where} (unconfirmed)`);
          else if (r.kind === "historical") result.saved.push(`${item.entity.label} was in the ${where} then (kept as history; a newer report is current)`);
          else result.saved.push(`${item.entity.label} location`);
          break;
        }
        case "item_absent": {
          const item = await findEntity(ctx, c.item, PHYSICAL);
          if (item.kind !== "found") {
            if (item.kind === "ambiguous") result.question = await askWhichEntity(ctx, input, i, "item", c.item, item.candidates);
            else result.lines.push(`I don't have ${cleanLabel(c.item)} recorded anywhere.`);
            continue;
          }
          const loc = await findEntity(ctx, c.location, PHYSICAL);
          const r = await reportAbsent(ctx, item.entity.id, loc.kind === "found" ? loc.entity.id : null, cleanLabel(c.location), input.anchorMs, sourceId, excerpt, key);
          result.saved.push(
            r === "retracted"
              ? `${item.entity.label}: not in the ${cleanLabel(c.location)} (old location cleared; no new location assumed)`
              : `${item.entity.label} not in the ${cleanLabel(c.location)}`,
          );
          break;
        }
        case "item_removed": {
          const item = await findEntity(ctx, c.item, PHYSICAL);
          if (item.kind !== "found") continue;
          const from = c.from ? await findEntity(ctx, c.from, PHYSICAL) : null;
          const r = await removeItem(ctx, item.entity.id, from?.kind === "found" ? from.entity.id : null, input.anchorMs, sourceId, excerpt, key);
          result.saved.push(r === "removed" ? `${item.entity.label} removed (location now unknown)` : `${item.entity.label} removal noted`);
          break;
        }
        case "item_lent": {
          const item = await resolveOrCreate(ctx, cleanLabel(c.item), "item", key, sourceId);
          if (item.kind === "ambiguous") {
            result.question = await askWhichEntity(ctx, input, i, "item", c.item, item.candidates);
            continue;
          }
          const p = await person(ctx, c.person, key, sourceId);
          if (p.kind === "ambiguous") continue;
          await lendItem(ctx, item.entity.id, p.entity.id, input.anchorMs, sourceId, excerpt, key);
          result.saved.push(`${item.entity.label} lent to ${p.entity.label}`);
          break;
        }
        case "item_returned": {
          const item = await findEntity(ctx, c.item, PHYSICAL);
          if (item.kind !== "found") continue;
          const r = await returnItem(ctx, item.entity.id, input.anchorMs, sourceId, excerpt, key);
          result.saved.push(r === "returned" ? `${item.entity.label} returned (where it's stored now isn't recorded)` : `${item.entity.label} return noted`);
          break;
        }
        case "fact":
        case "preference": {
          const isOwner = c.kind === "preference" || /^(i|me|myself|owner)$/i.test(c.subject.trim());
          const subj = isOwner
            ? await createEntity(ctx, { key: "owner", type: "owner", label: "me", sourceId: null })
            : await resolveOrCreate(ctx, cleanLabel(c.subject), "topic", key, sourceId);
          if (!("id" in subj) && subj.kind === "ambiguous") continue;
          const entity = "id" in subj ? subj : subj.entity;
          const predicate = c.kind === "preference" ? `pref:${labelTokens(c.topic).join("_")}` : `attr:${labelTokens(c.attribute).join("_")}`;
          const attributed = c.kind === "fact" ? c.attributed_to : null;
          const modality = c.kind === "fact" ? c.modality : "actual";
          const polarity = c.kind === "fact" ? c.polarity : "affirmative";
          const prior = (await assertionsFor(ctx, entity.id, predicate, ["current"])).filter((a) => a.modality === "actual");
          let status: "current" | "disputed" | "tentative" = modality === "possible" ? "tentative" : "current";
          if (status === "current" && modality === "actual") {
            for (const p of prior) {
              const same = (await decryptValue(ctx, p)) === c.value;
              if (same) continue;
              if (!attributed && !p.attributed_to) await closeAssertion(ctx, p, now, "historical", "corrected_by_owner");
              else status = "disputed";
            }
          }
          await insertAssertion(ctx, {
            extractionKey: key,
            subjectId: entity.id,
            predicate,
            value: c.value,
            evidenceType: modality === "possible" ? "tentative" : "explicit_report",
            attributedTo: attributed,
            polarity,
            modality,
            sourceId,
            excerpt,
            effectiveFrom: now,
            status,
            scopeKey: predicate,
            model: input.model,
          });
          result.saved.push(
            status === "disputed"
              ? `a conflicting report about ${c.kind === "fact" ? c.attribute : c.topic} (kept both)`
              : c.kind === "preference"
                ? `a preference (${c.topic})`
                : `${c.subject} ${c.attribute}`,
          );
          break;
        }
        case "idea": {
          let triggerKind: string | null = null;
          let taskId: string | null = null;
          if (c.revisit_condition) {
            const t = await findOpenTasksByText(ctx, c.revisit_condition.replace(/^(when|after|once)\s+(i\s+)?/i, ""));
            if (t.length === 1) {
              triggerKind = "task_complete";
              taskId = t[0]!.id;
            } else triggerKind = "keyword";
          }
          await createItem(ctx, {
            key,
            kind: "idea",
            title: c.text,
            data: { reason: c.reason_deferred, condition: c.revisit_condition, project: c.project, excerpt },
            taskId,
            triggerKind,
            triggerText: triggerKind === "keyword" ? c.revisit_condition : null,
            sourceId,
            evidenceType: "explicit_report",
          });
          result.saved.push("an idea");
          break;
        }
        case "question": {
          let personId: string | null = null;
          if (c.about) {
            const type = guessAboutType(c.about, input.sourceText);
            const r = await resolveOrCreate(ctx, cleanLabel(c.about), type, key, sourceId);
            if (r.kind !== "ambiguous") personId = r.entity.id;
          }
          await createItem(ctx, { key, kind: "question", title: c.text, data: { about: c.about, excerpt }, personId, sourceId });
          result.saved.push(`a question${c.about ? ` for ${cleanLabel(c.about)}` : ""}`);
          break;
        }
        case "promise": {
          const p = await person(ctx, c.person, key, sourceId);
          if (p.kind === "ambiguous") continue;
          const due = resolveDue(c.due, input.anchorMs, tz);
          await createItem(ctx, {
            key,
            kind: "promise",
            title: c.deliverable,
            data: { dueLabel: due.label, dateOnly: due.dateOnly, excerpt },
            personId: p.entity.id,
            dueAt: due.at,
            sourceId,
          });
          result.saved.push(`promise to ${p.entity.label}`);
          break;
        }
        case "waiting_for": {
          const p = await person(ctx, c.person, key, sourceId);
          if (p.kind === "ambiguous") continue;
          const hasTime = Boolean(c.check && (c.check.hour !== null || c.check.relative_minutes !== null));
          const check = c.check ? resolveDue(c.check, input.anchorMs, tz) : null;
          const { item } = await createItem(ctx, {
            key,
            kind: "waiting_for",
            title: c.item,
            data: { sentAt: input.anchorMs, excerpt },
            personId: p.entity.id,
            checkAt: hasTime ? (check?.at ?? null) : null,
            sourceId,
          });
          result.saved.push(`waiting on ${p.entity.label}`);
          if (c.check && !hasTime && check?.at) {
            const day = check.label;
            await createClarification(ctx, {
              type: "time",
              options: [],
              freeform: "time",
              pending: { action: { type: "_waiting_check", itemId: item.id, day: c.check }, slot: "day", anchorMs: input.anchorMs, sourceInboundId: input.originId },
              prompt: `What time ${day} should I check whether ${p.entity.label} replied?`,
              sourceActionKey: `${key}:checktime`,
            });
            result.question = { text: `What time ${day} should I check whether ${p.entity.label} replied?` };
          }
          break;
        }
        case "waiting_resolved": {
          const p = await findEntity(ctx, c.person, new Set(["person"]));
          if (p.kind !== "found") continue;
          const open = await listItems(ctx, "waiting_for", { status: ["open"], personId: p.entity.id });
          const match = c.item ? open.filter((w) => labelTokens(c.item!).some((t) => labelTokens(w.title).includes(t))) : open;
          if (match.length === 1) {
            await updateItem(ctx, match[0]!, { status: "resolved", resolved: true, data: { ...match[0]!.data, resolvedBy: "owner_report", resolvedExcerpt: excerpt } });
            result.saved.push(`${p.entity.label} replied about ${match[0]!.title} (resolved)`);
          } else if (match.length > 1) {
            result.lines.push(`Which item from ${p.entity.label}? ${match.map((m, k) => `${k + 1}) ${m.title}`).join(" ")}`);
          }
          break;
        }
        case "decision": {
          await createItem(ctx, {
            key,
            kind: "decision",
            title: c.choice,
            data: { alternatives: c.alternatives, rationale: c.rationale, assumptions: c.assumptions, decidedAt: input.anchorMs, excerpt },
            sourceId,
          });
          result.saved.push("a decision");
          result.lines.push(...(await surfaceFutureMessagesForDecision(ctx, `${c.choice} ${c.alternatives.join(" ")}`, tz)));
          break;
        }
        case "prediction": {
          await createItem(ctx, { key, kind: "prediction", title: c.subject, data: { value: c.value, unit: c.unit, excerpt }, sourceId });
          result.saved.push(`an estimate (${c.value} ${c.unit})`);
          break;
        }
        case "actual": {
          const preds = (await listItems(ctx, "prediction", { status: ["open"] })).filter((p) => labelTokens(c.subject).some((t) => labelTokens(p.title).includes(t)));
          const pred = preds[0];
          const compatible = pred && String(pred.data.unit).toLowerCase().replace(/s$/, "") === c.unit.toLowerCase().replace(/s$/, "");
          if (pred && compatible)
            await updateItem(ctx, pred, {
              status: "observed",
              data: { ...pred.data, actual: c.value, actualUnit: c.unit, measure: c.measure, actualExcerpt: excerpt, actualAt: input.anchorMs },
            });
          await createItem(ctx, {
            key,
            kind: "note",
            title: `Actual: ${c.subject} ${c.value} ${c.unit}`,
            data: { measure: c.measure, excerpt, linkedPrediction: pred?.id ?? null },
            sourceId,
          });
          result.saved.push(
            pred && compatible
              ? `the actual (${c.value} ${c.unit}) against your estimate of ${pred.data.value} ${pred.data.unit}`
              : pred
                ? `the actual (${c.value} ${c.unit}); units don't match the estimate, so no comparison`
                : `the actual (${c.value} ${c.unit})`,
          );
          break;
        }
        case "accomplishment": {
          await createItem(ctx, {
            key,
            kind: "accomplishment",
            title: c.description,
            data: {
              role: c.role,
              metric: c.metric_value,
              unit: c.metric_unit,
              baseline: c.baseline,
              team: c.team_result,
              confidential: c.confidential,
              verification: "self_reported",
              excerpt,
            },
            sourceId,
          });
          result.saved.push("an accomplishment");
          break;
        }
        case "work_checkpoint": {
          const proj = await resolveOrCreate(ctx, cleanLabel(c.project), "project", key, sourceId);
          if (proj.kind === "ambiguous") continue;
          await createItem(ctx, {
            key,
            kind: "checkpoint",
            title: c.project,
            data: { completed: c.completed, attempted: c.attempted, remaining: c.remaining, next: c.next_action, excerpt },
            projectId: proj.entity.id,
            sourceId,
          });
          result.saved.push(`checkpoint for ${proj.entity.label}`);
          break;
        }
        case "future_message": {
          const date = c.date ? resolveDue(c.date, input.anchorMs, tz) : null;
          await createItem(ctx, {
            key,
            kind: "future_message",
            title: c.message,
            data: { trigger: c.trigger, writtenAt: input.anchorMs },
            checkAt: date?.at ?? null,
            triggerKind: c.trigger ? "decision_keyword" : date?.at ? "date" : null,
            triggerText: c.trigger,
            sourceId,
          });
          result.saved.push(`a message for later${c.trigger ? ` (when: ${c.trigger})` : date?.label ? ` (${date.label})` : ""}`);
          break;
        }
        case "interaction": {
          const p = await person(ctx, c.person, key, sourceId);
          if (p.kind === "ambiguous") continue;
          await createItem(ctx, {
            key,
            kind: "interaction",
            title: `Talked with ${p.entity.label}`,
            data: { notes: c.notes, at: input.anchorMs, followUpDays: c.follow_up_days, excerpt },
            personId: p.entity.id,
            checkAt: c.follow_up_days ? input.anchorMs + c.follow_up_days * 86_400_000 : null,
            sourceId,
          });
          result.saved.push(`interaction with ${p.entity.label}`);
          break;
        }
        case "lesson": {
          const act = await resolveOrCreate(ctx, cleanLabel(c.activity), "activity", key, sourceId);
          if (act.kind === "ambiguous") continue;
          await createItem(ctx, { key, kind: "lesson", title: c.lesson, data: { activity: act.entity.label, excerpt }, projectId: act.entity.id, sourceId });
          result.saved.push(`a lesson for ${act.entity.label}`);
          break;
        }
        case "admin_item": {
          const due = resolveDue(c.due, input.anchorMs, tz);
          let personId: string | null = null;
          if (c.counterpart) {
            const p = await person(ctx, c.counterpart, key, sourceId);
            if (p.kind !== "ambiguous") personId = p.entity.id;
          }
          await createItem(ctx, {
            key,
            kind: "admin_item",
            title: c.title,
            data: { category: c.category, amount: c.amount, payments: [], dueLabel: due.label, excerpt },
            personId,
            dueAt: due.at,
            sourceId,
          });
          result.saved.push(`${c.category} item`);
          break;
        }
        case "payment": {
          const p = await findEntity(ctx, c.counterpart, new Set(["person", "organization"]));
          const items = (await listItems(ctx, "admin_item", { status: ["open"] })).filter(
            (x) => (p.kind === "found" && x.person_id === p.entity.id) || labelTokens(c.counterpart).some((t) => labelTokens(x.title).includes(t)),
          );
          const it = items[0];
          if (!it) {
            result.lines.push(`I don't have an open reimbursement or payment with ${cleanLabel(c.counterpart)} to apply that to.`);
            continue;
          }
          const payments = [...((it.data.payments as Array<{ amount: number }>) ?? []), { amount: c.amount, at: input.anchorMs }];
          const paid = payments.reduce((n, x) => n + x.amount, 0);
          const total = typeof it.data.amount === "number" ? it.data.amount : null;
          await updateItem(ctx, it, { status: total !== null && paid >= total ? "resolved" : "open", resolved: total !== null && paid >= total, data: { ...it.data, payments } });
          result.saved.push(total !== null ? `payment of ${c.amount} (${paid} of ${total} received)` : `payment of ${c.amount}`);
          break;
        }
        case "recruiting": {
          const org = await resolveOrCreate(ctx, cleanLabel(c.organization), "organization", key, sourceId);
          if (org.kind === "ambiguous") continue;
          const due = resolveDue(c.deadline, input.anchorMs, tz);
          await createItem(ctx, {
            key,
            kind: "recruiting",
            title: `${org.entity.label}${c.role ? ` — ${c.role}` : ""}`,
            data: { stage: c.stage, role: c.role, deadlineKind: c.deadline_kind, dueLabel: due.label, excerpt },
            projectId: org.entity.id,
            dueAt: due.at,
            status: c.stage,
            sourceId,
          });
          result.saved.push(`${org.entity.label}: ${c.stage.replace("_", " ")}`);
          break;
        }
        case "dependency": {
          const a = await findOpenTasksByText(ctx, c.task);
          const b = await findOpenTasksByText(ctx, c.depends_on);
          if (a.length !== 1 || b.length !== 1) {
            result.lines.push(`I couldn't match both tasks for that dependency (${cleanLabel(c.task)} → ${cleanLabel(c.depends_on)}).`);
            continue;
          }
          const r = await addDependency(ctx, a[0]!.id, b[0]!.id, "explicit", sourceId);
          result.saved.push(r === "cycle" ? "nothing (that dependency would create a loop)" : `${a[0]!.title} depends on ${b[0]!.title}`);
          break;
        }
        case "task_context": {
          const t = await findOpenTasksByText(ctx, c.task);
          if (t.length !== 1) continue;
          await upsertTaskMeta(ctx, t[0]!.id, { estimateMinutes: c.minutes, estimateSource: "owner", contextTags: c.context_tags });
          result.saved.push(`details for ${t[0]!.title}`);
          break;
        }
        case "interest":
        case "opportunity":
        case "trip":
        case "note": {
          const title = c.kind === "interest" ? c.topic : c.kind === "opportunity" ? c.title : c.kind === "trip" ? `Trip: ${c.destination}` : c.text;
          const date = c.kind === "opportunity" ? resolveDue(c.deadline, input.anchorMs, tz) : c.kind === "trip" ? resolveDue(c.date, input.anchorMs, tz) : null;
          await createItem(ctx, {
            key,
            kind: c.kind,
            title,
            data: {
              ...(c.kind === "trip" ? { destination: c.destination, packing: c.packing } : {}),
              ...(c.kind === "note" ? { project: c.project } : {}),
              dueLabel: date?.label ?? null,
              verified: c.kind === "opportunity" ? false : undefined,
              excerpt,
            },
            dueAt: date?.at ?? null,
            sourceId,
          });
          result.saved.push(c.kind === "note" ? "a note" : `an ${c.kind === "interest" ? "interest" : c.kind === "trip" ? "trip" : "opportunity"}`);
          break;
        }
      }
    } catch (err) {
      result.rejected.push({ kind: c.kind, reason: `error:${String(err).slice(0, 80)}` });
    }
  }
  result.lines.push(...(await triggerIdeasForText(ctx, input.sourceText)));
  if (skippedSensitive.size) result.lines.push(`Not saved to memory: something that looked like a ${[...skippedSensitive].join("/").replace("_", " ")}.`);
  if (result.saved.length) result.lines.unshift(`Saved: ${dedupe(result.saved).join("; ")}.`);
  await ctx.db.run(
    "INSERT OR IGNORE INTO extraction_runs (id, inbound_id, source_id, status, summary_enc, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    newId("xr"),
    input.originId,
    sourceId,
    result.rejected.length ? "partial" : "applied",
    await ctx.crypto.encrypt(JSON.stringify({ saved: result.saved, rejected: result.rejected }), "extraction"),
    ctx.clock.now(),
  );
  result.status = "applied";
  return result;
}

function dedupe(xs: string[]): string[] {
  const counts = new Map<string, number>();
  for (const x of xs) counts.set(x, (counts.get(x) ?? 0) + 1);
  return [...counts.entries()].map(([x, n]) => (n > 1 ? `${n} × ${x}` : x));
}

async function askWhichEntity(
  ctx: AppContext,
  input: IngestInput,
  index: number,
  field: string,
  said: string,
  candidates: Array<{ id: string; label: string }>,
): Promise<{ text: string }> {
  const list = candidates.slice(0, 4);
  const prompt = `Which ${cleanLabel(said)}: ${list.map((e, k) => `${k + 1}) ${e.label}`).join(" ")}? Or reply NEW for a different one.`;
  await createClarification(ctx, {
    type: "which_entity",
    options: [
      ...list.map((e) => ({ label: e.label, keywords: [e.label.toLowerCase()], value: e.id })),
      { label: "new", keywords: ["new", "different", "another"], value: "__new__" },
    ],
    freeform: null,
    pending: {
      action: {
        type: "_knowledge",
        // On resume the single candidate is index 0: carry earlier forced choices for it across.
        input: {
          ...input,
          candidates: [input.candidates[index]!],
          forcedEntities: Object.fromEntries(
            Object.entries(input.forcedEntities ?? {})
              .filter(([k]) => k.startsWith(`${index}:`))
              .map(([k, v]) => [`0:${k.split(":")[1]}`, v]),
          ),
        },
        field: `0:${field}`,
      },
      slot: null,
      anchorMs: input.anchorMs,
      sourceInboundId: input.originId,
    },
    prompt,
    sourceActionKey: `${input.originId}:which:${index}:${field}`,
  });
  return { text: prompt };
}

export async function aliasEntity(ctx: AppContext, entityId: string, alias: string, sourceId: string | null): Promise<void> {
  await addAlias(ctx, entityId, alias, sourceId);
}
