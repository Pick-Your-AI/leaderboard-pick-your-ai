import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { readFile } from "node:fs/promises";
import type { MetricRegistry, PublicScope } from "@pick-your-ai/contracts";

test.use({ storageState: { cookies: [], origins: [] } });
const at = "2026-10-18T21:00:00.000Z";
const pin = "overview-served-snapshot";

// Empty synthetic projections exercise discovery without inventing ranked work.
async function service(page: Page, unresolved = false, additionalDepartments = 0, futureDepartment = "future") {
  const registry: MetricRegistry = JSON.parse(
    await readFile(new URL("../../../packages/metrics/src/v1/registry.json", import.meta.url), "utf8"),
  );
  if (registry.ui_metadata.decision_state !== "candidate") throw new Error("Expected candidate fixture metadata");
  registry.ui_metadata.departments.find((entry) => entry.id === "review")!.label = "Review from the served registry";
  registry.ui_metadata.departments.push({ id: futureDepartment, label: "Future department", order: 10 });
  for (let index = 0; index < additionalDepartments; index++)
    registry.ui_metadata.departments.push({
      id: `additional-${index + 1}`,
      label: `Additional department ${index + 1}`,
      order: 11 + index,
    });
  if (unresolved)
    registry.ui_metadata = { decision_state: "unresolved", fields: ["department"], note: "Synthetic legacy fixture" };
  const { createService } = await import(new URL("../../service/dist/app.js", import.meta.url).href);
  let unavailable = false;
  const calls: URL[] = [];
  const app = createService({
    registry,
    now: () => Date.parse(at),
    source: {
      async read(scope: PublicScope, snapshot: string | null) {
        if (unavailable) throw new Error("SYNTHETIC_OVERVIEW_SOURCE_UNAVAILABLE");
        if (snapshot !== null && snapshot !== pin) return null;
        return {
          head: { snapshotId: pin, revision: 1, publishedAt: at },
          controls: {
            version: "overview-public-controls",
            suppressedActorIds: [],
            suppressedArtifactIds: [],
            revokedSnapshotIds: [],
          },
          selected: {
            approvedPublic: true,
            scope: { ...scope },
            actors: [],
            rows: [],
            evidence: [],
            ranking: [],
            snapshot: {
              schemaVersion: "leaderboard/v1",
              snapshotId: pin,
              revision: 1,
              generatedAt: at,
              metricDefinitionVersion: registry.policy_version,
              computationVersion: "synthetic-overview-browser-only",
              coverage: [],
              results: [],
            },
          },
        };
      },
    },
  });
  await page.route("**/api/v1/**", async (route) => {
    const url = new URL(route.request().url());
    calls.push(url);
    const response = await app.inject({ method: "GET", url: url.pathname + url.search });
    await route.fulfill({ status: response.statusCode, headers: response.headers, body: response.body });
  });
  return {
    calls,
    registry,
    fail() {
      unavailable = true;
    },
    async close() {
      await page.unrouteAll({ behavior: "wait" });
      await app.close();
    },
  };
}

const overview = (page: Page) => page.getByRole("region", { name: "Explore contribution departments" });

test("API overview keeps every served department discoverable without inventing outcomes", async ({ page }) => {
  const api = await service(page);
  try {
    await page.goto("/?ui=api");
    const section = overview(page);
    await expect(section).toBeVisible();
    await expect(section.getByRole("heading", { level: 3 })).toHaveText([
      "Research",
      "Issues",
      "Triage and stewardship",
      "Code delivery",
      "Review from the served registry",
      "Craft and quality",
      "Lines of change",
      "Operations and maintenance",
      "Community",
      "Breadth and milestones",
      "Future department",
    ]);
    await expect(section.getByRole("link", { name: "Documentation contributions", exact: true })).toBeVisible();
    await expect(
      section.getByText("No overview example is selected for this department.", { exact: true }),
    ).toHaveCount(3);
    await expect(
      section.getByText("No metric definitions are supplied for this department. Activity is unknown."),
    ).toBeVisible();
    await expect(section.getByRole("table")).toHaveCount(0);
    await expect(section.getByText(/synthetic-aster|syn-r42|0 contributions|0 contributors/)).toHaveCount(0);
    await expect(section.getByRole("link", { name: "All contributors in this scope", exact: true })).toBeVisible();
    expect(api.calls.some((url) => /\/(boards|contributors|activity)$/.test(url.pathname))).toBe(false);
  } finally {
    await api.close();
  }
});

test("keyboard department discovery preserves the displayed pin and complete scope through copied catalog navigation", async ({
  page,
}) => {
  const api = await service(page);
  const scope = {
    ui: "api",
    repository: "overview-repository",
    workstream: "T6",
    context: "current",
    project: "PVT_A,PVT_B=",
    role: "author,reviewer",
    actors: "user",
    start: "2026-10-01T00:00:00.000Z",
    end: "2026-10-18T00:00:00.000Z",
    tz: "America/New_York",
  };
  try {
    await page.goto(`/?${new URLSearchParams(scope)}`);
    const research = overview(page).getByRole("link", { name: "Research", exact: true });
    await expect(research).toBeVisible();
    const href = new URL((await research.getAttribute("href"))!, page.url());
    for (const [key, value] of Object.entries(scope)) expect(href.searchParams.get(key)).toBe(value);
    expect(href.searchParams.get("snapshot")).toBe(pin);
    expect(href.searchParams.get("department")).toBe("research");
    expect(href.searchParams.has("q")).toBe(false);
    await research.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("combobox", { name: "Department", exact: true })).toHaveValue("research");
    await expect(page.getByRole("heading", { level: 1 })).toBeFocused();
    const copied = page.url();
    await page.reload();
    await expect(page.getByRole("combobox", { name: "Department", exact: true })).toHaveValue("research");
    expect(page.url()).toBe(copied);
    await page.goBack();
    await expect(overview(page)).toBeVisible();
    const directory = overview(page).getByRole("link", { name: "All contributors in this scope", exact: true });
    await directory.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { name: "Contributor directory", exact: true })).toBeVisible();
    expect(new URL(page.url()).searchParams.get("snapshot")).toBe(pin);
    expect(new URL(page.url()).searchParams.get("project")).toBe(scope.project);
    expect(new URL(page.url()).searchParams.has("department")).toBe(false);
  } finally {
    await api.close();
  }
});

test("overview department identities survive copied URLs and catalog form submission with spaces and Unicode", async ({
  page,
}) => {
  const scope = {
    ui: "api",
    repository: "overview-repository",
    workstream: "T6",
    context: "current",
    project: "PVT_A,PVT_B=",
    role: "author,reviewer",
    actors: "user",
    start: "2026-10-01T00:00:00.000Z",
    end: "2026-10-18T00:00:00.000Z",
    tz: "America/New_York",
  };
  for (const department of ["Future Department", "résearch"]) {
    const api = await service(page, false, 0, department);
    try {
      await page.goto(`/?${new URLSearchParams(scope)}`);
      const link = overview(page).getByRole("link", { name: "Future department", exact: true });
      await expect(link).toBeVisible();
      const href = new URL((await link.getAttribute("href"))!, page.url());
      expect(href.searchParams.get("department")).toBe(department);
      expect(href.searchParams.get("snapshot")).toBe(pin);
      for (const [key, value] of Object.entries(scope)) expect(href.searchParams.get(key)).toBe(value);
      await link.focus();
      await page.keyboard.press("Enter");
      const catalog = page.getByRole("region", { name: "Metric discovery", exact: true });
      const filter = catalog.getByRole("combobox", { name: "Department", exact: true });
      await expect(filter).toHaveValue(department);
      await expect(catalog.getByRole("status")).toHaveText("0 of 98 defined measures");
      const copied = page.url();
      await page.reload();
      await expect(filter).toHaveValue(department);
      expect(page.url()).toBe(copied);
      await filter.selectOption("research");
      await catalog.getByRole("button", { name: "Search measures", exact: true }).click();
      await expect(page).toHaveURL(/department=research(?:&|$)/);
      await filter.selectOption(department);
      await catalog.getByRole("button", { name: "Search measures", exact: true }).click();
      await expect(filter).toHaveValue(department);
      await expect(catalog.getByRole("status")).toHaveText("0 of 98 defined measures");
      const submitted = new URL(page.url());
      expect(submitted.searchParams.get("department")).toBe(department);
      expect(submitted.searchParams.get("snapshot")).toBe(pin);
      for (const [key, value] of Object.entries(scope)) expect(submitted.searchParams.get(key)).toBe(value);
      expect(api.calls.every((url) => !url.searchParams.has("department"))).toBe(true);
      await expect(page.getByRole("alert")).toHaveCount(0);
    } finally {
      await api.close();
    }
  }
});

test("overview navigation remains readable at 320px and disappears after the selected health read fails", async ({
  page,
}, testInfo) => {
  const api = await service(page);
  try {
    await page.setViewportSize({ width: 320, height: 900 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(`/?ui=api&snapshot=${pin}`);
    await expect(overview(page)).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    expect(
      (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations,
    ).toEqual([]);
    await overview(page).screenshot({ path: testInfo.outputPath("overview-departments-320px.png") });
    api.fail();
    await page.getByRole("button", { name: "Recheck current publication controls", exact: true }).click();
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(overview(page)).toHaveCount(0);
    await expect(page.getByText("Review from the served registry", { exact: true })).toHaveCount(0);
  } finally {
    await api.close();
  }
});

test("unresolved overview metadata keeps the complete catalog reachable without substituting department labels", async ({
  page,
}) => {
  const api = await service(page, true);
  try {
    await page.goto(`/?ui=api&repository=overview-repository&snapshot=${pin}`);
    const section = overview(page);
    await expect(section).toBeVisible();
    await expect(section.getByText("Department navigation is unavailable in this registry.")).toBeVisible();
    await expect(section.getByRole("heading", { level: 3 })).toHaveCount(0);
    const link = section.getByRole("link", { name: "All metric definitions", exact: true });
    await link.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("status").filter({ hasText: "98 of 98" })).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Department", exact: true })).toBeDisabled();
    expect(new URL(page.url()).searchParams.get("snapshot")).toBe(pin);
    expect(new URL(page.url()).searchParams.get("repository")).toBe("overview-repository");
  } finally {
    await api.close();
  }
});

test("keyboard pagination reaches every supplied department without changing scope or requesting outcome data", async ({
  page,
}) => {
  const api = await service(page, false, 29);
  try {
    await page.goto(`/?ui=api&repository=overview-repository&workstream=T6&snapshot=${pin}`);
    const section = overview(page);
    await expect(section).toBeVisible();
    const pager = section.getByRole("navigation", { name: "Contribution department pages" });
    const next = pager.getByRole("button", { name: "Next departments", exact: true });
    const previous = pager.getByRole("button", { name: "Previous departments", exact: true });
    await expect(section.getByRole("heading", { level: 3 })).toHaveCount(12);
    await expect(pager.getByRole("status")).toHaveText("Departments 1–12 of 40");
    await expect(previous).toBeDisabled();
    const initialCalls = api.calls.length;
    await next.focus();
    await page.keyboard.press("Enter");
    await expect(pager.getByRole("status")).toHaveText("Departments 13–24 of 40");
    await expect(next).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(pager.getByRole("status")).toHaveText("Departments 25–36 of 40");
    await page.keyboard.press("Enter");
    await expect(pager.getByRole("status")).toHaveText("Departments 37–40 of 40");
    await expect(next).toBeDisabled();
    await expect(section.getByRole("heading", { level: 3 })).toHaveText([
      "Additional department 26",
      "Additional department 27",
      "Additional department 28",
      "Additional department 29",
    ]);
    const last = section.getByRole("link", { name: "Additional department 29", exact: true });
    const href = new URL((await last.getAttribute("href"))!, page.url());
    expect(href.searchParams.get("department")).toBe("additional-29");
    expect(href.searchParams.get("snapshot")).toBe(pin);
    expect(href.searchParams.get("repository")).toBe("overview-repository");
    expect(href.searchParams.get("workstream")).toBe("T6");
    await previous.focus();
    await page.keyboard.press("Enter");
    await expect(pager.getByRole("status")).toHaveText("Departments 25–36 of 40");
    await expect(previous).toBeFocused();
    expect(api.calls.length).toBe(initialCalls);
  } finally {
    await api.close();
  }
});
