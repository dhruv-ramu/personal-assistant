import { describe, expect, it } from "vitest";
import { parseEncryptionKey } from "../../src/config";
import { FieldCrypto, googleEventIdFor } from "../../src/security/crypto";
import { redactPhone, redactText } from "../../src/security/redaction";
import { countSegments } from "../../src/services/segments";
import { FAKE_TWILIO_SID } from "../helpers/fixtures";

describe("SMS segment counting", () => {
  it("GSM-7 single and multipart", () => {
    expect(countSegments("a".repeat(160))).toEqual({ encoding: "GSM-7", segments: 1, units: 160 });
    expect(countSegments("a".repeat(161))).toMatchObject({ encoding: "GSM-7", segments: 2 });
    expect(countSegments("a".repeat(306))).toMatchObject({ segments: 2 });
    expect(countSegments("a".repeat(307))).toMatchObject({ segments: 3 });
  });

  it("GSM extended characters cost two septets and are not split", () => {
    expect(countSegments("{".repeat(80))).toEqual({ encoding: "GSM-7", segments: 1, units: 160 });
    expect(countSegments("{".repeat(81)).segments).toBe(2);
    // 152 basic + one extended char cannot fit in the first 153-septet part.
    const s = "a".repeat(152) + "€" + "a".repeat(10);
    expect(countSegments(s)).toMatchObject({ encoding: "GSM-7", segments: 2, units: 164 });
  });

  it("Unicode switches to UCS-2 with 70/67 limits and surrogate pairs", () => {
    expect(countSegments("é".repeat(70)).encoding).toBe("GSM-7"); // é is in the GSM basic table
    expect(countSegments("ą".repeat(70))).toEqual({ encoding: "UCS-2", segments: 1, units: 70 });
    expect(countSegments("ą".repeat(71)).segments).toBe(2);
    expect(countSegments("😀".repeat(35))).toEqual({ encoding: "UCS-2", segments: 1, units: 70 });
    expect(countSegments("😀".repeat(36)).segments).toBe(2);
  });
});

describe("field encryption", () => {
  const k1 = parseEncryptionKey("k1:dGVzdC1rZXktMDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY=", "k1")!;
  const k2 = parseEncryptionKey("k2:ZGVsbGEtZGV2LW9ubHktaW5zZWN1cmUta2V5LTMyYnk=", "k2")!;

  it("round-trips with unique nonces and detects tampering", async () => {
    const c = new FieldCrypto(k1);
    const a = await c.encrypt("finish the application", "task");
    const b = await c.encrypt("finish the application", "task");
    expect(a).not.toBe(b);
    expect(a.startsWith("v1.k1.")).toBe(true);
    expect(await c.decrypt(a, "task")).toBe("finish the application");
    const tampered = a.slice(0, -2) + (a.endsWith("A") ? "BB" : "AA");
    await expect(c.decrypt(tampered, "task")).rejects.toThrow();
    await expect(c.decrypt(a, "other-context")).rejects.toThrow();
  });

  it("supports key rotation: new key writes, previous key still reads", async () => {
    const old = new FieldCrypto(k1);
    const env = await old.encrypt("secret", "x");
    const rotated = new FieldCrypto(k2, [k1]);
    expect(await rotated.decrypt(env, "x")).toBe("secret");
    expect((await rotated.encrypt("new", "x")).startsWith("v1.k2.")).toBe(true);
    await expect(new FieldCrypto(k2).decrypt(env, "x")).rejects.toThrow(/Missing decryption key/);
  });

  it("derives deterministic Google-compatible event IDs (base32hex, 5-1024 chars)", async () => {
    const a = await googleEventIdFor("in:abc:0");
    expect(a).toBe(await googleEventIdFor("in:abc:0"));
    expect(a).not.toBe(await googleEventIdFor("in:abc:1"));
    expect(a).toMatch(/^[0-9a-v]{5,1024}$/);
  });
});

describe("redaction", () => {
  it("removes phone numbers, SIDs, tokens and emails", () => {
    const t = redactText(`call +1 415 555 0100 sid ${FAKE_TWILIO_SID} token=abc123 Bearer xyz.abc owner@example.com sk-live1234567890`);
    expect(t).not.toMatch(/415|0123456789abcdef0123|abc123|xyz\.abc|owner@|sk-live/);
    expect(redactPhone("+14155550100")).toBe("***00");
  });
});
