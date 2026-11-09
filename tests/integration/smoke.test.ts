import { describe, expect, it } from "vitest";
import { makeHarness } from "../helpers/harness";

describe("smoke", () => {
  it("creates a reminder over SMS and confirms with the local date", async () => {
    const h = await makeHarness();
    const r = await h.send("Remind me tomorrow at 5 PM to finish the application, and ask at 8 PM if I have done it.");
    expect(r.status).toBe(200);
    const reply = await h.lastReply();
    expect(reply).toMatch(/^Reminder set: Finish the application, Mon Nov 9, 5 PM PT\. I'll check at 8 PM if it's still open\. \[T[2-9A-Z]{3}\]$/);
  });
});
