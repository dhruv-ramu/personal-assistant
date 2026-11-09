import { describe, expect, it } from "vitest";
import { bytesToBase64Url } from "../../src/security/crypto";
import { makeHarness, type Harness } from "../helpers/harness";

const ORIGIN = "https://della.test";
const SECRET = "test-admin-secret-0123456789abcdef";

async function login(h: Harness, secret = SECRET, ip = "203.0.113.7") {
  return h.fetchApp(
    new Request(`${ORIGIN}/admin/login`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN, "cf-connecting-ip": ip },
      body: new URLSearchParams({ secret }).toString(),
      redirect: "manual",
    }),
  );
}

async function session(h: Harness): Promise<{ cookie: string; csrf: string }> {
  const res = await login(h);
  const cookie = res.headers.get("set-cookie")!.split(";")[0]!;
  const page = await (await h.fetchApp(new Request(`${ORIGIN}/admin/settings`, { headers: { cookie } }))).text();
  const csrf = /name="_csrf" value="([^"]+)"/.exec(page)![1]!;
  return { cookie, csrf };
}

function post(h: Harness, path: string, s: { cookie: string; csrf?: string }, fields: Record<string, string> = {}, origin: string | null = ORIGIN) {
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", cookie: s.cookie };
  if (origin) headers.origin = origin;
  return h.fetchApp(
    new Request(`${ORIGIN}${path}`, { method: "POST", headers, body: new URLSearchParams({ ...(s.csrf ? { _csrf: s.csrf } : {}), ...fields }).toString(), redirect: "manual" }),
  );
}

describe("admin authentication", () => {
  it("denies by default and redirects to login", async () => {
    const h = await makeHarness();
    const res = await h.fetchApp(new Request(`${ORIGIN}/admin`, { redirect: "manual" }));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/admin/login");
    expect((await h.fetchApp(new Request(`${ORIGIN}/admin/tasks/x/complete`, { method: "POST" }))).status).toBe(401);
    expect((await h.fetchApp(new Request(`${ORIGIN}/nope`))).status).toBe(404);
    const health = await h.fetchApp(new Request(`${ORIGIN}/health`));
    expect(await health.json()).toEqual({ ok: true, service: "della" });
  });

  it("issues an HttpOnly, SameSite=Lax, Secure session cookie and stores only its hash", async () => {
    const h = await makeHarness();
    const res = await login(h);
    expect(res.status).toBe(303);
    const cookie = res.headers.get("set-cookie")!;
    expect(cookie).toMatch(/^della_session=[A-Za-z0-9_-]{40,}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=43200; Secure$/);
    const token = cookie.split(";")[0]!.split("=")[1]!;
    const row = await h.db.first<{ token_hash: string }>("SELECT token_hash FROM admin_sessions");
    expect(row!.token_hash).not.toBe(token);
    expect(row!.token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("throttles login attempts even if the correct secret is eventually tried", async () => {
    const h = await makeHarness();
    for (let i = 0; i < 5; i++) expect((await login(h, "wrong")).headers.get("location")).toBe("/admin/login?err=invalid");
    expect((await login(h)).headers.get("location")).toBe("/admin/login?err=throttled");
    expect((await login(h, SECRET, "198.51.100.9")).headers.get("location")).toBe("/admin");
  });

  it("requires the CSRF token and a same-origin Origin for state changes", async () => {
    const h = await makeHarness();
    const s = await session(h);
    expect((await post(h, "/admin/settings/resume", { cookie: s.cookie })).status).toBe(403);
    expect((await post(h, "/admin/settings/resume", s, {}, "https://evil.example")).status).toBe(403);
    expect((await post(h, "/admin/settings/resume", s, {}, null)).status).toBe(403);
    expect((await post(h, "/admin/settings/resume", s)).status).toBe(303);
  });

  it("escapes untrusted content in the dashboard and sets a restrictive CSP", async () => {
    const h = await makeHarness();
    await h.send("Remind me tomorrow at 5 PM to <script>alert(1)</script> review");
    const s = await session(h);
    const res = await h.fetchApp(new Request(`${ORIGIN}/admin/tasks`, { headers: { cookie: s.cookie } }));
    const html = await res.text();
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(res.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("dashboard operations use the same domain services as SMS", async () => {
    const h = await makeHarness();
    await h.send("Remind me tomorrow at 5 PM to file taxes");
    const id = (await h.db.first<{ id: string }>("SELECT id FROM tasks"))!.id;
    const s = await session(h);
    expect((await post(h, `/admin/tasks/${id}/complete`, s)).status).toBe(303);
    expect((await h.db.first<{ status: string }>("SELECT status FROM tasks"))!.status).toBe("completed");
    expect(await h.count("SELECT COUNT(*) AS n FROM jobs WHERE kind = 'send_reminder' AND status = 'pending'")).toBe(0);
  });

  it("blank numeric settings fields leave values unchanged instead of saving 0", async () => {
    const h = await makeHarness();
    const s = await session(h);
    expect(
      (await post(h, "/admin/settings", s, { section: "main", limit_ai_requests_per_day: "", limit_sms_segments_per_day: "40", sms_enabled: "1", calls_enabled: "1" })).status,
    ).toBe(303);
    const row = await h.db.first<{ limit_ai_requests_per_day: number; limit_sms_segments_per_day: number }>(
      "SELECT limit_ai_requests_per_day, limit_sms_segments_per_day FROM owner_settings",
    );
    expect(row).toEqual({ limit_ai_requests_per_day: 100, limit_sms_segments_per_day: 40 });
  });

  it("every admin page renders for an authenticated owner", async () => {
    const h = await makeHarness();
    const s = await session(h);
    for (const p of ["/admin", "/admin/simulator", "/admin/tasks", "/admin/calendar", "/admin/alarms", "/admin/activity", "/admin/settings", "/admin/diagnostics", "/admin/data"]) {
      const res = await h.fetchApp(new Request(`${ORIGIN}${p}`, { headers: { cookie: s.cookie } }));
      expect(res.status, p).toBe(200);
    }
  });

  it("production exposes no simulator, clock, or injection routes", async () => {
    const h = await makeHarness({ env: { APP_ENV: "production", SIMULATOR_ENABLED: "true" } });
    const s = await session(h);
    expect((await h.fetchApp(new Request(`${ORIGIN}/admin/simulator`, { headers: { cookie: s.cookie } }))).status).toBe(404);
    expect((await post(h, "/admin/simulator/clock", s, { at: "2030-01-01T00:00" })).status).toBe(404);
    expect((await post(h, "/admin/simulator/send", s, { text: "hi" })).status).toBe(404);
  });
});

const GOOGLE_ENV = {
  CALENDAR_PROVIDER: "google",
  GOOGLE_CLIENT_ID: "test-client.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "test-google-secret-value",
  GOOGLE_REDIRECT_URI: "https://della.test/oauth/google/callback",
};

function idToken(claims: Record<string, unknown>): string {
  const enc = (o: unknown) => bytesToBase64Url(new TextEncoder().encode(JSON.stringify(o)));
  return `${enc({ alg: "RS256" })}.${enc(claims)}.sig`;
}

function tokenFetcher(email: string, revoked: string[]) {
  return async (input: string, init?: RequestInit) => {
    if (input === "https://oauth2.googleapis.com/token") {
      const form = new URLSearchParams(String(init?.body));
      expect(form.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43,}$/);
      return new Response(
        JSON.stringify({
          access_token: "ya29.access",
          refresh_token: "1//refresh",
          expires_in: 3600,
          scope: "openid email https://www.googleapis.com/auth/calendar.calendarlist.readonly https://www.googleapis.com/auth/calendar.events",
          id_token: idToken({
            iss: "https://accounts.google.com",
            aud: GOOGLE_ENV.GOOGLE_CLIENT_ID,
            exp: Math.floor(Date.parse("2026-11-08T19:00:00Z") / 1000),
            sub: "1234",
            email,
            email_verified: true,
          }),
        }),
        { status: 200 },
      );
    }
    if (input === "https://oauth2.googleapis.com/revoke") {
      revoked.push(String(init?.body));
      return new Response("", { status: 200 });
    }
    if (input.includes("/users/me/calendarList"))
      return new Response(JSON.stringify({ items: [{ id: "primary", summary: "Me", primary: true, accessRole: "owner" }] }), { status: 200 });
    return new Response("{}", { status: 404 });
  };
}

describe("Google OAuth flow", () => {
  async function start(h: Harness, s: { cookie: string }) {
    const res = await h.fetchApp(new Request(`${ORIGIN}/oauth/google/start`, { headers: { cookie: s.cookie }, redirect: "manual" }));
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.origin + loc.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(loc.searchParams.get("code_challenge_method")).toBe("S256");
    expect(loc.searchParams.get("access_type")).toBe("offline");
    expect(loc.searchParams.get("redirect_uri")).toBe(GOOGLE_ENV.GOOGLE_REDIRECT_URI);
    expect(loc.searchParams.get("scope")).toBe("openid email https://www.googleapis.com/auth/calendar.calendarlist.readonly https://www.googleapis.com/auth/calendar.events");
    return loc.searchParams.get("state")!;
  }

  const callback = (h: Harness, cookie: string, q: string) => h.fetchApp(new Request(`${ORIGIN}/oauth/google/callback?${q}`, { headers: { cookie }, redirect: "manual" }));

  it("binds one-time state to the session, rejects replay/expiry, and redirects only to a fixed path", async () => {
    const revoked: string[] = [];
    const h = await makeHarness({ env: GOOGLE_ENV, fetcher: tokenFetcher("owner@example.com", revoked), connectCalendar: false });
    const s = await session(h);
    const state = await start(h, s);
    const ok = await callback(h, s.cookie, `state=${state}&code=abc&next=https://evil.example`);
    expect(ok.headers.get("location")).toBe("/admin/calendar?ok=saved");
    const conn = await h.db.first<{ status: string; account_email: string; refresh_token_enc: string }>("SELECT status, account_email, refresh_token_enc FROM calendar_connection");
    expect(conn!.status).toBe("pending_activation");
    expect(conn!.account_email).toBe("owner@example.com");
    expect(conn!.refresh_token_enc).not.toContain("1//refresh");
    expect((await callback(h, s.cookie, `state=${state}&code=abc`)).headers.get("location")).toBe("/admin/calendar?err=oauth_error");

    const state2 = await start(h, s);
    h.clock.advance(11 * 60_000);
    expect((await callback(h, s.cookie, `state=${state2}&code=abc`)).headers.get("location")).toBe("/admin/calendar?err=oauth_error");

    const other = await session(h);
    const state3 = await start(h, s);
    expect((await callback(h, other.cookie, `state=${state3}&code=abc`)).headers.get("location")).toBe("/admin/calendar?err=oauth_error");
  });

  it("refuses an account that doesn't match GOOGLE_EXPECTED_ACCOUNT and revokes its token", async () => {
    const revoked: string[] = [];
    const h = await makeHarness({
      env: { ...GOOGLE_ENV, GOOGLE_EXPECTED_ACCOUNT: "owner@example.com" },
      fetcher: tokenFetcher("someone-else@example.com", revoked),
      connectCalendar: false,
    });
    const s = await session(h);
    const state = await start(h, s);
    expect((await callback(h, s.cookie, `state=${state}&code=abc`)).headers.get("location")).toBe("/admin/calendar?err=wrong_account");
    expect(revoked).toHaveLength(1);
    expect((await h.db.first<{ status: string }>("SELECT status FROM calendar_connection"))!.status).toBe("disconnected");
  });
});
