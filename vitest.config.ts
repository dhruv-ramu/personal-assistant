import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Tests run inside workerd (the Workers runtime) via the Cloudflare Vitest integration, with the
// real checked-in D1 migrations applied. External providers are always simulated or mocked here.
export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));
      return {
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          d1Databases: ["DB_RESTORE"],
          bindings: {
            TEST_MIGRATIONS: migrations,
            APP_ENV: "test",
            PUBLIC_BASE_URL: "https://della.test",
            OWNER_PHONE_E164: "+15550100001",
            ADMIN_BOOTSTRAP_SECRET: "test-admin-secret-0123456789abcdef",
            DATA_ENCRYPTION_KEY: "k1:dGVzdC1rZXktMDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY=",
            SIM_WEBHOOK_SECRET: "test-sim-secret",
            SIMULATOR_ENABLED: "true",
            DRY_RUN: "true",
            // The live-AI project only receives a key when explicitly opted in.
            ...(process.env.LIVE_AI_EVAL === "1" && process.env.OPENAI_API_KEY
              ? {
                  LIVE_AI_EVAL: "1",
                  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
                  OPENAI_MODEL: process.env.OPENAI_MODEL ?? "gpt-6-luna",
                  ...(process.env.MEMORY_EVAL === "1" ? { MEMORY_EVAL: "1" } : {}),
                }
              : {}),
          },
        },
      };
    }),
  ],
  test: {
    setupFiles: ["./tests/setup/apply-migrations.ts"],
    testTimeout: 30_000,
    projects: [
      { extends: true, test: { name: "unit", include: ["tests/unit/**/*.test.ts"] } },
      { extends: true, test: { name: "integration", include: ["tests/integration/**/*.test.ts"] } },
      { extends: true, test: { name: "acceptance", include: ["tests/acceptance/**/*.test.ts"] } },
      { extends: true, test: { name: "demo", include: ["tests/demo/**/*.test.ts"], testTimeout: 120_000 } },
      { extends: true, test: { name: "live-ai", include: ["tests/live/**/*.test.ts"], testTimeout: 120_000 } },
    ],
  },
});
