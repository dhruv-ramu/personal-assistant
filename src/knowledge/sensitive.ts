/**
 * Sensitive-content guard applied before durable memory retention. Matches are excluded from
 * memory (unless the owner enabled sensitive memory) and redacted in retained excerpts.
 * Heuristic, not exhaustive: it catches common credentials and identifiers, not every secret.
 */
const PATTERNS: Array<{ kind: string; re: RegExp }> = [
  { kind: "password", re: /\b(password|passcode|passphrase|pin|pwd)\b\s*(is|:|=)?\s*\S+/gi },
  { kind: "ssn", re: /\b\d{3}-\d{2}-\d{4}\b/g },
  { kind: "api_key", re: /\b(sk-[A-Za-z0-9_-]{8,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,})\b/g },
  { kind: "card", re: /\b(?:\d[ -]?){13,19}\b/g },
  { kind: "bank", re: /\b(routing|account)\s*(number|no\.?|#)\s*(is|:)?\s*\d{6,}\b/gi },
];

function luhn(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = Number(digits[i]);
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

export function detectSensitive(text: string): string[] {
  const kinds = new Set<string>();
  for (const { kind, re } of PATTERNS) {
    for (const m of text.matchAll(re)) {
      if (kind === "card") {
        const d = m[0].replace(/\D/g, "");
        if (d.length < 13 || !luhn(d)) continue;
      }
      kinds.add(kind);
    }
  }
  return [...kinds];
}

export function redactSensitive(text: string): string {
  let out = text;
  for (const { kind, re } of PATTERNS) {
    out = out.replace(re, (m) => {
      if (kind === "card") {
        const d = m.replace(/\D/g, "");
        if (d.length < 13 || !luhn(d)) return m;
      }
      return `[redacted ${kind}]`;
    });
  }
  return out;
}

const OFF_RECORD = /^\s*(don'?t (store|save|remember) (this|that)|off[- ]the[- ]record|off[- ]record|do not (store|save|remember) (this|that))\b[\s:,.\-–—]*/i;

/** "Don't store this: …" → strip the marker; caller must not retain the content as memory. */
export function offRecord(text: string): { offRecord: boolean; rest: string } {
  const m = OFF_RECORD.exec(text);
  return m ? { offRecord: true, rest: text.slice(m[0].length).trim() } : { offRecord: false, rest: text };
}
