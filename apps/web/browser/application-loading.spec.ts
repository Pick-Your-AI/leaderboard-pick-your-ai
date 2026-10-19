import { test, expect } from "@playwright/test";
import { evidenceService } from "./evidenceHarness.ts";

test.use({ storageState: { cookies: [], origins: [] } });

for (const [name, path] of [
  ["public board", "/leaderboards/pr_merged?ui=api&repository=repo-1&snapshot=api-1"],
  ["public wall", "/live?ui=api&mode=frozen&boards=pr_merged&repository=repo-1&snapshot=api-1"],
] as const) {
  for (const outcome of ["loaded", "failed"] as const) {
    test(`${name} keeps its static fallback until the selected application is ${outcome}`, async ({ page }) => {
      await page.addInitScript(() =>
        Object.defineProperty(window, "EventSource", { value: undefined, configurable: true }),
      );
      const api = await evidenceService(page);
      const document = await page.request.get(path);
      expect(document.ok()).toBe(true);
      // Let the document's entry and static module preloads run. Hold only the
      // later application dependencies, independently of generated chunk names.
      const eagerScripts = new Set(
        [...(await document.text()).matchAll(/(?:src|href)="([^"]+\.js)"/g)].map(
          ([, src]) => new URL(src!, document.url()).href,
        ),
      );
      expect(eagerScripts.size).toBeGreaterThan(0);
      let release!: () => void;
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      const deferredScripts = new Set<string>();
      const failedScripts = new Set<string>();
      page.on("requestfailed", (request) => {
        if (deferredScripts.has(request.url())) failedScripts.add(request.url());
      });
      await page.route("**/assets/*.js", async (route) => {
        if (eagerScripts.has(route.request().url())) return route.continue();
        deferredScripts.add(route.request().url());
        await pending;
        return outcome === "failed" ? route.abort("failed") : route.continue();
      });
      try {
        await page.goto(path, { waitUntil: "domcontentloaded" });
        await expect.poll(() => deferredScripts.size).toBeGreaterThan(0);
        expect(await page.evaluate(() => localStorage.getItem("pyai.ui.mode"))).toBe("api");
        const fallback = page.getByRole("main", { name: "Live data has not loaded" });
        await expect(fallback).toBeVisible();
        await expect(fallback).toContainText("Source freshness is unknown");
        await expect(page.getByRole("table")).toHaveCount(0);
        expect(api.calls).toEqual([]);
        expect(new URL(page.url()).pathname + new URL(page.url()).search).toBe(path);
        release();
        if (outcome === "failed") {
          await expect.poll(() => failedScripts.size).toBeGreaterThan(0);
          await expect(fallback).toBeVisible();
          await expect(fallback).toContainText("reload this same page");
          expect(api.calls).toEqual([]);
          await page.unroute("**/assets/*.js");
          await page.reload();
        }
        await expect(page.getByRole("link", { name: "Synthetic API A", exact: true })).toBeVisible();
        await expect(fallback).toHaveCount(0);
        await expect(page.getByRole("region", { name: "Snapshot provenance" })).toContainText("api-1");
        expect(Object.fromEntries(new URL(page.url()).searchParams)).toMatchObject({
          ui: "api",
          repository: "repo-1",
          snapshot: "api-1",
        });
        await expect(page.getByRole("complementary", { name: "Synthetic data notice" })).toHaveCount(0);
      } finally {
        release();
        await api.close();
      }
    });
  }
}
