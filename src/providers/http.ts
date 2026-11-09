/**
 * Outbound HTTP is limited to an allowlist of provider hosts. There is no user-supplied URL fetch.
 */
export const ALLOWED_PROVIDER_HOSTS = new Set(["api.twilio.com", "oauth2.googleapis.com", "www.googleapis.com", "openidconnect.googleapis.com", "api.openai.com"]);

export type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

export class HostNotAllowedError extends Error {}

export function allowlistedFetch(base: Fetcher = (i, init) => fetch(i, init)): Fetcher {
  return async (input, init) => {
    const url = new URL(input);
    if (url.protocol !== "https:" || !ALLOWED_PROVIDER_HOSTS.has(url.hostname)) {
      throw new HostNotAllowedError(`Outbound host not allowed: ${url.hostname}`);
    }
    return base(input, init);
  };
}

export function isAbortOrNetworkError(err: unknown): boolean {
  if (err instanceof HostNotAllowedError) return false;
  return err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError" || err instanceof TypeError);
}
