import { describe, expect, it } from "vitest";
import { TERMINAL, transition, type SessionEvent, type SessionState } from "../../src/accountability/machine";
import { interpretationJsonSchema } from "../../src/domain/actions";
import { hasMetadata, sniff, validateImage } from "../../src/media/images";
import { validateCandidate } from "../../src/knowledge/ingest";
import { detectSensitive, offRecord, redactSensitive } from "../../src/knowledge/sensitive";
import { ruleExtAction, ruleKnowledge } from "../../src/providers/simulated/knowledge-rules";
import { parseExtCommand } from "../../src/services/ext-commands";
import { heicBytes, jpegWithExif, pngWithText } from "../helpers/ext";

describe("accountability state machine", () => {
  it("allows only the documented transitions", () => {
    expect(transition("scheduled", "arm")).toBe("awaiting_start");
    expect(transition("awaiting_start", "start")).toBe("active");
    expect(transition("active", "request")).toBe("awaiting_checkpoint");
    expect(transition("awaiting_checkpoint", "resolve")).toBe("active");
    expect(transition("active", "pause")).toBe("paused");
    expect(transition("paused", "resume")).toBe("active");
    expect(transition("active", "finish")).toBe("completed");
    expect(transition("active", "attention")).toBe("needs_attention");
    expect(transition("paused", "request")).toBeNull();
    expect(transition("scheduled", "finish")).toBeNull();
  });
  it("terminal states accept nothing except cancel from needs_attention", () => {
    const events: SessionEvent[] = ["arm", "start", "request", "resolve", "pause", "resume", "finish", "expire", "attention"];
    for (const s of TERMINAL) for (const e of events) expect(transition(s as SessionState, e)).toBeNull();
    expect(transition("needs_attention", "cancel")).toBe("canceled");
    expect(transition("completed", "cancel")).toBeNull();
  });
});

describe("image validation and metadata stripping", () => {
  it("identifies types by magic bytes, not names", () => {
    expect(sniff(jpegWithExif())).toBe("jpeg");
    expect(sniff(pngWithText())).toBe("png");
    expect(sniff(heicBytes())).toBe("heic");
    expect(sniff(new TextEncoder().encode("<svg></svg>"))).toBeNull();
  });
  it("strips EXIF/COM from JPEG and text chunks from PNG, keeps dimensions", () => {
    const j = validateImage(jpegWithExif(800, 600), 1_000_000);
    expect(j.ok && j.width === 800 && j.height === 600 && j.stripped).toBe(true);
    expect(j.ok && hasMetadata(j.bytes)).toBe(false);
    expect(hasMetadata(jpegWithExif())).toBe(true);
    const p = validateImage(pngWithText(), 1_000_000);
    expect(p.ok && !new TextDecoder("latin1").decode(p.bytes).includes("tEXt")).toBe(true);
  });
  it("rejects HEIC with an instruction, oversize, bad dimensions, and markup", () => {
    expect(validateImage(heicBytes(), 1_000_000)).toMatchObject({ ok: false, reason: "heic" });
    expect(validateImage(jpegWithExif(), 10)).toMatchObject({ ok: false, reason: "too_large" });
    expect(validateImage(jpegWithExif(13000, 10), 1_000_000)).toMatchObject({ ok: false, reason: "bad_dimensions" });
    const poly = new Uint8Array([...jpegWithExif().slice(0, 4), ...new TextEncoder().encode("<html>"), ...jpegWithExif().slice(4)]);
    expect(validateImage(poly, 1_000_000)).toMatchObject({ ok: false });
  });
});

describe("sensitive data and off-record detection", () => {
  it("detects passwords, SSNs, keys, and Luhn-valid cards only", () => {
    expect(detectSensitive("my password is hunter22")).toContain("password");
    expect(detectSensitive("ssn 123-45-6789")).toContain("ssn");
    expect(detectSensitive("card 4111 1111 1111 1111")).toContain("card");
    expect(detectSensitive("order 4111 1111 1111 1112")).not.toContain("card");
    expect(redactSensitive("my password is hunter22")).not.toContain("hunter22");
  });
  it("recognizes off-record phrasing and keeps the operational remainder", () => {
    expect(offRecord("Don't store this: remind me at 5 to call Bo")).toEqual({ offRecord: true, rest: "remind me at 5 to call Bo" });
    expect(offRecord("off the record").offRecord).toBe(true);
    expect(offRecord("store this in the drawer").offRecord).toBe(false);
  });
});

describe("knowledge candidate validation", () => {
  it("requires a verbatim span, names in the message, and numbers in the message", () => {
    const src = "I promised Alex I'd send the slides by Friday.";
    expect(validateCandidate({ kind: "promise", person: "Alex", deliverable: "send the slides", due: null, evidence_span: "I promised Alex I'd send the slides" }, src)).toBeNull();
    expect(validateCandidate({ kind: "promise", person: "Jordan", deliverable: "send the slides", due: null, evidence_span: "I promised Alex I'd send the slides" }, src)).toMatch(
      /does not appear/,
    );
    expect(validateCandidate({ kind: "promise", person: "Alex", deliverable: "x", due: null, evidence_span: "I promised Alex a car" }, src)).toMatch(/span not found/);
    expect(
      validateCandidate(
        {
          kind: "accomplishment",
          description: "cut costs",
          role: null,
          metric_value: 30,
          metric_unit: "%",
          baseline: null,
          team_result: false,
          confidential: false,
          evidence_span: "cut costs",
        },
        "I cut costs a lot",
      ),
    ).toMatch(/number 30/);
  });
  it("the strict JSON schema includes the knowledge array", () => {
    const s = interpretationJsonSchema() as { properties: Record<string, unknown>; required: string[] };
    expect(s.properties.knowledge).toBeTruthy();
    expect(s.required).toContain("knowledge");
  });
});

describe("rule-based extraction (simulator only; not model quality)", () => {
  it("extracts container paths innermost-first and keeps uncertainty", () => {
    const [c] = ruleKnowledge("I put my passport in the blue folder in the bottom drawer of my desk.", 2026);
    expect(c).toMatchObject({ kind: "item_location", item: "passport", container_path: ["blue folder", "bottom drawer", "desk"], modality: "actual" });
    expect(ruleKnowledge("Maybe the keys are in the bag.", 2026)[0]).toMatchObject({ modality: "possible", item: "keys" });
  });
  it("does not turn 'maybe I'll' into a commitment", () => {
    expect(ruleKnowledge("Maybe I'll join the hiking club.", 2026)).toEqual([]);
  });
  it("parses explicit accountability and routine requests", () => {
    expect(ruleExtAction("check on me once during the next hour", 2026)).toMatchObject({ type: "accountability_start", within_minutes: 60 });
    expect(ruleExtAction("morning routine at 7 AM weekdays, gym first, laptop check-in", 2026)).toMatchObject({
      type: "morning_routine",
      first_activity: "gym",
      device_check: true,
    });
  });
});

describe("deterministic extension commands", () => {
  const p = (t: string, active = false) => parseExtCommand(t, { accountabilityActive: active });
  it("routes memory questions and controls without AI", () => {
    expect(p("where are my keys")).toEqual({ type: "memory_query", query_kind: "item_location", subject: "keys" });
    expect(p("what did i promise alex")).toEqual({ type: "memory_query", query_kind: "promises", subject: "alex" });
    expect(p("what have you learned about me")).toMatchObject({ query_kind: "learned_about_me" });
    expect(p("why")).toMatchObject({ query_kind: "why" });
    expect(p("don't store this")).toEqual({ type: "memory_forget", scope: "last_message", target: null });
    expect(p("stop this accountability session")).toEqual({ type: "accountability_control", op: "cancel", minutes: null });
    expect(p("resume the thesis project")).toEqual({ type: "resume_project", project: "thesis" });
    expect(p("dismiss 2")).toEqual({ type: "suggestion_response", op: "dismiss", number: 2 });
  });
  it("leaves calendar questions and core commands alone", () => {
    expect(p("what's on my calendar tomorrow")).toBeNull();
    expect(p("resume reminders")).toBeNull();
    expect(p("pause 10")).toBeNull();
    expect(p("pause 10", true)).toEqual({ type: "accountability_control", op: "pause", minutes: 10 });
  });
});
