import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import type { PublicScope } from "@pick-your-ai/contracts";

test.use({ storageState: { cookies: [], origins: [] } });
const selected = { context: "current", project: "PVT_A,PVT_B=", role: "author,reviewer", actors: "user" };
const boardPath = (extra: Record<string, string> = {}) =>
  `/leaderboards/pr_merged?${new URLSearchParams({ ui: "api", ...selected, ...extra })}`;

// Exact synthetic service projections, never source rights or production observations.
async function service(page: Page) {
  const { createService } = await import(new URL("../../service/dist/app.js", import.meta.url).href);
  const { scopeFixture } = await import(new URL("../../../tests/fixtures/public-scope.mjs", import.meta.url).href);
  let suppressed = false,
    unavailable = false,
    corruptBoard = false;
  let gate: Promise<void> | null = null;
  let release = () => {};
  let held = 0,
    released = 0;
  const calls: URL[] = [];
  const app = createService({
    source: {
      async read(scope: PublicScope) {
        if (unavailable) throw Error("SYNTHETIC_SCOPE_PROVIDER_UNAVAILABLE");
        if (scope.projects?.includes("PVT_UNAPPROVED")) return null;
        const read = scopeFixture(scope);
        if (suppressed) {
          read.controls.suppressedActorIds = ["102"];
          read.controls.version = "synthetic-current-privacy-2";
        }
        return read;
      },
    },
  });
  await page.route("**/api/v1/**", async (route) => {
    const url = new URL(route.request().url());
    calls.push(url);
    const response = await app.inject({ method: "GET", url: url.pathname + url.search });
    let body = response.body;
    if (corruptBoard && url.pathname.endsWith("/boards") && response.statusCode === 200) {
      const value = JSON.parse(body);
      value.scope.roles = ["reporter"];
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
    calls,
    suppress() {
      suppressed = true;
    },
    fail() {
      unavailable = true;
    },
    corrupt() {
      corruptBoard = true;
    },
    holdExports() {
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    releaseExports() {
      release();
      gate = null;
    },
    held: () => held,
    released: () => released,
    async close() {
      release();
      await page.unrouteAll({ behavior: "wait" });
      await app.close();
    },
  };
}
const provenance = (page: Page) => page.getByRole("region", { name: "Snapshot provenance" });
async function expectScoped(page: Page) {
  await expect(provenance(page)).toContainText("Membership: current at snapshot cutoff");
  await expect(provenance(page)).toContainText("GitHub Projects: PVT_A, PVT_B=");
  await expect(provenance(page)).toContainText("Contribution roles: Author, Reviewer (any selected)");
}

test("scope controls select canonical membership and role unions and clear an unchanged old pin accessibly", async ({
  page,
}, testInfo) => {
  const api = await service(page);
  try {
    await page.setViewportSize({ width: 320, height: 800 });
    await page.goto("/leaderboards/pr_merged?ui=api&limit=1");
    await expect(provenance(page)).toBeVisible();
    await page.getByRole("link", { name: "Permalink to this snapshot" }).click();
    expect(new URL(page.url()).searchParams.get("snapshot")).toBeTruthy();
    await page.getByText("Exact scope and snapshot", { exact: true }).click();
    await page
      .getByRole("combobox", { name: "Project and workstream membership", exact: true })
      .selectOption("current");
    await page.getByRole("textbox", { name: "GitHub Project IDs", exact: true }).fill("PVT_A,PVT_B=");
    await page.getByRole("checkbox", { name: "Author", exact: true }).focus();
    await page.keyboard.press("Space");
    await page.getByRole("checkbox", { name: "Reviewer", exact: true }).check();
    await page.getByRole("button", { name: "Read exact scope", exact: true }).press("Enter");
    await expectScoped(page);
    expect(new URL(page.url()).searchParams.has("snapshot")).toBe(false);
    await page.getByText("Exact scope and snapshot", { exact: true }).click();
    await expect(page.getByRole("checkbox", { name: "Author", exact: true })).toBeChecked();
    await expect(page.getByRole("checkbox", { name: "Reviewer", exact: true })).toBeChecked();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    expect(
      (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations,
    ).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath("membership-role-controls-320px.png"), fullPage: true });
    const request = api.calls.filter((url) => url.pathname.endsWith("/boards")).at(-1)!;
    expect(Object.fromEntries(request.searchParams)).toMatchObject({
      context: "current",
      project: "PVT_A,PVT_B=",
      role: "author,reviewer",
    });
  } finally {
    await api.close();
  }
});

test("pinned scoped cursor proof survives timezone changes, history and copied routes", async ({ page }) => {
  const api = await service(page);
  try {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(boardPath({ limit: "1" }));
    await expectScoped(page);
    await page.getByRole("link", { name: "Next cursor page" }).click();
    await page.getByRole("link", { name: "synthetic-101-0", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Contribution evidence" });
    await expect(dialog.locator("[data-proof-projection]")).toBeVisible();
    const before = new URL(page.url());
    expect(before.searchParams.get("cursor")).toBeTruthy();
    expect(before.searchParams.get("snapshot")).toBeTruthy();
    const proof = await dialog.locator("[data-proof-projection]").innerText();
    await page.getByRole("combobox", { name: "Display timezone", exact: true }).selectOption("America/New_York");
    await expect(dialog.locator("[data-proof-projection]")).toHaveText(proof, { useInnerText: true });
    for (const key of ["snapshot", "cursor", "proof", "context", "project", "role"])
      expect(new URL(page.url()).searchParams.get(key)).toBe(before.searchParams.get(key));
    await page.goBack();
    await expect(page.getByRole("combobox", { name: "Display timezone", exact: true })).toHaveValue("UTC");
    await page.goForward();
    await expect(page.getByRole("combobox", { name: "Display timezone", exact: true })).toHaveValue("America/New_York");
    await page.goto(page.url());
    await expect(dialog.locator("[data-proof-projection]")).toHaveText(proof, { useInnerText: true });
    await expectScoped(page);
    await dialog.getByRole("button", { name: "Close evidence panel" }).click();
    await page.getByRole("link", { name: "synthetic-pending-101", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Contributor portfolio", exact: true })).toBeVisible();
    await expectScoped(page);
    for (const url of api.calls.filter((value) => !value.pathname.endsWith("/metrics"))) {
      expect(url.searchParams.get("project")).toBe(selected.project);
      expect(url.searchParams.get("role")).toBe(selected.role);
      expect(url.searchParams.get("context")).toBe(selected.context);
      expect(url.searchParams.has("tz")).toBe(false);
    }
  } finally {
    await api.close();
  }
});

test("scoped downloads retain original v3 metadata and a late export cannot outlive a role change", async ({
  page,
}) => {
  const api = await service(page);
  const downloads: string[] = [];
  page.on("download", (item) => downloads.push(item.suggestedFilename()));
  try {
    await page.goto(boardPath());
    await expectScoped(page);
    for (const format of ["JSON", "CSV"]) {
      const pending = page.waitForEvent("download");
      await page.getByRole("button", { name: `Download current ${format} page`, exact: true }).click();
      const download = await pending;
      const stream = await download.createReadStream();
      const chunks: Buffer[] = [];
      for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
      const raw = Buffer.concat(chunks).toString("utf8");
      if (format === "JSON") {
        const body = JSON.parse(raw);
        expect(body.exportSchemaVersion).toBe("public-export/v3");
        expect(body.scope).toMatchObject({
          context: "current",
          projects: ["PVT_A", "PVT_B="],
          roles: ["author", "reviewer"],
        });
      } else {
        expect(raw).toContain('"scope_schema_version","context","projects","roles"');
        expect(raw).toContain('"public-scope/v3","current","[""PVT_A"",""PVT_B=""]","[""author"",""reviewer""]"');
      }
    }
    api.holdExports();
    await page.getByRole("button", { name: "Download current CSV page", exact: true }).click();
    await expect.poll(api.held).toBe(1);
    await page.getByText("Exact scope and snapshot", { exact: true }).click();
    await page.getByRole("checkbox", { name: "Author", exact: true }).uncheck();
    await page.getByRole("button", { name: "Read exact scope", exact: true }).click();
    await expect(provenance(page)).toContainText("Contribution roles: Reviewer (any selected)");
    api.releaseExports();
    await expect.poll(api.released).toBe(1);
    await page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
    );
    expect(downloads).toHaveLength(2);
    expect(new URL(page.url()).searchParams.get("role")).toBe("reviewer");
  } finally {
    await api.close();
  }
});

test("wrong response scopes and unapproved Projects stay unavailable without wider fallback", async ({ page }) => {
  const api = await service(page);
  try {
    await page.goto(boardPath());
    await expectScoped(page);
    api.corrupt();
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page.getByRole("alert")).toContainText("api_scope_mismatch");
    await expect(page.getByRole("link", { name: "synthetic-pending-102", exact: true })).toHaveCount(0);
    await page.goto(boardPath({ project: "PVT_UNAPPROVED" }));
    await expect(page.getByRole("alert")).toContainText("public_snapshot_unavailable");
    const last = api.calls.filter((url) => url.pathname.endsWith("/boards")).at(-1)!;
    expect(last.searchParams.get("project")).toBe("PVT_UNAPPROVED");
    expect(last.searchParams.get("role")).toBe(selected.role);
    await expect(page.getByRole("complementary", { name: "Synthetic data notice" })).toHaveCount(0);
  } finally {
    await api.close();
  }
});

test("pinned membership views recheck current privacy and disclose exact frozen wall scope", async ({ page }) => {
  const api = await service(page);
  try {
    await page.goto(boardPath());
    await expectScoped(page);
    await page.getByRole("link", { name: "Permalink to this snapshot" }).click();
    const pin = new URL(page.url()).searchParams.get("snapshot")!;
    await expect(page.getByRole("link", { name: "synthetic-pending-102", exact: true })).toBeVisible();
    api.suppress();
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page.getByRole("link", { name: "synthetic-pending-102", exact: true })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "synthetic-pending-101", exact: true })).toBeVisible();
    await expectScoped(page);
    await page.goto(
      `/live?${new URLSearchParams({ ui: "api", ...selected, snapshot: pin, mode: "frozen", boards: "pr_merged", tz: "Asia/Kathmandu" })}`,
    );
    await expect(page.locator(".api-wall-scope")).toContainText("Membership: current at snapshot cutoff");
    await expect(page.locator(".api-wall-scope")).toContainText("GitHub Projects: PVT_A, PVT_B=");
    await expect(page.locator(".api-wall-scope")).toContainText("Contribution roles: Author, Reviewer (any selected)");
    await expect(page.getByText("synthetic-pending-101", { exact: true })).toBeVisible();
    await expect(page.getByText("synthetic-pending-102", { exact: true })).toHaveCount(0);
    const scoped = api.calls.filter((url) => url.pathname.endsWith("/boards") || url.pathname.endsWith("/health"));
    expect(
      scoped.every(
        (url) => url.searchParams.get("project") === selected.project && url.searchParams.get("role") === selected.role,
      ),
    ).toBe(true);
    expect(scoped.every((url) => !url.searchParams.has("tz"))).toBe(true);
  } finally {
    await api.close();
  }
});

test("percent-encoding expansion is rejected before live polling or EventSource construction", async ({ page }) => {
  let apiCalls = 0;
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/v1/**", async (route) => {
    apiCalls++;
    await route.abort();
  });
  await page.addInitScript(() => {
    const record = window as unknown as { scopeStreamAttempts: number };
    record.scopeStreamAttempts = 0;
    window.EventSource = class {
      constructor() {
        record.scopeStreamAttempts++;
        throw Error("unexpected scoped stream");
      }
    } as unknown as typeof EventSource;
  });
  const projects = Array.from({ length: 31 }, (_, i) => `PVT_${i}_` + ":".repeat(100));
  const path = "/leaderboards/pr_merged?ui=api&project=" + projects.join(",");
  expect(path.length).toBeLessThan(4096);
  await page.goto(path);
  await expect(page.getByRole("alert")).toContainText("query_too_large");
  await page.getByRole("button", { name: "Retry this selection", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("query_too_large");
  expect(apiCalls).toBe(0);
  expect(await page.evaluate(() => (window as unknown as { scopeStreamAttempts: number }).scopeStreamAttempts)).toBe(0);
  expect(errors).toEqual([]);
});

test("long in-budget Project scopes keep overlay controls visible and disclose every selected ID", async ({ page }) => {
  const api = await service(page);
  try {
    const projects = ["PVT_A", ...Array.from({ length: 10 }, (_, i) => `PVT_LONG_${i}_` + "A".repeat(100))];
    const project = projects.join(",");
    await page.setViewportSize({ width: 960, height: 540 });
    await page.goto(
      `/live?${new URLSearchParams({ ui: "api", ...selected, project, mode: "single", format: "overlay", boards: "pr_merged" })}`,
    );
    await expect(page.locator(".api-wall-scope summary")).toContainText("GitHub Projects: 11 selected");
    await expect(page.getByRole("button", { name: "Pause wall", exact: true })).toBeInViewport();
    expect(
      await page.evaluate(() => ({
        width: document.documentElement.scrollWidth,
        height: document.documentElement.scrollHeight,
      })),
    ).toEqual({ width: 960, height: 540 });
    const summary = page.locator(".api-wall-scope summary");
    await summary.focus();
    await summary.press("Enter");
    await expect(page.locator(".api-wall-scope details")).toHaveAttribute("open", "");
    await expect(page.locator(".api-wall-scope .public-scope-provenance")).toContainText(
      `GitHub Projects: ${projects.join(", ")}`,
    );
    await expect(page.locator(".api-wall-scope .public-scope-provenance")).toContainText(
      "Contribution roles: Author, Reviewer (any selected)",
    );
    await summary.press("Enter");
    await expect(page.locator(".api-wall-scope details")).not.toHaveAttribute("open", "");
    expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBe(540);
    const reads = api.calls.filter((url) => ["/api/v1/health", "/api/v1/boards"].includes(url.pathname));
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every((url) => url.searchParams.get("project") === project)).toBe(true);
    expect(
      (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations,
    ).toEqual([]);
  } finally {
    await api.close();
  }
});
