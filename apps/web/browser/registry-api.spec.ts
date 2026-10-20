import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { readFile } from "node:fs/promises";
import type { MetricRegistry } from "@pick-your-ai/contracts";

test.use({ storageState: { cookies: [], origins: [] } });
async function catalogService(page: Page, malformed = false, customize?: (registry: MetricRegistry) => void) {
  const registry = JSON.parse(
    await readFile(new URL("../../../packages/metrics/src/v1/registry.json", import.meta.url), "utf8"),
  );
  registry.ui_metadata.metrics.find((entry: { metric_id: string }) => entry.metric_id === "pr_merged").synonyms = [
    "serverexclusivealias",
  ];
  registry.ui_metadata.departments.find((entry: { id: string }) => entry.id === "delivery").label =
    "Served delivery label";
  customize?.(registry);
  const module = new URL("../../service/dist/app.js", import.meta.url).href;
  const { createService } = await import(module);
  let reads = 0;
  const app = createService({
    registry,
    source: {
      async read() {
        reads++;
        throw new Error("Synthetic unavailable source");
      },
    },
  });
  const calls: URL[] = [];
  await page.route("**/api/v1/**", async (route) => {
    const url = new URL(route.request().url());
    calls.push(url);
    if (malformed && url.pathname.endsWith("/metrics")) {
      const invalid = structuredClone(registry);
      invalid.ui_metadata.metrics.pop();
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(invalid) });
    } else {
      const response = await app.inject({ method: "GET", url: url.pathname + url.search });
      await route.fulfill({ status: response.statusCode, headers: response.headers, body: response.body });
    }
  });
  return {
    calls,
    get reads() {
      return reads;
    },
    close: () => app.close(),
  };
}

test("API discovery searches served aliases and opens an unmaterialized method without substituting fixtures", async ({
  page,
}) => {
  const service = await catalogService(page);
  try {
    await page.goto("/leaderboards?ui=api&repository=repo-1&snapshot=pin-1");
    await expect(page.getByRole("status").filter({ hasText: "98 of 98" })).toBeVisible();
    await page.getByRole("searchbox", { name: "Search definitions" }).fill("serverexclusivealias");
    await page.getByRole("combobox", { name: "Department", exact: true }).selectOption("delivery");
    await page.getByRole("button", { name: "Search measures", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "1 of 98" })).toBeVisible();
    await expect(page.getByText("Served delivery label · Synthetic verification only", { exact: false })).toBeVisible();
    await page.getByRole("link", { name: "Method sheet", exact: true }).click();
    await expect(page.getByText("Candidate state/date combinations", { exact: true })).toBeVisible();
    await expect(page.getByText("qualified / acceptedAt", { exact: true })).toBeVisible();
    await expect(page.getByText("UI metadata version", { exact: true })).toBeVisible();
    const selected = new URL(page.url());
    expect(selected.searchParams.get("snapshot")).toBe("pin-1");
    expect(selected.searchParams.get("repository")).toBe("repo-1");
    expect(selected.searchParams.has("q")).toBe(false);
    expect(service.calls.every((url) => url.pathname === "/api/v1/metrics")).toBe(true);
    expect(service.reads).toBe(0);
    await expect(page.getByText("synthetic-aster", { exact: false })).toHaveCount(0);
  } finally {
    await service.close();
  }
});

test("deferred and unknown definitions stay honest without a live board read", async ({ page }) => {
  const service = await catalogService(page);
  try {
    await page.goto("/methodology/retained_lines?ui=api");
    await expect(page.getByText("Deferred", { exact: true })).toBeVisible();
    await expect(
      page.getByText("No selectable candidate view registered; this is not a measured zero.", { exact: true }),
    ).toBeVisible();
    expect(service.reads).toBe(0);
    await page.goto("/methodology/not_a_metric?ui=api");
    await expect(page.getByRole("alert")).toContainText("unknown_metric_definition");
    expect(service.reads).toBe(0);
  } finally {
    await service.close();
  }
});

test("method sheets expose served denominator limits and source qualification without a snapshot", async ({ page }) => {
  const service = await catalogService(page, false, (registry) => {
    registry.metrics.find((metric) => metric.id === "pr_accepted_rate")!.definition.denominator.zero_behavior =
      "Served denominator guard: no decided PRs means unavailable, never 0%.";
  });
  try {
    await page.goto("/methodology/pr_accepted_rate?ui=api&snapshot=unavailable-pin");
    await expect(page.getByText("Served denominator guard: no decided PRs means unavailable, never 0%.")).toBeVisible();
    await expect(page.getByText("Apply identical source/time/eligibility scope to all ratio terms.")).toBeVisible();
    await expect(page.getByText("No subjective quality inference from measured activity")).toBeVisible();
    await expect(page.getByText("No published policy signature supplied for this selection.")).toBeVisible();
    await page.goto("/methodology/review_wait?ui=api");
    await expect(page.getByText("n=0 => unavailable; never 0 hours.")).toBeVisible();
    await expect(page.getByText("n eligible PRs with both timestamps;", { exact: false })).toContainText(
      "unresolved right-censored PR count and missing-readiness-evidence count separately",
    );
    await page.goto("/methodology/label_taxonomy?ui=api");
    await expect(page.getByText("Definition facets", { exact: true })).toBeVisible();
    await expect(page.getByText("name/description/color edit", { exact: true })).toBeVisible();
    await expect(
      page.getByText("Use only proven approved read scopes and public evidence.", { exact: false }),
    ).toBeVisible();
    await expect(
      page.getByText("An event plus its confirming receipt is one underlying unit.", { exact: false }),
    ).toBeVisible();
    await expect(page.getByText("A label rename retains the same label identity", { exact: false })).toBeVisible();
    expect(service.calls.every((url) => url.pathname === "/api/v1/metrics")).toBe(true);
    expect(service.reads).toBe(0);
    await expect(page.getByText("synthetic-aster", { exact: false })).toHaveCount(0);
  } finally {
    await service.close();
  }
});

test("API rejects unsupported state/date filters and malformed registry metadata without fallback", async ({
  page,
}) => {
  const service = await catalogService(page, true);
  try {
    await page.goto("/leaderboards?ui=api&state=qualified&date_basis=acceptedAt");
    await expect(page.getByRole("alert")).toContainText("unsupported_or_duplicate_filter");
    expect(service.calls).toHaveLength(0);
    await page.goto("/leaderboards?ui=api");
    await expect(page.getByRole("alert")).toContainText("invalid_metric_registry");
    await expect(page.getByRole("search", { name: "Search metric definitions" })).toHaveCount(0);
    await expect(page.getByRole("navigation", { name: "Metric categories", includeHidden: true })).toHaveCount(0);
    expect(service.reads).toBe(0);
  } finally {
    await service.close();
  }
});

test("keyboard category navigation retains search and exact scope across copied URLs without a source read", async ({
  page,
}) => {
  const service = await catalogService(page);
  const query = new URLSearchParams({
    ui: "api",
    organization: "Pick-Your-AI",
    repository: "repo-1",
    workstream: "docs",
    context: "event",
    project: "PVT_native",
    role: "author",
    actors: "user",
    start: "2026-10-01T00:00:00.000Z",
    end: "2026-10-18T00:00:00.000Z",
    snapshot: "immutable-pin",
    limit: "25",
    q: "serverexclusivealias",
    tz: "Asia/Kathmandu",
  });
  try {
    await page.goto(`/leaderboards?${query}`);
    const categories = page.getByRole("navigation", { name: "Metric categories", exact: true });
    const delivery = categories.getByRole("link", { name: "Served delivery label", exact: true });
    await delivery.focus();
    await page.keyboard.press("Enter");
    await expect(categories.getByRole("link", { name: "Served delivery label", exact: true })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(page.getByRole("status").filter({ hasText: "1 of 98" })).toBeVisible();
    const copied = page.url();
    const selected = new URL(copied);
    for (const [key, value] of query) expect(selected.searchParams.get(key), key).toBe(value);
    expect(selected.searchParams.get("department")).toBe("delivery");
    await page.goto(copied);
    await expect(categories.getByRole("link", { name: "Served delivery label", exact: true })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(page.getByRole("searchbox", { name: "Search definitions" })).toHaveValue("serverexclusivealias");
    await categories.getByRole("link", { name: "Research", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "0 of 98" })).toBeVisible();
    await expect(
      page.getByText("No metric definitions match these filters. No alternative measure was substituted."),
    ).toBeVisible();
    await categories.getByRole("link", { name: "All departments", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "1 of 98" })).toBeVisible();
    const reset = new URL(page.url());
    expect(reset.searchParams.has("department")).toBe(false);
    for (const [key, value] of query) expect(reset.searchParams.get(key), key).toBe(value);
    expect(service.calls.every((url) => url.pathname === "/api/v1/metrics")).toBe(true);
    expect(service.reads).toBe(0);
  } finally {
    await service.close();
  }
});

test("category pages stay bounded at narrow width, announce keyboard paging and restore the selected page", async ({
  page,
}) => {
  let count = 0;
  const service = await catalogService(page, false, (registry) => {
    if (registry.ui_metadata.decision_state !== "candidate") throw new Error("Expected synthetic candidate metadata");
    const departments = registry.ui_metadata.departments;
    const lastOrder = Math.max(...departments.map((entry) => entry.order));
    for (let index = 0; index < 26; index++)
      departments.push({
        id: `additional-${index}`,
        label: `Served additional category ${index}`,
        order: lastOrder + index + 1,
      });
    departments.at(-1)!.label = "Served-long-category-" + "x".repeat(80);
    count = departments.length;
  });
  try {
    await page.setViewportSize({ width: 320, height: 700 });
    const href = "/leaderboards?ui=api&department=additional-25&snapshot=immutable-pin";
    await page.goto(href);
    const categories = page.getByRole("navigation", { name: "Metric categories", exact: true });
    const lastPage = Math.ceil(count / 12);
    const announcement = categories.getByRole("status");
    await expect(announcement).toContainText(`Category page ${lastPage} of ${lastPage}`);
    await expect(categories.locator('a[aria-current="page"]')).toContainText("Served-long-category-");
    expect(await categories.getByRole("link").count()).toBeLessThanOrEqual(13);
    await expect(page.getByRole("status").filter({ hasText: "0 of 98" })).toBeVisible();
    const selected = page.url();
    const calls = service.calls.length;
    await categories.getByRole("button", { name: "Previous categories", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(announcement).toContainText(`Category page ${lastPage - 1} of ${lastPage}`);
    await expect(announcement).toBeFocused();
    expect(await categories.getByRole("link").count()).toBe(13);
    expect(page.url()).toBe(selected);
    expect(service.calls.length).toBe(calls);
    await categories.getByRole("button", { name: "Next categories", exact: true }).click();
    await expect(announcement).toContainText(`Category page ${lastPage} of ${lastPage}`);
    await expect(announcement).toBeFocused();
    await page.goto(selected);
    await expect(announcement).toContainText(`Category page ${lastPage} of ${lastPage}`);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(
      (await new AxeBuilder({ page }).include('nav[aria-label="Metric categories"]').analyze()).violations,
    ).toEqual([]);
    expect(service.calls.every((url) => url.pathname === "/api/v1/metrics")).toBe(true);
    expect(service.reads).toBe(0);
  } finally {
    await service.close();
  }
});

test("unresolved category metadata retains the full catalog without invented category controls", async ({ page }) => {
  const service = await catalogService(page, false, (registry) => {
    registry.ui_metadata = {
      decision_state: "unresolved",
      fields: ["department"],
      note: "Synthetic unresolved metadata",
    };
  });
  try {
    await page.goto("/leaderboards?ui=api&snapshot=immutable-pin");
    await expect(page.getByRole("status").filter({ hasText: "98 of 98" })).toBeVisible();
    await expect(
      page.getByText("Category navigation is unavailable in this registry. The complete metric catalog remains below."),
    ).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Metric categories", includeHidden: true })).toHaveCount(0);
    await expect(page.getByRole("combobox", { name: "Department", exact: true })).toBeDisabled();
    expect(service.calls.every((url) => url.pathname === "/api/v1/metrics")).toBe(true);
    expect(service.reads).toBe(0);
  } finally {
    await service.close();
  }
});

test("requested API scope stays visible across catalog and method navigation without claiming snapshot evidence", async ({
  page,
}) => {
  const service = await catalogService(page);
  const selected = {
    ui: "api",
    organization: "Pick-Your-AI",
    repository: "repo-1",
    branch: "release/Δ=1",
    workstream: "docs",
    context: "current",
    project: "PVT_native",
    start: "2026-10-01T00:00:00.000Z",
    end: "2026-10-18T00:00:00.000Z",
    snapshot: "unavailable-pin",
  };
  const expectRequestedScope = async () => {
    const summary = page.getByRole("region", { name: "Requested scope", exact: true });
    await expect(summary).toBeVisible();
    for (const text of [
      "Date window (UTC)",
      `${selected.start} inclusive`,
      `${selected.end} exclusive`,
      `Organization: ${selected.organization}`,
      `Repository: ${selected.repository}`,
      `Workstream: ${selected.workstream}`,
      `Merge target at merge: ${selected.branch}`,
      `GitHub Project IDs: ${selected.project}`,
      "Membership basis: current at snapshot cutoff",
      "Requested filters only. Availability and published results are checked separately.",
    ])
      await expect(summary).toContainText(text);
    await expect(page.getByRole("region", { name: "Snapshot provenance", exact: true })).toHaveCount(0);
    const editor = page.locator("details").filter({ has: page.getByText("Exact scope and snapshot", { exact: true }) });
    await expect(editor).toHaveJSProperty("open", false);
    await expect(page.getByLabel("GitHub Project IDs", { exact: true })).not.toBeVisible();
    await expect(page.getByLabel("Merge target at merge", { exact: true })).not.toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  };
  try {
    await page.setViewportSize({ width: 320, height: 900 });
    await page.goto(`/leaderboards?${new URLSearchParams(selected)}`);
    await expect(page.getByRole("status").filter({ hasText: "98 of 98" })).toBeVisible();
    await expectRequestedScope();
    const entry = page
      .getByRole("listitem")
      .filter({ has: page.getByRole("link", { name: "PRs merged", exact: true }) });
    await entry.getByRole("link", { name: "Method sheet", exact: true }).press("Enter");
    await expect(page.getByText("Candidate state/date combinations", { exact: true })).toBeVisible();
    await expectRequestedScope();
    const copied = page.url();
    expect(Object.fromEntries(new URL(copied).searchParams)).toMatchObject(selected);
    await page.goBack();
    await expect(page.getByRole("status").filter({ hasText: "98 of 98" })).toBeVisible();
    await expectRequestedScope();
    await page.goForward();
    await expect(page.getByText("Candidate state/date combinations", { exact: true })).toBeVisible();
    await expectRequestedScope();
    await page.goto(copied);
    await expect(page.getByText("Candidate state/date combinations", { exact: true })).toBeVisible();
    await expectRequestedScope();

    const invalid = new URL(copied);
    invalid.searchParams.set("start", "not-a-date");
    const callsBeforeInvalid = service.calls.length;
    await page.goto(invalid.href);
    await expect(page.getByRole("alert")).toContainText("invalid_utc_window");
    await expect(page.getByRole("region", { name: "Requested scope", exact: true })).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Snapshot provenance", exact: true })).toHaveCount(0);
    expect(service.calls).toHaveLength(callsBeforeInvalid);

    await page.goto("/leaderboards?ui=api");
    await expect(page.getByRole("status").filter({ hasText: "98 of 98" })).toBeVisible();
    const summary = page.getByRole("region", { name: "Requested scope", exact: true });
    await expect(summary).toBeVisible();
    await expect(summary).toContainText("All time requested");
    await expect(summary).toContainText("Repository: no repository filter");
    await expect(summary).not.toContainText("Merge target at merge");
    await expect(summary).toContainText("GitHub Project IDs: no Project filter");
    await expect(summary).toContainText("Membership basis: at event time");
    await expect(page.getByRole("region", { name: "Snapshot provenance", exact: true })).toHaveCount(0);
    expect(service.calls.every((url) => url.pathname === "/api/v1/metrics")).toBe(true);
    expect(service.reads).toBe(0);
  } finally {
    await service.close();
  }
});
