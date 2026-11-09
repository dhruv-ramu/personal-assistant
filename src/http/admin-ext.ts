import type { Hono } from "hono";
import { html } from "hono/html";
import { createPairingCode, devicesOnline, listDevices, revokeDevice } from "../accountability/devices";
import { LABEL_TEXT, cancelSession, getSession, type CheckpointRow, type SessionRow } from "../accountability/sessions";
import type { AppContext } from "../context";
import { parseJson } from "../db/db";
import { DAY, formatDateTime, MINUTE } from "../domain/time";
import { disconnectEmail, emailStatus } from "../ext/email";
import { EXT_MUTABLE, featureOn, getExtSettings, updateExtSettings, type ExtSettings, type Feature } from "../ext/settings";
import { forgetSource } from "../knowledge/forget";
import { deleteMediaWhere } from "../media/uploads";
import { containerContents, locationHistory, locationView, placeItem, renderLocation, reportAbsent } from "../knowledge/locations";
import { resolveOrCreate } from "../knowledge/resolve";
import { search } from "../knowledge/retrieval";
import { listItems, getItem, updateItem, type SecretaryKind } from "../knowledge/secretary";
import { PHYSICAL, activeEntities, assertionsFor, decryptExcerpt, decryptValue, getEntity, mergeEntities, recordSource, splitEntity, type AssertionRow } from "../knowledge/store";
import { audit } from "../services/audit";
import { getSettings } from "../services/settings";
import { csrfField, postButton, statusPill, table, type Html } from "../ui/layout";
import { back, form, page, ts, type C } from "./admin-helpers";
import type { AppEnvBindings } from "./types";

const conflictPill = (status: string): Html =>
  status === "disputed"
    ? statusPill("conflicting reports", "warn")
    : status === "tentative"
      ? statusPill("unconfirmed", "info")
      : status === "current"
        ? statusPill("current", "ok")
        : statusPill(status, "info");

async function objectText(ctx: AppContext, a: AssertionRow): Promise<string> {
  if (a.object_entity_id) return (await getEntity(ctx, a.object_entity_id))?.label ?? "(deleted)";
  return (await decryptValue(ctx, a)) ?? "";
}

/** Extension dashboard views. All are behind the existing admin session + CSRF middleware. */
export function registerExtensionPages(app: Hono<AppEnvBindings>): void {
  // ---------- Knowledge search ----------
  app.get("/knowledge", async (c) => {
    const ctx = c.get("app");
    const tz = (await getSettings(ctx.db)).timezone;
    const q = (c.req.query("q") ?? "").slice(0, 120);
    const type = c.req.query("type") ?? "";
    const entityId = c.req.query("entity");
    const results = q ? await search(ctx, q) : null;
    const entities = (await activeEntities(ctx, undefined, 400)).filter((e) => !type || e.type === type).slice(0, 100);
    let detail: Html = html``;
    if (entityId) {
      const e = await getEntity(ctx, entityId);
      if (e) {
        const rows = await assertionsFor(ctx, e.id, null, ["current", "tentative", "disputed", "historical", "retracted"]);
        const cells: Html[][] = [];
        for (const a of rows.slice(0, 60))
          cells.push([
            html`${a.predicate.replace(/^(attr|pref):/, "")}`,
            html`${await objectText(ctx, a)}`,
            conflictPill(a.status),
            html`${a.evidence_type.replace(/_/g, " ")}${a.attributed_to ? html` <span class="muted">(per ${a.attributed_to})</span>` : ""}`,
            html`${ts(a.effective_from, tz)}${a.effective_to ? html` → ${ts(a.effective_to, tz)}` : ""}`,
            html`<span class="muted">${(await decryptExcerpt(ctx, a)) ?? "(source text not retained)"}</span>`,
          ]);
        detail = html`<h2>${e.label} <span class="muted">(${e.type})</span></h2>
          ${table(["Relation", "Value", "Status", "Evidence", "When", "Source excerpt"], cells, "No facts recorded.")}`;
      }
    }
    return page(
      c,
      "Knowledge",
      "/admin/knowledge",
      html`<form method="get" class="row card">
          <div><label for="q">Search memory</label><input id="q" name="q" value="${q}" placeholder="e.g. lab door code" /></div>
          <div>
            <label for="type">Entity type</label
            ><select id="type" name="type">
              <option value="">any</option>
              ${["person", "item", "container", "place", "project", "organization", "topic", "activity"].map((t) => html`<option value="${t}" ${t === type ? "selected" : ""}>${t}</option>`)}
            </select>
          </div>
          <div><button type="submit" class="primary">Search</button></div>
        </form>
        ${
          results
            ? html`<div class="card">
                <p>${results.text}</p>
                ${results.packet.gaps.length ? html`<p class="muted">Gaps: ${results.packet.gaps.join("; ")}</p>` : ""}
              </div>`
            : ""
        }
        ${detail}
        <h2>Entities</h2>
        ${table(
          ["Name", "Type", "Updated"],
          entities.map((e) => [html`<a href="/admin/knowledge?entity=${e.id}">${e.label}</a>`, html`${e.type}`, html`${ts(e.updated_at, tz)}`]),
          "Nothing saved yet. Memory capture is off until you enable it.",
        )}
        <p class="muted">Answers come only from records you created; deleted or retracted items never appear. Semantic matches are always re-checked against these records.</p>`,
    );
  });

  // ---------- Items / locations ----------
  app.get("/items", async (c) => {
    const ctx = c.get("app");
    const tz = (await getSettings(ctx.db)).timezone;
    const csrf = c.get("session")!.csrf_token;
    const items = await activeEntities(ctx, PHYSICAL, 300);
    const rows: Html[][] = [];
    for (const e of items.slice(0, 80)) {
      const v = await locationView(ctx, e);
      const contents = e.type !== "item" ? await containerContents(ctx, e.id) : [];
      const hist = await locationHistory(ctx, e.id, tz);
      rows.push([
        html`<strong>${e.label}</strong> <span class="muted">${e.type}</span>`,
        html`${await renderLocation(ctx, v, tz)}`,
        html`${contents.map((x) => x.entity.label).join(", ") || "—"}`,
        html`<details>
          <summary>${hist.length} record(s)</summary>
          ${hist.join("; ")}
        </details>`,
        html`<form method="post" action="/admin/items/${e.id}/move" class="row">
            ${csrfField(csrf)}<input name="container" aria-label="New container for ${e.label}" placeholder="new container" required /><button type="submit">Move</button>
          </form>
          ${v.path.length ? postButton(`/admin/items/${e.id}/retract`, "Not there", csrf) : ""}`,
      ]);
    }
    const merges = await ctx.db.all<{ id: string; created_at: number; reason: string }>(
      "SELECT id, created_at, reason FROM memory_events WHERE kind = 'entity.merged' ORDER BY created_at DESC LIMIT 20",
    );
    return page(
      c,
      "Items and locations",
      "/admin/items",
      html`${table(["Item", "Current location", "Contains", "History", "Actions"], rows, "No items recorded yet.")}
        <h2>Merge duplicates</h2>
        <form method="post" action="/admin/items/merge" class="row card">
          ${csrfField(csrf)}
          <div>
            <label for="into">Keep</label
            ><select id="into" name="into">
              ${items.map((e) => html`<option value="${e.id}">${e.label} (${e.type})</option>`)}
            </select>
          </div>
          <div>
            <label for="from">Merge into it</label
            ><select id="from" name="from">
              ${items.map((e) => html`<option value="${e.id}">${e.label} (${e.type})</option>`)}
            </select>
          </div>
          <div><button type="submit" data-confirm="Merge these two records? You can split them again.">Merge</button></div>
        </form>
        ${table(
          ["Merged", "Reason", ""],
          merges.map((m) => [html`${ts(m.created_at, tz)}`, html`${m.reason}`, postButton(`/admin/items/split/${m.id}`, "Split", csrf)]),
          "No merges.",
        )}`,
    );
  });

  app.post("/items/:id/move", async (c) => {
    const ctx = c.get("app");
    const item = await getEntity(ctx, c.req.param("id"));
    const label = ((await form(c)).container ?? "").trim().slice(0, 120);
    if (!item || !label) return back(c, "/admin/items", "err", "invalid");
    const now = ctx.clock.now();
    const sourceId = await recordSource(ctx, { kind: "admin", originId: `admin:${now}`, content: `moved ${item.label} to ${label}`, eventAt: now, rawRetentionDays: 30 });
    const r = await resolveOrCreate(ctx, label, "container", `admin:${now}:c`, sourceId);
    if (r.kind === "ambiguous") return back(c, "/admin/items", "err", "conflict");
    const res = await placeItem(ctx, {
      itemId: item.id,
      containerId: r.entity.id,
      phrase: null,
      modality: "actual",
      effectiveFrom: now,
      sourceId,
      excerpt: `Dashboard: ${item.label} moved to ${label}`,
      extractionKey: `admin:${now}:move`,
      temporary: false,
    });
    await audit(ctx, "admin", "memory.move", "entity", item.id, res.kind);
    return back(c, "/admin/items", res.kind === "rejected" ? "err" : "ok", res.kind === "rejected" ? "invalid" : "moved");
  });

  app.post("/items/:id/retract", async (c) => {
    const ctx = c.get("app");
    const item = await getEntity(ctx, c.req.param("id"));
    if (!item) return back(c, "/admin/items", "err", "not_found");
    const v = await locationView(ctx, item);
    const now = ctx.clock.now();
    const sourceId = await recordSource(ctx, { kind: "admin", originId: `admin:${now}`, content: `${item.label} not at reported location`, eventAt: now, rawRetentionDays: 30 });
    const first = v.path[0];
    await reportAbsent(ctx, item.id, first?.entityId ?? null, first?.label ?? "", now, sourceId, "Dashboard: not there", `admin:${now}:absent`);
    return back(c, "/admin/items", "ok", "retracted");
  });

  app.post("/items/merge", async (c) => {
    const f = await form(c);
    const r = await mergeEntities(c.get("app"), f.into ?? "", f.from ?? "", "dashboard merge");
    return back(c, "/admin/items", r.ok ? "ok" : "err", r.ok ? "merged" : "invalid");
  });

  app.post("/items/split/:id", async (c) => {
    const r = await splitEntity(c.get("app"), c.req.param("id"));
    return back(c, "/admin/items", r.ok ? "ok" : "err", r.ok ? "split" : "invalid");
  });

  // ---------- Memory inbox ----------
  app.get("/memory", async (c) => {
    const ctx = c.get("app");
    const tz = (await getSettings(ctx.db)).timezone;
    const csrf = c.get("session")!.csrf_token;
    const ext = await getExtSettings(ctx.db);
    const runs = await ctx.db.all<{ id: string; source_id: string | null; status: string; summary_enc: string | null; created_at: number }>(
      "SELECT * FROM extraction_runs ORDER BY created_at DESC, rowid DESC LIMIT 40",
    );
    const rows: Html[][] = [];
    for (const r of runs) {
      const s = parseJson<{ saved: string[]; rejected: Array<{ kind: string; reason: string }> }>(r.summary_enc ? await ctx.crypto.decrypt(r.summary_enc, "extraction") : null, {
        saved: [],
        rejected: [],
      });
      const deleted = r.source_id ? await ctx.db.first("SELECT object_id FROM deletion_tombstones WHERE object_id = ?", r.source_id) : null;
      rows.push([
        html`${ts(r.created_at, tz)}`,
        html`${s.saved.join("; ") || "—"}`,
        html`${s.rejected.map((x) => `${x.kind}: ${x.reason}`).join("; ") || "—"}`,
        deleted
          ? statusPill("deleted", "info")
          : r.source_id
            ? postButton(`/admin/memory/forget/${r.source_id}`, "Delete what was learned", csrf, {
                kind: "danger",
                confirm: "Delete every fact and item learned from this message?",
              })
            : html``,
      ]);
    }
    const events = await ctx.db.all<{ kind: string; reason: string; created_at: number }>(
      "SELECT kind, reason, created_at FROM memory_events ORDER BY created_at DESC, rowid DESC LIMIT 30",
    );
    const captureState = featureOn(ctx, ext, "capture")
      ? statusPill("on", "ok")
      : ext.capture_paused_until && ext.capture_paused_until > ctx.clock.now()
        ? statusPill(`paused until ${ts(ext.capture_paused_until, tz)}`, "warn")
        : statusPill("off", "info");
    return page(
      c,
      "Memory inbox",
      "/admin/memory",
      html`<div class="card">
          <p>Automatic capture: ${captureState}</p>
          ${postButton("/admin/ext-settings", ext.capture_enabled ? "Turn memory off" : "Turn memory on", csrf, { fields: { capture_enabled: ext.capture_enabled ? "0" : "1", _back: "/admin/memory" } })}
          ${postButton("/admin/ext-settings", "Pause 24 hours", csrf, { fields: { capture_paused_until: String(ctx.clock.now() + DAY), _back: "/admin/memory" } })}
          <p class="muted">
            Texting "don't store this" keeps one message out of memory. "Forget that" deletes what the last message added. Deletion removes facts, source excerpts, search entries,
            and cached answers; provider logs and existing backups are outside Della's reach.
          </p>
        </div>
        <h2>What was learned, per message</h2>
        ${table(["When", "Saved", "Rejected (and why)", ""], rows, "Nothing captured yet.")}
        <h2>Memory audit</h2>
        ${table(
          ["When", "Event", "Reason"],
          events.map((e) => [html`${ts(e.created_at, tz)}`, html`${e.kind}`, html`${e.reason}`]),
          "No memory events.",
        )}`,
    );
  });

  app.post("/memory/forget/:sourceId", async (c) => {
    const ctx = c.get("app");
    await forgetSource(ctx, c.req.param("sourceId"));
    await audit(ctx, "admin", "memory.forget_source", "source", c.req.param("sourceId"));
    return back(c, "/admin/memory", "ok", "forgot");
  });

  // ---------- Secretary ----------
  app.get("/secretary", async (c) => {
    const ctx = c.get("app");
    const tz = (await getSettings(ctx.db)).timezone;
    const csrf = c.get("session")!.csrf_token;
    const sections: Array<[string, SecretaryKind[]]> = [
      ["Promises", ["promise"]],
      ["Waiting for", ["waiting_for"]],
      ["Questions", ["question"]],
      ["Decisions", ["decision"]],
      ["Estimates", ["prediction"]],
      ["Evidence locker", ["accomplishment"]],
      ["Handoffs / checkpoints", ["checkpoint"]],
      ["Ideas", ["idea"]],
      ["Admin and recruiting", ["admin_item", "recruiting"]],
      ["Future-self messages", ["future_message"]],
    ];
    const blocks: Html[] = [];
    for (const [title, kinds] of sections) {
      const items = await listItems(ctx, kinds, { status: ["open", "observed", "interested", "applied", "referral_requested", "interviewing", "offer"], limit: 30 });
      const rows: Html[][] = [];
      for (const i of items) {
        const who = i.person_id ? (await getEntity(ctx, i.person_id))?.label : null;
        rows.push([
          html`${i.title}`,
          html`${who ?? "—"}`,
          html`${i.due_at ? ts(i.due_at, tz) : i.check_at ? `check ${ts(i.check_at, tz)}` : "—"}`,
          html`${i.evidence_type.replace(/_/g, " ")}`,
          postButton(`/admin/secretary/${i.id}/resolve`, "Resolve", csrf),
        ]);
      }
      blocks.push(
        html`<h2>${title}</h2>
          ${table(["Item", "Person", "Date", "Evidence", ""], rows, "None.")}`,
      );
    }
    const sugg = await ctx.db.all<{ kind: string; status: string; text_enc: string; created_at: number }>(
      "SELECT kind, status, text_enc, created_at FROM suggestions ORDER BY created_at DESC LIMIT 20",
    );
    const srows: Html[][] = [];
    for (const s of sugg) srows.push([html`${ts(s.created_at, tz)}`, html`${s.kind}`, html`${await ctx.crypto.decrypt(s.text_enc, "suggestion")}`, html`${s.status}`]);
    return page(
      c,
      "Secretary",
      "/admin/secretary",
      html`${blocks}
        <h2>Suggestions</h2>
        ${table(["When", "Kind", "Text", "Status"], srows, "No suggestions.")}`,
    );
  });

  app.post("/secretary/:id/resolve", async (c) => {
    const ctx = c.get("app");
    const it = await getItem(ctx, c.req.param("id"));
    if (!it) return back(c, "/admin/secretary", "err", "not_found");
    const ok = await updateItem(ctx, it, { status: "resolved", resolved: true });
    return back(c, "/admin/secretary", ok ? "ok" : "err", ok ? "resolved" : "conflict");
  });

  // ---------- Accountability ----------
  app.get("/accountability", async (c) => {
    const ctx = c.get("app");
    const tz = (await getSettings(ctx.db)).timezone;
    const csrf = c.get("session")!.csrf_token;
    const ext = await getExtSettings(ctx.db);
    const policies = await ctx.db.all<{ id: string; kind: string; status: string; config_json: string; created_at: number }>(
      "SELECT id, kind, status, config_json, created_at FROM acc_policies ORDER BY created_at DESC LIMIT 20",
    );
    const sessions = await ctx.db.all<SessionRow>("SELECT * FROM acc_sessions ORDER BY intended_start DESC LIMIT 20");
    const srows: Html[][] = [];
    for (const s of sessions) {
      const cps = await ctx.db.all<CheckpointRow>("SELECT * FROM acc_checkpoints WHERE session_id = ? ORDER BY ordinal", s.id);
      const used =
        s.call_attempts +
        (s.alarm_occurrence_id
          ? ((await ctx.db.first<{ attempt_count: number }>("SELECT attempt_count FROM alarm_occurrences WHERE id = ?", s.alarm_occurrence_id))?.attempt_count ?? 0)
          : 0);
      const summary = s.summary_enc ? await ctx.crypto.decrypt(s.summary_enc, "accountability") : null;
      srows.push([
        html`${s.kind}<br /><span class="muted">${ts(s.intended_start, tz)} – ${ts(s.intended_end, tz)}</span>`,
        statusPill(s.state.replace(/_/g, " "), s.state === "needs_attention" ? "warn" : ["completed"].includes(s.state) ? "ok" : "info"),
        html`<ul>
          ${cps.map(
            (cp) =>
              html`<li>
                ${formatDateTime(cp.intended_at, tz)} ${cp.label} (${parseJson<string[]>(cp.evidence_kinds_json, []).join("/")}; grace to ${formatDateTime(cp.grace_until, tz)}):
                ${cp.status_label ? (LABEL_TEXT[cp.status_label] ?? cp.status_label) : cp.state}
              </li>`,
          )}
        </ul>`,
        html`${used}/${s.call_cap}`,
        html`${summary ? html`<span class="muted">${summary}</span>` : ["completed", "canceled", "expired", "needs_attention"].includes(s.state) ? "" : postButton(`/admin/accountability/${s.id}/cancel`, "Cancel", csrf, { kind: "danger" })}`,
      ]);
    }
    const evidence = await ctx.db.all<{ id: string; kind: string; state: string; received_at: number; verdict: string | null; model: string | null }>(
      "SELECT e.id, e.kind, e.state, e.received_at, a.verdict, a.model FROM evidence_submissions e LEFT JOIN evidence_assessments a ON a.submission_id = e.id ORDER BY e.received_at DESC LIMIT 20",
    );
    const toggles: Array<[keyof ExtSettings, Feature, string]> = [
      ["task_accountability_enabled", "task_accountability", "Task accountability"],
      ["morning_routines_enabled", "morning", "Morning routines"],
      ["uploads_enabled", "uploads", "Private photo uploads"],
      ["mms_enabled", "mms", "MMS photos"],
      ["assessment_enabled", "assessment", "AI photo assessment"],
      ["telemetry_enabled", "telemetry", "Browser check-ins"],
    ];
    return page(
      c,
      "Accountability",
      "/admin/accountability",
      html`<div class="card">
          <p class="muted">
            Everything here is off until enabled and only runs when you ask for it. Check-ins show that you answered a check; they never prove work or wakefulness. Photos are
            deleted after ${ext.raw_media_hours} hours.
          </p>
          ${toggles.map(
            ([col, f, label]) =>
              html`<p>
                ${label}: ${featureOn(ctx, ext, f) ? statusPill("on", "ok") : ext[col] === 1 ? statusPill("disabled by deployment", "warn") : statusPill("off", "info")}
                ${postButton("/admin/ext-settings", ext[col] === 1 ? "Turn off" : "Turn on", csrf, { fields: { [col]: ext[col] === 1 ? "0" : "1", _back: "/admin/accountability" } })}
              </p>`,
          )}
        </div>
        <h2>Policies</h2>
        ${table(
          ["Kind", "Status", "Created", "Configuration"],
          policies.map((p) => [html`${p.kind}`, html`${p.status}`, html`${ts(p.created_at, tz)}`, html`<code class="muted">${p.config_json.slice(0, 160)}</code>`]),
          "No policies.",
        )}
        <h2>Sessions</h2>
        ${table(["Session", "State", "Checks", "Calls used", ""], srows, "No sessions.")}
        <h2>Evidence</h2>
        <p>${postButton("/admin/accountability/delete-photos", "Delete all evidence photos now", csrf, { kind: "danger", confirm: "Delete every stored evidence photo now?" })}</p>
        ${table(
          ["Received", "Kind", "State", "Assessment"],
          evidence.map((e) => [html`${ts(e.received_at, tz)}`, html`${e.kind}`, html`${e.state.replace(/_/g, " ")}`, html`${e.verdict ? `${e.verdict} (${e.model})` : "—"}`]),
          "No evidence submitted.",
        )}`,
    );
  });

  app.post("/accountability/delete-photos", async (c) => {
    const ctx = c.get("app");
    const n = await deleteMediaWhere(ctx, "all");
    await audit(ctx, "admin", "media.delete_all", "media", null, String(n));
    return back(c, "/admin/accountability", "ok", "done");
  });

  app.post("/accountability/:id/cancel", async (c) => {
    const ctx = c.get("app");
    const s = await getSession(ctx, c.req.param("id"));
    if (!s) return back(c, "/admin/accountability", "err", "not_found");
    const ok = await cancelSession(ctx, s, "admin_canceled");
    return back(c, "/admin/accountability", ok ? "ok" : "err", ok ? "session_canceled" : "conflict");
  });

  // ---------- Devices ----------
  const devicesPage = async (c: C, code: { code: string; expiresAt: number } | null) => {
    const ctx = c.get("app");
    const tz = (await getSettings(ctx.db)).timezone;
    const csrf = c.get("session")!.csrf_token;
    const ext = await getExtSettings(ctx.db);
    const devices = await listDevices(ctx);
    const active = await ctx.db.first("SELECT id FROM acc_sessions WHERE state IN ('awaiting_start','active','awaiting_checkpoint')");
    return page(
      c,
      "Devices",
      "/admin/devices",
      html`<div class="card">
          <p>
            Browser check-ins: ${featureOn(ctx, ext, "telemetry") ? statusPill("on", "ok") : statusPill("off", "info")} · Monitoring right now:
            ${active && featureOn(ctx, ext, "telemetry") ? statusPill("active session", "warn") : statusPill("none", "ok")} · Any device online:
            ${(await devicesOnline(ctx)) ? "yes" : "no"}
          </p>
          ${
            code
              ? html`<p class="flash ok" role="status">
                  Pairing code: <strong><code>${code.code}</code></strong> (shown once; expires ${ts(code.expiresAt, tz)}). Enter it in the Della companion extension.
                </p>`
              : html`<form method="post" action="/admin/devices/pair" class="row">
                  ${csrfField(csrf)}
                  <div><label for="name">Device name</label><input id="name" name="name" maxlength="60" placeholder="Laptop Firefox" required /></div>
                  <div><button type="submit" class="primary">Create pairing code</button></div>
                </form>`
          }
          <p class="muted">The extension never reads tabs, pages, URLs, or history. It sends signed polls only during sessions and a click when you answer a check-in.</p>
        </div>
        ${table(
          ["Name", "Browser", "Capabilities", "Enrolled", "Last seen", "State", ""],
          devices.map((d) => [
            html`${d.name}`,
            html`${d.browser ?? "—"}`,
            html`<code class="muted">${d.capabilities_json}</code>`,
            html`${ts(d.enrolled_at, tz)}`,
            html`${ts(d.last_seen_at, tz)}`,
            d.revoked_at ? statusPill(`revoked (${d.revoked_reason ?? ""})`, "info") : html`${d.last_state ?? "—"}`,
            d.revoked_at ? html`` : postButton(`/admin/devices/${d.id}/revoke`, "Revoke", csrf, { kind: "danger", confirm: "Revoke this device?" }),
          ]),
          "No devices paired.",
        )}`,
    );
  };
  app.get("/devices", (c) => devicesPage(c, null));
  app.post("/devices/pair", async (c) => {
    const name = ((await form(c)).name ?? "").trim() || "Browser";
    return devicesPage(c, await createPairingCode(c.get("app"), name));
  });
  app.post("/devices/:id/revoke", async (c) => {
    const ok = await revokeDevice(c.get("app"), c.req.param("id"), "admin");
    return back(c, "/admin/devices", ok ? "ok" : "err", ok ? "revoked" : "not_found");
  });

  // ---------- Privacy / retention ----------
  app.get("/privacy", async (c) => {
    const ctx = c.get("app");
    const s = await getSettings(ctx.db);
    const tz = s.timezone;
    const csrf = c.get("session")!.csrf_token;
    const ext = await getExtSettings(ctx.db);
    const email = await emailStatus(ctx.db);
    const counts = await ctx.db.first<{ dirty: number; deleted: number; vectors: number; media: number; mediaExpired: number; tombstones: number }>(
      `SELECT (SELECT COUNT(*) FROM index_state WHERE dirty = 1 AND deleted = 0) AS dirty, (SELECT COUNT(*) FROM index_state WHERE deleted = 1 AND dirty = 1) AS deleted,
              (SELECT COUNT(*) FROM semantic_vectors) AS vectors, (SELECT COUNT(*) FROM media_objects WHERE deleted_at IS NULL) AS media,
              (SELECT COUNT(*) FROM media_objects WHERE deleted_at IS NOT NULL) AS mediaExpired, (SELECT COUNT(*) FROM deletion_tombstones) AS tombstones`,
    );
    const flag = (f: Feature, col: keyof ExtSettings, label: string) =>
      html`<tr>
        <td>${label}</td>
        <td>${featureOn(ctx, ext, f) ? statusPill("on", "ok") : ext[col] === 1 ? statusPill("deployment off", "warn") : statusPill("off", "info")}</td>
        <td>${postButton("/admin/ext-settings", ext[col] === 1 ? "Turn off" : "Turn on", csrf, { fields: { [col]: ext[col] === 1 ? "0" : "1", _back: "/admin/privacy" } })}</td>
      </tr>`;
    const num = (col: keyof ExtSettings, label: string) =>
      html`<div><label for="${col}">${label}</label><input id="${col}" name="${col}" type="number" min="0" value="${String(ext[col] ?? "")}" /></div>`;
    return page(
      c,
      "Privacy and retention",
      "/admin/privacy",
      html`<h2>Consents (each separate; all off by default except uploads)</h2>
        <div class="table-wrap">
          <table>
            <tbody>
              ${flag("capture", "capture_enabled", "Automatic memory capture")} ${flag("semantic", "semantic_enabled", "Semantic search index")}
              ${flag("uploads", "uploads_enabled", "Private uploads")} ${flag("mms", "mms_enabled", "MMS photo ingestion")}
              ${flag("assessment", "assessment_enabled", "AI photo assessment (provider can see photos)")} ${flag("telemetry", "telemetry_enabled", "Browser check-ins")}
              ${flag("morning", "morning_routines_enabled", "Morning routines")} ${flag("task_accountability", "task_accountability_enabled", "Task accountability")}
              ${flag("email", "email_enabled", "Read-only email for waiting-for checks")} ${flag("info", "info_enabled", "Weather / current information")}
              ${flag("suggestions", "suggestions_enabled", "Proactive suggestions")} ${flag("meeting_prep", "meeting_prep_enabled", "Meeting prep")}
              ${flag("post_meeting", "post_meeting_enabled", "Post-meeting check-ins")} ${flag("evening_reset", "evening_reset_enabled", "Evening reset")}
            </tbody>
          </table>
        </div>
        <p class="muted">
          Sensitive memory (passwords, card numbers, IDs) is ${ext.sensitive_memory_enabled ? "allowed" : "excluded and redacted"}. Stored text is encrypted at the application
          layer, but the Worker (and, if enabled, the AI and vision providers) can read it while processing. This is not end-to-end encryption.
        </p>
        <h2>Retention</h2>
        <form method="post" action="/admin/ext-settings" class="card">
          ${csrfField(csrf)}<input type="hidden" name="_back" value="/admin/privacy" />
          <div class="row">
            ${num("durable_memory_days", "Durable memory (days)")} ${num("raw_media_hours", "Raw photos (hours)")} ${num("telemetry_hours", "Device events (hours)")}
            ${num("accountability_summary_days", "Accountability summaries (days)")}
          </div>
          <div class="row">
            ${num("limit_embeddings_per_day", "Embeddings/day")} ${num("limit_semantic_queries_per_day", "Semantic queries/day")}
            ${num("limit_image_assessments_per_day", "Image assessments/day")} ${num("limit_media_bytes_per_day", "Media bytes/day")}
            ${num("max_standalone_suggestions_per_day", "Standalone suggestions/day")}
          </div>
          <div class="row">
            <div><label for="location_label">Weather location label</label><input id="location_label" name="location_label" value="${ext.location_label ?? ""}" /></div>
            <div><label for="location_lat">Latitude</label><input id="location_lat" name="location_lat" value="${ext.location_lat ?? ""}" /></div>
            <div><label for="location_lon">Longitude</label><input id="location_lon" name="location_lon" value="${ext.location_lon ?? ""}" /></div>
          </div>
          <p><button type="submit" class="primary">Save</button></p>
        </form>
        <p>
          Raw messages: ${s.retention_message_days} days (base setting). Raw source text for memories follows the same window; short supporting excerpts stay with each fact until
          you delete it.
        </p>
        <h2>Derived data</h2>
        <p>
          Index: ${counts?.dirty ?? 0} pending, ${counts?.deleted ?? 0} deletions pending, ${counts?.vectors ?? 0} vectors stored (${ctx.ext.semantic.name}). Media:
          ${counts?.media ?? 0} stored, ${counts?.mediaExpired ?? 0} deleted. Deletion tombstones: ${counts?.tombstones ?? 0}.
        </p>
        <h2>Integrations</h2>
        <p>
          Email (${ctx.config.ext.email}): ${email.status}${email.account ? ` (${email.account})` : ""}.
          ${ctx.config.ext.email === "gmail" ? html`<a href="/oauth/gmail/start">Connect Gmail (read-only)</a>` : html`<span class="muted">Simulated mailbox.</span>`}
          ${email.status !== "disconnected" ? postButton("/admin/email/disconnect", "Disconnect", csrf, { kind: "danger" }) : ""}
        </p>
        <p>Weather: ${ctx.ext.info.name}. Media storage: ${ctx.ext.media.name}. Vision: ${ctx.ext.vision.name}. Embeddings: ${ctx.ext.embeddings.name}.</p>
        <p><a href="/admin/data">Export or erase all data</a>. Last updated ${ts(ctx.clock.now(), tz)}.</p>`,
    );
  });

  app.post("/ext-settings", async (c) => {
    const ctx = c.get("app");
    const f = await form(c);
    const patch: Record<string, string | number | null> = {};
    for (const k of EXT_MUTABLE) {
      if (!(k in f)) continue;
      const v = (f[k] ?? "").trim();
      if (k === "location_label") patch[k] = v.slice(0, 60) || null;
      else if (k === "location_lat" || k === "location_lon") patch[k] = v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null;
      else if (v !== "" && Number.isFinite(Number(v)) && Number(v) >= 0) patch[k] = Math.round(Number(v));
    }
    if (patch.capture_enabled === 1) patch.capture_activated_at = ctx.clock.now();
    await updateExtSettings(ctx.db, patch as Parameters<typeof updateExtSettings>[1], ctx.clock.now());
    await audit(ctx, "admin", "ext_settings.update", "ext_settings", "1", Object.keys(patch).join(","));
    const to = f._back && /^\/admin\/[a-z-]+$/.test(f._back) ? f._back : "/admin/privacy";
    return back(c, to, "ok", "saved");
  });

  app.post("/email/disconnect", async (c) => {
    const ctx = c.get("app");
    await disconnectEmail(ctx.db, ctx.clock);
    await audit(ctx, "admin", "email.disconnected", "email", "1");
    return back(c, "/admin/privacy", "ok", "email_disconnected");
  });
}

/** Diagnostics additions: lag, conflicts, stale sources, outages, device gaps, unknown effects, missed checks. */
export async function extensionDiagnostics(ctx: AppContext): Promise<Html> {
  const tz = (await getSettings(ctx.db)).timezone;
  const now = ctx.clock.now();
  const q = async (sql: string, ...p: Array<string | number>) => (await ctx.db.first<{ n: number }>(sql, ...p))?.n ?? 0;
  const oldestDirty = await ctx.db.first<{ t: number | null }>("SELECT MIN(updated_at) AS t FROM index_state WHERE dirty = 1");
  const rows: Array<[string, string]> = [
    ["Index items pending", String(await q("SELECT COUNT(*) AS n FROM index_state WHERE dirty = 1"))],
    ["Oldest pending index change", oldestDirty?.t ? formatDateTime(oldestDirty.t, tz) : "—"],
    ["Index items failing (≥5 retries)", String(await q("SELECT COUNT(*) AS n FROM index_state WHERE retries >= 5"))],
    [
      "Messages without extraction (last 24 h, memory on)",
      String(
        await q(
          "SELECT COUNT(*) AS n FROM plans p WHERE p.created_at > ? AND p.plan_enc IS NOT NULL AND NOT EXISTS (SELECT 1 FROM extraction_runs x WHERE x.inbound_id = p.inbound_id)",
          now - DAY,
        ),
      ),
    ],
    ["Unresolved conflicting facts", String(await q("SELECT COUNT(*) AS n FROM assertions WHERE status = 'disputed'"))],
    ["Sources past raw retention", String(await q("SELECT COUNT(*) AS n FROM source_records WHERE content_enc IS NULL AND deleted_at IS NULL"))],
    ["Vision outages (7 days)", String(await q("SELECT COUNT(*) AS n FROM evidence_assessments WHERE verdict = 'unavailable' AND created_at > ?", now - 7 * DAY))],
    ["Device checks unverifiable (7 days)", String(await q("SELECT COUNT(*) AS n FROM acc_checkpoints WHERE state = 'unverifiable' AND updated_at > ?", now - 7 * DAY))],
    [
      "Devices offline (>3 min) during an active session",
      String(
        (await ctx.db.first("SELECT id FROM acc_sessions WHERE state IN ('active','awaiting_checkpoint')"))
          ? await q("SELECT COUNT(*) AS n FROM registered_devices WHERE revoked_at IS NULL AND (last_seen_at IS NULL OR last_seen_at < ?)", now - 3 * MINUTE)
          : 0,
      ),
    ],
    ["Missed checkpoints (7 days)", String(await q("SELECT COUNT(*) AS n FROM acc_checkpoints WHERE state = 'missed' AND updated_at > ?", now - 7 * DAY))],
    ["Sessions needing attention", String(await q("SELECT COUNT(*) AS n FROM acc_sessions WHERE state = 'needs_attention' AND updated_at > ?", now - 7 * DAY))],
    ["Effects with unknown outcome", String(await q("SELECT COUNT(*) AS n FROM outbound_effects WHERE state = 'unknown'"))],
  ];
  return html`<h2>Extension health</h2>
    ${table(
      ["Signal", "Value"],
      rows.map(([a, b]) => [html`${a}`, html`${b}`]),
    )}`;
}
