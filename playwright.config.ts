import { defineConfig, devices } from "@playwright/test";

// Browser tests for meaningful admin flows only, against a real local Worker (simulated providers).
export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: { baseURL: "http://localhost:8788", trace: "retain-on-failure" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 7"] } },
  ],
  webServer: {
    command: "node scripts/e2e-server.mjs",
    url: "http://localhost:8788/health",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
