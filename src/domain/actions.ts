import { z } from "zod";
import { KnowledgeCandidateSchema, MAX_CANDIDATES } from "../knowledge/schema";
import { RecurrenceSpecSchema } from "./recurrence";
import { TimeSpecSchema } from "./timespec-schema";

export { TimeSpecSchema };

/**
 * Action proposals: the bounded, typed vocabulary that both the AI planner and the deterministic
 * command parser produce. Proposals carry *expressions* (time specs, references), never trusted IDs
 * or destinations. Application code resolves and authorizes them before anything executes.
 *
 * Every field is required and nullable so the same schema works with OpenAI strict structured
 * outputs (`text.format.type = "json_schema"`, `strict: true`).
 */

export type WireTimeSpec = z.infer<typeof TimeSpecSchema>;

/** Internal extension: hints that only the application adds while resolving clarifications. */
export type TimeSpec = WireTimeSpec & { fold?: "earlier" | "later"; gap_ok?: boolean; past_ok?: boolean };

const ts = TimeSpecSchema;
const tsN = TimeSpecSchema.nullable();
const recurrence = RecurrenceSpecSchema.nullable();
const taskRef = z.string().max(120).nullable().describe("Short task ID like T4K8, or words identifying the task; null = the task in context.");
const title = z.string().min(1).max(200);

/** Core assistant actions (tasks, reminders, calendar, calls, settings). Always offered to the model. */
const CORE_ACTIONS = [
  z.object({
    type: z.literal("create_task"),
    title,
    notes: z.string().max(500).nullable(),
    due: tsN,
    reminders: z.array(ts).max(3),
    followups: z.array(ts).max(2),
    recurrence,
    priority: z.enum(["low", "normal", "high"]).nullable(),
  }),
  z.object({
    type: z.literal("create_reminder"),
    title,
    at: ts,
    followup_at: tsN,
    recurrence,
  }),
  z.object({ type: z.literal("list_tasks"), filter: z.enum(["open", "today", "overdue", "upcoming", "completed", "scheduled"]) }),
  z.object({ type: z.literal("get_task"), task_ref: taskRef }),
  z.object({ type: z.literal("complete_task"), task_ref: taskRef }),
  z.object({ type: z.literal("reopen_task"), task_ref: taskRef }),
  z.object({ type: z.literal("update_task"), task_ref: taskRef, new_title: z.string().max(200).nullable(), new_due: tsN }),
  z.object({ type: z.literal("cancel_task"), task_ref: taskRef, scope: z.enum(["occurrence", "series"]) }),
  z.object({
    type: z.literal("snooze_reminder"),
    task_ref: taskRef,
    minutes: z.number().int().min(1).max(10080).nullable(),
    until: tsN,
  }),
  z.object({ type: z.literal("cancel_reminder"), task_ref: taskRef }),
  z.object({
    type: z.literal("set_followup_policy"),
    task_ref: taskRef,
    applies_to: z.enum(["task", "global_default"]),
    enabled: z.boolean(),
    at: tsN,
  }),
  z.object({
    type: z.literal("get_agenda"),
    day: z.enum(["today", "tomorrow", "next_event", "other"]),
    other_day: tsN.describe("Day expression when day is 'other' (e.g. a weekday or date); the app resolves it."),
  }),
  z.object({ type: z.literal("find_calendar_events"), query: z.string().max(120).nullable(), day: tsN }),
  z.object({
    type: z.literal("create_calendar_event"),
    title,
    start: ts,
    end: tsN,
    duration_minutes: z.number().int().min(5).max(1440).nullable(),
    location: z.string().max(200).nullable(),
    description: z.string().max(500).nullable(),
    recurrence,
    allow_overlap: z.boolean(),
  }),
  z.object({
    type: z.literal("update_calendar_event"),
    event_query: z.string().max(120).nullable(),
    event_day: tsN,
    new_start: tsN,
    new_end: tsN,
    new_title: z.string().max(200).nullable(),
    scope: z.enum(["instance", "series", "this_and_future"]),
  }),
  z.object({
    type: z.literal("cancel_calendar_event"),
    event_query: z.string().max(120).nullable(),
    event_day: tsN,
    scope: z.enum(["instance", "series", "this_and_future"]),
  }),
  z.object({
    type: z.literal("propose_focus_block"),
    title,
    duration_minutes: z.number().int().min(15).max(480),
    day: ts,
  }),
  z.object({
    type: z.literal("set_wake_alarm"),
    time: ts,
    recurrence,
    read_agenda: z.boolean().nullable(),
    retry_if_missed: z.boolean().nullable(),
  }),
  z.object({ type: z.literal("snooze_wake_alarm"), minutes: z.number().int().min(1).max(60).nullable() }),
  z.object({ type: z.literal("cancel_wake_alarm"), scope: z.enum(["next", "all"]) }),
  z.object({ type: z.literal("acknowledge_awake") }),
  z.object({ type: z.literal("get_settings") }),
  z.object({ type: z.literal("get_status") }),
  z.object({
    type: z.literal("update_allowed_settings"),
    display_name: z.string().min(1).max(60).nullable(),
    timezone: z.string().max(60).nullable(),
    quiet_start: z.string().max(5).nullable().describe("HH:MM 24-hour"),
    quiet_end: z.string().max(5).nullable().describe("HH:MM 24-hour"),
    morning_brief_enabled: z.boolean().nullable(),
    morning_brief_time: z.string().max(5).nullable().describe("HH:MM 24-hour"),
    followup_default_enabled: z.boolean().nullable(),
    calendar_headsup_enabled: z.boolean().nullable(),
    calendar_headsup_lead_minutes: z.number().int().min(5).max(240).nullable(),
  }),
  z.object({ type: z.literal("pause_automation"), scope: z.enum(["reminders", "all"]), until: tsN }),
  z.object({ type: z.literal("resume_automation") }),
  z.object({ type: z.literal("answer_clarification"), answer: z.string().max(200) }),
  z.object({ type: z.literal("answer_confirmation"), nonce: z.string().max(8).nullable(), accept: z.boolean() }),
  z.object({ type: z.literal("help") }),
  z.object({ type: z.literal("general_reply"), text: z.string().max(320) }),
  z.object({ type: z.literal("unsupported"), reason: z.string().max(200) }),
  z.object({ type: z.literal("activity_history"), day: z.enum(["today", "yesterday"]) }),
  z.object({ type: z.literal("undo") }),
  z.object({ type: z.literal("suggestion_response"), op: z.enum(["accept", "dismiss", "snooze", "never"]), number: z.number().int().min(1).max(9).nullable() }),
  z.object({
    type: z.literal("enable_feature"),
    feature: z.enum(["memory", "task_accountability", "morning_routines", "suggestions", "meeting_prep", "post_meeting", "evening_reset", "photos_assessment"]),
    enabled: z.boolean(),
  }),
  z.object({ type: z.literal("plan_day"), mode: z.enum(["plan", "minimum_viable", "evening_reset"]), day: tsN }),
  z.object({ type: z.literal("context_tasks"), minutes: z.number().int().min(1).max(600).nullable(), context: z.array(z.string().max(30)).max(5) }),
  z.object({ type: z.literal("free_time"), minutes: z.number().int().min(5).max(720) }),
  z.object({ type: z.literal("trip_brief"), destination: z.string().max(120).nullable() }),
] as const;

/** Memory actions: offered to the model only while memory capture is on. */
const MEMORY_ACTIONS = [
  z.object({
    type: z.literal("memory_query"),
    query_kind: z.enum([
      "item_location",
      "container_contents",
      "item_history",
      "about",
      "learned_about_me",
      "why",
      "promises",
      "waiting_for",
      "questions",
      "decisions",
      "predictions",
      "accomplishments",
      "resume_bullets",
      "ideas",
      "admin",
      "recruiting",
      "search",
      "last_capture",
    ]),
    subject: z.string().max(160).nullable(),
  }),
  z.object({ type: z.literal("memory_forget"), scope: z.enum(["last_message", "entity", "matching_facts"]), target: z.string().max(160).nullable() }),
  z.object({ type: z.literal("memory_correct"), target: z.string().max(160), correction: z.string().max(300) }),
  z.object({ type: z.literal("capture_control"), mode: z.enum(["pause", "resume", "enable", "status"]), until: tsN }),
  z.object({ type: z.literal("resume_project"), project: z.string().max(120) }),
] as const;

/** Accountability actions: offered only while task accountability or morning routines are on. */
const ACCOUNTABILITY_ACTIONS = [
  z.object({
    type: z.literal("accountability_start"),
    task_ref: z.string().max(120).nullable(),
    start: tsN,
    end: tsN,
    within_minutes: z.number().int().min(5).max(480).nullable().describe("For 'check on me once during the next hour'."),
    checkpoints: z
      .array(
        z.object({
          at: z.enum(["start", "halfway", "end", "offset"]),
          offset_minutes: z.number().int().min(0).max(480).nullable(),
          evidence: z.enum(["photo", "text", "device", "any"]),
          criterion: z.string().max(160).nullable(),
        }),
      )
      .max(4),
    allow_call: z.boolean(),
  }),
  z.object({
    type: z.literal("accountability_control"),
    op: z.enum(["pause", "resume", "cancel", "cancel_routine", "no_photos", "status"]),
    minutes: z.number().int().min(1).max(240).nullable(),
  }),
  z.object({
    type: z.literal("morning_routine"),
    wake: ts,
    recurrence,
    first_activity: z.string().max(80).nullable(),
    device_check: z.boolean(),
  }),
] as const;

export const ActionSchema = z.discriminatedUnion("type", [...CORE_ACTIONS, ...MEMORY_ACTIONS, ...ACCOUNTABILITY_ACTIONS]);
export type Action = z.infer<typeof ActionSchema>;
export type ActionType = Action["type"];
export type ActionOf<T extends ActionType> = Extract<Action, { type: T }>;

export const MAX_ACTIONS = 5;

/** The model's interpretation envelope. Self-reported confidence is deliberately absent. */
export const InterpretationSchema = z.object({
  // Bookkeeping fields: filled by deterministic/simulated planners; the live model doesn't write them.
  intent: z.string().max(80).default(""),
  time_expressions: z.array(z.string().max(120)).max(10).default([]),
  references: z.array(z.string().max(120)).max(10).default([]),
  missing_fields: z.array(z.string().max(60)).max(10).default([]),
  actions: z.array(ActionSchema).min(1).max(MAX_ACTIONS),
  knowledge: z.array(KnowledgeCandidateSchema).max(MAX_CANDIDATES).default([]).describe("Memories to store from this message; empty when nothing durable was said."),
});
export type Interpretation = z.infer<typeof InterpretationSchema>;

/** Stored plan = interpretation + provenance; resumed (not regenerated) on job retry. */
export interface StoredPlan {
  source_message_id: string;
  source: "deterministic" | "ai" | "ai_unavailable";
  interpretation: Interpretation;
  /** Candidates dropped before storage because memory was off or the message was off-record. */
  knowledgeDropped?: number;
}

export function blankTimeSpec(raw = ""): TimeSpec {
  return {
    raw,
    relative_minutes: null,
    day_kind: "none",
    weekday: null,
    weekday_qualifier: null,
    date: null,
    hour: null,
    minute: null,
    meridiem: null,
    part_of_day: null,
  };
}

/** Actions that only read state; safe to execute without confirmation. */
export const READ_ONLY_ACTIONS: ReadonlySet<ActionType> = new Set([
  "list_tasks",
  "get_task",
  "get_agenda",
  "find_calendar_events",
  "get_settings",
  "get_status",
  "help",
  "general_reply",
  "unsupported",
  "memory_query",
  "activity_history",
  "context_tasks",
  "free_time",
  "trip_brief",
]);

// ---------- JSON Schema for OpenAI strict structured outputs ----------

type JsonSchema = Record<string, unknown>;

/** Keywords the model doesn't need: Zod re-validates every bound after the response arrives. */
const DROP_KEYWORDS = new Set(["$schema", "minLength", "maxLength", "minItems", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"]);

function normalizeForStrict(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(normalizeForStrict);
  if (!node || typeof node !== "object") return node;
  const obj: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) if (!DROP_KEYWORDS.has(k)) obj[k] = normalizeForStrict(v);
  if (obj.oneOf) {
    obj.anyOf = obj.oneOf;
    delete obj.oneOf;
  }
  if (obj.type === "object" && obj.properties && typeof obj.properties === "object") {
    obj.additionalProperties = false;
    obj.required = Object.keys(obj.properties as object);
  }
  return obj;
}

/** Inlines shared fragments that are smaller than a reference to them; renames the rest d0, d1, …. */
function compactDefs(schema: JsonSchema): JsonSchema {
  const defs = (schema.$defs ?? {}) as Record<string, unknown>;
  const uses = new Map<string, number>();
  for (const m of JSON.stringify(schema).matchAll(/"#\/\$defs\/([^"]+)"/g)) uses.set(m[1]!, (uses.get(m[1]!) ?? 0) + 1);
  const inline = new Set(Object.keys(defs).filter((k) => (uses.get(k) ?? 0) <= 1 || JSON.stringify(defs[k]).length <= 24));
  const names = new Map(
    Object.keys(defs)
      .filter((k) => !inline.has(k))
      .map((k, i) => [k, `d${i}`]),
  );
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== "object") return node;
    const obj = node as Record<string, unknown>;
    if (typeof obj.$ref === "string") {
      const key = obj.$ref.replace("#/$defs/", "");
      const { $ref: _ref, ...rest } = obj;
      if (inline.has(key)) return { ...(walk(defs[key]) as object), ...rest };
      // OpenAI strict mode: a $ref may not carry sibling keywords (e.g. description).
      if (names.has(key)) return { $ref: `#/$defs/${names.get(key)}` };
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) if (k !== "$defs") out[k] = walk(v);
    return out;
  };
  const body = walk(schema) as JsonSchema;
  if (names.size) body.$defs = Object.fromEntries([...names].map(([old, short]) => [short, walk(defs[old])]));
  return body;
}

/** Which optional parts of the vocabulary the model is offered for this request. */
export interface SchemaFeatures {
  /** Memory questions/controls (memory on). */
  memory: boolean;
  /** Memory extraction candidates (memory on and the message states something). */
  knowledge?: boolean;
  accountability: boolean;
}

export const ALL_FEATURES: SchemaFeatures = { memory: true, knowledge: true, accountability: true };

const schemaCache = new Map<string, JsonSchema>();

/**
 * Strict JSON schema for one request. Only enabled feature groups are included, and repeated
 * sub-schemas (time expressions, recurrence) are emitted once as $defs, which keeps the
 * per-request token cost small. The response is still validated against the full Zod schema.
 */
export function interpretationJsonSchema(f: SchemaFeatures = ALL_FEATURES): JsonSchema {
  const knowledge = f.knowledge ?? f.memory;
  const key = `${f.memory ? "m" : ""}${knowledge ? "k" : ""}${f.accountability ? "a" : ""}`;
  const hit = schemaCache.get(key);
  if (hit) return hit;
  const options = [...CORE_ACTIONS, ...(f.memory ? MEMORY_ACTIONS : []), ...(f.accountability ? ACCOUNTABILITY_ACTIONS : [])] as unknown as [
    (typeof CORE_ACTIONS)[number],
    ...(typeof CORE_ACTIONS)[number][],
  ];
  const wire = z.object({
    actions: z.array(z.discriminatedUnion("type", options)).max(MAX_ACTIONS),
    ...(knowledge ? { knowledge: z.array(KnowledgeCandidateSchema).max(MAX_CANDIDATES) } : {}),
  });
  const schema = compactDefs(normalizeForStrict(z.toJSONSchema(wire, { target: "draft-2020-12", reused: "ref" })) as JsonSchema);
  schemaCache.set(key, schema);
  return schema;
}
