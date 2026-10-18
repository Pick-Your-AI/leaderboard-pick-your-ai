import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import type { Coverage } from "@pick-your-ai/contracts";

test.use({ storageState: { cookies: [], origins: [] } });
const at = "2026-10-18T07:00:00.000Z";
const pin = "coverage-snapshot";
const scope = {
  organization: "Pick-Your-AI",
  repository: "coverage-repository",
  workstream: null,
  start: null,
  end: null,
};
const record = (index = 0): Coverage => ({
  schemaVersion: "leaderboard/v1",
  source: "github_rest",
  state: "unknown",
  scopeId: `served-scope-${index}`,
  windowStart: "2026-10-01T00:00:00.125Z",
  windowEnd: "2026-10-18T00:00:00.875Z",
  knownStart: null,
  lastSuccessfulSync: null,
  sourceWatermark: null,
  missingPages: 0,
  permissionsMissing: [],
  sourceErrors: [],
});

async function service(page: Page, records: Coverage[]) {
  const module = new URL("../../service/dist/app.js", import.meta.url).href;
  const { createService } = await import(module);
  let unavailable = false;
  const calls: URL[] = [];
  const app = createService({
    now: () => Date.parse(at),
    source: {
      async read(selected: typeof scope, snapshot: string | null) {
        if (unavailable) throw new Error("SENSITIVE_PROVIDER_EXCEPTION");
        if (snapshot !== null && snapshot !== pin) return null;
        return {
          head: { snapshotId: pin, revision: 1, publishedAt: at },
          controls: {
            version: "coverage-controls",
            suppressedActorIds: [],
            suppressedArtifactIds: [],
            revokedSnapshotIds: [],
          },
          selected: {
            approvedPublic: true,
            scope: { ...selected },
            actors: [],
            rows: [],
            evidence: [],
            ranking: [],
            snapshot: {
              schemaVersion: "leaderboard/v1",
              snapshotId: pin,
              revision: 1,
              generatedAt: at,
              metricDefinitionVersion: "candidate-0.1.1",
              computationVersion: "synthetic-coverage-browser-only",
              coverage: structuredClone(records),
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
    fail: () => {
      unavailable = true;
    },
    close: () => app.close(),
  };
}

test("coverage exposes frozen source gaps and exact windows on a narrow accessible page", async ({ page }) => {
  const partial = {
    ...record(),
    state: "partial" as const,
    missingPages: 3,
    permissionsMissing: ["PRIVATE_PERMISSION_DETAIL"],
    sourceErrors: ["SENSITIVE_EXCEPTION_DETAIL"],
  };
  const api = await service(page, [partial, { ...record(1), scopeId: null }]);
  try {
    await page.setViewportSize({ width: 320, height: 900 });
    await page.goto(`/coverage?ui=api&repository=${scope.repository}&snapshot=${pin}`);
    const coverage = page.getByRole("region", { name: "Snapshot source coverage records" });
    await expect(coverage).toBeVisible();
    await expect(coverage.getByRole("rowheader")).toHaveCount(2);
    await expect(coverage).toContainText("Reported state: partial");
    await expect(coverage).toContainText("Known missing pages: 3");
    await expect(coverage).toContainText("source_capability_unavailable");
    await expect(coverage).toContainText("source_collection_failed");
    await expect(coverage).toContainText("2026-10-01T00:00:00.125Z");
    await expect(coverage).toContainText("Window end (exclusive): 2026-10-18T00:00:00.875Z");
    await expect(coverage).toContainText("History known since: Unknown");
    await expect(coverage).toContainText("Known missing pages: 0");
    await expect(coverage).toContainText("Scope: Unknown");
    await expect(page.getByText(/A completeness percentage is unavailable/)).toBeVisible();
    await expect(page.getByText(/PRIVATE_PERMISSION_DETAIL|SENSITIVE_EXCEPTION_DETAIL|100%/)).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    const correction = page.getByRole("link", { name: "Corrections and privacy for this selection" });
    const href = new URL((await correction.getAttribute("href"))!, page.url());
    expect(href.searchParams.get("snapshot")).toBe(pin);
    expect(href.searchParams.get("repository")).toBe(scope.repository);
    await correction.click();
    await expect(page.getByRole("heading", { name: "Corrections and privacy", exact: true })).toBeVisible();
  } finally {
    await api.close();
  }
});

test("every source record remains reachable without refetching or resetting the selected snapshot", async ({
  page,
}) => {
  const api = await service(
    page,
    Array.from({ length: 41 }, (_, index) => record(index)),
  );
  try {
    await page.goto(`/leaderboards/pr_opened?ui=api&repository=${scope.repository}&snapshot=${pin}`);
    await page.locator("summary").filter({ hasText: "Snapshot source coverage" }).click();
    const coverage = page.getByRole("region", { name: "Snapshot source coverage records" });
    await expect(coverage.getByRole("rowheader")).toHaveCount(20);
    const calls = api.calls.length;
    const next = page.getByRole("button", { name: "Next source records" });
    await next.focus();
    await page.keyboard.press("Enter");
    await expect(coverage).toContainText("Scope: served-scope-20");
    await expect(next).toBeFocused();
    await next.click();
    await expect(coverage.getByRole("rowheader")).toHaveCount(1);
    await expect(coverage).toContainText("Scope: served-scope-40");
    await expect(next).toBeDisabled();
    expect(api.calls.length).toBe(calls);
    await page.getByRole("button", { name: "Recheck current publication controls" }).click();
    await expect(coverage).toContainText("Scope: served-scope-40");
    expect(new URL(page.url()).searchParams.get("snapshot")).toBe(pin);
    await page.getByRole("button", { name: "Previous source records" }).click();
    await expect(coverage).toContainText("Scope: served-scope-20");
    api.fail();
    await page.getByRole("button", { name: "Recheck current publication controls" }).click();
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(coverage).toHaveCount(0);
    await expect(page.getByText(/served-scope-/)).toHaveCount(0);
  } finally {
    await api.close();
  }
});

test("a served snapshot with no coverage records stays explicitly unknown", async ({ page }) => {
  const api = await service(page, []);
  try {
    await page.goto(`/coverage?ui=api&snapshot=${pin}`);
    await expect(
      page.getByText("No source coverage records were supplied for this snapshot. Coverage is unknown."),
    ).toBeVisible();
    await expect(page.getByRole("region", { name: "Snapshot source coverage records" })).toHaveCount(0);
    await expect(page.getByText(/100%/)).toHaveCount(0);
  } finally {
    await api.close();
  }
});
