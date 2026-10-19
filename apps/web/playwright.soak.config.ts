import { defineConfig } from "@playwright/test";
import browserConfig from "./playwright.config.ts";
import { selectSoakTimezone } from "./soak/midnight.ts";
import { soakEndpoint } from "./soak/endpoint.ts";

const minutes = Number(process.env.WALL_SOAK_MINUTES ?? "480");
if (!Number.isFinite(minutes) || minutes < 2 || minutes > 1_440)
  throw new Error("WALL_SOAK_MINUTES must be between 2 and 1440 real minutes");
const { port, baseURL } = soakEndpoint();
// Leave startup time before midnight and a full hour before the scheduled
// six-hour timezone change. A late start is checked again inside the real test.
const timezoneId = selectSoakTimezone(Date.now(), minutes >= 480, process.env.WALL_SOAK_TIMEZONE);

export default defineConfig({
  ...browserConfig,
  testDir: "./soak",
  testMatch: "**/*.soak.ts",
  outputDir: "../../test-results/wall-soak",
  timeout: minutes * 60_000 + 180_000,
  globalTimeout: minutes * 60_000 + 240_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    ...browserConfig.use,
    baseURL,
    timezoneId,
    viewport: { width: 1920, height: 1080 },
    reducedMotion: "no-preference",
    headless: process.env.WALL_SOAK_HEADFUL !== "1",
    launchOptions: process.env.WALL_SOAK_BROWSER_PATH ? { executablePath: process.env.WALL_SOAK_BROWSER_PATH } : {},
    trace: "off",
    video: "off",
    screenshot: "only-on-failure",
    storageState: { cookies: [], origins: [] },
  },
  webServer: {
    command: `npm run preview --workspace @pick-your-ai/web -- --host 127.0.0.1 --port ${port} --strictPort`,
    url: baseURL,
    cwd: "../..",
    reuseExistingServer: false,
  },
});
