import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import type { PublicScope, PublicWindow, PublicWindowPeriod } from "@pick-your-ai/contracts";

test.use({ storageState: { cookies: [], origins: [] } });
const filters = {
  organization: "Pick-Your-AI",
  repository: "2",
  workstream: "w1",
  context: "current",
  project: "PVT_A,PVT_B=",
  role: "author",
  actors: "user",
  metric: "pr_merged",
  tz: "America/New_York",
};
const start = (extra: Record<string, string> = {}) => `/start?${new URLSearchParams({ ...filters, ...extra })}`;
const provenance = (page: Page) => page.getByRole("region", { name: "Snapshot provenance" });
const picker = (page: Page) => page.getByRole("region", { name: "Published date windows", exact: true });
async function openPicker(page: Page) {
  if (!(await picker(page).isVisible()))
    await page.getByText("Choose a published date window", { exact: true }).click();
  await expect(picker(page)).toBeVisible();
}
const utcPeriods: PublicWindowPeriod[] = ["7d", "30d", "90d", "month", "quarter", "year", "all"];

type FixtureOptions = {
  filter?: PublicScope;
  periods?: PublicWindowPeriod[];
  cutoff?: string;
  custom?: { start: string; end: string }[];
};
function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
// Calls the actual service and metric engine over finite, predeclared synthetic publications.
async function service(page: Page, options: FixtureOptions = {}) {
  const { createService } = await import(new URL("../../service/dist/app.js", import.meta.url).href);
  const { publishedWindowFixture } = await import(
    new URL("../../../tests/fixtures/published-windows.mjs", import.meta.url).href
  );
  const fixture = publishedWindowFixture(options);
  const app = createService({ source: fixture.source });
  const calls: URL[] = [];
  const responses: { url: URL; status: number; body: string }[] = [];
  let gate: Promise<void> | null = null;
  let closing = false;
  let release = () => {};
  type ExportGate = {
    entered: ReturnType<typeof deferred>;
    release: ReturnType<typeof deferred>;
    done: ReturnType<typeof deferred>;
  };
  let nextExport: ExportGate | null = null;
  const exports = new Set<ExportGate>();
  await page.addInitScript(() => {
    const state = window as unknown as { windowStreamAttempts: number };
    state.windowStreamAttempts = 0;
    const NativeEventSource = window.EventSource;
    window.EventSource = class extends NativeEventSource {
      constructor(url: string | URL, options?: EventSourceInit) {
        state.windowStreamAttempts++;
        super(url, options);
      }
    };
  });
  await page.route("**/api/v1/**", async (route) => {
    if (closing) {
      await route.abort();
      return;
    }
    const url = new URL(route.request().url());
    calls.push(url);
    if (url.pathname.endsWith("/updates")) {
      await route.abort();
      return;
    }
    const heldExport = url.pathname.endsWith("/exports") ? nextExport : null;
    if (heldExport) nextExport = null;
    try {
      const response = await app.inject({ method: "GET", url: url.pathname + url.search });
      responses.push({ url, status: response.statusCode, body: response.body });
      if (heldExport) {
        heldExport.entered.resolve();
        await heldExport.release.promise;
      }
      if (url.pathname.endsWith("/windows") && gate) await gate;
      if (closing) {
        await route.abort();
        return;
      }
      await route.fulfill({ status: response.statusCode, headers: response.headers, body: response.body });
    } finally {
      if (heldExport) {
        heldExport.done.resolve();
        exports.delete(heldExport);
      }
    }
  });
  return {
    fixture,
    calls,
    responses,
    holdWindows() {
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    releaseWindows() {
      release();
      gate = null;
    },
    holdNextExport() {
      if (nextExport) throw new Error("a synthetic export response is already held");
      const held = { entered: deferred(), release: deferred(), done: deferred() };
      nextExport = held;
      exports.add(held);
      return held;
    },
    async close() {
      closing = true;
      release();
      for (const held of exports) held.release.resolve();
      await app.close();
    },
  };
}
function expectScope(url: URL, scope: PublicScope) {
  expect(url.searchParams.get("organization")).toBe(scope.organization);
  expect(url.searchParams.get("repository")).toBe(scope.repository);
  expect(url.searchParams.get("workstream")).toBe(scope.workstream);
  expect(url.searchParams.get("context")).toBe(scope.context ?? null);
  expect(url.searchParams.get("project")).toBe(scope.projects?.join(",") ?? null);
  expect(url.searchParams.get("role")).toBe(scope.roles?.join(",") ?? null);
  expect(url.searchParams.get("start")).toBe(scope.start);
  expect(url.searchParams.get("end")).toBe(scope.end);
}
async function expectWindow(page: Page, window: PublicWindow) {
  await expect.poll(() => new URL(page.url()).searchParams.get("snapshot")).toBe(window.snapshotId);
  const url = new URL(page.url());
  expect(url.pathname).toBe("/leaderboards/pr_merged");
  expectScope(url, window.scope);
  expect(url.searchParams.get("actors")).toBe("user");
  expect(url.searchParams.get("tz")).toBe("America/New_York");
  for (const key of ["period", "cursor", "proof"]) expect(url.searchParams.has(key)).toBe(false);
  await expect(provenance(page)).toContainText(window.snapshotId);
  await expect(provenance(page)).toContainText("Membership: current at snapshot cutoff");
  await expect(provenance(page)).toContainText(`GitHub Projects: ${window.scope.projects!.join(", ")}`);
}
async function downloadJSON(page: Page) {
  const pending = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download current JSON page", exact: true }).click();
  const stream = await (await pending).createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8");
  return { raw, value: JSON.parse(raw) };
}

test("new entry resolves confirmed last 30 days before any reader and overrides only explicit entry mode", async ({
  page,
}) => {
  const api = await service(page);
  api.holdWindows();
  await page.addInitScript(() => localStorage.setItem("pyai.ui.mode", "prototype"));
  try {
    await page.goto(start());
    await expect(page.getByRole("heading", { name: "Browse public contribution evidence", exact: true })).toBeVisible();
    await expect(picker(page).getByRole("status")).toContainText("Checking published date windows");
    await expect.poll(() => api.calls.length).toBeGreaterThan(0);
    expect(api.calls.every((url) => url.pathname === "/api/v1/windows")).toBe(true);
    expect(api.fixture.calls.reads).toEqual([]);
    expect(
      await page.evaluate(() => (window as unknown as { windowStreamAttempts: number }).windowStreamAttempts),
    ).toBe(0);
    for (const url of api.calls) {
      expectScope(url, api.fixture.filter);
      for (const key of ["actors", "metric", "tz", "period", "snapshot", "cursor", "compare"])
        expect(url.searchParams.has(key)).toBe(false);
    }
    api.releaseWindows();
    const expected = api.fixture.descriptor("30d");
    await expectWindow(page, expected);
    const board = api.calls.filter((url) => url.pathname.endsWith("/boards")).at(-1)!;
    expectScope(board, expected.scope);
    expect(board.searchParams.get("snapshot")).toBe(expected.snapshotId);
    expect(board.searchParams.has("tz")).toBe(false);
    const brand = page.getByRole("link", { name: "PickYour.AI Credits", exact: true });
    expect(new URL((await brand.getAttribute("href"))!, page.url()).pathname).toBe("/start");
    await expect(brand).not.toHaveAttribute("data-api-nav");
    await expect(
      page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Browse", exact: true }),
    ).toBeVisible();
  } finally {
    await api.close();
  }
});

test("an unavailable default waits for an explicit published choice without all-time fallback", async ({ page }) => {
  const api = await service(page, { periods: ["7d", "all"] });
  try {
    await page.goto(start());
    await expect(picker(page).getByRole("alert")).toContainText("Last 30 days is unavailable");
    expect(new URL(page.url()).pathname).toBe("/start");
    expect(api.fixture.calls.reads).toEqual([]);
    expect(api.calls.every((url) => url.pathname.endsWith("/windows"))).toBe(true);
    await picker(page).getByRole("combobox", { name: "Date window", exact: true }).selectOption("7d");
    expect(api.fixture.calls.reads).toEqual([]);
    await picker(page).getByRole("button", { name: "Open published window", exact: true }).press("Enter");
    await expectWindow(page, api.fixture.descriptor("7d"));
    expect(
      api.calls.filter((url) => url.pathname.endsWith("/boards")).every((url) => url.searchParams.has("start")),
    ).toBe(true);
  } finally {
    await api.close();
  }
});

test("ordinary undated links stay unchanged and all seven presets retain exact confirmed scope and export bytes", async ({
  page,
}) => {
  const api = await service(page);
  try {
    const legacy = `/leaderboards/pr_merged?${new URLSearchParams({ ui: "api", ...filters })}`;
    await page.goto(legacy);
    await expect(provenance(page)).toBeVisible();
    const original = new URL(page.url());
    expect(original.searchParams.has("start")).toBe(false);
    expect(original.searchParams.has("end")).toBe(false);
    expect(original.searchParams.has("snapshot")).toBe(false);
    expect(api.calls.some((url) => url.pathname.endsWith("/windows"))).toBe(false);
    await openPicker(page);
    await expect(picker(page).getByRole("combobox", { name: "Date window", exact: true })).toHaveValue("");
    for (const period of utcPeriods) {
      await openPicker(page);
      await picker(page).getByRole("combobox", { name: "Date window", exact: true }).selectOption(period);
      await picker(page).getByRole("button", { name: "Open published window", exact: true }).click();
      const expected = api.fixture.descriptor(period);
      await expectWindow(page, expected);
      const copy = page.url();
      await page.goto(copy);
      await expectWindow(page, expected);
    }
    const expected = api.fixture.descriptor("all");
    const { raw, value } = await downloadJSON(page);
    expect(value.exportSchemaVersion).toBe("public-export/v3");
    expect(value.scope).toEqual(expected.scope);
    expect(value.snapshotId).toBe(expected.snapshotId);
    expect(raw).toBe(api.responses.filter((response) => response.url.pathname.endsWith("/exports")).at(-1)!.body);
    api.holdWindows();
    let entryDocuments = 0;
    await page.route(
      (url) => url.pathname === "/start",
      async (route) => {
        expect(route.request().isNavigationRequest()).toBe(true);
        expect(route.request().frame()).toBe(page.mainFrame());
        entryDocuments++;
        // Start observing before the new document can run, after the old page's export revalidation.
        api.calls.length = 0;
        api.fixture.calls.reads.length = 0;
        await route.continue();
      },
      { times: 1 },
    );
    await page.getByRole("link", { name: "PickYour.AI Credits", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Browse public contribution evidence", exact: true })).toBeVisible();
    expect(entryDocuments).toBe(1);
    await expect.poll(() => api.calls.length).toBeGreaterThan(0);
    expect(api.calls.every((url) => url.pathname.endsWith("/windows"))).toBe(true);
    expect(api.fixture.calls.reads).toEqual([]);
    expect(
      await page.evaluate(() => (window as unknown as { windowStreamAttempts: number }).windowStreamAttempts),
    ).toBe(0);
    api.releaseWindows();
    await expectWindow(page, api.fixture.descriptor("30d"));
    await page.goBack();
    await expectWindow(page, expected);
  } finally {
    await api.close();
  }
});

for (const [cutoff, periods] of [
  ["2026-01-15T12:00:00.000Z", ["month", "quarter", "year"]],
  ["2026-02-15T12:00:00.000Z", ["quarter", "year"]],
] as const) {
  test(`separately approved calendar labels share only their exact concrete publication at ${cutoff}`, async ({
    page,
  }) => {
    const api = await service(page, { cutoff });
    try {
      await page.goto(start({ period: periods[0] }));
      const expected = api.fixture.descriptor(periods[0]);
      await expectWindow(page, expected);
      for (const period of periods.slice(1)) {
        expect(api.fixture.descriptor(period)).toMatchObject({
          scope: expected.scope,
          snapshotId: expected.snapshotId,
          revision: expected.revision,
        });
        await openPicker(page);
        await picker(page).getByRole("combobox", { name: "Date window", exact: true }).selectOption(period);
        await picker(page).getByRole("button", { name: "Open published window", exact: true }).click();
        await expectWindow(page, api.fixture.descriptor(period));
      }
    } finally {
      await api.close();
    }
  });
}

for (const [name, bounds] of [
  ["spring-forward", { start: "2026-03-08T06:30:00.000Z", end: "2026-03-08T07:30:00.000Z" }],
  ["fall-back", { start: "2025-11-02T05:30:00.000Z", end: "2025-11-02T06:30:00.000Z" }],
] as const) {
  test(`registry-only custom entry preserves half-open UTC counting through ${name}, display change and export`, async ({
    page,
  }, testInfo) => {
    const api = await service(page, { periods: [], custom: [bounds] });
    try {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(start());
      await expect(
        picker(page).getByText("No date windows are published for this selection.", { exact: true }),
      ).toBeVisible();
      await page.getByRole("link", { name: "Browse measures or enter custom UTC dates", exact: true }).click();
      await expect(page.getByRole("region", { name: "Metric discovery", exact: true })).toBeVisible();
      expect(new URL(page.url()).pathname).toBe("/leaderboards");
      expect(api.fixture.calls.reads).toEqual([]);
      expect(api.calls.every((url) => ["/api/v1/windows", "/api/v1/metrics"].includes(url.pathname))).toBe(true);
      expect(
        await page.evaluate(() => (window as unknown as { windowStreamAttempts: number }).windowStreamAttempts),
      ).toBe(0);
      await page.getByText("Exact scope and snapshot", { exact: true }).click();
      await page.getByRole("textbox", { name: "start", exact: true }).fill(bounds.start);
      await page.getByRole("textbox", { name: "end", exact: true }).fill(bounds.end);
      await page.getByRole("button", { name: "Read exact scope", exact: true }).click();
      await expect(page.getByRole("region", { name: "Metric discovery", exact: true })).toBeVisible();
      expect(api.fixture.calls.reads).toEqual([]);
      const link = page.locator('a[data-api-nav][href^="/leaderboards/pr_merged?"]');
      await expect(link).toHaveCount(1);
      await link.click();
      await expect(provenance(page)).toBeVisible();
      const expected = api.fixture.customRead(bounds);
      const url = new URL(page.url());
      expectScope(url, expected.selected.scope);
      const before = api.responses.filter((response) => response.url.pathname.endsWith("/boards")).at(-1)!;
      expect(before.status).toBe(200);
      const rows = JSON.parse(before.body).rows;
      expect(rows).toHaveLength(1);
      expect(rows[0].result.value).toBe(2);
      expect(rows[0].evidenceIds).toEqual(["synthetic-101-1", "synthetic-101-2"]);
      await expect(page.getByRole("link", { name: "synthetic-101-0", exact: true })).toHaveCount(0);
      await expect(page.getByRole("link", { name: "synthetic-101-3", exact: true })).toHaveCount(0);
      const local = await provenance(page).innerText();
      await page.getByRole("combobox", { name: "Display timezone", exact: true }).selectOption("UTC");
      await expect(provenance(page)).toContainText(bounds.start);
      await expect(provenance(page)).toContainText(bounds.end);
      expect(await provenance(page).innerText()).not.toBe(local);
      for (const key of ["start", "end", "context", "project", "role", "actors"])
        expect(new URL(page.url()).searchParams.get(key)).toBe(url.searchParams.get(key));
      const { raw, value } = await downloadJSON(page);
      expect(value.scope).toEqual(expected.selected.scope);
      expect(value.rows[0].result.value).toBe(2);
      expect(raw).toBe(api.responses.filter((response) => response.url.pathname.endsWith("/exports")).at(-1)!.body);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      expect(
        (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations,
      ).toEqual([]);
      await page.screenshot({ path: testInfo.outputPath(`custom-${name}-390px.png`), fullPage: true });
    } finally {
      await api.close();
    }
  });
}

test("entry rejects retained pins and over-budget links before any discovery or live access", async ({ page }) => {
  const api = await service(page);
  try {
    for (const url of [start({ snapshot: "synthetic-old" }), start({ compare: "synthetic-old" })]) {
      await page.goto(url);
      await expect(page.getByRole("alert")).toContainText("invalid");
      expect(api.calls).toEqual([]);
    }
    const response = await page.goto(`/start?${"a".repeat(48 * 1024 - 6)}`);
    expect(response!.status()).toBe(414);
    await expect(page.locator("body")).toContainText("query_too_large");
    expect(api.calls).toEqual([]);
    expect(
      await page.evaluate(() => (window as unknown as { windowStreamAttempts: number }).windowStreamAttempts),
    ).toBe(0);
  } finally {
    await api.close();
  }
});

test("a selected publication withdrawn after discovery stays unavailable without another window", async ({ page }) => {
  const api = await service(page);
  try {
    await page.goto(start());
    const selected = api.fixture.descriptor("30d");
    await expectWindow(page, selected);
    await expect(page.getByRole("link", { name: "synthetic-pending-101", exact: true })).toBeVisible();
    api.fixture.withdraw("30d");
    await page.getByRole("button", { name: "Recheck current publication controls", exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: "snapshot_expired_refetch" })).toBeVisible();
    const response = api.responses.filter((value) => value.url.pathname.endsWith("/boards")).at(-1)!;
    expect(response.status).toBe(410);
    expect(JSON.parse(response.body)).toEqual({ error: "snapshot_expired_refetch" });
    expect(new URL(page.url()).searchParams.get("snapshot")).toBe(selected.snapshotId);
    for (const url of api.calls.filter((value) => value.pathname.endsWith("/boards"))) expectScope(url, selected.scope);
    await expect(page.getByRole("link", { name: "synthetic-pending-101", exact: true })).toHaveCount(0);
  } finally {
    await api.close();
  }
});

test("a failed deferred window entry preserves the requested link and static unknown state", async ({ page }) => {
  let blocked = 0;
  let reads = 0;
  const requested = start();
  await page.route("**/*", (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path.startsWith("/api/v1/")) reads++;
    if (request.resourceType() === "script" && /\/assets\/PublishedWindows-[^/]+\.js$/.test(path)) {
      blocked++;
      return route.abort("failed");
    }
    return route.continue();
  });
  await page.goto(requested);
  await expect.poll(() => blocked).toBeGreaterThan(0);
  await expect(page.getByRole("main", { name: "Live data has not loaded" })).toBeVisible();
  await expect(page.getByRole("table")).toHaveCount(0);
  expect(new URL(page.url()).pathname + new URL(page.url()).search).toBe(requested);
  expect(reads).toBe(0);
});

test("entering Browse cancels a held export before the next document can commit", async ({ page }) => {
  const api = await service(page);
  const documentEntered = deferred();
  const documentRelease = deferred();
  const entryObserved = deferred();
  let requestAborted: boolean | null = null;
  let downloadAttempts = 0;
  let downloads = 0;
  page.on("download", () => downloads++);
  await page.exposeFunction("recordWindowEntry", (aborted: boolean | null) => {
    requestAborted = aborted;
    entryObserved.resolve();
  });
  await page.exposeFunction("recordWindowExportDownload", () => downloadAttempts++);
  await page.addInitScript(() => {
    const state = window as unknown as {
      recordWindowEntry: (aborted: boolean | null) => Promise<void>;
      recordWindowExportDownload: () => Promise<void>;
    };
    let exportSignal: AbortSignal | null = null;
    const nativeFetch = window.fetch;
    window.fetch = (input, init) => {
      if (new URL(String(input), location.href).pathname.endsWith("/exports")) exportSignal = init?.signal ?? null;
      return nativeFetch(input, init);
    };
    // The document listener runs after the reader's delegated React click handler.
    // Capture the actual request signal now: evaluating the old document later
    // can wait behind Chromium's provisional full-document navigation.
    document.addEventListener("click", (event) => {
      if (
        (event.target as Element).closest("a[data-window-entry]") &&
        !event.defaultPrevented &&
        event.button === 0 &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.shiftKey &&
        !event.altKey
      )
        void state.recordWindowEntry(exportSignal?.aborted ?? null);
    });
    const nativeClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      if (this.download) void state.recordWindowExportDownload();
      return nativeClick.call(this);
    };
  });
  try {
    await page.goto(start());
    await expectWindow(page, api.fixture.descriptor("30d"));
    await page.route("**/start?**", async (route) => {
      documentEntered.resolve();
      await documentRelease.promise;
      await route.continue();
    });
    const held = api.holdNextExport();
    await page.getByRole("button", { name: "Download current CSV page", exact: true }).click();
    await held.entered.promise;
    expect(api.responses.filter((value) => value.url.pathname.endsWith("/exports")).at(-1)!.status).toBe(200);
    await page
      .getByRole("navigation", { name: "Primary" })
      .getByRole("link", { name: "Browse", exact: true })
      .click({ noWaitAfter: true });
    await Promise.all([documentEntered.promise, entryObserved.promise]);
    expect(requestAborted).toBe(true);
    held.release.resolve();
    await held.done.promise;
    expect(downloadAttempts).toBe(0);
    expect(downloads).toBe(0);
    documentRelease.resolve();
    await expectWindow(page, api.fixture.descriptor("30d"));
    expect(downloadAttempts).toBe(0);
    expect(downloads).toBe(0);
  } finally {
    documentRelease.resolve();
    await api.close();
  }
});

const maximumProjects = Array.from(
  { length: 100 },
  (_, index) => `PVT_${String(index).padStart(3, "0")}_${":".repeat(120)}`,
);
const maximumFilter: PublicScope = {
  organization: filters.organization,
  repository: filters.repository,
  workstream: filters.workstream,
  start: null,
  end: null,
  context: "current",
  projects: maximumProjects,
  roles: ["author"],
};

test("100 maximum-length Projects resolve the default and picker with their complete confirmed pins", async ({
  page,
}) => {
  const api = await service(page, { filter: maximumFilter });
  api.holdWindows();
  try {
    const entry = start({ project: maximumProjects.join(",") });
    expect(entry.length).toBeGreaterThan(16 * 1024);
    expect(entry.length).toBeLessThan(48 * 1024);
    const document = await page.goto(entry);
    expect(document!.status()).toBe(200);
    await expect(picker(page).getByRole("status")).toContainText("Checking published date windows");
    await expect.poll(() => api.calls.length).toBeGreaterThan(0);
    expect(api.calls.every((url) => url.pathname === "/api/v1/windows")).toBe(true);
    expect(api.fixture.calls.reads).toEqual([]);
    for (const url of api.calls) expectScope(url, api.fixture.filter);
    expect(
      await page.evaluate(() => (window as unknown as { windowStreamAttempts: number }).windowStreamAttempts),
    ).toBe(0);
    api.releaseWindows();
    await expectWindow(page, api.fixture.descriptor("30d"));
    await openPicker(page);
    await picker(page).getByRole("combobox", { name: "Date window", exact: true }).selectOption("7d");
    await picker(page).getByRole("button", { name: "Open published window", exact: true }).click();
    const expected = api.fixture.descriptor("7d");
    await expectWindow(page, expected);
    const board = api.responses.filter((value) => value.url.pathname.endsWith("/boards")).at(-1)!;
    expect(board.status).toBe(200);
    expectScope(board.url, expected.scope);
    expect(JSON.parse(board.body).scope).toEqual(expected.scope);
    expect(JSON.parse(board.body).snapshotId).toBe(expected.snapshotId);
    const copied = page.url();
    await page.goto(copied);
    await expectWindow(page, expected);
  } finally {
    await api.close();
  }
});

test("100 maximum-length Projects keep custom entry registry-only until the reader chooses a measure", async ({
  page,
}) => {
  const bounds = { start: "2026-10-17T12:00:00.000Z", end: "2026-10-18T12:00:00.000Z" };
  const api = await service(page, { filter: maximumFilter, periods: [], custom: [bounds] });
  try {
    await page.goto(start({ project: maximumProjects.join(",") }));
    await expect(
      picker(page).getByText("No date windows are published for this selection.", { exact: true }),
    ).toBeVisible();
    await page.getByRole("link", { name: "Browse measures or enter custom UTC dates", exact: true }).click();
    await expect(page.getByRole("region", { name: "Metric discovery", exact: true })).toBeVisible();
    const registry = new URL(page.url());
    expect(registry.pathname).toBe("/leaderboards");
    expectScope(registry, api.fixture.filter);
    expect(registry.searchParams.get("actors")).toBe("user");
    expect(registry.searchParams.get("metric")).toBe("pr_merged");
    expect(registry.searchParams.get("tz")).toBe("America/New_York");
    expect(api.fixture.calls.reads).toEqual([]);
    expect(api.calls.every((url) => ["/api/v1/windows", "/api/v1/metrics"].includes(url.pathname))).toBe(true);
    expect(
      await page.evaluate(() => (window as unknown as { windowStreamAttempts: number }).windowStreamAttempts),
    ).toBe(0);
    await page.getByText("Exact scope and snapshot", { exact: true }).click();
    await page.getByRole("textbox", { name: "start", exact: true }).fill(bounds.start);
    await page.getByRole("textbox", { name: "end", exact: true }).fill(bounds.end);
    await page.getByRole("button", { name: "Read exact scope", exact: true }).click();
    await expect(page.getByRole("region", { name: "Metric discovery", exact: true })).toBeVisible();
    expect(api.fixture.calls.reads).toEqual([]);
    await page.locator('a[data-api-nav][href^="/leaderboards/pr_merged?"]').click();
    await expect(provenance(page)).toBeVisible();
    const expected = api.fixture.customRead(bounds);
    expectScope(new URL(page.url()), expected.selected.scope);
    const board = api.responses.filter((value) => value.url.pathname.endsWith("/boards")).at(-1)!;
    expect(board.status).toBe(200);
    expect(JSON.parse(board.body).scope).toEqual(expected.selected.scope);
    expect(JSON.parse(board.body).rows[0].result.value).toBe(2);
  } finally {
    await api.close();
  }
});
