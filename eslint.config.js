import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["node_modules/", "dist*/", ".wrangler/", "artifacts/", "playwright-report/", "test-results/", "worker-configuration.d.ts", "Jarvis_Cursor_Build_Prompt.md"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-non-null-assertion": "off",
      "no-control-regex": "off",
      eqeqeq: ["error", "always"],
    },
  },
  {
    // WebExtension sources run in browser extension contexts (background event page / service worker, popup).
    files: ["extension/src/**/*.js"],
    languageOptions: {
      globals: {
        browser: "readonly",
        chrome: "readonly",
        indexedDB: "readonly",
        btoa: "readonly",
        crypto: "readonly",
        TextEncoder: "readonly",
        fetch: "readonly",
        URL: "readonly",
        navigator: "readonly",
        document: "readonly",
      },
    },
  },
  {
    files: ["scripts/**/*.mjs", "*.config.{js,ts}"],
    languageOptions: { globals: { process: "readonly", console: "readonly", URL: "readonly", fetch: "readonly", Buffer: "readonly" } },
  },
);
