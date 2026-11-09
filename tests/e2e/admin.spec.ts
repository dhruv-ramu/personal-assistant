import { expect, test, type Page } from "@playwright/test";

const SECRET = "e2e-admin-secret-0123456789abcdef";

async function signIn(page: Page) {
  await page.goto("/admin/login");
  await page.getByLabel("Admin secret").fill(SECRET);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
}

test.describe.configure({ mode: "serial" });

test("rejects a wrong secret, then signs in and shows simulated modes", async ({ page }) => {
  await page.goto("/admin");
  await expect(page).toHaveURL(/\/admin\/login$/);
  await page.getByLabel("Admin secret").fill("not-the-secret");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("status")).toHaveText("Sign-in failed.");
  await signIn(page);
  await expect(page.getByText("SMS: simulated")).toBeVisible();
  await expect(page.getByText("DRY RUN: on")).toBeVisible();
});

test("simulator: create a reminder, advance the clock, see it fire, complete it from Tasks", async ({ page }, info) => {
  // Projects share one local database: give each its own day and task so state doesn't collide.
  const mobile = info.project.name === "mobile";
  const [dayWord, dayLabel] = mobile ? ["Wednesday", "Wed Nov 11"] : ["Tuesday", "Tue Nov 10"];
  const chore = mobile ? "stretch legs" : "stretch";
  const [start, startLabel, dueLabel] = mobile ? ["2026-11-08T12:00", "12 PM", "12:10 PM"] : ["2026-11-08T10:00", "10 AM", "10:10 AM"];
  const Chore = chore[0]!.toUpperCase() + chore.slice(1);
  await signIn(page);
  await page.goto("/admin/calendar");
  const connect = page.getByRole("button", { name: "Connect simulated calendar" });
  if (await connect.isVisible()) await connect.click();

  await page.goto("/admin/simulator");
  await expect(page.getByText("Simulated.", { exact: false }).first()).toBeVisible();
  await page.getByLabel("Set (local America/Los_Angeles)").fill(start);
  await page.getByRole("button", { name: "Set", exact: true }).click();
  await expect(page.getByText(`Frozen at Sun Nov 8, ${startLabel} PT`)).toBeVisible();

  await page.getByLabel("Text Della as the owner").fill(`Add badminton ${dayWord} from 7 PM to 9 PM.`);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.locator(".msg.to_owner").last()).toContainText(`Added Badminton: ${dayLabel}, 7-9 PM PT.`);

  await page.getByLabel("Text Della as the owner").fill(`Remind me in 10 minutes to ${chore}`);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.locator(".msg.to_owner").last()).toContainText(`Reminder set: ${Chore}, Sun Nov 8, ${dueLabel} PT.`);

  await page.getByRole("button", { name: "+10m" }).click();
  await expect(page.locator(".msg.to_owner").last()).toContainText(`Reminder: ${Chore}. Reply DONE when finished.`);

  await page.goto("/admin/tasks");
  const row = page.getByRole("row", { name: new RegExp(`${Chore}\\b`) }).first();
  await row.getByRole("button", { name: "Done" }).click();
  await expect(page.getByRole("status")).toHaveText("Done.");
  await page.goto("/admin/tasks?filter=completed");
  await expect(page.getByRole("row", { name: new RegExp(Chore) }).first()).toContainText("completed");
});

test("activity shows provider acceptance separately from delivery", async ({ page }) => {
  await signIn(page);
  await page.goto("/admin/activity");
  await expect(page.getByText('"accepted" means the provider took the request', { exact: false })).toBeVisible();
  await expect(page.getByRole("cell", { name: "accepted" }).first()).toBeVisible();
});
