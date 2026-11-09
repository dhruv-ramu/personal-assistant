import { z } from "zod";
import { TimeSpecSchema } from "../domain/timespec-schema";

/**
 * Knowledge candidates: typed memory extracted from one owner message (by the AI planner in the
 * same structured call as action interpretation, or by the rule-based simulator). Candidates are
 * proposals: `knowledge/ingest.ts` validates every `evidence_span` against the actual message
 * text and checks names/numbers appear in it before anything is stored.
 */
const span = z.string().min(1).max(400).describe("Exact substring of the owner's message that supports this item (copied verbatim).");
const name = z.string().min(1).max(120);
const nameN = z.string().max(120).nullable();
const tsN = TimeSpecSchema.nullable();

export const KnowledgeCandidateSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("item_location"),
    item: name.describe("The object, without possessives, e.g. 'passport'."),
    container_path: z.array(name).max(6).describe("Containers from innermost to outermost, e.g. ['blue folder','bottom drawer','desk']."),
    location_phrase: nameN.describe("Free-text place when not a container, e.g. 'at the lab'."),
    modality: z.enum(["actual", "possible"]).describe("'possible' for maybe/might/probably."),
    when: z.enum(["now", "earlier_today", "yesterday", "date"]),
    when_date: z.string().nullable(),
    temporary: z.boolean(),
    evidence_span: span,
  }),
  z.object({ kind: z.literal("item_absent"), item: name, location: name, evidence_span: span }),
  z.object({ kind: z.literal("item_removed"), item: name, from: nameN, evidence_span: span }),
  z.object({ kind: z.literal("item_lent"), item: name, person: name, evidence_span: span }),
  z.object({ kind: z.literal("item_returned"), item: name, person: nameN, evidence_span: span }),
  z.object({
    kind: z.literal("fact"),
    subject: name,
    attribute: name,
    value: z.string().min(1).max(200),
    attributed_to: nameN.describe("Who said it, if someone other than the owner (e.g. 'Alex')."),
    polarity: z.enum(["affirmative", "negated"]),
    modality: z.enum(["actual", "intended", "possible", "hypothetical", "obligation"]),
    evidence_span: span,
  }),
  z.object({ kind: z.literal("preference"), topic: name, value: z.string().min(1).max(200), evidence_span: span }),
  z.object({ kind: z.literal("idea"), text: z.string().min(1).max(300), reason_deferred: nameN, revisit_condition: nameN, project: nameN, evidence_span: span }),
  z.object({
    kind: z.literal("question"),
    text: z.string().min(1).max(300),
    about: nameN.describe("Person, course, project, or meeting the question is for."),
    evidence_span: span,
  }),
  z.object({ kind: z.literal("promise"), person: name, deliverable: z.string().min(1).max(200), due: tsN, evidence_span: span }),
  z.object({ kind: z.literal("waiting_for"), person: name, item: z.string().min(1).max(200), check: tsN, evidence_span: span }),
  z.object({ kind: z.literal("waiting_resolved"), person: name, item: nameN, evidence_span: span }),
  z.object({
    kind: z.literal("decision"),
    choice: z.string().min(1).max(200),
    alternatives: z.array(z.string().max(120)).max(5),
    rationale: z.string().max(300).nullable(),
    assumptions: z.array(z.string().max(160)).max(5),
    evidence_span: span,
  }),
  z.object({ kind: z.literal("prediction"), subject: name, value: z.number(), unit: z.string().min(1).max(30), evidence_span: span }),
  z.object({
    kind: z.literal("actual"),
    subject: name,
    value: z.number(),
    unit: z.string().min(1).max(30),
    measure: z.enum(["active", "elapsed", "unspecified"]),
    evidence_span: span,
  }),
  z.object({
    kind: z.literal("accomplishment"),
    description: z.string().min(1).max(300),
    role: nameN,
    metric_value: z.number().nullable(),
    metric_unit: z.string().max(30).nullable(),
    baseline: z.string().max(60).nullable(),
    team_result: z.boolean().describe("True if the result belongs to a team rather than the owner personally."),
    confidential: z.boolean(),
    evidence_span: span,
  }),
  z.object({
    kind: z.literal("work_checkpoint"),
    project: name,
    completed: z.string().max(300).nullable(),
    attempted: z.string().max(300).nullable(),
    remaining: z.string().max(300).nullable(),
    next_action: z.string().max(200).nullable(),
    evidence_span: span,
  }),
  z.object({ kind: z.literal("future_message"), message: z.string().min(1).max(500), trigger: nameN, date: tsN, evidence_span: span }),
  z.object({
    kind: z.literal("interaction"),
    person: name,
    notes: z.string().max(300).nullable(),
    follow_up_days: z.number().int().min(1).max(365).nullable(),
    evidence_span: span,
  }),
  z.object({ kind: z.literal("lesson"), activity: name, lesson: z.string().min(1).max(300), evidence_span: span }),
  z.object({
    kind: z.literal("admin_item"),
    category: z.enum(["return", "reimbursement", "renewal", "subscription", "appointment_prep"]),
    title: z.string().min(1).max(200),
    counterpart: nameN,
    amount: z.number().nullable(),
    due: tsN,
    evidence_span: span,
  }),
  z.object({ kind: z.literal("payment"), counterpart: name, amount: z.number(), evidence_span: span }),
  z.object({
    kind: z.literal("recruiting"),
    organization: name,
    role: nameN,
    stage: z.enum(["interested", "applied", "referral_requested", "interviewing", "offer", "rejected", "withdrawn"]),
    deadline: tsN,
    deadline_kind: z.enum(["external", "self_imposed", "none"]),
    evidence_span: span,
  }),
  z.object({ kind: z.literal("dependency"), task: name, depends_on: name, evidence_span: span }),
  z.object({
    kind: z.literal("task_context"),
    task: name,
    minutes: z.number().int().min(1).max(1440).nullable(),
    context_tags: z.array(z.string().max(30)).max(5),
    evidence_span: span,
  }),
  z.object({ kind: z.literal("interest"), topic: name, evidence_span: span }),
  z.object({ kind: z.literal("opportunity"), title: z.string().min(1).max(200), deadline: tsN, evidence_span: span }),
  z.object({ kind: z.literal("trip"), destination: name, date: tsN, packing: z.array(z.string().max(60)).max(15), evidence_span: span }),
  z.object({ kind: z.literal("note"), text: z.string().min(1).max(500), project: nameN, evidence_span: span }),
]);
export type KnowledgeCandidate = z.infer<typeof KnowledgeCandidateSchema>;
export type KnowledgeKind = KnowledgeCandidate["kind"];
export type CandidateOf<K extends KnowledgeKind> = Extract<KnowledgeCandidate, { kind: K }>;

export const MAX_CANDIDATES = 10;
