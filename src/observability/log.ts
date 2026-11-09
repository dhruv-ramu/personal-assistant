import { redactText } from "../security/redaction";

type Level = "debug" | "info" | "warn" | "error";

export interface LogFields {
  [key: string]: string | number | boolean | null | undefined;
}

let sink: ((line: string) => void) | null = null;

/** Tests can capture structured log lines to assert redaction. */
export function setLogSink(fn: ((line: string) => void) | null): void {
  sink = fn;
}

/**
 * Structured JSON logging. Values are passed through redaction; callers must still avoid
 * passing message bodies, tokens, or full phone numbers (use IDs and redactPhone()).
 */
export function log(level: Level, event: string, fields: LogFields = {}): void {
  const clean: Record<string, string | number | boolean | null> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    clean[k] = typeof v === "string" ? redactText(v, 500) : v;
  }
  const line = JSON.stringify({ level, event, ...clean });
  if (sink) sink(line);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else if (level === "info") console.log(line);
}
