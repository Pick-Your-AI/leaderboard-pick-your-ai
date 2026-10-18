import { test, expect, type Page, type Request } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { readFile } from "node:fs/promises";
import { metricRegistryV1 } from "@pick-your-ai/metrics";
import { parseCSVExport } from "../src/remote/csv-export.ts";

test.use({ storageState: { cookies: [], origins: [] } });

const metric = metricRegistryV1.metrics.find((entry) => entry.id === "pr_merged")!;
const comparisonKeys = ["compare", "compareStart", "compareEnd"];
const privateFields = [
  "private-acceptance-secret",
  "SENSITIVE_SYNTHETIC_COMPARISON_PROVIDER_FAILURE",
  "comparisonSignature",
  "backfillRevision",
  "datasetId",
  "currentHistory",
  "previousHistory",
];

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function rankService(page: Page) {
  // Build first. Dynamic import keeps the browser TypeScript project separate
  // from the compiled service and the root synthetic fixture module.
  const module = new URL("../../../tests/fixtures/rank-comparison.mjs", import.meta.url).href;
  const { createRankComparisonHarness } = await import(module);
  const harness = createRankComparisonHarness();
  const requests: URL[] = [];
  type Gate = {
    entered: ReturnType<typeof deferred>;
    release: ReturnType<typeof deferred>;
    done: ReturnType<typeof deferred>;
    request: Request | null;
  };
  let nextBoard: Gate | null = null;
  let nextExport: Gate | null = null;
  const pending = new Set<Gate>();
  await page.route("**/api/v1/**", async (route) => {
    const url = new URL(route.request().url());
    requests.push(url);
    const gate = url.pathname === "/api/v1/boards" ? nextBoard : url.pathname === "/api/v1/exports" ? nextExport : null;
    if (gate) {
      gate.request = route.request();
      if (url.pathname === "/api/v1/boards") nextBoard = null;
      else nextExport = null;
    }
    try {
      // The gate delays a completed real response, never a hand-written body.
      const response = await harness.app.inject({ method: "GET", url: url.pathname + url.search });
      if (gate) {
        gate.entered.resolve();
        await gate.release.promise;
      }
      await route.fulfill({ status: response.statusCode, headers: response.headers, body: response.body });
    } finally {
      if (gate) {
        gate.done.resolve();
        pending.delete(gate);
      }
    }
  });
  return {
    harness,
    requests,
    href(overrides: Record<string, string | null> = {}) {
      const params = new URLSearchParams(harness.params);
      params.set("ui", "api");
      for (const [key, value] of Object.entries(overrides))
        if (value === null) params.delete(key);
        else params.set(key, value);
      return `/leaderboards/pr_merged?${params}`;
    },
    holdNextBoard() {
      if (nextBoard) throw Error("a synthetic board response is already held");
      const gate: Gate = { entered: deferred(), release: deferred(), done: deferred(), request: null };
      nextBoard = gate;
      pending.add(gate);
      return gate;
    },
    holdNextExport() {
      if (nextExport) throw Error("a synthetic export response is already held");
      const gate: Gate = { entered: deferred(), release: deferred(), done: deferred(), request: null };
      nextExport = gate;
      pending.add(gate);
      return gate;
    },
    async close() {
      for (const gate of pending) gate.release.resolve();
      await harness.app.close();
    },
  };
}

function row(page: Page, letter: string) {
  return page.getByRole("row").filter({ has: page.getByRole("link", { name: `synthetic-${letter}`, exact: true }) });
}

async function movement(page: Page, letter: string, rank: string, text: string) {
  await expect(row(page, letter).getByRole("cell").nth(0)).toHaveText(rank);
  await expect(row(page, letter).getByRole("cell").nth(1)).toHaveText(text);
}

function safe(body: string) {
  for (const field of privateFields) expect(body).not.toContain(field);
}

test("real engine movement, dense ties and cursor exports preserve the selected pair", async ({ page }) => {
  const api = await rankService(page);
  try {
    await page.goto(api.href({ limit: "4" }));
    const table = page.getByRole("region", { name: "Published contributions" });
    await expect(table.getByRole("rowheader")).toHaveText(["synthetic-b", "synthetic-a", "synthetic-c", "synthetic-d"]);
    await movement(page, "b", "1", "Up 1 rank");
    await movement(page, "a", "2", "Down 1 rank");
    await movement(page, "c", "3", "New entrant; no previous rank");
    await movement(page, "d", "3", "Rank unchanged");
    const accessibility = await new AxeBuilder({ page }).include("main").analyze();
    expect(accessibility.violations).toEqual([]);
    await expect(page.getByRole("region", { name: "Rank comparison" })).toContainText(
      `Baseline snapshot ${api.harness.beforeId}.`,
    );
    const next = new URL(
      (await page.getByRole("link", { name: "Next cursor page" }).getAttribute("href"))!,
      page.url(),
    );
    for (const key of comparisonKeys) expect(next.searchParams.get(key)).toBe(api.harness.params.get(key));
    expect(next.searchParams.get("snapshot")).toBe(api.harness.afterId);
    expect(next.searchParams.get("limit")).toBe("4");
    expect(next.searchParams.get("cursor")).toBeTruthy();
    await page.getByRole("link", { name: "Next cursor page" }).click();
    await expect(table.getByRole("rowheader")).toHaveText(["synthetic-e"]);
    await movement(page, "e", "3", "Rank unchanged");

    for (const format of ["json", "csv"] as const) {
      const downloaded = page.waitForEvent("download");
      await page.getByRole("button", { name: `Download current ${format.toUpperCase()} page` }).click();
      const file = await downloaded;
      expect(file.suggestedFilename()).toBe(`contributions-${api.harness.afterId}.${format}`);
      const body = await readFile((await file.path())!, "utf8");
      safe(body);
      const request = api.requests.filter((url) => url.pathname === "/api/v1/exports").at(-1)!;
      expect(request.searchParams.get("format")).toBe(format);
      for (const key of ["snapshot", "limit", "cursor", ...comparisonKeys])
        expect(request.searchParams.get(key)).toBe(next.searchParams.get(key));
      const exact = await api.harness.app.inject({ method: "GET", url: request.pathname + request.search });
      expect(exact.statusCode).toBe(200);
      expect(body).toBe(exact.body);
      const document = format === "json" ? JSON.parse(body) : parseCSVExport(body, metric, 4);
      expect(document.snapshotId).toBe(api.harness.afterId);
      expect(document.comparison).toEqual({
        snapshotId: api.harness.beforeId,
        scope: api.harness.previousScope,
        generatedAt: api.harness.previousScope.end,
      });
      expect(document.rows).toHaveLength(1);
      expect(document.rows[0]).toMatchObject({
        actorId: api.harness.actorIds.e,
        rank: 3,
        result: { value: 1 },
        movement: { actorId: api.harness.actorIds.e, state: "comparable", delta: 0, reason: null },
      });
      await expect(page.getByText("Rechecking…")).toHaveCount(0);
    }
  } finally {
    await api.close();
  }
});

test("permalink, proof drawer and browser history retain both windows without leaking filters to proof reads", async ({
  page,
}) => {
  const api = await rankService(page);
  try {
    await page.goto(api.href({ limit: "4" }));
    await movement(page, "b", "1", "Up 1 rank");
    const permalink = new URL(
      (await page.getByRole("link", { name: "Permalink to this snapshot" }).getAttribute("href"))!,
      page.url(),
    );
    for (const key of ["snapshot", "start", "end", ...comparisonKeys])
      expect(permalink.searchParams.get(key)).toBe(api.harness.params.get(key));
    await page.getByRole("link", { name: "Next cursor page" }).click();
    await movement(page, "e", "3", "Rank unchanged");
    const background = page.url();
    const evidenceId = api.harness.pair.current.selected.rows.find(
      (entry: { actorId: string; evidenceIds: string[] }) => entry.actorId === api.harness.actorIds.e,
    ).evidenceIds[0];
    const opener = page.getByRole("link", { name: evidenceId, exact: true });
    await opener.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Contribution evidence" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("heading", { name: "Contribution evidence" })).toBeFocused();
    await expect(dialog.getByRole("link", { name: "Open public source artifact" })).toHaveAttribute(
      "href",
      /^https:\/\/github\.com\/synthetic\/example\/pull\/\d+$/,
    );
    const proofURL = new URL(page.url());
    for (const key of ["snapshot", "cursor", ...comparisonKeys])
      expect(proofURL.searchParams.get(key)).toBe(new URL(background).searchParams.get(key));
    expect(proofURL.searchParams.get("proof")).toBe(evidenceId);
    expect(api.requests.some((url) => url.pathname.endsWith(`/evidence/${evidenceId}`))).toBe(true);
    for (const request of api.requests.filter((url) => !["/api/v1/boards", "/api/v1/exports"].includes(url.pathname)))
      for (const key of comparisonKeys) expect(request.searchParams.has(key)).toBe(false);

    await dialog.getByRole("button", { name: "Close evidence panel" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page).toHaveURL(background);
    await expect(opener).toBeFocused();
    await page.goBack();
    await movement(page, "b", "1", "Up 1 rank");
    await page.goForward();
    await movement(page, "e", "3", "Rank unchanged");
    await expect(page).toHaveURL(background);
    await page.goto(permalink.href);
    await movement(page, "b", "1", "Up 1 rank");
  } finally {
    await api.close();
  }
});

test("selecting, replacing and clearing a baseline cannot restore a delayed earlier comparison", async ({ page }) => {
  const api = await rankService(page);
  try {
    await page.goto(api.href({ compare: null, compareStart: null, compareEnd: null }));
    await expect(row(page, "b")).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Rank movement" })).toHaveCount(0);
    await page.getByText("Compare with a published snapshot", { exact: true }).click();
    await page.getByLabel("Baseline snapshot ID").fill(api.harness.beforeId);
    await page.getByLabel("Baseline start (UTC)").fill(api.harness.previousScope.start);
    await page.getByLabel("Baseline end (UTC)").fill(api.harness.previousScope.end);
    await page.getByRole("button", { name: "Compare ranks", exact: true }).click();
    await movement(page, "b", "1", "Up 1 rank");
    await expect(page.getByText("Rechecking…")).toHaveCount(0);
    const held = api.holdNextBoard();
    await page.getByRole("button", { name: "Recheck current publication controls" }).click();
    await held.entered.promise;
    const cancelled = page.waitForEvent("requestfailed", { predicate: (request) => request === held.request });
    await page.getByLabel("Baseline snapshot ID").fill("synthetic-missing-baseline");
    await page.getByRole("button", { name: "Compare ranks", exact: true }).click();
    expect((await cancelled).failure()?.errorText).toMatch(/aborted/i);
    await expect(page.getByRole("region", { name: "Rank comparison" })).toContainText(
      "The requested baseline is unavailable under current publication controls.",
    );
    held.release.resolve();
    await held.done.promise;
    await expect(row(page, "b")).toContainText(
      "Unavailable: The baseline is missing, expired, revoked or unavailable.",
    );
    await expect(page.getByText("Up 1 rank", { exact: true })).toHaveCount(0);
    expect(new URL(page.url()).searchParams.get("compare")).toBe("synthetic-missing-baseline");
    await page.getByRole("button", { name: "Clear rank comparison" }).click();
    await expect(row(page, "b")).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Rank movement" })).toHaveCount(0);
    const cleared = new URL(page.url());
    for (const key of comparisonKeys) expect(cleared.searchParams.has(key)).toBe(false);
    expect(cleared.searchParams.get("snapshot")).toBe(api.harness.afterId);
    expect(cleared.searchParams.get("start")).toBe(api.harness.scope.start);
    expect(cleared.searchParams.get("end")).toBe(api.harness.scope.end);
  } finally {
    await api.close();
  }
});

for (const scenario of [
  {
    name: "baseline revocation",
    change: (api: Awaited<ReturnType<typeof rankService>>) => api.harness.revoke("previous"),
    text: "Unavailable: The baseline is missing, expired, revoked or unavailable.",
  },
  {
    name: "baseline actor withdrawal",
    change: (api: Awaited<ReturnType<typeof rankService>>) => api.harness.hideBaselineActor(),
    text: "Unavailable: The retained history or visible contributor cohort changed.",
  },
  {
    name: "incomplete baseline source coverage",
    change: (api: Awaited<ReturnType<typeof rankService>>) => {
      api.harness.pair.previous.selected.snapshot.coverage[0].state = "partial";
    },
    text: "Unavailable: Source coverage does not establish complete comparable history.",
  },
  {
    name: "historical backfill",
    change: (api: Awaited<ReturnType<typeof rankService>>) => api.harness.backfill(),
    text: "Unavailable: Historical backfill or reconciliation changed.",
  },
]) {
  test(`${scenario.name} withholds movement while retaining current public values`, async ({ page }) => {
    const api = await rankService(page);
    try {
      await page.goto(api.href());
      await movement(page, "b", "1", "Up 1 rank");
      scenario.change(api);
      await page.getByRole("button", { name: "Recheck current publication controls" }).click();
      await movement(page, "b", "1", scenario.text);
      await movement(page, "a", "2", scenario.text);
      await movement(page, "d", "3", scenario.text);
      await expect(row(page, "b").getByRole("cell").nth(2)).toContainText("4");
      await expect(row(page, "a").getByRole("cell").nth(2)).toContainText("3");
      await expect(page.getByText(/^(Up|Down) \d+ ranks?$/)).toHaveCount(0);
      await expect(page.getByText("Rank unchanged", { exact: true })).toHaveCount(0);
      safe(await page.locator("body").innerText());
    } finally {
      await api.close();
    }
  });
}

test("a privacy recheck prevents a previously authorized delayed export from downloading", async ({ page }) => {
  const api = await rankService(page);
  let downloads = 0;
  page.on("download", () => {
    downloads++;
  });
  try {
    await page.goto(api.href());
    await movement(page, "b", "1", "Up 1 rank");
    const held = api.holdNextExport();
    await page.getByRole("button", { name: "Download current CSV page" }).click();
    await held.entered.promise;
    api.harness.revoke("current");
    await page.getByRole("button", { name: "Recheck current publication controls" }).click();
    await expect(page.getByRole("alert")).toContainText("Selection expired or revoked");
    held.release.resolve();
    await held.done.promise;
    await expect(page.getByRole("region", { name: "Published contributions" })).toHaveCount(0);
    expect(downloads).toBe(0);
    safe(await page.locator("body").innerText());
  } finally {
    await api.close();
  }
});

test("current suppression, provider failure and current revocation revalidate pinned exports and clear stale rows", async ({
  page,
}) => {
  const api = await rankService(page);
  let downloads = 0;
  page.on("download", () => {
    downloads++;
  });
  try {
    await page.goto(api.href());
    await movement(page, "b", "1", "Up 1 rank");
    api.harness.suppressActor();
    const downloaded = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download current CSV page" }).click();
    const body = await readFile((await (await downloaded).path())!, "utf8");
    safe(body);
    const document = parseCSVExport(body, metric, 50) as {
      rows: { actorId: string; movement?: { state: string } }[];
    };
    expect(document.rows.some((entry) => entry.actorId === api.harness.actorIds.a)).toBe(false);
    expect(document.rows).toHaveLength(4);
    expect(document.rows.every((entry) => entry.movement?.state === "unavailable")).toBe(true);
    await expect(row(page, "a")).toHaveCount(0);
    await expect(row(page, "b")).toBeVisible();

    api.harness.fail();
    await page.getByRole("button", { name: "Recheck current publication controls" }).click();
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page.getByRole("region", { name: "Published contributions" })).toHaveCount(0);
    safe(await page.locator("body").innerText());
    api.harness.recover();
    await page.getByRole("button", { name: "Recheck current publication controls" }).click();
    await expect(row(page, "b")).toBeVisible();
    api.harness.revoke("current");
    await page.getByRole("button", { name: "Download current JSON page" }).click();
    await expect(page.getByRole("alert")).toContainText("Selection expired or revoked");
    await expect(page.getByRole("region", { name: "Published contributions" })).toHaveCount(0);
    expect(downloads).toBe(1);
    safe(await page.locator("body").innerText());
  } finally {
    await api.close();
  }
});
