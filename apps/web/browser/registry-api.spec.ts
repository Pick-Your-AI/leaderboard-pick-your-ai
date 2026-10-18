import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";

test.use({ storageState: { cookies: [], origins: [] } });
async function catalogService(page: Page, malformed = false) {
  const registry = JSON.parse(
    await readFile(new URL("../../../packages/metrics/src/v1/registry.json", import.meta.url), "utf8"),
  );
  registry.ui_metadata.metrics.find((entry: { metric_id: string }) => entry.metric_id === "pr_merged").synonyms = [
    "serverexclusivealias",
  ];
  registry.ui_metadata.departments.find((entry: { id: string }) => entry.id === "delivery").label =
    "Served delivery label";
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
    expect(service.reads).toBe(0);
  } finally {
    await service.close();
  }
});
