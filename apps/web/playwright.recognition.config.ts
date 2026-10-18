import { defineConfig } from "@playwright/test";
import shared from "./playwright.config";
export default defineConfig(shared, {
  testMatch: "recognition.spec.ts",
  outputDir: "../../test-results/recognition",
  use: { baseURL: "http://127.0.0.1:4193" },
  webServer: {
    command: "npm exec --workspace @pick-your-ai/web -- vite preview --host 127.0.0.1 --port 4193 --strictPort",
    url: "http://127.0.0.1:4193",
    reuseExistingServer: false,
    cwd: "../..",
  },
});
