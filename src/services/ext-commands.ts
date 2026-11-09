import { blankTimeSpec, type Action, type ActionOf } from "../domain/actions";

/**
 * Deterministic extension commands: exact memory queries, forget/undo, capture control,
 * accountability controls, suggestion responses, and planning shortcuts. No AI request is spent.
 * Input is already lowercased with trailing punctuation removed.
 */

type QueryKind = ActionOf<"memory_query">["query_kind"];
const q = (query_kind: QueryKind, subject: string | null = null): Action => ({
  type: "memory_query",
  query_kind,
  subject: subject ? subject.replace(/^(my|the|our)\s+/, "").trim() || null : null,
});

const FEATURES: Record<string, ActionOf<"enable_feature">["feature"]> = {
  memory: "memory",
  accountability: "task_accountability",
  "task accountability": "task_accountability",
  "morning routine": "morning_routines",
  "morning routines": "morning_routines",
  suggestions: "suggestions",
  "meeting prep": "meeting_prep",
  "post meeting": "post_meeting",
  "post-meeting": "post_meeting",
  "post meeting check-ins": "post_meeting",
  "post-meeting check-ins": "post_meeting",
  "evening reset": "evening_reset",
  "photo assessment": "photos_assessment",
};

const NOT_PROJECTS = /^(reminders|everything|all|automation|memory|session|accountability|checks)$/;

const CALENDARISH = /\b(calendar|agenda|schedule|today|tomorrow|tonight|this week|next week|meeting|wake-?up call)\b/;

export function parseExtCommand(t: string, opts: { accountabilityActive: boolean }): Action | null {
  let m: RegExpExecArray | null;
  if ((m = /^(?:what did you (?:change|do)|activity|history)(?: (today|yesterday))?$/.exec(t)))
    return { type: "activity_history", day: m[1] === "yesterday" ? "yesterday" : "today" };
  if (CALENDARISH.test(t) && /^(where|what)/.test(t)) return null;
  // Memory queries
  if ((m = /^where was i (?:on|with) (.+)$/.exec(t))) return { type: "resume_project", project: m[1]! };
  if ((m = /^where (?:did i (?:put|leave)|(?:is|are|'s)|s) (.+)$/.exec(t.replace(/^where's /, "where is ")))) return q("item_location", m[1]!);
  if ((m = /^where (?:has|have) (.+?) been$/.exec(t))) return q("item_history", m[1]!);
  if ((m = /^(?:what'?s|what is|what are) (?:in|inside|on) (.+)$/.exec(t))) return q("container_contents", m[1]!);
  if ((m = /^what (?:did i promise|do i owe)(?: to)?(?: (.+))?$/.exec(t))) return q("promises", m[1] ?? null);
  if ((m = /^(?:what|who) am i waiting (?:on|for)(?: from (.+))?$/.exec(t)) || /^who owes me(?: anything)?$/.test(t)) return q("waiting_for", m?.[1] ?? null);
  if ((m = /^what questions do i have(?: for (.+))?$/.exec(t))) return q("questions", m[1] ?? null);
  if ((m = /^what (?:decisions have i made|did i decide)(?: about (.+))?$/.exec(t))) return q("decisions", m[1] ?? null);
  if (/^(?:my )?predictions$/.test(t)) return q("predictions");
  if (/^(?:my )?(?:wins|accomplishments|evidence locker)$/.test(t)) return q("accomplishments");
  if (/^(?:resume bullets?|bullets? for my resume)$/.test(t)) return q("resume_bullets");
  if (/^(?:my |parked )?ideas$/.test(t)) return q("ideas");
  if (/^admin(?: items)?$/.test(t)) return q("admin");
  if (/^(?:recruiting|applications|my applications)$/.test(t)) return q("recruiting");
  if (/^what (?:have you learned|do you know) about me$/.test(t)) return q("learned_about_me");
  if ((m = /^(?:what do you know about|tell me about) (.+)$/.exec(t))) return q("about", m[1]!);
  if (/^why(?: do you think (?:that|so))?$/.test(t)) return q("why");
  if (/^what did you (?:save|store|remember)(?: from that)?$/.test(t)) return q("last_capture");
  if ((m = /^(?:search(?: for)?|recall|search memory for) (.+)$/.exec(t))) return q("search", m[1]!);
  // Deletion and undo
  if (/^(?:forget (?:that|it)|don'?t remember (?:that|this)|don'?t store (?:that|this)|delete that memory)$/.test(t))
    return { type: "memory_forget", scope: "last_message", target: null };
  if ((m = /^forget (?:everything about |about )?(.+)$/.exec(t))) return { type: "memory_forget", scope: "entity", target: m[1]! };
  if (/^undo(?: that| last| it)?$/.test(t)) return { type: "undo" };
  // Capture control and features
  if ((m = /^pause memory(?: for (\d+) (hours?|days?))?$/.exec(t))) {
    const mins = m[1] ? Number(m[1]) * (m[2]!.startsWith("day") ? 1440 : 60) : 1440;
    return { type: "capture_control", mode: "pause", until: { ...blankTimeSpec(t), relative_minutes: mins } };
  }
  if (/^resume memory$/.test(t)) return { type: "capture_control", mode: "resume", until: null };
  if (/^memory status$/.test(t)) return { type: "capture_control", mode: "status", until: null };
  if ((m = /^(enable|turn on|disable|turn off) (.+)$/.exec(t)) && FEATURES[m[2]!])
    return { type: "enable_feature", feature: FEATURES[m[2]!]!, enabled: m[1] === "enable" || m[1] === "turn on" };
  // Accountability controls
  if (/^(?:cancel|stop) (?:my )?(?:morning )?routine$/.test(t)) return { type: "accountability_control", op: "cancel_routine", minutes: null };
  if (/^(?:stop|cancel|end) (?:this )?(?:accountability(?: session)?|session|check-?ins?)$/.test(t)) return { type: "accountability_control", op: "cancel", minutes: null };
  if (/^no (?:more )?photos(?: for this session)?$/.test(t)) return { type: "accountability_control", op: "no_photos", minutes: null };
  if (/^(?:session|accountability) status$/.test(t)) return { type: "accountability_control", op: "status", minutes: null };
  if (/^resume (?:session|accountability)$/.test(t)) return { type: "accountability_control", op: "resume", minutes: null };
  if (opts.accountabilityActive && (m = /^pause(?: session| accountability)?(?: for)? (\d+)(?: ?(?:m|min|mins|minutes))?$/.exec(t)))
    return { type: "accountability_control", op: "pause", minutes: Math.min(240, Number(m[1])) };
  // Suggestions
  if ((m = /^(accept|do|dismiss|snooze|never) (\d)$/.exec(t)))
    return { type: "suggestion_response", op: m[1] === "do" ? "accept" : (m[1] as "accept" | "dismiss" | "snooze" | "never"), number: Number(m[2]) };
  // Planning
  if (/^plan (?:my day|today)$/.test(t)) return { type: "plan_day", mode: "plan", day: null };
  if (/^(?:minimum viable day|mvd|bad day|low energy day|i'?m having a bad day)$/.test(t)) return { type: "plan_day", mode: "minimum_viable", day: null };
  if (/^evening reset$/.test(t)) return { type: "plan_day", mode: "evening_reset", day: null };
  if ((m = /^i have (\d+) (min(?:ute)?s?|hours?) free$/.exec(t)))
    return { type: "free_time", minutes: Math.min(720, Math.max(5, Number(m[1]) * (m[2]!.startsWith("h") ? 60 : 1))) };
  if ((m = /^what can i do in (\d+) min(?:ute)?s?(?: (?:on|at|from) (?:my )?(phone|laptop|home|computer|office))?$/.exec(t)))
    return { type: "context_tasks", minutes: Number(m[1]), context: m[2] ? [m[2]] : [] };
  if ((m = /^(?:trip brief|what should i pack)(?: for (.+))?$/.exec(t))) return { type: "trip_brief", destination: m[1] ?? null };
  if ((m = /^(?:resume|continue|pick up) (?:the |my )?(.+?)(?: project)?$/.exec(t)) && !NOT_PROJECTS.test(m[1]!)) return { type: "resume_project", project: m[1]! };
  return null;
}
