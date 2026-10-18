import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const routes = [
  "/",
  "/leaderboards",
  "/leaderboards/pr_merged",
  "/leaderboards/prs_reviewed",
  "/leaderboards/pr_lines_changed",
  "/contributors",
  "/contributors/synthetic-aster",
  "/contributions/syn-c-001",
  "/activity",
  "/projects/syn-proj-web",
  "/methodology",
  "/methodology/pr_merged",
  "/methodology/changes",
  "/coverage",
  "/corrections",
  "/live",
  "/live?ui=prototype&mode=cycle&boards=not-a-metric",
  "/live?ui=prototype&mode=bogus",
  "/live?ui=prototype&mode=frozen&boards=pr_merged&snapshot=syn-r99",
  "/live?ui=prototype&mode=frozen&boards=pr_merged&snapshot=syn-r45-failed",
  "/prototype",
  "/leaderboards/issues_opened?repo=syn-repo-research",
  "/contributors?q=nobody",
  "/leaderboards/pr_merged?repo=syn-repo-website",
  "/leaderboards/project_status_updates",
  "/leaderboards/decision_records?proof=synthetic-fern",
  "/leaderboards/pr_merged?snapshot=syn-r40-stale",
  "/leaderboards/pr_merged?snapshot=syn-r44-rebuilding",
  "/leaderboards/pr_merged?snapshot=syn-r45-failed",
  "/contributors/synthetic-hazel",
  "/contributors/synthetic-iris",
  "/contributions/syn-c-032",
  "/contributions/syn-c-024",
  "/leaderboards/pr_merged?period=fortnight&repo=nope&snapshot=syn-r99",
  "/not-found",
];

async function ready(page: Page, route: string) {
  await page.goto(route);
  await expect(page.locator("h1")).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: /Loading/ })).toHaveCount(0);
  await expect(page.locator(".loading")).toHaveCount(0);
  // Async fixture reads deliberately wait 120ms; wait for their rendered result.
  await page.waitForTimeout(180);
}

async function expectNoHorizontalOverflow(page: Page, context: string, collectFailure = false) {
  const layout = await page.evaluate(() => ({
    viewport: innerWidth,
    pageWidth: document.documentElement.scrollWidth,
    outsideViewport: Array.from(document.querySelectorAll("body *"))
      .filter((element) => element.getClientRects().length && element.getBoundingClientRect().right > innerWidth + 1)
      .slice(0, 12)
      .map((element) => ({
        element: `${element.tagName.toLowerCase()}.${element.className}`,
        right: element.getBoundingClientRect().right,
      })),
  }));
  const message = `${context}: ${JSON.stringify(layout)}`;
  const assertion = collectFailure ? expect.soft(layout.pageWidth, message) : expect(layout.pageWidth, message);
  assertion.toBeLessThanOrEqual(layout.viewport + 1);
}

for (const width of [320, 360, 768, 1024, 1280]) {
  for (const colorScheme of ["light", "dark"] as const) {
    test(`${width}px ${colorScheme}: public routes, states, reflow and axe`, async ({ page }, info) => {
      test.setTimeout(180_000);
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme });
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      for (const route of routes) {
        await test.step(route, async () => {
          await ready(page, route);
          await expect(page.getByRole("complementary", { name: "Synthetic data notice" })).toBeVisible();
          // Collect every route failure; soft assertions still fail the complete test.
          await expectNoHorizontalOverflow(page, route, true);
          const results = await new AxeBuilder({ page })
            .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"])
            .analyze();
          expect
            .soft(
              results.violations,
              `${route}: ${JSON.stringify(results.violations.map((v) => ({ id: v.id, targets: v.nodes.map((n) => n.target) })))}`,
            )
            .toEqual([]);
        });
      }
      expect(errors).toEqual([]);
      await page.goto("/leaderboards/pr_merged?snapshot=syn-r42");
      await page.waitForTimeout(200);
      await info.attach("responsive-observation", {
        body: await page.screenshot({ fullPage: true }),
        contentType: "image/png",
      });
    });
  }
}

test("320px scope labels contain the longest selected snapshot without clipping the page", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 900 });
  for (const media of [
    { colorScheme: "light", forcedColors: "none" },
    { colorScheme: "dark", forcedColors: "none" },
    { colorScheme: "light", forcedColors: "active" },
  ] as const) {
    await page.emulateMedia(media);
    await ready(page, "/?snapshot=syn-r44-rebuilding");
    const snapshot = page.getByRole("combobox", { name: "Snapshot", exact: true });
    await expect(snapshot).toHaveValue("syn-r44-rebuilding");
    const bounds = await snapshot.evaluate((element) => {
      const control = element.getBoundingClientRect();
      const region = element.closest(".scope-controls")!.getBoundingClientRect();
      return {
        left: control.left,
        right: control.right,
        height: control.height,
        regionLeft: region.left,
        regionRight: region.right,
      };
    });
    expect(bounds.left).toBeGreaterThanOrEqual(bounds.regionLeft);
    expect(bounds.right).toBeLessThanOrEqual(bounds.regionRight + 1);
    expect(bounds.height).toBeGreaterThanOrEqual(44);
    await expectNoHorizontalOverflow(page, JSON.stringify(media));
  }
});

test("320px wall configuration keeps every control within its grid track", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 900 });
  for (const media of [
    { colorScheme: "light", forcedColors: "none" },
    { colorScheme: "dark", forcedColors: "none" },
    { colorScheme: "light", forcedColors: "active" },
  ] as const) {
    await page.emulateMedia(media);
    await ready(page, "/live");
    const format = page.getByRole("combobox", { name: "Format", exact: true });
    await expect(format).toHaveValue("landscape");
    const bounds = await page.locator(".wall-config").evaluate((form) => {
      const region = form.getBoundingClientRect();
      return Array.from(form.querySelectorAll("fieldset, label, input, select")).map((element) => {
        const control = element.getBoundingClientRect();
        return {
          tag: element.tagName,
          left: control.left,
          right: control.right,
          regionLeft: region.left,
          regionRight: region.right,
        };
      });
    });
    for (const control of bounds) {
      expect(control.left, JSON.stringify(control)).toBeGreaterThanOrEqual(control.regionLeft);
      expect(control.right, JSON.stringify(control)).toBeLessThanOrEqual(control.regionRight + 1);
    }
    await format.selectOption("portrait");
    await expect(format).toHaveValue("portrait");
    await expectNoHorizontalOverflow(page, `wall configuration ${JSON.stringify(media)}`);
  }
});

test("forced colors, reduced motion, unavailable fonts and wall resolutions", async ({ page }, info) => {
  test.setTimeout(120_000);
  for (const media of [
    { forcedColors: "active", reducedMotion: "no-preference" },
    { forcedColors: "none", reducedMotion: "reduce" },
  ] as const) {
    await page.emulateMedia(media);
    await page.setViewportSize({ width: 320, height: 900 });
    await page.route(/\.(woff2?|ttf|otf)(\?|$)/, (route) => route.abort());
    for (const route of ["/leaderboards/pr_merged", "/coverage", "/contributions/syn-c-032"]) {
      await ready(page, route);
      expect(await page.evaluate(() => matchMedia("(forced-colors: active)").matches)).toBe(
        media.forcedColors === "active",
      );
      expect(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(
        media.reducedMotion === "reduce",
      );
      await expectNoHorizontalOverflow(page, `${route}: ${JSON.stringify(media)}`);
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    }
    await info.attach(JSON.stringify(media), {
      body: await page.screenshot({ fullPage: true }),
      contentType: "image/png",
    });
  }
  await page.emulateMedia({ forcedColors: "none", reducedMotion: "no-preference" });
  for (const [width, height] of [
    [1920, 1080],
    [1080, 1920],
    [1024, 768],
  ] as const) {
    await page.setViewportSize({ width, height });
    await ready(page, "/live?mode=cycle&boards=pr_merged,prs_reviewed,labels_applied");
    await expectNoHorizontalOverflow(page, `wall ${width}x${height}`);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    const pause = page.getByRole("button", { name: "Pause", exact: true });
    await pause.click();
    await expect(page.getByRole("button", { name: "Play", exact: true })).toBeVisible();
    await info.attach(`wall-${width}x${height}`, { body: await page.screenshot(), contentType: "image/png" });
  }
});

test("keyboard drawer opens, traps narrow-screen focus, closes and restores focus", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await ready(page, "/leaderboards/pr_merged?snapshot=syn-r42");
  const proof = page.locator(".proof-link").first();
  await proof.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.locator("#drawer-title")).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(page.getByRole("dialog").getByRole("link", { name: "Open as a full page" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.locator("#drawer-title")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(proof).toBeFocused();
});

test("follow waits independently for pointer, keyboard focus and open proof", async ({ page }) => {
  await page.clock.install();
  await ready(page, "/leaderboards/prs_reviewed");
  await page.clock.runFor(200);
  const follow = page.getByRole("checkbox", { name: /Follow updates/ });
  await follow.check();
  const proof = page.locator(".proof-link").first();
  await proof.focus();
  await proof.hover();
  await page.clock.runFor(20_000);
  await expect(page.getByRole("button", { name: "Apply updates" })).toBeVisible();
  await page.mouse.move(0, 0);
  await expect(page.getByRole("button", { name: "Apply updates" })).toBeVisible();
  await proof.hover();
  await page.locator("h1").evaluate((element) => {
    element.setAttribute("tabindex", "-1");
    (element as HTMLElement).focus({ preventScroll: true });
  });
  await expect(page.getByRole("button", { name: "Apply updates" })).toBeVisible();
  await proof.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.mouse.move(0, 0);
  await page.keyboard.press("Escape");
  await expect(proof).toBeFocused();
  await expect(page.getByRole("button", { name: "Apply updates" })).toBeVisible();
  await page.locator("h1").evaluate((element) => (element as HTMLElement).focus({ preventScroll: true }));
  await page.clock.runFor(200);
  await expect(page.getByRole("button", { name: "Apply updates" })).toHaveCount(0);
  await expect(page.getByRole("status")).toContainText("Updated to snapshot syn-r43");
});

test("cold production read records resource, timing, memory and DOM observations", async ({ page }, info) => {
  await page.goto("/leaderboards/pr_merged?snapshot=syn-r42");
  await expect(page.locator(".proof-link").first()).toBeVisible();
  const observations = await page.evaluate(() => {
    const resources = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
    const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming;
    return {
      resources: resources.map((r) => ({
        name: new URL(r.name).pathname,
        bytes: r.decodedBodySize,
        durationMs: r.duration,
      })),
      totalDecodedBytes: resources.reduce((n, r) => n + r.decodedBodySize, 0),
      domNodes: document.querySelectorAll("*").length,
      domContentLoadedMs: navigation.domContentLoadedEventEnd,
      heapBytes: (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? null,
    };
  });
  await info.attach("performance-observations.json", {
    body: JSON.stringify(observations, null, 2),
    contentType: "application/json",
  });
  // Candidate regression ceilings for this fixture, not accepted production SLOs.
  expect(observations.totalDecodedBytes).toBeLessThan(800_000);
  expect(observations.domNodes).toBeLessThan(5000);
  expect(observations.domContentLoadedMs).toBeLessThan(15_000);
});

test("scoped keyboard navigation preserves the snapshot and privacy states keep meaning", async ({ page }) => {
  await ready(page, "/leaderboards/pr_merged?period=90d&repo=syn-repo-leaderboard&actor=all&snapshot=syn-r41");
  const contributor = page.getByRole("link", { name: /Aster \(synthetic\)/ }).first();
  await contributor.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/contributors\/synthetic-aster\?/);
  await expect(page.locator("h1")).toBeFocused();
  await expect(page.locator(".receipt-list a").first()).toBeVisible();
  const receipt = page.locator(".receipt-list a").first();
  await receipt.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/contributions\//);
  for (const [name, value] of [
    ["period", "90d"],
    ["repo", "syn-repo-leaderboard"],
    ["actor", "all"],
    ["snapshot", "syn-r41"],
  ] as const) {
    expect(new URL(page.url()).searchParams.get(name)).toBe(value);
  }
  await expect(page.locator("h1")).toBeFocused();
  await ready(page, "/contributions/syn-c-009?snapshot=syn-r42");
  await expect(page.getByRole("heading", { name: "Contribution not available" })).toBeVisible();
  await ready(page, "/contributors/synthetic-hazel");
  const hidden = await page.locator("main").innerText();
  await ready(page, "/contributors/unknown-person");
  expect(await page.locator("main").innerText()).toEqual(hidden);
  await ready(page, "/contributions/syn-c-032");
  await expect(page.getByText("Source no longer public; the link was removed.")).toBeVisible();
  await expect(page.locator('main a[href^="https://synthetic.example"]')).toHaveCount(0);
});
