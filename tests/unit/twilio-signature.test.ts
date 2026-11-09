import { describe, expect, it } from "vitest";
import { computeSignature, parseForm, signatureAlgorithm, validateSignature, type FormParams } from "../../src/providers/twilio/signature";
import { renderTwiml } from "../../src/providers/twilio/voice";

// Official vector from Twilio's webhook security docs / twilio-node test suite.
const TOKEN = "12345";
const URL_ = "https://mycompany.com/myapp.php?foo=1&bar=2";
const PARAMS: FormParams = new Map([
  ["CallSid", ["CA1234567890ABCDE"]],
  ["Caller", ["+14158675309"]],
  ["Digits", ["1234"]],
  ["From", ["+14158675309"]],
  ["To", ["+18005551212"]],
]);
const EXPECTED = "RSOYDt4T1cUTdK1PDd93/VVr8B8=";

describe("Twilio signature validation (Web Crypto port)", () => {
  it("matches the official test vector", async () => {
    expect(await computeSignature(TOKEN, URL_, PARAMS)).toBe(EXPECTED);
    expect(await validateSignature({ secret: TOKEN, signature: EXPECTED, url: URL_, params: PARAMS })).toBe(true);
  });

  it("accepts the URL with or without the default port, like the official library", async () => {
    expect(await validateSignature({ secret: TOKEN, signature: EXPECTED, url: "https://mycompany.com:443/myapp.php?foo=1&bar=2", params: PARAMS })).toBe(true);
  });

  it("rejects a wrong token, changed query string, extra field, or missing signature", async () => {
    expect(await validateSignature({ secret: "54321", signature: EXPECTED, url: URL_, params: PARAMS })).toBe(false);
    expect(await validateSignature({ secret: TOKEN, signature: EXPECTED, url: "https://mycompany.com/myapp.php?foo=1&bar=3", params: PARAMS })).toBe(false);
    const extra = new Map(PARAMS);
    extra.set("Body", ["hi"]);
    expect(await validateSignature({ secret: TOKEN, signature: EXPECTED, url: URL_, params: extra })).toBe(false);
    expect(await validateSignature({ secret: TOKEN, signature: null, url: URL_, params: PARAMS })).toBe(false);
  });

  it("handles repeated parameters (unique values sorted) and preserves original decoded values", async () => {
    const p = parseForm("B=2&A=x%2By&A=x%20z&A=x%2By");
    expect(p.get("A")).toEqual(["x+y", "x z", "x+y"]);
    const sig = await computeSignature(TOKEN, "https://h.test/w", p);
    const manual = await computeSignature(
      TOKEN,
      "https://h.test/w",
      new Map([
        ["A", ["x z", "x+y"]],
        ["B", ["2"]],
      ]),
    );
    expect(sig).toBe(manual);
  });

  it("selects the algorithm from the signature-settings header and fails closed on unknown ones", () => {
    expect(signatureAlgorithm(null)).toBe("SHA-1");
    expect(signatureAlgorithm("key=webhooks_sharedkey_x,algorithm=HMAC_SHA256")).toBe("SHA-256");
    expect(signatureAlgorithm("algorithm=HMAC_MD5")).toBeNull();
  });
});

describe("TwiML rendering", () => {
  it("escapes text and bounds the prompt (no redirects, finite input)", () => {
    const xml = renderTwiml({ kind: "prompt", text: `Hi <Dial>+1</Dial> & "x"`, repeatText: "again", gatherActionUrl: "https://della.test/g?e=a&b=c", inputTimeoutSec: 8 });
    expect(xml).not.toContain("<Dial>");
    expect(xml).toContain("&lt;Dial&gt;");
    expect(xml).toContain('action="https://della.test/g?e=a&amp;b=c"');
    expect(xml).not.toContain("<Redirect");
    expect(xml.match(/<Gather/g)).toHaveLength(2);
    expect(xml).toContain("<Hangup/>");
  });
});
