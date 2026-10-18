import { defineConfig } from "@playwright/test";
import browserConfig from "./playwright.config.ts";

const minutes = Number(process.env.WALL_SOAK_MINUTES ?? "480");
if (!Number.isFinite(minutes) || minutes < 2 || minutes > 1_440)
  throw new Error("WALL_SOAK_MINUTES must be between 2 and 1440 real minutes");
const baseURL = "http://127.0.0.1:4277";
const dateIn = (zone: string, time: number) => new Intl.DateTimeFormat("en-CA", { timeZone: zone }).format(time);
const now = Date.now();
// Choose a real timezone whose next midnight falls within six hours. No clock
// is changed: the long run must actually observe the date transition.
const timezoneId =
  process.env.WALL_SOAK_TIMEZONE ??
  [
    "Etc/UTC",
    "America/Los_Angeles",
    "America/New_York",
    "Pacific/Honolulu",
    "Asia/Tokyo",
    "Asia/Kolkata",
    "Europe/Paris",
  ].find((zone) => dateIn(zone, now) !== dateIn(zone, now + 6 * 3_600_000)) ??
  "Etc/UTC";

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
    command: "npm exec --workspace @pick-your-ai/web -- vite preview --host 127.0.0.1 --port 4277 --strictPort",
    url: baseURL,
    cwd: "../..",
    reuseExistingServer: false,
  },
});
