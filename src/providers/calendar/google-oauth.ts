import { base64UrlToBytes, bytesToBase64Url, sha256 } from "../../security/crypto";
import { redactText } from "../../security/redaction";
import type { Fetcher } from "../http";

/**
 * Google OAuth 2.0 authorization-code flow for web server apps, with offline access and PKCE (S256).
 * Scopes are the minimum for: selecting calendars (calendarList read-only), reading and writing
 * events (calendar.events), and identifying the connected account (openid email).
 */
export const GOOGLE_SCOPES = ["openid", "email", "https://www.googleapis.com/auth/calendar.calendarlist.readonly", "https://www.googleapis.com/auth/calendar.events"] as const;

export const REQUIRED_CALENDAR_SCOPES = ["https://www.googleapis.com/auth/calendar.calendarlist.readonly", "https://www.googleapis.com/auth/calendar.events"];

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  expectedAccount: string | null;
}

export interface TokenResponse {
  accessToken: string;
  expiresInSec: number;
  refreshToken: string | null;
  scopes: string[];
  idToken: string | null;
}

export class OAuthError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "OAuthError";
  }
}

export interface VerifiedGoogleIdentity {
  sub: string;
  email: string;
  emailVerified: boolean;
}

export async function pkceChallenge(verifier: string): Promise<string> {
  return bytesToBase64Url(await sha256(verifier));
}

export function buildAuthorizationUrl(cfg: GoogleOAuthConfig, state: string, codeChallenge: string): string {
  const u = new URL(AUTH_ENDPOINT);
  u.searchParams.set("client_id", cfg.clientId);
  u.searchParams.set("redirect_uri", cfg.redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", GOOGLE_SCOPES.join(" "));
  u.searchParams.set("access_type", "offline");
  u.searchParams.set("prompt", "consent");
  u.searchParams.set("include_granted_scopes", "false");
  u.searchParams.set("state", state);
  u.searchParams.set("code_challenge", codeChallenge);
  u.searchParams.set("code_challenge_method", "S256");
  if (cfg.expectedAccount) u.searchParams.set("login_hint", cfg.expectedAccount);
  return u.toString();
}

async function postToken(fetcher: Fetcher, form: URLSearchParams): Promise<TokenResponse> {
  let res: Response;
  try {
    res = await fetcher(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new OAuthError("unavailable", "Token endpoint unreachable");
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const code = typeof body.error === "string" ? body.error : `http_${res.status}`;
    throw new OAuthError(code, redactText(typeof body.error_description === "string" ? body.error_description : code));
  }
  if (typeof body.access_token !== "string") throw new OAuthError("invalid_response", "Token response missing access_token");
  return {
    accessToken: body.access_token,
    expiresInSec: typeof body.expires_in === "number" ? body.expires_in : 3600,
    refreshToken: typeof body.refresh_token === "string" ? body.refresh_token : null,
    scopes: typeof body.scope === "string" ? body.scope.split(" ").filter(Boolean) : [],
    idToken: typeof body.id_token === "string" ? body.id_token : null,
  };
}

export function exchangeCode(fetcher: Fetcher, cfg: GoogleOAuthConfig, code: string, codeVerifier: string): Promise<TokenResponse> {
  const form = new URLSearchParams({
    code,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    redirect_uri: cfg.redirectUri,
    grant_type: "authorization_code",
    code_verifier: codeVerifier,
  });
  return postToken(fetcher, form);
}

export function refreshAccessToken(fetcher: Fetcher, cfg: GoogleOAuthConfig, refreshToken: string): Promise<TokenResponse> {
  const form = new URLSearchParams({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  return postToken(fetcher, form);
}

export async function revokeToken(fetcher: Fetcher, token: string): Promise<boolean> {
  try {
    const res = await fetcher(REVOKE_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }).toString(),
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * The ID token arrives directly from Google's token endpoint over TLS in exchange for our client
 * secret, which Google's OpenID Connect guide accepts as sufficient provenance; we still check
 * issuer, audience, expiry, and email verification rather than trusting any browser-asserted email.
 */
export function verifyIdTokenClaims(idToken: string, clientId: string, nowMs: number): VerifiedGoogleIdentity {
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new OAuthError("invalid_id_token", "Malformed ID token");
  let claims: Record<string, unknown>;
  try {
    claims = JSON.parse(new TextDecoder().decode(base64UrlToBytes(parts[1]!))) as Record<string, unknown>;
  } catch {
    throw new OAuthError("invalid_id_token", "Unreadable ID token");
  }
  if (claims.iss !== "https://accounts.google.com" && claims.iss !== "accounts.google.com") throw new OAuthError("invalid_id_token", "Unexpected issuer");
  const aud = claims.aud;
  if (aud !== clientId && !(Array.isArray(aud) && aud.includes(clientId))) throw new OAuthError("invalid_id_token", "Unexpected audience");
  if (typeof claims.exp !== "number" || claims.exp * 1000 < nowMs - 60_000) throw new OAuthError("invalid_id_token", "Expired ID token");
  if (typeof claims.sub !== "string" || typeof claims.email !== "string") throw new OAuthError("invalid_id_token", "Missing identity claims");
  return { sub: claims.sub, email: claims.email.toLowerCase(), emailVerified: claims.email_verified === true };
}

export function hasRequiredScopes(scopes: string[]): boolean {
  return REQUIRED_CALENDAR_SCOPES.every((s) => scopes.includes(s));
}
