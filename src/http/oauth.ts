import { Hono } from "hono";
import { MINUTE } from "../domain/time";
import { log } from "../observability/log";
import { OAuthError, buildAuthorizationUrl, exchangeCode, hasRequiredScopes, pkceChallenge, revokeToken, verifyIdTokenClaims } from "../providers/calendar/google-oauth";
import { randomToken, sha256Hex } from "../security/crypto";
import { getSession, readCookie, SESSION_COOKIE } from "../security/sessions";
import { audit } from "../services/audit";
import { persistTokens, refreshCalendarList } from "../services/calendar-connection";
import type { AppEnvBindings } from "./types";
import { gmailAuthorizationUrl, persistEmailTokens } from "../ext/email";

const STATE_TTL_MS = 10 * MINUTE;

/**
 * Google OAuth (authorization code + PKCE). The state is random, one-time, short-lived, and bound
 * to the admin session (only its hash is stored). The callback only ever redirects to a fixed
 * admin path — there is no caller-controlled redirect target.
 */
export function oauthRoutes(): Hono<AppEnvBindings> {
  const app = new Hono<AppEnvBindings>();

  app.get("/google/start", async (c) => {
    const ctx = c.get("app");
    const token = readCookie(c.req.raw, SESSION_COOKIE);
    const session = await getSession(ctx, token);
    if (!session || !token) return c.redirect("/admin/login", 303);
    const g = ctx.config.google;
    if (ctx.config.providers.calendar !== "google" || !g.clientId || !g.clientSecret || !g.redirectUri) return c.redirect("/admin/calendar?err=oauth_error", 303);
    const state = randomToken(32);
    const verifier = randomToken(48);
    const now = ctx.clock.now();
    await ctx.db.run(
      "INSERT INTO oauth_states (state_hash, session_hash, code_verifier_enc, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
      await sha256Hex(state),
      await sha256Hex(token),
      await ctx.crypto.encrypt(verifier, "oauth_state"),
      now,
      now + STATE_TTL_MS,
    );
    const url = buildAuthorizationUrl(
      { clientId: g.clientId, clientSecret: g.clientSecret, redirectUri: g.redirectUri, expectedAccount: g.expectedAccount },
      state,
      await pkceChallenge(verifier),
    );
    return c.redirect(url, 302);
  });

  app.get("/google/callback", async (c) => {
    const ctx = c.get("app");
    const fail = (code = "oauth_error") => c.redirect(`/admin/calendar?err=${code}`, 303);
    const token = readCookie(c.req.raw, SESSION_COOKIE);
    const session = await getSession(ctx, token);
    if (!session || !token) return c.redirect("/admin/login", 303);
    const state = c.req.query("state");
    const code = c.req.query("code");
    if (!state || state.length > 200) return fail();
    const stateHash = await sha256Hex(state);
    const row = await ctx.db.first<{ session_hash: string; code_verifier_enc: string; expires_at: number; used_at: number | null }>(
      "SELECT * FROM oauth_states WHERE state_hash = ?",
      stateHash,
    );
    const now = ctx.clock.now();
    if (!row || row.used_at !== null || row.expires_at < now || row.session_hash !== (await sha256Hex(token))) return fail();
    // One-time use: conditional update; a replayed state loses.
    if ((await ctx.db.run("UPDATE oauth_states SET used_at = ? WHERE state_hash = ? AND used_at IS NULL", now, stateHash)) !== 1) return fail();
    if (c.req.query("error") || !code || code.length > 2000) return fail();
    const g = ctx.config.google;
    if (!g.clientId || !g.clientSecret || !g.redirectUri) return fail();
    const cfg = { clientId: g.clientId, clientSecret: g.clientSecret, redirectUri: g.redirectUri, expectedAccount: g.expectedAccount };
    try {
      const verifier = await ctx.crypto.decrypt(row.code_verifier_enc, "oauth_state");
      const tokens = await exchangeCode(ctx.fetcher, cfg, code, verifier);
      if (!tokens.idToken || !hasRequiredScopes(tokens.scopes)) {
        await revokeToken(ctx.fetcher, tokens.refreshToken ?? tokens.accessToken);
        return fail();
      }
      const identity = verifyIdTokenClaims(tokens.idToken, g.clientId, now);
      if (!identity.emailVerified) return fail();
      if (g.expectedAccount && g.expectedAccount.toLowerCase() !== identity.email) {
        await revokeToken(ctx.fetcher, tokens.refreshToken ?? tokens.accessToken);
        await audit(ctx, "admin", "calendar.wrong_account", "calendar", "google");
        return fail("wrong_account");
      }
      // Without a configured expected account, the owner reviews the verified identity before activation.
      await persistTokens(ctx.db, ctx.crypto, ctx.clock, tokens, identity, g.expectedAccount ? "connected" : "pending_activation");
      await audit(ctx, "admin", "calendar.oauth_connected", "calendar", "google", g.expectedAccount ? "connected" : "pending_activation");
      if (g.expectedAccount) {
        try {
          await refreshCalendarList(ctx);
        } catch (err) {
          log("warn", "calendar_list_failed", { error: String(err) });
        }
      }
      return c.redirect(`/admin/calendar?ok=${g.expectedAccount ? "connected" : "saved"}`, 303);
    } catch (err) {
      log("warn", "oauth_callback_failed", { code: err instanceof OAuthError ? err.code : "error" });
      return fail();
    }
  });

  // Read-only Gmail: a separate grant from Calendar; state hashes are namespaced so they can't cross over.
  app.get("/gmail/start", async (c) => {
    const ctx = c.get("app");
    const token = readCookie(c.req.raw, SESSION_COOKIE);
    const session = await getSession(ctx, token);
    if (!session || !token) return c.redirect("/admin/login", 303);
    const g = ctx.config.google;
    const redirectUri = ctx.config.ext.gmailRedirectUri;
    if (ctx.config.ext.email !== "gmail" || !g.clientId || !g.clientSecret || !redirectUri) return c.redirect("/admin/privacy?err=oauth_error", 303);
    const state = randomToken(32);
    const verifier = randomToken(48);
    const now = ctx.clock.now();
    await ctx.db.run(
      "INSERT INTO oauth_states (state_hash, session_hash, code_verifier_enc, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
      await sha256Hex(`gmail:${state}`),
      await sha256Hex(token),
      await ctx.crypto.encrypt(verifier, "oauth_state"),
      now,
      now + STATE_TTL_MS,
    );
    return c.redirect(
      gmailAuthorizationUrl({ clientId: g.clientId, clientSecret: g.clientSecret, redirectUri, expectedAccount: g.expectedAccount }, state, await pkceChallenge(verifier)),
      302,
    );
  });

  app.get("/gmail/callback", async (c) => {
    const ctx = c.get("app");
    const fail = () => c.redirect("/admin/privacy?err=oauth_error", 303);
    const token = readCookie(c.req.raw, SESSION_COOKIE);
    const session = await getSession(ctx, token);
    if (!session || !token) return c.redirect("/admin/login", 303);
    const state = c.req.query("state");
    const code = c.req.query("code");
    if (!state || state.length > 200) return fail();
    const stateHash = await sha256Hex(`gmail:${state}`);
    const row = await ctx.db.first<{ session_hash: string; code_verifier_enc: string; expires_at: number; used_at: number | null }>(
      "SELECT * FROM oauth_states WHERE state_hash = ?",
      stateHash,
    );
    const now = ctx.clock.now();
    if (!row || row.used_at !== null || row.expires_at < now || row.session_hash !== (await sha256Hex(token))) return fail();
    if ((await ctx.db.run("UPDATE oauth_states SET used_at = ? WHERE state_hash = ? AND used_at IS NULL", now, stateHash)) !== 1) return fail();
    const g = ctx.config.google;
    const redirectUri = ctx.config.ext.gmailRedirectUri;
    if (c.req.query("error") || !code || code.length > 2000 || !g.clientId || !g.clientSecret || !redirectUri) return fail();
    const cfg = { clientId: g.clientId, clientSecret: g.clientSecret, redirectUri, expectedAccount: g.expectedAccount };
    try {
      const tokens = await exchangeCode(ctx.fetcher, cfg, code, await ctx.crypto.decrypt(row.code_verifier_enc, "oauth_state"));
      if (
        !tokens.idToken ||
        !tokens.scopes.includes("https://www.googleapis.com/auth/gmail.readonly") ||
        tokens.scopes.some((s) => /gmail\.(send|modify|compose)|mail\.google\.com/.test(s))
      ) {
        await revokeToken(ctx.fetcher, tokens.refreshToken ?? tokens.accessToken);
        return fail();
      }
      const identity = verifyIdTokenClaims(tokens.idToken, g.clientId, now);
      if (!identity.emailVerified || (g.expectedAccount && g.expectedAccount.toLowerCase() !== identity.email)) {
        await revokeToken(ctx.fetcher, tokens.refreshToken ?? tokens.accessToken);
        return fail();
      }
      await persistEmailTokens(ctx.db, ctx.crypto, ctx.clock, tokens, identity.email);
      await audit(ctx, "admin", "email.connected", "email", "gmail", "read-only");
      return c.redirect("/admin/privacy?ok=email_connected", 303);
    } catch (err) {
      log("warn", "gmail_oauth_failed", { code: err instanceof OAuthError ? err.code : "error" });
      return fail();
    }
  });

  return app;
}
