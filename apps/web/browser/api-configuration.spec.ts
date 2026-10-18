import { test, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build, preview, type PreviewServer } from "vite";

test("a built cross-origin API configuration fails before public fetch or live connections", async ({ page }) => {
  test.setTimeout(90_000);
  const root = fileURLToPath(new URL("../", import.meta.url));
  const outDir = await mkdtemp(join(tmpdir(), "leaderboard-api-configuration-"));
  let server: PreviewServer | undefined;
  try {
    // Compile the actual entry with a representative nondefault public setting.
    // This build and server belong to this test; the shared preview is untouched.
    const config = {
      root,
      configFile: join(root, "vite.config.ts"),
      logLevel: "silent" as const,
      build: { outDir, emptyOutDir: true },
    };
    await build({
      ...config,
      define: { "import.meta.env.VITE_PUBLIC_API_BASE": JSON.stringify("https://api.example.invalid/api/v1") },
    });
    server = await preview({ ...config, preview: { host: "127.0.0.1", port: 0, strictPort: false } });
    const base = server.resolvedUrls?.local[0];
    expect(base).toBeTruthy();
    await page.addInitScript(() => {
      const attempts: string[] = [];
      Reflect.set(window, "syntheticApiAttempts", attempts);
      const originalFetch = window.fetch.bind(window);
      window.fetch = (...args) => {
        attempts.push(`fetch:${String(args[0])}`);
        return originalFetch(...args);
      };
      const OriginalEventSource = window.EventSource;
      window.EventSource = class extends OriginalEventSource {
        constructor(url: string | URL, options?: EventSourceInit) {
          attempts.push(`stream:${String(url)}`);
          super(url, options);
        }
      };
    });
    // A regression cannot contact the synthetic external host during this test.
    await page.route("https://api.example.invalid/**", (route) => route.abort());
    const response = await page.goto(new URL("/leaderboards/pr_opened?ui=api", base!).href);
    expect(response?.headers()["content-security-policy"]).toContain("connect-src 'self'");
    await expect(page.getByRole("alert")).toContainText("invalid_public_api_configuration");
    await expect(page.getByRole("region", { name: "Current source freshness" })).toHaveCount(0);
    await expect(page.getByText("SYNTHETIC DATA", { exact: false })).toHaveCount(0);
    await page.getByRole("button", { name: "Recheck current publication controls" }).click();
    await expect(page.getByRole("alert")).toContainText("invalid_public_api_configuration");
    await expect(page.getByText("Rechecking…", { exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => Reflect.get(window, "syntheticApiAttempts"))).toEqual([]);
  } finally {
    await server?.close();
    await rm(outDir, { recursive: true, force: true });
  }
});
