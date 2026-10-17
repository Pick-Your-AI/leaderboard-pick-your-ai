import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./browser",
  outputDir: "../../test-results/browser",
  timeout: 45_000,
  globalTimeout: 600_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: 2,
  reporter: [["list"], ["html", { outputFolder: "../../playwright-report", open: "never" }]],
  use: {
    baseURL: "http://127.0.0.1:4187",
    browserName: "chromium",
    actionTimeout: 10_000,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "npm exec --workspace @pick-your-ai/web -- vite preview --host 127.0.0.1 --port 4187 --strictPort",
    url: "http://127.0.0.1:4187",
    reuseExistingServer: false,
    cwd: "../..",
  },
});
