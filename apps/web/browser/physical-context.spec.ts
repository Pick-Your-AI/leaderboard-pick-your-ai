import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { readFile } from "node:fs/promises";
import { parseCSVExport } from "../src/remote/csv-export.ts";

test.use({ storageState: { cookies: [], origins: [] } });

async function fixture(page: Page, metricId = "pr_lines_added") {
  // Fictional source passes through the stock normalizer and actual service.
  // No response body, privacy result or physical subtotal is hand-written here.
  const { createPhysicalContextHarness, physicalSnapshotId } = await import(
    new URL("../../../tests/fixtures/physical-context.mjs", import.meta.url).href
  );
  const harness = createPhysicalContextHarness({ metricId });
  const calls: URL[] = [];
  await page.route("**/api/v1/**", async (route) => {
    const url = new URL(route.request().url());
    calls.push(url);
    const response = await harness.app.inject({ method: "GET", url: url.pathname + url.search });
    await route.fulfill({ status: response.statusCode, headers: response.headers, body: response.body });
  });
  const board = await harness.app.inject(`/api/v1/boards?metric=${metricId}&snapshot=${physicalSnapshotId}`);
  if (board.statusCode !== 200) {
    await page.unrouteAll({ behavior: "wait" });
    await harness.app.close();
    throw new Error(`Synthetic physical fixture returned ${board.statusCode}: ${board.body}`);
  }
  return {
    harness,
    calls,
    board: board.json(),
    snapshotId: physicalSnapshotId,
    href: `/leaderboards/${metricId}?ui=api&snapshot=${physicalSnapshotId}`,
    async close() {
      // Dispose focus/refresh handlers while the synthetic API is still routed.
      await page.goto("about:blank");
      await page.unrouteAll({ behavior: "wait" });
      await harness.app.close();
    },
  };
}

const table = (page: Page) => page.getByRole("region", { name: "Published contributions", exact: true });
const row = (page: Page) =>
  table(page)
    .getByRole("row")
    .filter({ has: page.getByRole("link", { name: "synthetic-author", exact: true }) });
const context = (page: Page) => row(page).getByRole("group", { name: "Change-size context", exact: true });
const recheck = (page: Page) => page.getByRole("button", { name: "Recheck current publication controls", exact: true });

async function download(page: Page, api: Awaited<ReturnType<typeof fixture>>, format: "json" | "csv") {
  const pending = page.waitForEvent("download");
  await page.getByRole("button", { name: `Download current ${format.toUpperCase()} page`, exact: true }).click();
  const file = await pending;
  const body = await readFile((await file.path())!, "utf8");
  const request = api.calls.filter((url) => url.pathname.endsWith("/exports")).at(-1)!;
  expect(request.searchParams.get("snapshot")).toBe(api.snapshotId);
  expect(request.searchParams.get("format")).toBe(format);
  const exact = await api.harness.app.inject({ method: "GET", url: request.pathname + request.search });
  expect(exact.statusCode, exact.body).toBe(200);
  expect(body).toBe(exact.body);
  return format === "json" ? JSON.parse(body) : parseCSVExport(body, api.board.metric, 50);
}

test("keyboard inspection keeps source pins, selected evidence and both exports on the same physical sample", async ({
  page,
}) => {
  const api = await fixture(page);
  try {
    const original = structuredClone(api.board.rows[0]);
    await page.goto(api.href);
    await expect(context(page)).toContainText("17 added lines; 8 removed lines; +9 net lines");
    await expect(context(page)).toContainText("25 changed lines; 3 file changes");
    await expect(context(page)).toContainText(
      "1 verified default-branch integration sample; 1 selected evidence record",
    );
    await expect(context(page)).toContainText("88 added lines; 56 removed lines; 9 file changes");
    await expect(context(page)).toContainText("6 file changes; 71 added lines; 48 removed lines");
    await expect(context(page)).toContainText("Source-history coverage and freshness remain those shown for the board");
    await expect(row(page).getByRole("cell").nth(0)).toHaveText("Unranked");
    await expect(row(page).getByRole("cell").nth(1)).toContainText("17");
    const detail = context(page).locator("details");
    await expect(detail).not.toHaveAttribute("open");
    const summary = context(page).locator("summary");
    await summary.focus();
    await page.keyboard.press("Enter");
    await expect(detail).toHaveAttribute("open", "");
    await expect(detail.locator("dt")).toHaveText([
      "Source",
      "Tests",
      "Documentation",
      "Generated",
      "Vendor",
      "Lockfiles",
      "Binary",
      "Imported",
    ]);
    const sample = original.physicalContext.samples[0];
    await expect(detail.getByRole("link", { name: /^Before revision / })).toHaveAttribute("href", sample.beforeUrl);
    await expect(detail.getByRole("link", { name: /^After revision / })).toHaveAttribute("href", sample.afterUrl);
    await expect(detail.locator("time")).toHaveAttribute("datetime", sample.integratedAt);
    for (const id of sample.evidenceIds)
      await expect(row(page).getByRole("link", { name: id, exact: true })).toHaveCount(1);
    for (const format of ["json", "csv"] as const) {
      const exported = await download(page, api, format);
      expect(exported.exportSchemaVersion).toBe("public-export/v4");
      expect(exported.rows[0].physicalContext).toEqual(original.physicalContext);
      expect(exported.rows[0].result.value).toBe(original.result.value);
      expect(exported.rows[0].evidenceIds).toEqual(original.evidenceIds);
      expect(exported.rows[0].rank).toBeNull();
      expect(exported.coverage[0].state).toBe("partial");
    }
    await summary.focus();
    await page.keyboard.press("Space");
    await expect(detail).not.toHaveAttribute("open");
    await expect(summary).toBeFocused();
  } finally {
    await api.close();
  }
});

test("current dependency loss, suppression and failed reads remove stale physical counts and recover truthfully", async ({
  page,
}) => {
  const api = await fixture(page);
  try {
    await page.goto(api.href);
    await expect(context(page)).toContainText("17 added lines");
    const proofs = structuredClone(api.harness.input.selected.physicalEvidence);
    api.harness.input.selected.physicalEvidence = [];
    await recheck(page).click();
    await expect(context(page)).toContainText("unavailable under current publication controls");
    await expect(context(page)).toContainText("Missing context does not mean zero change");
    await expect(context(page)).not.toContainText("17 added lines");
    await expect(context(page).getByRole("link", { includeHidden: true })).toHaveCount(0);
    await expect(context(page).locator("details")).toHaveCount(0);
    await expect(row(page).getByRole("cell").nth(1)).toContainText("17");
    for (const format of ["json", "csv"] as const) {
      const exported = await download(page, api, format);
      const withheld = exported.rows[0].physicalContext;
      expect(withheld.state).toBe("unknown");
      expect(withheld.reason).toBe("current_context_unavailable");
      for (const key of ["summary", "samples", "sampleCount", "unitCount"]) expect(withheld).not.toHaveProperty(key);
      expect(exported.rows[0].result.value).toBe(17);
    }
    api.harness.input.controls.suppressedActorIds = ["101"];
    await recheck(page).click();
    await expect(page.getByRole("link", { name: "synthetic-author", exact: true, includeHidden: true })).toHaveCount(0);
    await expect(page.getByRole("group", { name: "Change-size context", includeHidden: true })).toHaveCount(0);
    api.harness.input.controls.suppressedActorIds = [];
    api.harness.input.selected.physicalEvidence = proofs;
    await recheck(page).click();
    await expect(context(page)).toContainText("17 added lines");
    api.harness.fail();
    await recheck(page).click();
    const unavailable = page.getByRole("alert");
    await expect(unavailable.getByRole("heading", { name: "Public read unavailable", exact: true })).toBeVisible();
    await expect(unavailable).toContainText("public_projection_unavailable");
    await expect(unavailable).not.toContainText("synthetic-private-source-failure");
    await expect(page.getByRole("group", { name: "Change-size context", includeHidden: true })).toHaveCount(0);
    api.harness.fail(false);
    await recheck(page).click();
    await expect(context(page)).toContainText("17 added lines; 8 removed lines; +9 net lines");
  } finally {
    await api.close();
  }
});

test("320px cards keep descriptive file units distinct from PR samples with accessible expanded classification", async ({
  page,
}, info) => {
  const api = await fixture(page, "files_changed");
  try {
    await page.setViewportSize({ width: 320, height: 800 });
    await page.goto(api.href);
    await expect(context(page)).toContainText(
      "1 verified default-branch integration sample; 3 selected evidence records",
    );
    await expect(row(page).getByRole("cell").nth(0)).toHaveText("Unranked");
    await expect(row(page).getByRole("cell").nth(1)).toContainText("3");
    await expect(page.getByText("Descriptive values; no rank is assigned.", { exact: true })).toBeVisible();
    const summary = context(page).locator("summary");
    await summary.focus();
    await page.keyboard.press("Enter");
    await expect(context(page).locator("details")).toHaveAttribute("open", "");
    await expect(context(page).getByRole("link", { name: /^Before revision / })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    expect((await new AxeBuilder({ page }).include("main").analyze()).violations).toEqual([]);
    await page.screenshot({ path: info.outputPath("physical-context-320px.png"), fullPage: true });
    const exported = await download(page, api, "csv");
    expect(exported.rows[0].physicalContext).toEqual(api.board.rows[0].physicalContext);
    expect(exported.rows[0].rank).toBeNull();
  } finally {
    await api.close();
  }
});
