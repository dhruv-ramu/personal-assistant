/** Redaction helpers. Logs and error strings never carry phone numbers, tokens, or message bodies. */

export function redactPhone(phone: string | null | undefined): string {
  if (!phone) return "(none)";
  const digits = phone.replace(/\D/g, "");
  return digits.length >= 4 ? `***${digits.slice(-2)}` : "***";
}

const PATTERNS: Array<[RegExp, string]> = [
  [/\b(AC|SK|MG|SM|MM|CA|PN)[0-9a-fA-F]{32}\b/g, "$1…"],
  [/\b(sk-[A-Za-z0-9_-]{8,})\b/g, "[api-key]"],
  [/\bya29\.[A-Za-z0-9._-]+/g, "[google-token]"],
  [/\b1\/\/[A-Za-z0-9._-]{10,}/g, "[google-refresh-token]"],
  [/(authorization|bearer|token|secret|password|code)=([^&\s]+)/gi, "$1=[redacted]"],
  [/(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/g, "$1 [redacted]"],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]"],
  [/\+?\d[\d\s().-]{7,}\d/g, "[phone]"],
];

/** Removes likely secrets/PII from free text (errors, provider messages) before logging or storing. */
export function redactText(text: string, maxLength = 300): string {
  let out = text;
  for (const [re, replacement] of PATTERNS) out = out.replace(re, replacement);
  return out.length > maxLength ? `${out.slice(0, maxLength)}…` : out;
}

export function safeErrorMessage(err: unknown): string {
  if (err instanceof Error) return redactText(`${err.name}: ${err.message}`);
  return redactText(String(err));
}
