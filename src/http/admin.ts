import { Hono, type Context } from "hono";
import { html } from "hono/html";
import { configErrors, isValidTimeZone } from "../config";
import { listAlarms, cancelAlarm, createAlarm, nextOccurrenceTime } from "../domain/alarms";
import { agendaText } from "../domain/calendar";
import { cancelTask, completeTask, decryptTask, reopenTask, rescheduleReminder, type TaskRow } from "../domain/tasks";
import { HOUR, MINUTE, formatMinuteOfDay, localParts, parseHHMM, resolveLocal, todayLocal } from "../domain/time";
import { scriptSimOutcome, type SimOutcome } from "../providers/simulated/common";
import { SIM_PRIMARY_CALENDAR, simMoveEvent, simSetRevoked, simUpsertExternalEvent } from "../providers/simulated/calendar";
import { redactPhone } from "../security/redaction";
import { clearedSessionCookie, checkCsrf, clientKey, getSession, login, logout, readCookie, SESSION_COOKIE, sessionCookie } from "../security/sessions";
import { audit } from "../services/audit";
import { ERASE_CONFIRMATION_PHRASE, eraseAllData, exportOwnerData, resumeAfterRestore } from "../services/backup";
import {
  activateConnection,
  connectSimulatedCalendar,
  disconnectCalendar,
  getConnection,
  knownCalendars,
  readCalendarIds,
  refreshCalendarList,
  selectCalendars,
} from "../services/calendar-connection";
import { operatorRetrySms } from "../services/effects";
import { aiReadiness, calendarReadiness, smsReadiness, voiceReadiness, type ChannelReadiness } from "../services/readiness";
import { runTick } from "../services/scheduler";
import { PAUSE_INDEFINITE, getSettings, getSystemState, updateSettings, type OwnerSettings } from "../services/settings";
import { clearSimClock, drainJobs, setSimClock, simBase, simCall, simDeliveryCallback, simSendFromOwner, type CallScript } from "../services/simulator";
import { limitFor, usageToday, type UsageMetric } from "../services/usage";
import { APP_CSS, APP_JS, csrfField, layout, postButton, statusPill, table, type Html } from "../ui/layout";
import type { AppEnvBindings } from "./types";
import { back, expectedOrigin, form, page, secureCookies, ts } from "./admin-helpers";
import { registerExtensionPages, extensionDiagnostics } from "./admin-ext";

type C = Context<AppEnvBindings>;

/** Parses a datetime-local value as wall time in the owner's zone (gap → next valid; fold → earlier). */
function parseLocalDateTime(value: string, tz: string): number | null {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!m) return null;
  const r = resolveLocal(m[1]!, Number(m[2]), Number(m[3]), tz);
  return r.kind === "exact" ? r.ms : r.kind === "gap" ? r.nextValidMs : r.earlierMs;
}

function toLocalInput(ms: number, tz: string): string {
  const p = localParts(ms, tz);
  return `${p.date}T${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}

function readinessCard(r: ChannelReadiness): Html {
  const failing = r.checks.filter((x) => !x.ok);
  return html`<div class="card">
    <h2>${r.channel.toUpperCase()} <span class="muted">(${r.provider})</span></h2>
    <p>
      ${statusPill(r.mode, r.mode === "live" ? "ok" : r.mode === "simulated" ? "info" : "warn")}
      ${r.ready ? statusPill("ready", "ok") : statusPill(`${failing.length} blocker${failing.length === 1 ? "" : "s"}`, "warn")}
    </p>
    <ul>
      ${failing.slice(0, 4).map((f) => html`<li>${f.name}: ${f.detail} <span class="muted">[${f.kind}]</span></li>`)}
    </ul>
  </div>`;
}

export function adminRoutes(): Hono<AppEnvBindings> {
  const app = new Hono<AppEnvBindings>();

  app.get("/assets/app.css", (c) => c.body(APP_CSS, 200, { "content-type": "text/css; charset=utf-8", "cache-control": "public, max-age=300" }));
  app.get("/assets/app.js", (c) => c.body(APP_JS, 200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=300" }));

  app.get("/login", async (c) => {
    const ctx = c.get("app");
    const disabled = !ctx.config.adminSecret;
    return c.html(
      layout(
        {
          title: "Sign in",
          active: "",
          csrf: null,
          simulatorEnabled: false,
          modes: [],
          flash: c.req.query("err") ? { kind: "error", text: c.req.query("err") === "throttled" ? "Too many attempts. Wait 15 minutes." : "Sign-in failed." } : null,
        },
        disabled
          ? html`<p>Admin login is disabled because ADMIN_BOOTSTRAP_SECRET is not configured.</p>`
          : html`<form method="post" action="/admin/login" class="card">
              <label for="secret">Admin secret</label>
              <input id="secret" name="secret" type="password" autocomplete="current-password" required />
              <p><button type="submit" class="primary">Sign in</button></p>
            </form>`,
      ),
    );
  });

  app.post("/login", async (c) => {
    const ctx = c.get("app");
    const origin = c.req.header("origin");
    if (origin && origin !== expectedOrigin(c)) return c.redirect("/admin/login?err=1", 303);
    const f = await form(c);
    const r = await login(ctx, f.secret ?? "", clientKey(c.req.raw));
    if (!r.ok) {
      await audit(ctx, "admin", "login.failed", null, null, r.reason);
      return c.redirect(`/admin/login?err=${r.reason}`, 303);
    }
    // Rotation: any presented old session is revoked on successful login.
    await logout(ctx, readCookie(c.req.raw, SESSION_COOKIE));
    await audit(ctx, "admin", "login.ok", null, null);
    c.header("set-cookie", sessionCookie(r.token, secureCookies(c)));
    return c.redirect("/admin", 303);
  });

  // Everything below requires a valid session; state-changing requests require CSRF + Origin.
  app.use("*", async (c, next) => {
    const ctx = c.get("app");
    const token = readCookie(c.req.raw, SESSION_COOKIE);
    const session = await getSession(ctx, token);
    if (!session) {
      if (c.req.method === "GET") return c.redirect("/admin/login", 303);
      return c.text("Unauthorized", 401);
    }
    c.set("session", session);
    c.set("sessionToken", token);
    if (c.req.method === "POST") {
      const f = await form(c);
      if (!checkCsrf(c.req.raw, session, f._csrf ?? null, expectedOrigin(c))) return c.text("CSRF check failed", 403);
    }
    await next();
  });

  app.post("/logout", async (c) => {
    await logout(c.get("app"), c.get("sessionToken"));
    c.header("set-cookie", clearedSessionCookie(secureCookies(c)));
    return c.redirect("/admin/login", 303);
  });

  // ---------- Overview ----------
  app.get("/", async (c) => {
    const ctx = c.get("app");
    const s = await getSettings(ctx.db);
    const tz = s.timezone;
    const [sms, voice, cal, ai] = await Promise.all([smsReadiness(ctx, s), voiceReadiness(ctx, s), calendarReadiness(ctx), aiReadiness(ctx)]);
    const lastTick = Number((await getSystemState(ctx.db, "last_tick_at")) ?? "0");
    const lag = Number((await getSystemState(ctx.db, "last_tick_lag_ms")) ?? "0");
    const usage = await usageToday(ctx, tz);
    const counts = await ctx.db.first<{ open: number; pending: number; failed: number; unknown: number }>(
      `SELECT (SELECT COUNT(*) FROM tasks WHERE status='open') AS open, (SELECT COUNT(*) FROM jobs WHERE status='pending') AS pending,
       (SELECT COUNT(*) FROM jobs WHERE status IN ('failed','dead','blocked')) AS failed, (SELECT COUNT(*) FROM outbound_effects WHERE state='unknown') AS unknown`,
    );
    const nextJobs = await ctx.db.all<{ id: string; kind: string; due_at: number; status: string }>(
      "SELECT id, kind, due_at, status FROM jobs WHERE status = 'pending' ORDER BY due_at LIMIT 10",
    );
    const problems = await ctx.db.all<{ id: string; channel: string; purpose: string; state: string; error_detail: string | null; created_at: number }>(
      "SELECT id, channel, purpose, state, error_detail, created_at FROM outbound_effects WHERE state IN ('unknown','failed') ORDER BY created_at DESC LIMIT 10",
    );
    const suppressedSms = (await ctx.db.first<{ state: string }>("SELECT state FROM suppressions WHERE channel='sms'"))?.state ?? "active";
    const heartbeatOk = lastTick > 0 && ctx.clock.now() - lastTick < 3 * MINUTE;
    const metrics: UsageMetric[] = ["inbound", "sms_segments", "call_attempts", "call_minutes", "ai_requests"];
    return page(
      c,
      "Overview",
      "/admin",
      html`
        ${s.restore_hold ? html`<p class="flash error">Restored database: proactive automation is on hold until you review and resume on the Data page.</p>` : ""}
        <div class="grid">${readinessCard(sms)} ${readinessCard(voice)} ${readinessCard(cal)} ${readinessCard(ai)}</div>
        <div class="grid">
          <div class="card">
            <h2>Scheduler</h2>
            <p>${heartbeatOk ? statusPill("heartbeat ok", "ok") : statusPill("no recent tick", "bad")} Last tick: ${ts(lastTick, tz)} (lag ${Math.round(lag / 1000)}s)</p>
            <p class="muted">Minute-scale cron; not exact-second delivery.</p>
          </div>
          <div class="card">
            <h2>Consent and pause</h2>
            <p>SMS consent: ${s.sms_consent_at ? ts(s.sms_consent_at, tz) : "not recorded"}. Calls consent: ${s.call_consent_at ? ts(s.call_consent_at, tz) : "not recorded"}.</p>
            <p>
              SMS opt-out: ${suppressedSms}. Pause:
              ${s.automation_paused_until && s.automation_paused_until > ctx.clock.now() ? `${s.automation_pause_scope} until ${s.automation_paused_until >= PAUSE_INDEFINITE ? "resumed" : ts(s.automation_paused_until, tz)}` : "none"}.
            </p>
          </div>
          <div class="card">
            <h2>Today's usage</h2>
            <ul>
              ${metrics.map((m) => html`<li>${m}: ${usage[m].used}${usage[m].reserved ? ` (+${usage[m].reserved} reserved)` : ""} / ${limitFor(s, m)}</li>`)}
            </ul>
          </div>
          <div class="card">
            <h2>Counts</h2>
            <p>
              ${counts?.open ?? 0} open tasks · ${counts?.pending ?? 0} pending jobs · ${counts?.failed ?? 0} failed/dead/blocked jobs · ${counts?.unknown ?? 0} unknown effects
            </p>
          </div>
        </div>
        <h2>Next jobs</h2>
        ${table(
          ["Kind", "Due", "Status"],
          nextJobs.map((j) => [html`${j.kind}`, html`${ts(j.due_at, tz)}`, html`${j.status}`]),
        )}
        <h2>Failed or unknown effects</h2>
        ${table(
          ["Channel", "Purpose", "State", "Detail", "Created"],
          problems.map((p) => [
            html`${p.channel}`,
            html`${p.purpose}`,
            statusPill(p.state, p.state === "unknown" ? "warn" : "bad"),
            html`${p.error_detail ?? ""}`,
            html`${ts(p.created_at, tz)}`,
          ]),
          "None.",
        )}
      `,
    );
  });

  // ---------- Simulator (non-production only) ----------
  const sim = new Hono<AppEnvBindings>();
  sim.use("*", async (c, next) => {
    if (!c.get("app").config.simulatorEnabled) return c.text("Not found", 404);
    await next();
  });

  sim.get("/", async (c) => {
    const ctx = c.get("app");
    const s = await getSettings(ctx.db);
    const tz = s.timezone;
    const csrf = c.get("session")!.csrf_token;
    const simNow = await getSystemState(ctx.db, "sim_now");
    const msgs = await ctx.db.all<{ direction: string; body: string; provider_sid: string | null; status: string; created_at: number }>(
      "SELECT direction, body, provider_sid, status, created_at FROM (SELECT rowid AS rid, * FROM sim_messages ORDER BY created_at DESC, rowid DESC LIMIT 60) ORDER BY created_at, rid",
    );
    const calls = await ctx.db.all<{ sid: string; status: string; created_at: number }>("SELECT sid, status, created_at FROM sim_calls ORDER BY created_at DESC LIMIT 10");
    const events = await ctx.db.all<{ event_id: string; data_json: string }>(
      "SELECT event_id, data_json FROM sim_calendar_events WHERE calendar_id = ? ORDER BY updated_at DESC LIMIT 15",
      SIM_PRIMARY_CALENDAR,
    );
    const revoked = (await getSystemState(ctx.db, "sim_calendar_revoked")) === "1";
    return page(
      c,
      "Conversation simulator",
      "/admin/simulator",
      html`
        <p class="sim-banner">
          <strong>Simulated.</strong> Messages, calls, and calendar events here never reach a real phone, carrier, or calendar. The simulator uses the same webhooks, database,
          jobs, and scheduler as production.
        </p>
        <div class="grid">
          <div class="card">
            <h2>Clock</h2>
            <p>${simNow ? html`Frozen at <strong>${ts(Number(simNow), tz)}</strong>` : html`Real time (${ts(ctx.clock.now(), tz)})`}</p>
            <form method="post" action="/admin/simulator/clock" class="row">
              ${csrfField(csrf)}
              <div><label for="at">Set (local ${tz})</label><input id="at" name="at" type="datetime-local" value="${toLocalInput(ctx.clock.now(), tz)}" /></div>
              <button type="submit">Set</button>
            </form>
            <div class="row">
              ${["1m", "10m", "1h", "6h", "1d"].map((d) => postButton("/admin/simulator/advance", `+${d}`, csrf, { fields: { by: d } }))}
              ${postButton("/admin/simulator/clock", "Use real time", csrf, { fields: { real: "1" } })}
            </div>
            <div class="row">${postButton("/admin/simulator/tick", "Run scheduler tick", csrf)} ${postButton("/admin/simulator/drain", "Process due jobs", csrf)}</div>
          </div>
          <div class="card">
            <h2>Scripted failures</h2>
            <form method="post" action="/admin/simulator/script" class="row">
              ${csrfField(csrf)}
              <div>
                <label for="op">Next operation</label>
                <select id="op" name="op">
                  ${["sms_send", "call_create", "ai", "calendar_read", "calendar_write", "calendar_insert_response"].map((o) => html`<option>${o}</option>`)}
                </select>
              </div>
              <div>
                <label for="outcome">Outcome</label>
                <select id="outcome" name="outcome">
                  ${["reject_permanent", "reject_retryable", "unknown", "unknown_but_accepted", "unavailable", "timeout", "refusal", "invalid", "incomplete", "rate_limited"].map((o) => html`<option>${o}</option>`)}
                </select>
              </div>
              <button type="submit">Queue</button>
            </form>
            <p>
              ${postButton("/admin/simulator/calendar-revoke", revoked ? "Restore calendar consent" : "Revoke calendar consent", csrf, { fields: { revoked: revoked ? "0" : "1" } })}
            </p>
          </div>
        </div>
        <h2>Conversation</h2>
        <div class="chat" aria-live="polite">
          ${msgs.length === 0 ? html`<p class="empty">No messages yet.</p>` : ""}
          ${msgs.map(
            (m) =>
              html`<div class="msg ${m.direction}">
                <span class="text">${m.body}</span>
                <span class="meta"
                  >${m.direction === "from_owner" ? "You" : m.direction === "provider_auto" ? "Provider" : "Della"} ·
                  ${ts(m.created_at, tz)}${m.direction === "to_owner" ? ` · ${m.status}` : ""}</span
                >
                ${
                  m.direction === "to_owner" && m.provider_sid && (m.status === "queued" || m.status === "sent")
                    ? html`<span class="row"
                        >${postButton("/admin/simulator/sms-status", "Mark delivered", csrf, { fields: { sid: m.provider_sid, status: "delivered" } })}
                        ${postButton("/admin/simulator/sms-status", "Mark failed", csrf, { fields: { sid: m.provider_sid, status: "failed" } })}</span
                      >`
                    : ""
                }
              </div>`,
          )}
        </div>
        <form method="post" action="/admin/simulator/send" class="row">
          ${csrfField(csrf)}
          <div style="flex:1 1 300px"><label for="text">Text Della as the owner</label><input id="text" name="text" required maxlength="1000" autocomplete="off" /></div>
          <button type="submit" class="primary">Send</button>
        </form>
        <h2>Simulated calls</h2>
        ${table(
          ["Call", "Status", "Created", "Act as the phone"],
          calls.map((k) => [
            html`<code>${k.sid.slice(0, 10)}…</code>`,
            html`${k.status}`,
            html`${ts(k.created_at, tz)}`,
            html`${(["press1", "press2", "no_input", "no_answer", "busy", "press2_duplicate"] as CallScript[]).map((s2) => postButton("/admin/simulator/call", s2, csrf, { fields: { sid: k.sid, script: s2 } }))}`,
          ]),
          "No calls yet.",
        )}
        <h2>Simulated calendar (external events)</h2>
        <form method="post" action="/admin/simulator/calendar-event" class="row">
          ${csrfField(csrf)}
          <div><label for="ev-title">Title</label><input id="ev-title" name="title" required maxlength="100" /></div>
          <div><label for="ev-start">Start</label><input id="ev-start" name="start" type="datetime-local" required /></div>
          <div><label for="ev-end">End</label><input id="ev-end" name="end" type="datetime-local" required /></div>
          <div>
            <label><input type="checkbox" name="guests" value="1" /> Has guests</label>
          </div>
          <button type="submit">Add external event</button>
        </form>
        ${table(
          ["Event", "When", "Move"],
          events.map((e) => {
            const d = JSON.parse(e.data_json) as { summary: string; startMs: number | null; endMs: number | null; status: string; createdByDella: boolean };
            return [
              html`${d.summary} ${d.createdByDella ? statusPill("by Della") : ""} ${d.status === "cancelled" ? statusPill("cancelled", "bad") : ""}`,
              html`${d.startMs ? ts(d.startMs, tz) : "all day"}`,
              d.startMs
                ? html`<form method="post" action="/admin/simulator/calendar-move" class="row">
                    ${csrfField(csrf)}<input type="hidden" name="eventId" value="${e.event_id}" /><input
                      name="start"
                      type="datetime-local"
                      aria-label="New start"
                      value="${toLocalInput(d.startMs, tz)}"
                    /><button type="submit">Move</button>
                  </form>`
                : html``,
            ];
          }),
          "No simulated events.",
        )}
      `,
    );
  });

  sim.post("/send", async (c) => {
    const ctx = c.get("app");
    const f = await form(c);
    const text = (f.text ?? "").trim();
    if (!text) return back(c, "/admin/simulator", "err", "invalid");
    await simSendFromOwner(ctx, appFetch(c), text, { base: simBase(ctx, new URL(c.req.url).origin) });
    await drainJobs(ctx, 20);
    return back(c, "/admin/simulator", "ok", "sent");
  });

  sim.post("/clock", async (c) => {
    const ctx = c.get("app");
    const f = await form(c);
    if (f.real === "1") {
      await clearSimClock(ctx);
      return back(c, "/admin/simulator", "ok", "clock");
    }
    const s = await getSettings(ctx.db);
    const ms = parseLocalDateTime(f.at ?? "", s.timezone);
    if (ms === null) return back(c, "/admin/simulator", "err", "invalid");
    await setSimClock(ctx, ms);
    return back(c, "/admin/simulator", "ok", "clock");
  });

  sim.post("/advance", async (c) => {
    const ctx = c.get("app");
    const f = await form(c);
    const by = { "1m": MINUTE, "10m": 10 * MINUTE, "1h": HOUR, "6h": 6 * HOUR, "1d": 24 * HOUR }[f.by ?? ""];
    if (!by) return back(c, "/admin/simulator", "err", "invalid");
    await setSimClock(ctx, ctx.clock.now() + by);
    await runTick(ctx);
    await drainJobs(ctx, 50);
    return back(c, "/admin/simulator", "ok", "clock");
  });

  sim.post("/tick", async (c) => {
    await runTick(c.get("app"));
    return back(c, "/admin/simulator", "ok", "tick");
  });

  sim.post("/drain", async (c) => {
    await drainJobs(c.get("app"), 50);
    return back(c, "/admin/simulator", "ok", "drained");
  });

  sim.post("/script", async (c) => {
    const ctx = c.get("app");
    const f = await form(c);
    const allowedOps = ["sms_send", "call_create", "ai", "calendar_read", "calendar_write", "calendar_insert_response"];
    if (!allowedOps.includes(f.op ?? "")) return back(c, "/admin/simulator", "err", "invalid");
    await scriptSimOutcome(ctx.db, f.op!, (f.outcome ?? "unknown") as SimOutcome, ctx.clock);
    return back(c, "/admin/simulator", "ok", "saved");
  });

  sim.post("/sms-status", async (c) => {
    const ctx = c.get("app");
    const f = await form(c);
    const status = f.status === "failed" ? "failed" : "delivered";
    await simDeliveryCallback(ctx, appFetch(c), f.sid ?? "", status, { base: simBase(ctx, new URL(c.req.url).origin) });
    return back(c, "/admin/simulator", "ok", "done");
  });

  sim.post("/call", async (c) => {
    const ctx = c.get("app");
    const f = await form(c);
    const scripts: CallScript[] = ["press1", "press2", "no_input", "no_answer", "busy", "failed", "press2_duplicate", "out_of_order"];
    if (!scripts.includes(f.script as CallScript)) return back(c, "/admin/simulator", "err", "invalid");
    await simCall(ctx, appFetch(c), f.sid ?? "", f.script as CallScript, { base: simBase(ctx, new URL(c.req.url).origin) });
    await drainJobs(ctx, 20);
    return back(c, "/admin/simulator", "ok", "done");
  });

  sim.post("/calendar-event", async (c) => {
    const ctx = c.get("app");
    const f = await form(c);
    const s = await getSettings(ctx.db);
    const start = parseLocalDateTime(f.start ?? "", s.timezone);
    const end = parseLocalDateTime(f.end ?? "", s.timezone);
    if (!start || !end || end <= start || !f.title) return back(c, "/admin/simulator", "err", "invalid");
    await simUpsertExternalEvent(ctx.db, ctx.clock, {
      eventId: `ext${Date.now().toString(36)}`,
      summary: f.title.slice(0, 100),
      startMs: start,
      endMs: end,
      hasAttendees: f.guests === "1",
    });
    return back(c, "/admin/simulator", "ok", "saved");
  });

  sim.post("/calendar-move", async (c) => {
    const ctx = c.get("app");
    const f = await form(c);
    const s = await getSettings(ctx.db);
    const row = await ctx.db.first<{ data_json: string }>(
      "SELECT data_json FROM sim_calendar_events WHERE calendar_id = ? AND event_id = ?",
      SIM_PRIMARY_CALENDAR,
      f.eventId ?? "",
    );
    const start = parseLocalDateTime(f.start ?? "", s.timezone);
    if (!row || !start) return back(c, "/admin/simulator", "err", "invalid");
    const d = JSON.parse(row.data_json) as { startMs: number; endMs: number };
    await simMoveEvent(ctx.db, ctx.clock, SIM_PRIMARY_CALENDAR, f.eventId!, start, start + (d.endMs - d.startMs));
    return back(c, "/admin/simulator", "ok", "saved");
  });

  sim.post("/calendar-revoke", async (c) => {
    const ctx = c.get("app");
    const f = await form(c);
    await simSetRevoked(ctx.db, ctx.clock, f.revoked === "1");
    return back(c, "/admin/simulator", "ok", "saved");
  });

  app.route("/simulator", sim);

  // ---------- Tasks ----------
  app.get("/tasks", async (c) => {
    const ctx = c.get("app");
    const s = await getSettings(ctx.db);
    const tz = s.timezone;
    const csrf = c.get("session")!.csrf_token;
    const filter = ["open", "completed", "overdue", "all"].includes(c.req.query("filter") ?? "") ? c.req.query("filter")! : "open";
    const where =
      filter === "open" ? "status = 'open'" : filter === "completed" ? "status = 'completed'" : filter === "overdue" ? `status = 'open' AND due_at < ${ctx.clock.now()}` : "1=1";
    const rows = await ctx.db.all<TaskRow>(`SELECT * FROM tasks WHERE ${where} ORDER BY COALESCE(due_at, created_at) DESC LIMIT 100`);
    const tasks = await Promise.all(rows.map((r) => decryptTask(ctx, r)));
    const reminders = await ctx.db.all<{ task_id: string; kind: string; planned_at: number; status: string }>(
      "SELECT task_id, kind, planned_at, status FROM reminders WHERE status = 'scheduled' ORDER BY planned_at",
    );
    return page(
      c,
      "Tasks and reminders",
      "/admin/tasks",
      html`
        <p class="row">${["open", "overdue", "completed", "all"].map((f) => html`<a href="/admin/tasks?filter=${f}" ${f === filter ? html`aria-current="page"` : ""}>${f}</a>`)}</p>
        ${table(
          ["ID", "Title", "Status", "Due", "Scheduled checks", "Recurring", "Actions"],
          tasks.map((t) => [
            html`<code>${t.short_id}</code>`,
            html`${t.title}`,
            statusPill(t.status, t.status === "open" ? "info" : t.status === "completed" ? "ok" : "warn"),
            html`${ts(t.due_at, tz)}`,
            html`${reminders.filter((r) => r.task_id === t.id).map((r) => html`<div>${r.kind}: ${ts(r.planned_at, tz)}</div>`)}`,
            html`${t.series_id ? "yes" : ""}`,
            t.status === "open"
              ? html`${postButton(`/admin/tasks/${t.id}/complete`, "Done", csrf)} ${postButton(`/admin/tasks/${t.id}/snooze`, "Snooze 1h", csrf)}
                ${postButton(`/admin/tasks/${t.id}/cancel`, "Cancel", csrf, { kind: "danger", confirm: "Cancel this task and its reminders?" })}`
              : postButton(`/admin/tasks/${t.id}/reopen`, "Reopen", csrf),
          ]),
          "No tasks.",
        )}
      `,
    );
  });

  app.post("/tasks/:id/:op", async (c) => {
    const ctx = c.get("app");
    const id = c.req.param("id");
    const op = c.req.param("op");
    let ok: boolean;
    if (op === "complete") ok = (await completeTask(ctx, id, "admin")).ok;
    else if (op === "reopen") ok = (await reopenTask(ctx, id, "admin")).ok;
    else if (op === "cancel") ok = (await cancelTask(ctx, id, "admin")).ok;
    else if (op === "snooze") ok = (await rescheduleReminder(ctx, id, ctx.clock.now() + HOUR, { reason: "snoozed" })).ok;
    else return back(c, "/admin/tasks", "err", "not_found");
    return back(c, "/admin/tasks", ok ? "ok" : "err", ok ? "done" : "conflict");
  });

  // ---------- Calendar ----------
  app.get("/calendar", async (c) => {
    const ctx = c.get("app");
    const s = await getSettings(ctx.db);
    const tz = s.timezone;
    const csrf = c.get("session")!.csrf_token;
    const conn = await getConnection(ctx.db);
    const google = ctx.config.providers.calendar === "google";
    const calendars = knownCalendars(conn);
    const readIds = new Set(readCalendarIds(conn));
    const agenda = conn.status === "connected" ? await agendaText(ctx, todayLocal(ctx.clock.now(), tz), tz, "Today") : null;
    return page(
      c,
      "Calendar",
      "/admin/calendar",
      html`
        <div class="card">
          <h2>Connection</h2>
          <p>Provider: ${google ? "Google Calendar" : "Simulated calendar (no real account)"} · Status: ${statusPill(conn.status, conn.status === "connected" ? "ok" : "warn")}</p>
          ${conn.account_email ? html`<p>Verified account: <strong>${conn.account_email}</strong></p>` : ""}
          ${conn.last_sync_at ? html`<p class="muted">Last reconciliation: ${ts(conn.last_sync_at, tz)}${conn.last_sync_error ? ` · last error: ${conn.last_sync_error}` : ""}</p>` : ""}
          ${
            conn.status === "pending_activation"
              ? html`<p>Confirm this is your account, then activate:</p>
                  ${postButton("/admin/calendar/activate", "Activate this account", csrf)}`
              : ""
          }
          <p class="row">
            ${
              conn.status !== "connected" && conn.status !== "pending_activation"
                ? google
                  ? html`<a href="/oauth/google/start"><button type="button" class="primary">Connect Google Calendar</button></a>`
                  : postButton("/admin/calendar/connect-sim", "Connect simulated calendar", csrf)
                : ""
            }
            ${conn.status !== "disconnected" ? postButton("/admin/calendar/disconnect", "Disconnect", csrf, { kind: "danger", confirm: "Disconnect and delete stored tokens?" }) : ""}
          </p>
          ${
            google
              ? html`<p class="muted">
                  Google OAuth apps in "Testing" publishing status issue refresh tokens that expire after 7 days, so Della will need reconnecting weekly in that mode. See
                  docs/SETUP.md.
                </p>`
              : ""
          }
        </div>
        ${
          conn.status === "connected"
            ? html`<div class="card">
                  <h2>Calendars</h2>
                  <form method="post" action="/admin/calendar/select">
                    ${csrfField(csrf)}
                    ${table(
                      ["Calendar", "Write (default)", "Read"],
                      calendars.map((cal) => [
                        html`${cal.summary} ${cal.primary ? statusPill("primary") : ""} <span class="muted">${cal.accessRole}</span>`,
                        html`<input
                          type="radio"
                          name="write"
                          value="${cal.id}"
                          aria-label="Write to ${cal.summary}"
                          ${conn.default_write_calendar_id === cal.id ? "checked" : ""}
                        />`,
                        html`<input
                          type="checkbox"
                          name="read_${calendars.indexOf(cal)}"
                          value="${cal.id}"
                          aria-label="Read ${cal.summary}"
                          ${readIds.has(cal.id) ? "checked" : ""}
                        />`,
                      ]),
                      "No calendars found.",
                    )}
                    <p><button type="submit">Save selection</button> ${postButton("/admin/calendar/refresh", "Refresh list", csrf)}</p>
                  </form>
                </div>
                <div class="card">
                  <h2>Today (live read)</h2>
                  <p>${agenda}</p>
                </div>`
            : html`<p class="empty">No calendar connected; no agenda is shown.</p>`
        }
        <div class="card">
          <h2>Heads-up reminders</h2>
          <form method="post" action="/admin/settings" class="row">
            ${csrfField(csrf)}
            <input type="hidden" name="section" value="headsup" />
            <div>
              <label><input type="checkbox" name="calendar_headsup_enabled" value="1" ${s.calendar_headsup_enabled ? "checked" : ""} /> Text me before timed events</label>
            </div>
            <div>
              <label for="lead">Lead time (minutes)</label
              ><input id="lead" name="calendar_headsup_lead_minutes" type="number" min="5" max="240" value="${s.calendar_headsup_lead_minutes}" />
            </div>
            <button type="submit">Save</button>
          </form>
          <p class="muted">
            Polling every 5 minutes; changes can take about 5 minutes to appear. One heads-up per event instance. Declined, free, cancelled, and all-day events are excluded.
          </p>
        </div>
      `,
    );
  });

  app.post("/calendar/connect-sim", async (c) => {
    const ctx = c.get("app");
    if (ctx.config.providers.calendar !== "simulated") return back(c, "/admin/calendar", "err", "invalid");
    await connectSimulatedCalendar(ctx);
    return back(c, "/admin/calendar", "ok", "connected");
  });
  app.post("/calendar/activate", async (c) => back(c, "/admin/calendar", (await activateConnection(c.get("app"))) ? "ok" : "err", "activated"));
  app.post("/calendar/disconnect", async (c) => {
    await disconnectCalendar(c.get("app"));
    return back(c, "/admin/calendar", "ok", "disconnected");
  });
  app.post("/calendar/refresh", async (c) => {
    try {
      await refreshCalendarList(c.get("app"));
      return back(c, "/admin/calendar", "ok", "saved");
    } catch {
      return back(c, "/admin/calendar", "err", "oauth_error");
    }
  });
  app.post("/calendar/select", async (c) => {
    const ctx = c.get("app");
    const f = await form(c);
    const reads = Object.entries(f)
      .filter(([k]) => k.startsWith("read_"))
      .map(([, v]) => v);
    const ok = await selectCalendars(ctx, f.write ?? null, reads);
    return back(c, "/admin/calendar", ok ? "ok" : "err", ok ? "saved" : "invalid");
  });

  // ---------- Wake-up calls ----------
  app.get("/alarms", async (c) => {
    const ctx = c.get("app");
    const s = await getSettings(ctx.db);
    const tz = s.timezone;
    const csrf = c.get("session")!.csrf_token;
    const alarms = await listAlarms(ctx);
    const nexts = await Promise.all(alarms.map((a) => nextOccurrenceTime(ctx, a.id)));
    const occs = await ctx.db.all<{
      id: string;
      alarm_id: string;
      intended_at: number;
      target_at: number;
      status: string;
      attempt_count: number;
      snooze_count: number;
      acknowledged_at: number | null;
      status_reason: string | null;
    }>("SELECT * FROM alarm_occurrences ORDER BY intended_at DESC LIMIT 20");
    const series = await ctx.db.all<{ id: string; rrule: string }>("SELECT id, rrule FROM series WHERE kind = 'alarm'");
    return page(
      c,
      "Wake-up calls",
      "/admin/alarms",
      html`
        <p class="muted">
          Calls are best effort (minute-scale scheduling, provider and carrier delays). Keep your phone's native alarm as the dependable backup. Only keypad 1 or an "I'm awake"
          text counts as acknowledgement.
        </p>
        <p>Calls switch: ${s.calls_enabled ? statusPill("on", "ok") : statusPill("off", "warn")} (change in Settings)</p>
        ${table(
          ["ID", "Time", "Repeats", "Retry", "Next", "Enabled", ""],
          alarms.map((a, i) => [
            html`<code>${a.short_id}</code>`,
            html`${formatMinuteOfDay(Number(a.local_time.slice(0, 2)) * 60 + Number(a.local_time.slice(3)))} ${a.timezone}`,
            html`${a.series_id ? (series.find((x) => x.id === a.series_id)?.rrule ?? "") : "once"}`,
            html`${a.retry_enabled ? `1 retry after ${a.retry_delay_minutes} min` : "no"}`,
            html`${ts(nexts[i], tz)}`,
            html`${a.enabled ? "yes" : "no"}`,
            a.enabled ? postButton(`/admin/alarms/${a.id}/disable`, "Disable", csrf, { kind: "danger", confirm: "Disable this wake-up schedule?" }) : html``,
          ]),
          "No wake-up calls configured.",
        )}
        <h2>Recent occurrences</h2>
        ${table(
          ["Intended", "Target", "Status", "Attempts", "Snoozes", "Acknowledged", "Reason"],
          occs.map((o) => [
            html`${ts(o.intended_at, tz)}`,
            html`${ts(o.target_at, tz)}`,
            statusPill(o.status, o.status === "acknowledged" ? "ok" : ["missed", "expired", "unknown"].includes(o.status) ? "warn" : "info"),
            html`${o.attempt_count}`,
            html`${o.snooze_count}`,
            html`${ts(o.acknowledged_at, tz)}`,
            html`${o.status_reason ?? ""}`,
          ]),
          "None yet.",
        )}
        <div class="card">
          <h2>One-time test call</h2>
          <form method="post" action="/admin/alarms/test-call" class="row">
            ${csrfField(csrf)}
            <div><label for="mins">Minutes from now</label><input id="mins" name="minutes" type="number" min="1" max="60" value="2" /></div>
            <button type="submit" data-confirm="Schedule a test wake-up call to the owner phone?">Schedule test call</button>
          </form>
        </div>
      `,
    );
  });

  app.post("/alarms/test-call", async (c) => {
    const ctx = c.get("app");
    const f = await form(c);
    const mins = Math.max(1, Math.min(60, Number(f.minutes ?? "2") || 2));
    const s = await getSettings(ctx.db);
    const at = ctx.clock.now() + mins * MINUTE;
    const p = localParts(at, s.timezone);
    await createAlarm(ctx, {
      actionKey: `admin-test:${at}`,
      hour: p.hour,
      minute: p.minute,
      timezone: s.timezone,
      rrule: null,
      startDate: null,
      oneTimeAt: at,
      retryEnabled: false,
      readAgenda: false,
      label: "Test call",
    });
    await audit(ctx, "admin", "alarm.test_call", null, null);
    return back(c, "/admin/alarms", "ok", "test_call");
  });

  app.post("/alarms/:id/disable", async (c) => back(c, "/admin/alarms", (await cancelAlarm(c.get("app"), c.req.param("id"), "admin")) ? "ok" : "err", "done"));

  // ---------- Activity ----------
  app.get("/activity", async (c) => {
    const ctx = c.get("app");
    const s = await getSettings(ctx.db);
    const tz = s.timezone;
    const csrf = c.get("session")!.csrf_token;
    const status = ["pending", "running", "failed", "dead", "blocked", "skipped", "succeeded", "canceled"].includes(c.req.query("status") ?? "") ? c.req.query("status")! : null;
    const jobs = await ctx.db.all<{ id: string; kind: string; status: string; due_at: number; attempts: number; last_error: string | null; result_json: string | null }>(
      `SELECT id, kind, status, due_at, attempts, last_error, result_json FROM jobs ${status ? "WHERE status = ?" : ""} ORDER BY updated_at DESC LIMIT 60`,
      ...(status ? [status] : []),
    );
    const effects = await ctx.db.all<{
      id: string;
      channel: string;
      purpose: string;
      state: string;
      provider_id: string | null;
      provider_status: string | null;
      segments: number | null;
      error_detail: string | null;
      created_at: number;
    }>("SELECT id, channel, purpose, state, provider_id, provider_status, segments, error_detail, created_at FROM outbound_effects ORDER BY created_at DESC LIMIT 50");
    const auditRows = await ctx.db.all<{ actor: string; action: string; entity_type: string | null; detail: string | null; created_at: number }>(
      "SELECT actor, action, entity_type, detail, created_at FROM audit_log ORDER BY created_at DESC LIMIT 40",
    );
    return page(
      c,
      "Activity and jobs",
      "/admin/activity",
      html`
        <p class="row">
          ${["all", "pending", "running", "failed", "blocked", "dead", "skipped", "succeeded"].map((f) => html`<a href="/admin/activity${f === "all" ? "" : `?status=${f}`}">${f}</a>`)}
        </p>
        <h2>Jobs</h2>
        ${table(
          ["Kind", "Status", "Due", "Attempts", "Result / error", ""],
          jobs.map((j) => [
            html`${j.kind}`,
            statusPill(j.status, j.status === "succeeded" ? "ok" : ["failed", "dead", "blocked"].includes(j.status) ? "bad" : "info"),
            html`${ts(j.due_at, tz)}`,
            html`${j.attempts}`,
            html`<span class="muted">${(j.last_error ?? j.result_json ?? "").slice(0, 160)}</span>`,
            ["failed", "dead", "blocked"].includes(j.status)
              ? postButton(`/admin/jobs/${j.id}/retry`, "Retry", csrf, { confirm: "Retry this job? It will recheck current state first." })
              : html``,
          ]),
        )}
        <h2>Outbound effects</h2>
        <p class="muted">
          "accepted" means the provider took the request; only "delivered" means the carrier reported delivery. "unknown" means the request may or may not have gone through.
        </p>
        ${table(
          ["Channel", "Purpose", "State", "Provider", "Segments", "Detail", "Created", ""],
          effects.map((e) => [
            html`${e.channel}`,
            html`${e.purpose}`,
            statusPill(
              e.state,
              e.state === "delivered" ? "ok" : e.state === "accepted" ? "info" : ["unknown"].includes(e.state) ? "warn" : ["failed"].includes(e.state) ? "bad" : "info",
            ),
            html`${e.provider_id ? `${e.provider_id.slice(0, 8)}… ${e.provider_status ?? ""}` : "—"}`,
            html`${e.segments ?? ""}`,
            html`<span class="muted">${e.error_detail ?? ""}</span>`,
            html`${ts(e.created_at, tz)}`,
            e.channel === "sms" && (e.state === "unknown" || e.state === "failed")
              ? postButton(`/admin/effects/${e.id}/retry`, "Resend", csrf, {
                  confirm: e.state === "unknown" ? "The original may already have been delivered. Send again anyway?" : "Send again?",
                })
              : html``,
          ]),
        )}
        <h2>Audit (redacted)</h2>
        ${table(
          ["When", "Actor", "Action", "Detail"],
          auditRows.map((a) => [html`${ts(a.created_at, tz)}`, html`${a.actor}`, html`${a.action}`, html`<span class="muted">${a.detail ?? ""}</span>`]),
        )}
      `,
    );
  });

  app.post("/jobs/:id/retry", async (c) => {
    const ctx = c.get("app");
    const changed = await ctx.db.run(
      "UPDATE jobs SET status = 'pending', attempts = 0, due_at = ?, next_dispatch_at = NULL, expires_at = CASE WHEN expires_at IS NOT NULL AND expires_at < ? THEN expires_at ELSE expires_at END, last_error = 'operator retry', updated_at = ? WHERE id = ? AND status IN ('failed','dead','blocked')",
      ctx.clock.now(),
      ctx.clock.now(),
      ctx.clock.now(),
      c.req.param("id"),
    );
    if (changed === 1) await audit(ctx, "admin", "job.retry", "job", c.req.param("id"));
    return back(c, "/admin/activity", changed === 1 ? "ok" : "err", changed === 1 ? "retry" : "conflict");
  });

  app.post("/effects/:id/retry", async (c) => {
    const ctx = c.get("app");
    const r = await operatorRetrySms(ctx, c.req.param("id"));
    if (r.ok) await audit(ctx, "admin", "effect.operator_retry", "effect", c.req.param("id"));
    return back(c, "/admin/activity", r.ok ? "ok" : "err", r.ok ? (r.message.includes("duplicate") ? "retry_dup" : "retry") : "conflict");
  });

  // ---------- Settings ----------
  app.get("/settings", async (c) => {
    const ctx = c.get("app");
    const s = await getSettings(ctx.db);
    const tz = s.timezone;
    const csrf = c.get("session")!.csrf_token;
    const supp = await ctx.db.all<{ channel: string; state: string; source: string }>("SELECT channel, state, source FROM suppressions");
    const num = (name: keyof OwnerSettings, label: string, min: number, max: number) =>
      html`<div><label for="${name}">${label}</label><input id="${name}" name="${name}" type="number" min="${min}" max="${max}" value="${String(s[name] ?? "")}" /></div>`;
    const check = (name: keyof OwnerSettings, label: string) =>
      html`<div>
        <label><input type="checkbox" name="${name}" value="1" ${s[name] ? "checked" : ""} /> ${label}</label>
      </div>`;
    const time = (name: keyof OwnerSettings, label: string) =>
      html`<div>
        <label for="${name}">${label}</label
        ><input id="${name}" name="${name}" type="time" value="${String(Math.floor(Number(s[name]) / 60)).padStart(2, "0")}:${String(Number(s[name]) % 60).padStart(2, "0")}" />
      </div>`;
    return page(
      c,
      "Settings",
      "/admin/settings",
      html`
        <form method="post" action="/admin/settings" class="card">
          ${csrfField(csrf)}
          <input type="hidden" name="section" value="main" />
          <h2>General</h2>
          <div class="row">
            <div><label for="display_name">Display name</label><input id="display_name" name="display_name" value="${s.display_name}" maxlength="40" /></div>
            <div><label for="timezone">Timezone (IANA)</label><input id="timezone" name="timezone" value="${s.timezone}" maxlength="60" /></div>
            ${num("default_event_minutes", "Default event minutes", 5, 1440)}
          </div>
          <p class="muted">
            Owner phone: ${redactPhone(ctx.config.ownerPhone)} — changed only through the OWNER_PHONE_E164 deployment variable, never by SMS. Changing timezone here keeps recurring
            schedules in their saved zones; use SMS ("my timezone is …") to be asked whether they should follow.
          </p>
          <h2>Quiet hours and proactive messages</h2>
          <div class="row">${time("quiet_start_minute", "Quiet hours start")} ${time("quiet_end_minute", "Quiet hours end")}</div>
          <p class="muted">Routine reminders defer during quiet hours; reminders you explicitly set for a quiet-hour time still fire. Wake-up calls are exempt when enabled.</p>
          <div class="row">${check("morning_brief_enabled", "Morning brief")} ${time("morning_brief_minute", "Brief time")}</div>
          <div class="row">
            ${check("followup_default_enabled", "Default completion check-ins")} ${num("followup_default_delay_minutes", "Check-in delay (min)", 30, 1440)}
            ${num("followup_max_per_occurrence", "Max per task", 0, 5)} ${num("followup_min_gap_minutes", "Min gap (min)", 30, 1440)}
          </div>
          <div class="row">
            ${time("focus_day_start_minute", "Focus window start")} ${time("focus_day_end_minute", "Focus window end")} ${num("wake_snooze_minutes", "Wake snooze (min)", 1, 60)}
          </div>
          <h2>Channels</h2>
          <div class="row">${check("sms_enabled", "SMS on")} ${check("calls_enabled", "Calls on")}</div>
          <p class="muted">Deployment flags (SMS_LIVE_ENABLED, VOICE_LIVE_ENABLED, DRY_RUN) always override these switches.</p>
          <h2>Daily limits</h2>
          <div class="row">
            ${num("limit_inbound_per_day", "Inbound messages", 1, 1000)} ${num("limit_sms_segments_per_day", "SMS segments", 1, 1000)}
            ${num("limit_call_attempts_per_day", "Call attempts", 0, 50)} ${num("limit_call_minutes_per_day", "Call minutes", 0, 120)}
            ${num("limit_ai_requests_per_day", "AI requests", 0, 2000)}
          </div>
          <h2>Retention (days)</h2>
          <div class="row">
            ${num("retention_message_days", "Message content", 1, 3650)} ${num("retention_task_days", "Completed task text", 1, 3650)}
            ${num("retention_audit_days", "Audit", 1, 3650)}
          </div>
          <p><button type="submit" class="primary">Save settings</button></p>
        </form>
        <div class="card">
          <h2>Pause</h2>
          <form method="post" action="/admin/settings/pause" class="row">
            ${csrfField(csrf)}
            <div>
              <label for="scope">Scope</label>
              <select id="scope" name="scope">
                <option value="reminders">Reminders, briefs, heads-ups</option>
                <option value="all">Everything incl. wake-up calls</option>
              </select>
            </div>
            <div><label for="until">Until (blank = until resumed)</label><input id="until" name="until" type="datetime-local" /></div>
            <button type="submit">Pause</button>
          </form>
          <p>${postButton("/admin/settings/resume", "Resume", csrf)}</p>
        </div>
        <div class="card">
          <h2>Consent</h2>
          <p>
            SMS consent: ${s.sms_consent_at ? `${ts(s.sms_consent_at, tz)} (${s.sms_consent_source})` : "not recorded"} · Call consent:
            ${s.call_consent_at ? `${ts(s.call_consent_at, tz)} (${s.call_consent_source})` : "not recorded"}
          </p>
          <form method="post" action="/admin/settings/consent" class="row">
            ${csrfField(csrf)}
            <div>
              <label><input type="checkbox" name="sms" value="1" required /> I am the owner of the configured phone and consent to receive Della's SMS.</label>
            </div>
            <button type="submit">Record SMS consent</button>
          </form>
          <form method="post" action="/admin/settings/consent" class="row">
            ${csrfField(csrf)}
            <div>
              <label><input type="checkbox" name="call" value="1" required /> I consent to automated wake-up calls to the configured phone.</label>
            </div>
            <button type="submit">Record call consent</button>
          </form>
          <p>Opt-out state: ${supp.length ? supp.map((x) => `${x.channel}: ${x.state} (${x.source})`).join(", ") : "none"}</p>
          ${supp.some((x) => x.channel === "call" && x.state === "opted_out") ? postButton("/admin/settings/calls-resume", "Re-enable calls after STOP", csrf, { confirm: "Re-enable wake-up calls?" }) : ""}
          <p class="muted">SMS opt-out is lifted only by the owner texting START (provider rules).</p>
        </div>
        <div class="card">
          <h2>SMS provider attestation (operator-confirmed, not independently verified)</h2>
          <p>
            Current:
            ${s.sms_attestation_provider ? `${s.sms_attestation_provider}, ${s.sms_attestation_date}, sender ${s.sms_attestation_sender_status}, ref ${s.sms_attestation_reference ?? "—"}` : "none"}
          </p>
          <form method="post" action="/admin/settings/attestation" class="row">
            ${csrfField(csrf)}
            <div><label for="ap">Provider</label><input id="ap" name="provider" maxlength="40" required /></div>
            <div><label for="ad">Approval date</label><input id="ad" name="date" type="date" required /></div>
            <div>
              <label for="as">Sender status</label>
              <select id="as" name="sender_status">
                <option>approved</option>
                <option>pending</option>
                <option>rejected</option>
              </select>
            </div>
            <div><label for="ar">Support reference (non-secret)</label><input id="ar" name="reference" maxlength="60" /></div>
            <button type="submit">Record attestation</button>
          </form>
        </div>
      `,
    );
  });

  app.post("/settings", async (c) => {
    const ctx = c.get("app");
    const f = await form(c);
    const s = await getSettings(ctx.db);
    const patch: Record<string, string | number | null> = {};
    const int = (k: string, min: number, max: number) => {
      if (f[k] === undefined || f[k].trim() === "") return;
      const n = Number(f[k]);
      if (!Number.isInteger(n) || n < min || n > max) throw new Error("invalid");
      patch[k] = n;
    };
    const hhmm = (k: string) => {
      if (f[k] === undefined || f[k].trim() === "") return;
      const m = parseHHMM(f[k]!);
      if (m === null) throw new Error("invalid");
      patch[k] = m;
    };
    const flag = (k: string) => {
      patch[k] = f[k] === "1" ? 1 : 0;
    };
    try {
      if (f.section === "headsup") {
        flag("calendar_headsup_enabled");
        int("calendar_headsup_lead_minutes", 5, 240);
      } else {
        if (f.display_name !== undefined) patch.display_name = f.display_name.replace(/[^\p{L}\p{N} .'-]/gu, "").slice(0, 40) || s.display_name;
        if (f.timezone !== undefined) {
          if (!isValidTimeZone(f.timezone)) throw new Error("invalid");
          patch.timezone = f.timezone;
        }
        int("default_event_minutes", 5, 1440);
        hhmm("quiet_start_minute");
        hhmm("quiet_end_minute");
        hhmm("morning_brief_minute");
        hhmm("focus_day_start_minute");
        hhmm("focus_day_end_minute");
        int("followup_default_delay_minutes", 30, 1440);
        int("followup_max_per_occurrence", 0, 5);
        int("followup_min_gap_minutes", 30, 1440);
        int("wake_snooze_minutes", 1, 60);
        int("limit_inbound_per_day", 1, 1000);
        int("limit_sms_segments_per_day", 1, 1000);
        int("limit_call_attempts_per_day", 0, 50);
        int("limit_call_minutes_per_day", 0, 120);
        int("limit_ai_requests_per_day", 0, 2000);
        int("retention_message_days", 1, 3650);
        int("retention_task_days", 1, 3650);
        int("retention_audit_days", 1, 3650);
        for (const k of ["morning_brief_enabled", "followup_default_enabled", "sms_enabled", "calls_enabled"]) flag(k);
      }
    } catch {
      return back(c, "/admin/settings", "err", "invalid");
    }
    const ok = await updateSettings(ctx.db, patch, ctx.clock.now(), s.version);
    if (ok) await audit(ctx, "admin", "settings.update", "settings", "1", Object.keys(patch).join(","));
    return back(c, f.section === "headsup" ? "/admin/calendar" : "/admin/settings", ok ? "ok" : "err", ok ? "saved" : "conflict");
  });

  app.post("/settings/pause", async (c) => {
    const ctx = c.get("app");
    const f = await form(c);
    const s = await getSettings(ctx.db);
    const until = f.until ? parseLocalDateTime(f.until, s.timezone) : PAUSE_INDEFINITE;
    if (!until || until <= ctx.clock.now()) return back(c, "/admin/settings", "err", "invalid");
    await updateSettings(ctx.db, { automation_paused_until: until, automation_pause_scope: f.scope === "all" ? "all" : "reminders" }, ctx.clock.now());
    await audit(ctx, "admin", "automation.pause", "settings", "1", f.scope === "all" ? "all" : "reminders");
    return back(c, "/admin/settings", "ok", "saved");
  });

  app.post("/settings/resume", async (c) => {
    const ctx = c.get("app");
    await updateSettings(ctx.db, { automation_paused_until: null, automation_pause_scope: null }, ctx.clock.now());
    await audit(ctx, "admin", "automation.resume", "settings", "1");
    return back(c, "/admin/settings", "ok", "saved");
  });

  app.post("/settings/consent", async (c) => {
    const ctx = c.get("app");
    const f = await form(c);
    const now = ctx.clock.now();
    if (f.sms === "1") await updateSettings(ctx.db, { sms_consent_at: now, sms_consent_source: "admin_attested" }, now);
    else if (f.call === "1") await updateSettings(ctx.db, { call_consent_at: now, call_consent_source: "admin_attested" }, now);
    else return back(c, "/admin/settings", "err", "invalid");
    await ctx.db.run(
      "INSERT INTO consent_events (id, channel, event, source, created_at) VALUES (?, ?, 'consented', 'admin', ?)",
      `ce_${now}`,
      f.sms === "1" ? "sms" : "call",
      now,
    );
    return back(c, "/admin/settings", "ok", "saved");
  });

  app.post("/settings/calls-resume", async (c) => {
    const ctx = c.get("app");
    await ctx.db.run("UPDATE suppressions SET state = 'active', source = 'admin', updated_at = ? WHERE channel = 'call'", ctx.clock.now());
    await audit(ctx, "admin", "consent.calls_resumed", "settings", "1");
    return back(c, "/admin/settings", "ok", "saved");
  });

  app.post("/settings/attestation", async (c) => {
    const ctx = c.get("app");
    const f = await form(c);
    if (!f.provider || !/^\d{4}-\d{2}-\d{2}$/.test(f.date ?? "") || !["approved", "pending", "rejected"].includes(f.sender_status ?? ""))
      return back(c, "/admin/settings", "err", "invalid");
    await updateSettings(
      ctx.db,
      {
        sms_attestation_provider: f.provider.slice(0, 40),
        sms_attestation_date: f.date!,
        sms_attestation_sender_status: f.sender_status!,
        sms_attestation_reference: (f.reference ?? "").replace(/[^A-Za-z0-9 #._-]/g, "").slice(0, 60) || null,
        sms_attestation_recorded_at: ctx.clock.now(),
      },
      ctx.clock.now(),
    );
    await audit(ctx, "admin", "sms.attestation", "settings", "1", `${f.provider} ${f.sender_status}`);
    return back(c, "/admin/settings", "ok", "saved");
  });

  // ---------- Diagnostics ----------
  app.get("/diagnostics", async (c) => {
    const ctx = c.get("app");
    const s = await getSettings(ctx.db);
    const tz = s.timezone;
    const readiness = await Promise.all([smsReadiness(ctx, s), voiceReadiness(ctx, s), calendarReadiness(ctx), aiReadiness(ctx)]);
    const migrations = await ctx.db
      .all<{ name: string; applied_at: string }>("SELECT name, applied_at FROM d1_migrations ORDER BY id")
      .catch(() => [] as Array<{ name: string; applied_at: string }>);
    const lastTick = Number((await getSystemState(ctx.db, "last_tick_at")) ?? "0");
    const lastJob = await ctx.db.first<{ updated_at: number }>("SELECT updated_at FROM jobs WHERE status IN ('succeeded','skipped') ORDER BY updated_at DESC LIMIT 1");
    const gap = await getSystemState(ctx.db, "last_scheduler_gap");
    const blockers = readiness.flatMap((r) => r.checks.filter((x) => !x.ok).map((x) => `${r.channel}: ${x.name}`));
    return page(
      c,
      "Diagnostics",
      "/admin/diagnostics",
      html`
        <div class="grid">
          <div class="card">
            <h2>Environment</h2>
            <p>
              APP_ENV: <code>${ctx.config.appEnv}</code> · DRY_RUN: <code>${String(ctx.config.flags.dryRun)}</code> · Simulator: <code>${String(ctx.config.simulatorEnabled)}</code>
            </p>
            <p>Encryption key id: <code>${ctx.crypto.currentKeyId}</code>${ctx.config.usingDevEncryptionKey ? html` ${statusPill("development key", "bad")}` : ""}</p>
            <p>Public base URL configured: ${ctx.config.publicBaseUrl ? "yes" : "no"} · Owner phone configured: ${ctx.config.ownerPhone ? "yes" : "no"}</p>
          </div>
          <div class="card">
            <h2>Scheduler and queue</h2>
            <p>Last tick: ${ts(lastTick, tz)} · Last job completion: ${ts(lastJob?.updated_at, tz)}</p>
            <p>${gap ? `Last detected gap: ${gap}` : "No scheduler gaps detected."}</p>
          </div>
        </div>
        <h2>Configuration issues (values never shown)</h2>
        ${table(
          ["Severity", "Integration", "Code", "Message"],
          ctx.config.issues.map((i) => [statusPill(i.severity, i.severity === "error" ? "bad" : "warn"), html`${i.integration}`, html`<code>${i.code}</code>`, html`${i.message}`]),
          "No configuration issues.",
        )}
        <h2>Provider readiness checks</h2>
        ${readiness.map(
          (r) =>
            html`<h3>${r.channel.toUpperCase()} (${r.provider}) — ${r.mode}</h3>
              ${table(
                ["Check", "OK", "Kind", "Detail"],
                r.checks.map((x) => [html`${x.name}`, x.ok ? statusPill("ok", "ok") : statusPill("no", "bad"), html`${x.kind}`, html`${x.detail}`]),
              )}`,
        )}
        <h2>Unresolved launch blockers</h2>
        ${
          blockers.length
            ? html`<ul>
                ${blockers.map((b) => html`<li>${b}</li>`)}
              </ul>`
            : html`<p>None.</p>`
        }
        <p class="muted">
          Errors with integration "${configErrors(ctx.config).length ? "core/admin" : "—"}" keep live effects disabled. Production builds expose no simulator, clock, or
          unsigned-webhook routes.
        </p>
        ${await extensionDiagnostics(ctx)}
        <h2>Database migrations</h2>
        ${table(
          ["Migration", "Applied"],
          migrations.map((m) => [html`${m.name}`, html`${m.applied_at}`]),
          "Migration table not found (tests apply migrations directly).",
        )}
      `,
    );
  });

  // ---------- Data ----------
  app.get("/data", async (c) => {
    const ctx = c.get("app");
    const s = await getSettings(ctx.db);
    const csrf = c.get("session")!.csrf_token;
    const restoredAt = await getSystemState(ctx.db, "restored_at");
    return page(
      c,
      "Data: export, erase, restore",
      "/admin/data",
      html`
        <div class="card">
          <h2>Export</h2>
          <p>Download a decrypted JSON export of your tasks, schedules, settings, consent log, and conversation context.</p>
          <p><a href="/admin/data/export">Download export</a></p>
        </div>
        <div class="card">
          <h2>Restore status</h2>
          ${
            s.restore_hold
              ? html`<p class="flash error">This database was restored${restoredAt ? ` at ${ts(Number(restoredAt), s.timezone)}` : ""}. Proactive automation is on hold.</p>
                  <p>
                    Before resuming, review Activity for unknown effects: a backup can predate messages or calls the provider already accepted. Resuming marks past-due occurrences
                    as missed/expired; it never replays them.
                  </p>
                  ${postButton("/admin/data/resume-after-restore", "Resume after restore", csrf, { confirm: "Resume proactive automation now?" })}`
              : html`<p>Not in a restored state.</p>`
          }
          <p class="muted">
            Backups: run <code>npm run backup -- --env production</code> (D1 export; content columns remain encrypted). Keep backups encrypted and access-controlled; never commit
            them. Restoring needs the same DATA_ENCRYPTION_KEY (or it as DATA_ENCRYPTION_KEY_PREVIOUS).
          </p>
        </div>
        <div class="card">
          <h2>Erase everything</h2>
          <p>
            Disables all future work first, then deletes Della's stored content. Provider-held records (carrier, Twilio, Google, OpenAI logs) and existing backups are not erased by
            this.
          </p>
          <form method="post" action="/admin/data/erase" class="row">
            ${csrfField(csrf)}
            <div><label for="phrase">Type ${ERASE_CONFIRMATION_PHRASE}</label><input id="phrase" name="phrase" autocomplete="off" required /></div>
            <button type="submit" class="danger" data-confirm="This cannot be undone. Erase all Della data?">Erase</button>
          </form>
        </div>
      `,
    );
  });

  app.get("/data/export", async (c) => {
    const ctx = c.get("app");
    const data = await exportOwnerData(ctx);
    await audit(ctx, "admin", "data.export", null, null);
    return c.body(JSON.stringify(data, null, 2), 200, {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="della-export-${new Date(ctx.clock.now()).toISOString().slice(0, 10)}.json"`,
      "cache-control": "no-store",
    });
  });

  app.post("/data/erase", async (c) => {
    const ctx = c.get("app");
    const f = await form(c);
    const ok = await eraseAllData(ctx, f.phrase ?? "");
    return back(c, "/admin/data", ok ? "ok" : "err", ok ? "erased" : "erase_phrase");
  });

  app.post("/data/resume-after-restore", async (c) => {
    await resumeAfterRestore(c.get("app"));
    return back(c, "/admin/data", "ok", "resumed");
  });

  registerExtensionPages(app);
  return app;
}

/** In-process fetch to this same app (used by the simulator to hit real webhook routes). */
function appFetch(c: C): (req: Request) => Promise<Response> {
  return c.get("selfFetch");
}
