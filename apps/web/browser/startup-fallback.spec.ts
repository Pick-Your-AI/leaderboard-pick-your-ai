import { test, expect, type Page } from "@playwright/test";

const wallPath = "/live?ui=api&repository=synthetic-repository&snapshot=synthetic-snapshot";

async function expectStaticFallback(page: Page, requestedPath = wallPath) {
  const fallback = page.getByRole("main", { name: "Live data has not loaded" });
  await expect(fallback).toBeVisible({ timeout: 2000 });
  await expect(fallback).toContainText("Source freshness is unknown");
  await expect(fallback).toContainText("reload this same page");
  await expect(page.getByRole("table")).toHaveCount(0);
  expect(new URL(page.url()).pathname + new URL(page.url()).search).toBe(requestedPath);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

test("static startup remains readable without JavaScript and without its stylesheet", async ({
  browser,
  baseURL,
}, testInfo) => {
  if (!baseURL) throw new Error("Browser base URL is required");
  const context = await browser.newContext({
    baseURL,
    javaScriptEnabled: false,
    viewport: { width: 320, height: 640 },
  });
  try {
    const page = await context.newPage();
    let publicReads = 0;
    page.on("request", (request) => {
      if (new URL(request.url()).pathname.startsWith("/api/v1/")) publicReads++;
    });
    const response = await page.goto(wallPath);
    expect(response?.status()).toBe(200);
    expect(response?.headers()["content-security-policy"]).toContain("frame-ancestors 'none'");
    await expectStaticFallback(page);
    // Text locators skip noscript; inspect its rendered paragraph directly.
    const disabledScriptMessage = page.locator("noscript p");
    await expect(disabledScriptMessage).toBeVisible();
    await expect(disabledScriptMessage).toHaveText(
      "JavaScript is disabled. Enable it for this site, then reload this same page.",
    );
    await page.screenshot({ path: testInfo.outputPath("startup-no-javascript-320.png"), fullPage: true });

    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.emulateMedia({ colorScheme: "dark" });
    await expectStaticFallback(page);
    await page.screenshot({ path: testInfo.outputPath("startup-no-javascript-1920-dark.png"), fullPage: true });

    let blockedStylesheets = 0;
    await page.route("**/*", (route) => {
      if (route.request().resourceType() === "stylesheet") {
        blockedStylesheets++;
        return route.abort("failed");
      }
      return route.continue();
    });
    await page.setViewportSize({ width: 320, height: 640 });
    await page.reload();
    await expectStaticFallback(page);
    expect(blockedStylesheets).toBeGreaterThan(0);
    expect(publicReads).toBe(0);
  } finally {
    await context.close();
  }
});

test("a failed entry script keeps the static unknown state and original wall URL", async ({ page }, testInfo) => {
  let blockedScripts = 0;
  let publicReads = 0;
  await page.route("**/*", (route) => {
    const request = route.request();
    if (new URL(request.url()).pathname.startsWith("/api/v1/")) publicReads++;
    if (request.resourceType() === "script") {
      blockedScripts++;
      return route.abort("failed");
    }
    return route.continue();
  });
  await page.goto(wallPath);
  await expectStaticFallback(page);
  await expect(page.locator("noscript")).toBeHidden();
  expect(blockedScripts).toBeGreaterThan(0);
  expect(publicReads).toBe(0);
  await page.screenshot({ path: testInfo.outputPath("startup-entry-script-failed.png"), fullPage: true });
});

for (const { surface, requestedPath, modulePath } of [
  {
    surface: "leaderboard",
    requestedPath: "/leaderboards/pr_merged?ui=api&repository=synthetic-repository&snapshot=synthetic-snapshot",
    modulePath: /\/assets\/App-[^/]+\.js$/,
  },
  { surface: "live wall", requestedPath: wallPath, modulePath: /\/assets\/Wall-[^/]+\.js$/ },
]) {
  test(`a failed deferred ${surface} script preserves the static unknown state and requested URL`, async ({ page }) => {
    let blockedDeferredScripts = 0;
    let publicReads = 0;
    await page.route("**/*", (route) => {
      const request = route.request();
      const pathname = new URL(request.url()).pathname;
      if (pathname.startsWith("/api/v1/")) publicReads++;
      if (request.resourceType() === "script" && modulePath.test(pathname)) {
        blockedDeferredScripts++;
        return route.abort("failed");
      }
      return route.continue();
    });
    await page.goto(requestedPath);
    await expect.poll(() => blockedDeferredScripts).toBeGreaterThan(0);
    // The entry script ran and selected API mode before this later script failed.
    expect(await page.evaluate(() => localStorage.getItem("pyai.ui.mode"))).toBe("api");
    await expectStaticFallback(page, requestedPath);
    await expect(page.locator("noscript")).toBeHidden();
    expect(publicReads).toBe(0);
  });
}
