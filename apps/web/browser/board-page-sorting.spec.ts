import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { readFile } from "node:fs/promises";

test.use({ storageState: { cookies: [], origins: [] } });

async function fixture(page: Page, limit = "4") {
  // The existing synthetic engine fixture and actual service compute every response.
  const { createRankComparisonHarness } = await import(
    new URL("../../../tests/fixtures/rank-comparison.mjs", import.meta.url).href
  );
  const harness = createRankComparisonHarness();
  const calls: URL[] = [];
  await page.route("**/api/v1/**", async (route) => {
    const url = new URL(route.request().url());
    calls.push(url);
    const response = await harness.app.inject({ method: "GET", url: url.pathname + url.search });
    await route.fulfill({ status: response.statusCode, headers: response.headers, body: response.body });
  });
  const params = new URLSearchParams(harness.params);
  params.set("ui", "api");
  params.set("limit", limit);
  return {
    harness,
    calls,
    href: `/leaderboards/pr_merged?${params}`,
    async close() {
      await page.unrouteAll({ behavior: "wait" });
      await harness.app.close();
    },
  };
}
const table = (page: Page) => page.getByRole("region", { name: "Published contributions", exact: true });
const order = (page: Page) => page.getByRole("combobox", { name: "Sort current page", exact: true });
const row = (page: Page, letter: string) =>
  table(page)
    .getByRole("row")
    .filter({ has: page.getByRole("link", { name: `synthetic-${letter}`, exact: true }) });

test("keyboard sorting conserves API ranks, pinned proof, exact export order and tied cursor continuation", async ({
  page,
}) => {
  const api = await fixture(page);
  try {
    await page.goto(api.href);
    await expect(table(page).getByRole("rowheader")).toHaveText([
      "synthetic-b",
      "synthetic-a",
      "synthetic-c",
      "synthetic-d",
    ]);
    const pageUrl = page.url();
    const nextHref = await page.getByRole("link", { name: "Next cursor page", exact: true }).getAttribute("href");
    const boardReads = api.calls.filter((url) => url.pathname.endsWith("/boards")).length;
    await order(page).focus();
    await page.keyboard.press("Home");
    for (let step = 0; step < 3; step++) await page.keyboard.press("ArrowDown");
    await expect(order(page)).toHaveValue("contributor_ascending");
    await expect(table(page).getByRole("rowheader")).toHaveText([
      "synthetic-a",
      "synthetic-b",
      "synthetic-c",
      "synthetic-d",
    ]);
    await expect(table(page).getByRole("columnheader", { name: "Contributor", exact: true })).toHaveAttribute(
      "aria-sort",
      "ascending",
    );
    await expect(row(page, "a").getByRole("cell").nth(0)).toHaveText("2");
    await expect(row(page, "b").getByRole("cell").nth(0)).toHaveText("1");
    for (const letter of ["c", "d"]) await expect(row(page, letter).getByRole("cell").nth(0)).toHaveText("3");
    expect(page.url()).toBe(pageUrl);
    expect(api.calls.filter((url) => url.pathname.endsWith("/boards")).length).toBe(boardReads);
    expect(await page.getByRole("link", { name: "Next cursor page", exact: true }).getAttribute("href")).toBe(nextHref);

    const proofId = api.harness.pair.current.selected.rows.find(
      (entry: { actorId: string }) => entry.actorId === api.harness.actorIds.a,
    ).evidenceIds[0];
    const proof = row(page, "a").getByRole("link", { name: proofId, exact: true });
    await proof.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog", { name: "Contribution evidence", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Contribution evidence", exact: true })).toHaveCount(0);
    await expect(order(page)).toHaveValue("contributor_ascending");
    await expect(proof).toBeFocused();

    const downloading = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download current JSON page", exact: true }).click();
    const body = await readFile((await (await downloading).path())!, "utf8");
    const exported = JSON.parse(body);
    expect(exported.rows.map((entry: { actorId: string }) => entry.actorId)).toEqual(
      ["b", "a", "c", "d"].map((letter) => api.harness.actorIds[letter]),
    );
    const exportRequest = api.calls.filter((url) => url.pathname.endsWith("/exports")).at(-1)!;
    const exact = await api.harness.app.inject({ method: "GET", url: exportRequest.pathname + exportRequest.search });
    expect(body).toBe(exact.body);
    expect(exportRequest.searchParams.get("snapshot")).toBe(api.harness.afterId);
    await page.getByRole("link", { name: "Next cursor page", exact: true }).click();
    await expect(table(page).getByRole("rowheader")).toHaveText(["synthetic-e"]);
    await expect(row(page, "e").getByRole("cell").nth(0)).toHaveText("3");
    await expect(order(page)).toHaveValue("api");
  } finally {
    await api.close();
  }
});

test("mobile cards expose visible keyboard sorting with the same row information and stable ties", async ({
  page,
}, info) => {
  const api = await fixture(page);
  try {
    await page.setViewportSize({ width: 320, height: 800 });
    await page.goto(api.href);
    await expect(row(page, "b")).toBeVisible();
    const contents = Object.fromEntries(
      await Promise.all(["a", "b", "c", "d"].map(async (letter) => [letter, await row(page, letter).innerText()])),
    );
    await expect(order(page)).toBeVisible();
    await order(page).focus();
    await page.keyboard.press("End");
    await expect(order(page)).toHaveValue("value_descending");
    await page.keyboard.press("ArrowUp");
    await expect(order(page)).toHaveValue("value_ascending");
    await expect(table(page).getByRole("rowheader")).toHaveText([
      "synthetic-c",
      "synthetic-d",
      "synthetic-a",
      "synthetic-b",
    ]);
    for (const letter of ["a", "b", "c", "d"]) expect(await row(page, letter).innerText()).toBe(contents[letter]);
    await expect(page.getByRole("status").filter({ hasText: "Current page order:" })).toHaveText(
      "Current page order: Published value: lowest first.",
    );
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    expect((await new AxeBuilder({ page }).include("main").analyze()).violations).toEqual([]);
    await page.screenshot({ path: info.outputPath("board-page-sorting-320px.png"), fullPage: true });
    await page.keyboard.press("Home");
    await expect(order(page)).toHaveValue("api");
    await expect(table(page).getByRole("rowheader")).toHaveText([
      "synthetic-b",
      "synthetic-a",
      "synthetic-c",
      "synthetic-d",
    ]);
  } finally {
    await api.close();
  }
});

test("current suppression and failed reads remove sorted row content and stale sorting controls", async ({ page }) => {
  const api = await fixture(page, "50");
  try {
    await page.goto(api.href);
    await order(page).selectOption("contributor_descending");
    await expect(row(page, "a")).toBeVisible();
    api.harness.suppressActor();
    await page.getByRole("button", { name: "Recheck current publication controls", exact: true }).click();
    await expect(page.getByRole("link", { name: "synthetic-a", exact: true, includeHidden: true })).toHaveCount(0);
    await expect(row(page, "b")).toBeVisible();
    await order(page).selectOption("rank_descending");
    api.harness.fail();
    await page.getByRole("button", { name: "Recheck current publication controls", exact: true }).click();
    const unavailable = page.getByRole("alert");
    await expect(unavailable.getByRole("heading", { name: "Public read unavailable", exact: true })).toBeVisible();
    await expect(unavailable).toContainText("public_projection_unavailable");
    await expect(unavailable).not.toContainText("SENSITIVE_SYNTHETIC_COMPARISON_PROVIDER_FAILURE");
    await expect(
      page.getByRole("region", { name: "Published contributions", exact: true, includeHidden: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("combobox", { name: "Sort current page", exact: true, includeHidden: true }),
    ).toHaveCount(0);
    api.harness.recover();
    await page.getByRole("button", { name: "Recheck current publication controls", exact: true }).click();
    await expect(row(page, "b")).toBeVisible();
    await expect(order(page)).toHaveValue("api");
    await expect(page.getByRole("link", { name: "synthetic-a", exact: true, includeHidden: true })).toHaveCount(0);
  } finally {
    await api.close();
  }
});
