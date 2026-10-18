import { test, expect } from "@playwright/test";

test.use({ storageState: { cookies: [], origins: [] } });

const referenceRoutes = [
  "/leaderboards",
  "/methodology",
  "/methodology/pr_merged",
  "/methodology/changes",
  "/coverage",
  "/projects/syn-proj-web",
  "/corrections",
  "/prototype",
  "/not-found",
];
const selected = {
  from: "2026-09-01",
  to: "2026-10-01",
  repo: "syn-repo-website",
  project: "syn-proj-web",
  actor: "all",
  snapshot: "syn-r41",
};

test("reference routes keep the carried scope visible and usable at 320px", async ({ page }, info) => {
  await page.setViewportSize({ width: 320, height: 900 });
  for (const route of referenceRoutes) {
    await test.step(route, async () => {
      await page.goto(`${route}?${new URLSearchParams({ ...selected, ui: "prototype" })}`);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      const scope = page.getByRole("region", { name: "Scope", exact: true });
      await expect(scope).toBeVisible();
      await expect(scope.getByRole("combobox", { name: "Period", exact: true })).toHaveValue("custom");
      await expect(scope.getByLabel("From (UTC, inclusive)", { exact: true })).toHaveValue(selected.from);
      await expect(scope.getByLabel("To (UTC, exclusive)", { exact: true })).toHaveValue(selected.to);
      await expect(scope.getByRole("combobox", { name: "Repository", exact: true })).toHaveValue(selected.repo);
      await expect(scope.getByRole("combobox", { name: "Program", exact: true })).toHaveValue(selected.project);
      const snapshot = scope.getByRole("combobox", { name: "Snapshot", exact: true });
      await expect(snapshot).toHaveValue(selected.snapshot);
      await expect(scope.getByRole("radio", { name: "All activity", exact: true })).toBeChecked();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(321);
      await snapshot.selectOption("syn-r42");
      await expect(page).toHaveURL(/snapshot=syn-r42/);
      await page.goBack();
      await expect(snapshot).toHaveValue(selected.snapshot);
      const overview = page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Overview", exact: true });
      const href = new URL((await overview.getAttribute("href"))!, page.url());
      expect(Object.fromEntries(href.searchParams)).toMatchObject(selected);
      if (route === "/leaderboards" || route === "/coverage") {
        await info.attach(`${route.slice(1)}-scope-320px`, {
          body: await page.screenshot(),
          contentType: "image/png",
        });
      }
    });
  }
});

test("reference routes explain invalid scope values before following their fallback links", async ({ page }) => {
  for (const route of referenceRoutes) {
    await test.step(route, async () => {
      await page.goto(`${route}?ui=prototype&period=fortnight&repo=missing-repo&project=missing-project&snapshot=missing-pin`);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      const alert = page.getByRole("alert").filter({ hasText: "Some link parameters could not be used" });
      await expect(alert).toBeVisible();
      for (const value of ["period=fortnight", "repo=missing-repo", "project=missing-project", "snapshot=missing-pin"])
        await expect(alert).toContainText(value);
      const scope = page.getByRole("region", { name: "Scope", exact: true });
      await expect(scope.getByRole("combobox", { name: "Period", exact: true })).toHaveValue("30d");
      await expect(scope.getByRole("combobox", { name: "Repository", exact: true })).toHaveValue("");
      await expect(scope.getByRole("combobox", { name: "Program", exact: true })).toHaveValue("");
      await expect(scope.getByRole("combobox", { name: "Snapshot", exact: true })).toHaveValue("");
      await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Overview", exact: true }).press("Enter");
      await expect(page.getByRole("heading", { level: 1, name: "Contributions, with evidence", exact: true })).toBeFocused();
      await expect(page.getByRole("alert").filter({ hasText: "Some link parameters could not be used" })).toHaveCount(0);
      const restored = new URL(page.url());
      for (const key of ["period", "repo", "project", "snapshot"])
        expect(restored.searchParams.has(key)).toBe(false);
    });
  }
});

test("custom date controls restore the URL's dates after Back and Forward", async ({ page }) => {
  await page.goto(`/leaderboards/pr_merged?${new URLSearchParams({ ...selected, ui: "prototype" })}`);
  const from = page.getByLabel("From (UTC, inclusive)", { exact: true });
  const to = page.getByLabel("To (UTC, exclusive)", { exact: true });
  await expect(from).toHaveValue(selected.from);
  await expect(to).toHaveValue(selected.to);
  await from.fill("2026-10-01");
  await to.fill("2026-10-15");
  await page.getByRole("button", { name: "Apply dates", exact: true }).press("Enter");
  await expect(page).toHaveURL(/from=2026-10-01&to=2026-10-15/);
  await page.goBack();
  await expect(page).toHaveURL(/from=2026-09-01&to=2026-10-01/);
  await expect(from).toHaveValue(selected.from);
  await expect(to).toHaveValue(selected.to);
  await page.goForward();
  await expect(page).toHaveURL(/from=2026-10-01&to=2026-10-15/);
  await expect(from).toHaveValue("2026-10-01");
  await expect(to).toHaveValue("2026-10-15");
  expect(Object.fromEntries(new URL(page.url()).searchParams)).toMatchObject({
    ...selected,
    from: "2026-10-01",
    to: "2026-10-15",
  });
  await page.getByRole("combobox", { name: "Period", exact: true }).selectOption("30d");
  await expect(from).toHaveCount(0);
  await page.goBack();
  await expect(from).toHaveValue("2026-10-01");
  await expect(to).toHaveValue("2026-10-15");
  await page.goForward();
  await expect(from).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: "Period", exact: true })).toHaveValue("30d");
});
