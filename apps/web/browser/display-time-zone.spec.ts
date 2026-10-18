import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { evidenceService } from "./evidenceHarness.ts";

test.use({ storageState: { cookies: [], origins: [] } });

test("prototype timezone survives navigation and history without moving the pinned UTC interval", async ({ page }) => {
  await page.goto("/leaderboards/pr_merged?ui=prototype&period=90d&actor=all&snapshot=syn-r41");
  const scope = page.getByRole("region", { name: "Scope", exact: true });
  const timezone = scope.getByRole("combobox", { name: "Display timezone", exact: true });
  await expect(timezone).toHaveValue("UTC");
  await expect(scope.locator(".display-window time")).toHaveCount(2);
  const bounds = await scope
    .locator(".display-window time")
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("datetime")));
  await timezone.selectOption("America/New_York");
  await expect(timezone).toHaveValue("America/New_York");
  expect(
    await scope
      .locator(".display-window time")
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("datetime"))),
  ).toEqual(bounds);
  await expect(scope.locator(".display-window")).toContainText("GMT-04:00");
  await expect(scope.locator(".display-window")).toContainText("Exact UTC bounds:");
  for (const [key, value] of [
    ["period", "90d"],
    ["actor", "all"],
    ["snapshot", "syn-r41"],
    ["tz", "America/New_York"],
  ])
    expect(new URL(page.url()).searchParams.get(key!)).toBe(value);
  await page
    .getByRole("navigation", { name: "Primary" })
    .getByRole("link", { name: "Contributors", exact: true })
    .press("Enter");
  await expect(page.getByRole("heading", { name: "Contributors", exact: true })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Display timezone", exact: true })).toHaveValue("America/New_York");
  await page.goBack();
  await expect(timezone).toHaveValue("America/New_York");
  await page.goBack();
  await expect(timezone).toHaveValue("UTC");
  await page.goForward();
  await expect(timezone).toHaveValue("America/New_York");
  await page.goto(page.url());
  await expect(timezone).toHaveValue("America/New_York");
});

test("API timezone changes retain the displayed snapshot after a new publication and never reach the service", async ({
  page,
}) => {
  const api = await evidenceService(page);
  const query = new URLSearchParams({
    ui: "api",
    start: "2026-10-01T00:00:00.000Z",
    end: "2026-11-01T00:00:00.000Z",
    actors: "user",
    limit: "1",
  });
  try {
    await page.goto(`/leaderboards/pr_merged?${query}`);
    const provenance = page.getByRole("region", { name: "Snapshot provenance" });
    await expect(provenance).toContainText("Snapshot api-1 ·");
    await expect(page.getByRole("link", { name: "Synthetic API A", exact: true })).toBeVisible();
    api.next();
    const timezone = page.getByRole("combobox", { name: "Display timezone", exact: true });
    await timezone.selectOption("America/New_York");
    await expect(provenance).toContainText("Snapshot api-1 ·");
    await expect(provenance).toContainText("America/New_York");
    await expect(provenance).toContainText("GMT-04:00");
    await expect(provenance).toContainText("2026-10-01T00:00:00.000Z");
    await expect(provenance).toContainText("2026-11-01T00:00:00.000Z");
    expect(new URL(page.url()).searchParams.get("snapshot")).toBe("api-1");
    await page.getByRole("link", { name: "Synthetic API A", exact: true }).press("Enter");
    await expect(page.getByRole("heading", { name: "Contributor portfolio", exact: true })).toBeVisible();
    await expect(provenance).toContainText("Snapshot api-1 ·");
    await expect(timezone).toHaveValue("America/New_York");
    await page.goBack();
    await expect(provenance).toContainText("Snapshot api-1 ·");
    await page.goBack();
    await expect(timezone).toHaveValue("UTC");
    await expect(provenance).toContainText("Snapshot api-1 ·");
    await page.goForward();
    await expect(timezone).toHaveValue("America/New_York");
    await expect(provenance).toContainText("Snapshot api-1 ·");
    await page.goto(page.url());
    await expect(provenance).toContainText("Snapshot api-1 ·");
    expect(api.calls.filter((url) => url.pathname.endsWith("/boards")).length).toBeGreaterThan(1);
    for (const url of api.calls) expect(url.searchParams.has("tz")).toBe(false);
  } finally {
    await api.close();
  }
});

test("both prototype and API walls disclose the selected display timezone and exact bounds", async ({ page }) => {
  await page.goto("/live?ui=prototype&mode=frozen&boards=pr_merged&snapshot=syn-r41&tz=America%2FNew_York");
  await expect(page.locator(".wall-header .display-window")).toContainText("America/New_York");
  await expect(page.locator(".wall-header .display-window")).toContainText("Exact UTC bounds:");
  const api = await evidenceService(page);
  try {
    const query = new URLSearchParams({
      ui: "api",
      mode: "frozen",
      boards: "pr_merged",
      snapshot: "api-1",
      tz: "Asia/Kathmandu",
      start: "2026-10-01T00:00:00.000Z",
      end: "2026-11-01T00:00:00.000Z",
    });
    await page.goto(`/live?${query}`);
    await expect(page.locator(".api-wall-scope .display-window")).toContainText("Asia/Kathmandu");
    await expect(page.locator(".api-wall-scope .display-window")).toContainText("GMT+05:45");
    await expect(page.locator(".api-wall-scope .display-window")).toContainText("2026-10-01T00:00:00.000Z");
    for (const url of api.calls) expect(url.searchParams.has("tz")).toBe(false);
  } finally {
    await api.close();
  }
});

test("malformed display zones are visible and do not permit API source reads", async ({ page }) => {
  const api = await evidenceService(page);
  try {
    await page.goto("/leaderboards/pr_merged?ui=api&tz=Mars%2FOlympus");
    await expect(page.getByRole("alert")).toContainText("invalid_display_timezone");
    expect(api.calls).toHaveLength(0);
    await page.goto("/leaderboards/pr_merged?ui=prototype&tz=Mars%2FOlympus");
    await expect(page.getByRole("alert")).toContainText("Displaying UTC; the selected UTC window is unchanged");
    await expect(page.getByRole("combobox", { name: "Display timezone", exact: true })).toHaveValue("UTC");
  } finally {
    await api.close();
  }
});

test("display controls and exact UTC bounds reflow accessibly at 320px", async ({ page }, testInfo) => {
  const api = await evidenceService(page);
  try {
    await page.setViewportSize({ width: 320, height: 800 });
    await page.goto("/leaderboards/pr_merged?ui=prototype");
    // Timezone database aliases differ across browser/ICU versions. Exercise the
    // longest actual supported choice, not an alias this runtime may have removed.
    const longZone = await page.evaluate(
      () => Intl.supportedValuesOf("timeZone").sort((a, b) => b.length - a.length)[0]!,
    );
    for (const ui of ["prototype", "api"]) {
      const query = new URLSearchParams({
        ui,
        tz: longZone,
        ...(ui === "prototype"
          ? { snapshot: "syn-r41", period: "90d" }
          : { snapshot: "api-1", start: "2026-10-01T00:00:00.000Z", end: "2026-11-01T00:00:00.000Z" }),
      });
      await page.goto(`/leaderboards/pr_merged?${query}`);
      await expect(page.getByRole("combobox", { name: "Display timezone", exact: true })).toHaveValue(longZone);
      await expect(page.locator(".display-window")).toContainText("Exact UTC bounds:");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      expect(
        (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations,
      ).toEqual([]);
      await page.screenshot({ path: testInfo.outputPath(`${ui}-timezone-320px.png`), fullPage: true });
    }
  } finally {
    await api.close();
  }
});

test("a timezone change retains the current cursor page and open proof", async ({ page }) => {
  const api = await evidenceService(page);
  try {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/leaderboards/pr_merged?ui=api&snapshot=api-1&limit=1");
    await page.getByRole("link", { name: "Next cursor page" }).click();
    await page.getByRole("link", { name: "e-api-b", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Contribution evidence" });
    await expect(dialog.locator("[data-proof-projection]")).toBeVisible();
    const projection = await dialog.locator("[data-proof-projection]").innerText();
    const before = new URL(page.url());
    expect(before.searchParams.get("cursor")).toBeTruthy();
    expect(before.searchParams.get("proof")).toBe("e-api-b");
    api.next();
    await page.getByRole("combobox", { name: "Display timezone", exact: true }).selectOption("America/New_York");
    await expect(dialog.locator("[data-proof-projection]")).toHaveText(projection, { useInnerText: true });
    const after = new URL(page.url());
    for (const key of ["snapshot", "cursor", "proof", "limit"])
      expect(after.searchParams.get(key)).toBe(before.searchParams.get(key));
    expect(after.searchParams.get("tz")).toBe("America/New_York");
    await page.goBack();
    await expect(page.getByRole("combobox", { name: "Display timezone", exact: true })).toHaveValue("UTC");
    await expect(dialog.locator("[data-proof-projection]")).toHaveText(projection, { useInnerText: true });
    await page.goForward();
    await expect(page.getByRole("combobox", { name: "Display timezone", exact: true })).toHaveValue("America/New_York");
    await expect(dialog.locator("[data-proof-projection]")).toHaveText(projection, { useInnerText: true });
    for (const url of api.calls) expect(url.searchParams.has("tz")).toBe(false);
  } finally {
    await api.close();
  }
});
