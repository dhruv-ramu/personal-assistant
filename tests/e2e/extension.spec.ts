import { chromium, expect, test, type Page } from "@playwright/test";

const SECRET = "e2e-admin-secret-0123456789abcdef";

async function signIn(page: Page) {
  await page.goto("/admin/login");
  await page.getByLabel("Admin secret").fill(SECRET);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
}

// Loads the built Chromium extension in a real Chromium and pairs it with the local Worker:
// real WebCrypto key generation, real CORS fetches, real signed polls. (Firefox can't load
// unpacked extensions under Playwright; its build is verified by manifest generation only.)
test("browser companion pairs with a one-time code and polls with signed envelopes", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "extension test runs once, in desktop Chromium");
  // Built by scripts/e2e-server.mjs before the server starts.
  const extPath = `${info.config.rootDir}/../../dist-extension/chrome`;

  await signIn(page);
  await page.goto("/admin/devices");
  await page.getByLabel("Device name").fill("E2E Chromium");
  await page.getByRole("button", { name: "Create pairing code" }).click();
  const code = (await page.locator("strong code").textContent())!.trim();
  expect(code).toMatch(/^[2-9A-HJ-NP-Z]{10}$/);

  const ctx = await chromium.launchPersistentContext("", { channel: "chromium", args: [`--disable-extensions-except=${extPath}`, `--load-extension=${extPath}`] });
  try {
    let [worker] = ctx.serviceWorkers();
    if (!worker) worker = await ctx.waitForEvent("serviceworker");
    const extId = new URL(worker.url()).host;
    const popup = await ctx.newPage();
    await popup.goto(`chrome-extension://${extId}/popup.html`);
    await popup.getByLabel("Server URL").fill("http://localhost:8788");
    await popup.getByLabel("Pairing code").fill(code);
    await popup.getByRole("button", { name: "Pair" }).click();
    await expect(popup.locator("#status")).toContainText("Paired with http://localhost:8788");
    await popup.getByRole("button", { name: "Refresh" }).click();
    await expect(popup.locator("#status")).toContainText("No active session.");
    await expect(popup.locator("#error")).toHaveText("");
  } finally {
    await ctx.close();
  }

  await page.goto("/admin/devices");
  const row = page.getByRole("row", { name: /E2E Chromium/ });
  await expect(row).toContainText("chromium");
  await expect(row).toContainText('"idle":true');
  await row.getByRole("button", { name: "Revoke" }).click({ noWaitAfter: true });
});

test("extension dashboard views render for a signed-in owner", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "one pass is enough");
  await signIn(page);
  for (const [path, heading] of [
    ["/admin/knowledge", "Knowledge"],
    ["/admin/items", "Items and locations"],
    ["/admin/memory", "Memory inbox"],
    ["/admin/secretary", "Secretary"],
    ["/admin/accountability", "Accountability"],
    ["/admin/privacy", "Privacy and retention"],
  ] as const) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
  }
});
