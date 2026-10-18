import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { readFile } from "node:fs/promises";
import { metricRegistryV1 } from "@pick-your-ai/metrics";
import { parseCSVExport } from "../src/remote/csv-export.ts";

test.use({ storageState: { cookies: [], origins: [] } });
const filters = { context: "current", projects: ["PVT_A", "PVT_B="], roles: ["author", "reviewer"] };
const scopeKeys = ["context", "project", "role"];
const comparisonKeys = ["compare", "compareStart", "compareEnd"];
const metric = metricRegistryV1.metrics.find((entry) => entry.id === "pr_merged")!;

async function scopedService(page: Page) {
  const { createRankComparisonHarness } = await import(
    new URL("../../../tests/fixtures/rank-comparison.mjs", import.meta.url).href
  );
  const harness = createRankComparisonHarness(filters);
  const calls: URL[] = [];
  let corrupt = false,
    held = 0,
    released = 0;
  let gate: Promise<void> | null = null;
  let release = () => {};
  await page.route("**/api/v1/**", async (route) => {
    const url = new URL(route.request().url());
    calls.push(url);
    const response = await harness.app.inject({ method: "GET", url: url.pathname + url.search });
    let body = response.body;
    if (corrupt && url.pathname.endsWith("/boards") && response.statusCode === 200) {
      const value = JSON.parse(body);
      value.comparison.scope.context = "event";
      body = JSON.stringify(value);
    }
    if (url.pathname.endsWith("/exports") && gate) {
      held++;
      await gate;
      released++;
    }
    await route.fulfill({ status: response.statusCode, headers: response.headers, body });
  });
  return {
    harness,
    calls,
    href(extra: Record<string, string> = {}) {
      const params = new URLSearchParams(harness.params);
      params.set("ui", "api");
      for (const [key, value] of Object.entries(extra)) params.set(key, value);
      return `/leaderboards/pr_merged?${params}`;
    },
    corrupt() {
      corrupt = true;
    },
    hold() {
      gate = new Promise<void>((done) => {
        release = done;
      });
    },
    release() {
      release();
      gate = null;
    },
    held: () => held,
    released: () => released,
    async close() {
      release();
      await page.unrouteAll({ behavior: "wait" });
      await harness.app.close();
    },
  };
}
const comparison = (page: Page) => page.getByRole("region", { name: "Rank comparison", exact: true });
async function completeBaseline(page: Page) {
  await expect(comparison(page)).toContainText("Membership: current at snapshot cutoff");
  await expect(comparison(page)).toContainText("GitHub Projects: PVT_A, PVT_B=");
  await expect(comparison(page)).toContainText("Contribution roles: Author, Reviewer (any selected)");
}

test("scoped comparison preserves both frozen scopes through cursor proof, timezone and history", async ({ page }) => {
  const api = await scopedService(page);
  try {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(api.href({ limit: "4" }));
    await completeBaseline(page);
    await expect(comparison(page)).toContainText(`Baseline snapshot ${api.harness.beforeId}.`);
    await expect(comparison(page)).toContainText(api.harness.previousScope.start);
    await expect(comparison(page)).toContainText(api.harness.previousScope.end);
    await page.getByRole("link", { name: "Next cursor page", exact: true }).click();
    await expect(page.getByRole("rowheader")).toHaveText(["synthetic-e"]);
    await page.getByRole("link", { name: "synthetic-e1", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Contribution evidence", exact: true });
    const projection = dialog.locator("[data-proof-projection]");
    await expect(projection).toBeVisible();
    const proof = await projection.innerText(),
      before = new URL(page.url());
    expect(before.searchParams.get("cursor")).toBeTruthy();
    await page.getByRole("combobox", { name: "Display timezone", exact: true }).selectOption("America/New_York");
    await expect(projection).toHaveText(proof, { useInnerText: true });
    for (const key of ["snapshot", "cursor", "proof", ...scopeKeys, ...comparisonKeys])
      expect(new URL(page.url()).searchParams.get(key)).toBe(before.searchParams.get(key));
    await expect(comparison(page)).toContainText("Display timezone: America/New_York");
    await page.goBack();
    await expect(page.getByRole("combobox", { name: "Display timezone", exact: true })).toHaveValue("UTC");
    await page.goForward();
    await expect(page.getByRole("combobox", { name: "Display timezone", exact: true })).toHaveValue("America/New_York");
    await page.goto(page.url());
    await expect(projection).toHaveText(proof, { useInnerText: true });
    await completeBaseline(page);
    await dialog.getByRole("button", { name: "Close evidence panel", exact: true }).click();
    expect((await new AxeBuilder({ page }).include("main").analyze()).violations).toEqual([]);
    for (const url of api.calls.filter((url) => !url.pathname.endsWith("/metrics"))) {
      for (const key of scopeKeys) expect(url.searchParams.get(key)).toBe(api.harness.params.get(key));
      expect(url.searchParams.has("tz")).toBe(false);
      if (!url.pathname.endsWith("/boards") && !url.pathname.endsWith("/exports"))
        for (const key of comparisonKeys) expect(url.searchParams.has(key)).toBe(false);
    }
  } finally {
    await api.close();
  }
});

test("scoped comparison downloads retain exact v3 source bytes and tied cursor selection", async ({ page }) => {
  const api = await scopedService(page);
  try {
    await page.goto(api.href({ limit: "2", tz: "America/New_York" }));
    await completeBaseline(page);
    await page.getByRole("link", { name: "Next cursor page", exact: true }).click();
    await expect(page.getByRole("rowheader")).toHaveText(["synthetic-c", "synthetic-d"]);
    const selection = new URL(page.url());
    for (const format of ["json", "csv"] as const) {
      const download = page.waitForEvent("download");
      await page.getByRole("button", { name: `Download current ${format.toUpperCase()} page`, exact: true }).click();
      const file = await download,
        raw = await readFile((await file.path())!, "utf8");
      const request = api.calls.filter((url) => url.pathname.endsWith("/exports")).at(-1)!;
      for (const key of ["snapshot", "cursor", ...scopeKeys, ...comparisonKeys])
        expect(request.searchParams.get(key)).toBe(selection.searchParams.get(key));
      const original = await api.harness.app.inject(request.pathname + request.search);
      expect(original.statusCode).toBe(200);
      expect(raw).toBe(original.body);
      const document = format === "json" ? JSON.parse(raw) : (parseCSVExport(raw, metric, 2) as Record<string, any>);
      expect(document.exportSchemaVersion).toBe("public-export/v3");
      expect(document.scope).toEqual(api.harness.scope);
      expect(document.comparison.scope).toEqual(api.harness.previousScope);
      expect(document.rows.map((row: { rank: number }) => row.rank)).toEqual([3, 3]);
      expect(document.rows[0].movement.state).toBe("new_entrant");
      expect(document.rows[1].movement).toEqual({
        actorId: api.harness.actorIds.d,
        state: "comparable",
        delta: 0,
        reason: null,
      });
      for (const privateField of [
        "private-acceptance-secret",
        "comparisonSignature",
        "backfillRevision",
        "currentHistory",
        "previousHistory",
      ])
        expect(raw).not.toContain(privateField);
    }
  } finally {
    await api.close();
  }
});

test("a substituted baseline membership stays unavailable and never falls back to an ordinary board", async ({
  page,
}) => {
  const api = await scopedService(page);
  try {
    await page.goto(api.href());
    await completeBaseline(page);
    api.corrupt();
    await page.getByRole("button", { name: "Recheck current publication controls", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("invalid_rank_comparison");
    await expect(page.getByRole("region", { name: "Published contributions", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Retry this selection", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("invalid_rank_comparison");
    const last = api.calls.filter((url) => url.pathname.endsWith("/boards")).at(-1)!;
    for (const key of [...scopeKeys, ...comparisonKeys])
      expect(last.searchParams.get(key)).toBe(api.harness.params.get(key));
  } finally {
    await api.close();
  }
});

test("a held scoped comparison export cannot survive a role change", async ({ page }) => {
  const api = await scopedService(page);
  let downloads = 0;
  page.on("download", () => {
    downloads++;
  });
  try {
    await page.goto(api.href());
    await completeBaseline(page);
    api.hold();
    await page.getByRole("button", { name: "Download current CSV page", exact: true }).click();
    await expect.poll(api.held).toBe(1);
    await page.getByText("Exact scope and snapshot", { exact: true }).click();
    await page.getByRole("checkbox", { name: "Author", exact: true }).uncheck();
    await page.getByRole("button", { name: "Read exact scope", exact: true }).click();
    await expect(page.getByRole("alert")).toBeVisible();
    expect(new URL(page.url()).searchParams.get("role")).toBe("reviewer");
    expect(new URL(page.url()).searchParams.get("snapshot")).toBeNull();
    api.release();
    await expect.poll(api.released).toBe(1);
    await page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
    );
    expect(downloads).toBe(0);
    await expect(page.getByRole("region", { name: "Published contributions", exact: true })).toHaveCount(0);
  } finally {
    await api.close();
  }
});
