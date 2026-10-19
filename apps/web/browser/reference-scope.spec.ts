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
      const overview = page
        .getByRole("navigation", { name: "Primary" })
        .getByRole("link", { name: "Overview", exact: true });
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
      await page.goto(
        `${route}?ui=prototype&period=fortnight&repo=missing-repo&project=missing-project&snapshot=missing-pin`,
      );
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      const alert = page.getByRole("alert").filter({ hasText: "Some link parameters could not be used" });
      await expect(alert).toBeVisible();
      for (const value of [
        "period=fortnight",
        "repo=missing-repo",
        "project=missing-project",
        "snapshot=missing-pin",
      ]) {
        await expect(alert).toContainText(value);
      }
      const scope = page.getByRole("region", { name: "Scope", exact: true });
      await expect(scope.getByRole("combobox", { name: "Period", exact: true })).toHaveValue("30d");
      await expect(scope.getByRole("combobox", { name: "Repository", exact: true })).toHaveValue("");
      await expect(scope.getByRole("combobox", { name: "Program", exact: true })).toHaveValue("");
      await expect(scope.getByRole("combobox", { name: "Snapshot", exact: true })).toHaveValue("");
      await page
        .getByRole("navigation", { name: "Primary" })
        .getByRole("link", { name: "Overview", exact: true })
        .press("Enter");
      await expect(
        page.getByRole("heading", { level: 1, name: "Contributions, with evidence", exact: true }),
      ).toBeFocused();
      await expect(page.getByRole("alert").filter({ hasText: "Some link parameters could not be used" })).toHaveCount(
        0,
      );
      const restored = new URL(page.url());
      for (const key of ["period", "repo", "project", "snapshot"]) {
        expect(restored.searchParams.has(key)).toBe(false);
      }
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

test("multiple Programs remain visible through scope edits, copied links and history", async ({ page }) => {
  const multi = {
    ...selected,
    repo: "syn-repo-research,syn-repo-website",
    project: "syn-proj-research,syn-proj-web",
  };
  for (const route of ["/leaderboards/pr_merged", "/methodology"]) {
    await test.step(route, async () => {
      await page.goto(`${route}?${new URLSearchParams({ ...multi, ui: "prototype" })}`);
      const scope = page.getByRole("region", { name: "Scope", exact: true });
      const program = scope.getByRole("combobox", { name: "Program", exact: true });
      const repository = scope.getByRole("combobox", { name: "Repository", exact: true });
      await expect(program).toHaveValue("__multiple");
      await expect(program.locator("option:checked")).toHaveText("2 selected from link");
      await expect(repository).toHaveValue("__multiple");
      await scope.getByRole("radio", { name: "Automation", exact: true }).check();
      const overview = page
        .getByRole("navigation", { name: "Primary" })
        .getByRole("link", { name: "Overview", exact: true });
      const href = new URL((await overview.getAttribute("href"))!, page.url());
      expect(Object.fromEntries(href.searchParams)).toMatchObject({ ...multi, actor: "automation" });
      await page.goBack();
      await expect(scope.getByRole("radio", { name: "All activity", exact: true })).toBeChecked();
      await expect(program).toHaveValue("__multiple");
      await program.selectOption("syn-proj-web");
      await expect(program).toHaveValue("syn-proj-web");
      expect(new URL(page.url()).searchParams.get("project")).toBe("syn-proj-web");
      await page.goBack();
      await expect(program).toHaveValue("__multiple");
      await page.reload();
      await expect(program).toHaveValue("__multiple");
      expect(Object.fromEntries(new URL(page.url()).searchParams)).toMatchObject(multi);
    });
  }
});

test("invalid custom bounds display and carry the same documented default", async ({ page }) => {
  for (const invalid of [
    { period: "90d", from: "invalid", to: "2026-10-01" },
    { period: "all", from: "2026-10-08", to: "2026-10-01" },
  ]) {
    await test.step(invalid.period, async () => {
      await page.goto(`/leaderboards/pr_merged?${new URLSearchParams({ ...selected, ...invalid, ui: "prototype" })}`);
      const alert = page.getByRole("alert").filter({ hasText: "Some link parameters could not be used" });
      await expect(alert).toContainText("Showing the last 30 days instead.");
      const scope = page.getByRole("region", { name: "Scope", exact: true });
      await expect(scope.getByRole("combobox", { name: "Period", exact: true })).toHaveValue("30d");
      await expect(scope.getByLabel("From (UTC, inclusive)", { exact: true })).toHaveCount(0);
      const overview = page
        .getByRole("navigation", { name: "Primary" })
        .getByRole("link", { name: "Overview", exact: true });
      const href = new URL((await overview.getAttribute("href"))!, page.url());
      for (const key of ["period", "from", "to"]) {
        expect(href.searchParams.has(key)).toBe(false);
      }
      for (const key of ["repo", "project", "actor", "snapshot"] as const) {
        expect(href.searchParams.get(key)).toBe(selected[key]);
      }
      await overview.press("Enter");
      await expect(page.getByRole("combobox", { name: "Period", exact: true })).toHaveValue("30d");
      await expect(page.getByRole("alert").filter({ hasText: "Some link parameters could not be used" })).toHaveCount(
        0,
      );
    });
  }
});

test("unapplied custom dates survive repository and snapshot changes", async ({ page }) => {
  const presetSelection = {
    repo: selected.repo,
    project: selected.project,
    actor: selected.actor,
    snapshot: selected.snapshot,
  };
  await page.goto(`/leaderboards/pr_merged?${new URLSearchParams({ ...presetSelection, ui: "prototype" })}`);
  const scope = page.getByRole("region", { name: "Scope", exact: true });
  const period = scope.getByRole("combobox", { name: "Period", exact: true });
  await expect(period).toHaveValue("30d");
  await period.selectOption("custom");
  const from = scope.getByLabel("From (UTC, inclusive)", { exact: true });
  const to = scope.getByLabel("To (UTC, exclusive)", { exact: true });
  await from.fill("2026-10-01");
  await to.fill("2026-10-15");
  await scope.getByRole("combobox", { name: "Repository", exact: true }).selectOption("syn-repo-leaderboard");
  await scope.getByRole("combobox", { name: "Snapshot", exact: true }).selectOption("syn-r42");
  await expect(period).toHaveValue("custom");
  await expect(from).toHaveValue("2026-10-01");
  await expect(to).toHaveValue("2026-10-15");
  const beforeApply = new URL(page.url());
  for (const key of ["period", "from", "to"]) {
    expect(beforeApply.searchParams.has(key)).toBe(false);
  }
  expect(Object.fromEntries(beforeApply.searchParams)).toMatchObject({
    ...presetSelection,
    repo: "syn-repo-leaderboard",
    snapshot: "syn-r42",
  });
  await scope.getByRole("button", { name: "Apply dates", exact: true }).press("Enter");
  await expect(page).toHaveURL(/from=2026-10-01&to=2026-10-15/);
  expect(Object.fromEntries(new URL(page.url()).searchParams)).toMatchObject({
    ...presetSelection,
    repo: "syn-repo-leaderboard",
    snapshot: "syn-r42",
    from: "2026-10-01",
    to: "2026-10-15",
  });
  await expect(from).toHaveValue("2026-10-01");
  await expect(to).toHaveValue("2026-10-15");
});

test("an invalid preset with valid custom dates explains the window still in use", async ({ page }) => {
  await page.goto(
    `/leaderboards/pr_merged?${new URLSearchParams({ ...selected, period: "fortnight", ui: "prototype" })}`,
  );
  const alert = page.getByRole("alert").filter({ hasText: "Some link parameters could not be used" });
  await expect(alert).toContainText("period=fortnight");
  await expect(alert).toContainText("Using the valid custom UTC dates instead.");
  await expect(alert).not.toContainText("last 30 days");
  const scope = page.getByRole("region", { name: "Scope", exact: true });
  await expect(scope.getByRole("combobox", { name: "Period", exact: true })).toHaveValue("custom");
  await expect(scope.getByLabel("From (UTC, inclusive)", { exact: true })).toHaveValue(selected.from);
  await expect(scope.getByLabel("To (UTC, exclusive)", { exact: true })).toHaveValue(selected.to);
  const overview = page
    .getByRole("navigation", { name: "Primary" })
    .getByRole("link", { name: "Overview", exact: true });
  const href = new URL((await overview.getAttribute("href"))!, page.url());
  expect(Object.fromEntries(href.searchParams)).toMatchObject(selected);
  expect(href.searchParams.has("period")).toBe(false);
});
