import { html } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";

export type Html = HtmlEscapedString | Promise<HtmlEscapedString>;

export interface PageOptions {
  title: string;
  active: string;
  csrf: string | null;
  simulatorEnabled: boolean;
  modes: Array<{ label: string; value: string; live: boolean }>;
  flash?: { kind: "ok" | "error"; text: string } | null;
}

const NAV: Array<[string, string, boolean?]> = [
  ["/admin", "Overview"],
  ["/admin/simulator", "Simulator", true],
  ["/admin/tasks", "Tasks"],
  ["/admin/calendar", "Calendar"],
  ["/admin/alarms", "Wake-up calls"],
  ["/admin/knowledge", "Knowledge"],
  ["/admin/items", "Items"],
  ["/admin/memory", "Memory inbox"],
  ["/admin/secretary", "Secretary"],
  ["/admin/accountability", "Accountability"],
  ["/admin/devices", "Devices"],
  ["/admin/activity", "Activity"],
  ["/admin/settings", "Settings"],
  ["/admin/diagnostics", "Diagnostics"],
  ["/admin/privacy", "Privacy"],
  ["/admin/data", "Data"],
];

export function layout(opts: PageOptions, body: Html): Html {
  return html`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${opts.title} · Della</title>
        <link rel="icon" type="image/png" href="/logo.png" />
        <link rel="stylesheet" href="/admin/assets/app.css" />
        <script src="/admin/assets/app.js" defer></script>
      </head>
      <body>
        <a class="skip" href="#main">Skip to content</a>
        <header>
          <div class="brand">Della <span class="muted">admin</span></div>
          ${
            opts.csrf
              ? html`<nav aria-label="Main">
                  ${NAV.filter(([, , sim]) => !sim || opts.simulatorEnabled).map(([href, label]) => html`<a href="${href}" ${opts.active === href ? html`aria-current="page"` : ""}>${label}</a>`)}
                </nav>`
              : ""
          }
          <div class="modes" aria-label="Provider modes">
            ${opts.modes.map((m) => html`<span class="badge ${m.live ? "live" : "sim"}" title="${m.label}">${m.label}: ${m.value}</span>`)}
          </div>
          ${
            opts.csrf
              ? html`<form method="post" action="/admin/logout" class="logout">
                  <input type="hidden" name="_csrf" value="${opts.csrf}" /><button type="submit">Log out</button>
                </form>`
              : ""
          }
        </header>
        <main id="main" tabindex="-1">
          ${opts.flash ? html`<p class="flash ${opts.flash.kind}" role="status">${opts.flash.text}</p>` : ""}
          <h1>${opts.title}</h1>
          ${body}
        </main>
      </body>
    </html>`;
}

export function csrfField(csrf: string): Html {
  return html`<input type="hidden" name="_csrf" value="${csrf}" />`;
}

export function postButton(action: string, label: string, csrf: string, opts: { confirm?: string; fields?: Record<string, string>; kind?: "danger" | "normal" } = {}): Html {
  return html`<form method="post" action="${action}" class="inline">
    ${csrfField(csrf)} ${Object.entries(opts.fields ?? {}).map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}" />`)}
    <button type="submit" class="${opts.kind === "danger" ? "danger" : ""}" ${opts.confirm ? html`data-confirm="${opts.confirm}"` : ""}>${label}</button>
  </form>`;
}

export function table(headers: string[], rows: Html[][], empty = "Nothing here yet."): Html {
  if (rows.length === 0) return html`<p class="empty">${empty}</p>`;
  return html`<div class="table-wrap">
    <table>
      <thead>
        <tr>
          ${headers.map((h) => html`<th scope="col">${h}</th>`)}
        </tr>
      </thead>
      <tbody>
        ${rows.map(
          (r) =>
            html`<tr>
              ${r.map((cell) => html`<td>${cell}</td>`)}
            </tr>`,
        )}
      </tbody>
    </table>
  </div>`;
}

export function statusPill(text: string, kind: "ok" | "warn" | "bad" | "info" = "info"): Html {
  return html`<span class="pill ${kind}">${text}</span>`;
}

export const APP_CSS = `
:root{--fg:#1b1f24;--muted:#5b6470;--bg:#f7f7f5;--card:#fff;--line:#dcdfe3;--accent:#1f5fbf;--ok:#1d7a3a;--warn:#9a6400;--bad:#b42318}
*{box-sizing:border-box}body{margin:0;font:15px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:var(--fg);background:var(--bg)}
header{display:flex;flex-wrap:wrap;gap:.5rem 1rem;align-items:center;padding:.6rem 1rem;background:var(--card);border-bottom:1px solid var(--line)}
.brand{font-weight:700}nav{display:flex;flex-wrap:wrap;gap:.25rem}nav a{padding:.3rem .55rem;border-radius:6px;color:var(--fg);text-decoration:none}
nav a[aria-current=page]{background:#e8eefb;color:var(--accent);font-weight:600}nav a:focus-visible,button:focus-visible,input:focus-visible,select:focus-visible{outline:3px solid #7aa7ff;outline-offset:1px}
.modes{display:flex;flex-wrap:wrap;gap:.25rem;margin-left:auto;min-width:0;max-width:100%}.badge{font-size:12px;padding:.15rem .45rem;border-radius:999px;border:1px solid var(--line)}
.badge.sim{background:#fff6dd}.badge.live{background:#e3f6e8;border-color:#9fd3ad}.logout{margin:0}
main{max-width:1100px;margin:0 auto;padding:1rem}h1{font-size:1.4rem;margin:.3rem 0 1rem}h2{font-size:1.1rem;margin:1.2rem 0 .5rem}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:.75rem}.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:.8rem}
.muted{color:var(--muted)}.empty{color:var(--muted);font-style:italic}.table-wrap{overflow-x:auto;background:var(--card);border:1px solid var(--line);border-radius:10px}
table{border-collapse:collapse;width:100%;font-size:14px}th,td{text-align:left;padding:.4rem .55rem;border-bottom:1px solid var(--line);vertical-align:top}th{background:#f1f3f5}
.pill{display:inline-block;font-size:12px;padding:.05rem .45rem;border-radius:999px;background:#eef1f4}.pill.ok{background:#e3f6e8;color:var(--ok)}.pill.warn{background:#fff3d6;color:var(--warn)}.pill.bad{background:#fde7e5;color:var(--bad)}
form.inline{display:inline}button{font:inherit;padding:.35rem .7rem;border:1px solid #b8c0ca;border-radius:6px;background:#fff;cursor:pointer;min-height:34px}button:hover{background:#f1f4f8}
button.danger{border-color:#e3a39c;color:var(--bad)}button.primary{background:var(--accent);color:#fff;border-color:var(--accent)}
label{display:block;font-weight:600;margin:.5rem 0 .2rem}input,select,textarea{font:inherit;padding:.4rem;border:1px solid #b8c0ca;border-radius:6px;width:100%;max-width:420px;background:#fff}
.row{display:flex;flex-wrap:wrap;gap:.5rem;align-items:end}.row > *{flex:0 1 auto}.flash{padding:.5rem .75rem;border-radius:8px}.flash.ok{background:#e3f6e8}.flash.error{background:#fde7e5}
.chat{display:flex;flex-direction:column;gap:.4rem;max-height:520px;overflow-y:auto;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:.6rem}
.msg{max-width:80%;padding:.45rem .65rem;border-radius:12px}.msg .text{white-space:pre-wrap}.msg.from_owner{align-self:flex-end;background:#dbe8ff}.msg.to_owner{align-self:flex-start;background:#eef0f2}.msg.provider_auto{align-self:center;background:#fff6dd;font-size:13px}
.msg .meta{display:block;font-size:11px;color:var(--muted);margin-top:.15rem}.sim-banner{background:#fff6dd;border:1px solid #f0d58a;padding:.5rem .75rem;border-radius:8px;margin-bottom:.75rem}
.skip{position:absolute;left:-999px}.skip:focus{left:1rem;top:1rem;background:#fff;padding:.5rem;z-index:9}code{font-size:13px;background:#f1f3f5;padding:.05rem .3rem;border-radius:4px}
@media (max-width:640px){header{padding:.5rem}.modes{margin-left:0}main{padding:.6rem}}
`;

export const APP_JS = `
document.addEventListener('submit', function (e) {
  var b = e.submitter || (e.target && e.target.querySelector('[data-confirm]'));
  var msg = b && b.getAttribute && b.getAttribute('data-confirm');
  if (msg && !window.confirm(msg)) e.preventDefault();
});
document.addEventListener('DOMContentLoaded', function () {
  var chat = document.querySelector('.chat');
  if (chat) chat.scrollTop = chat.scrollHeight;
});
`;
