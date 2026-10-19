import { test, expect, type Page } from "@playwright/test";

test.use({ storageState: { cookies: [], origins: [] } });

/** The only fabricated source is the synthetic GitHub HTTP response. Browser
 * reads cross the real public HTTP service and its SQL/SQLite authorities. */
async function service(page: Page, options: { enabled?: boolean; empty?: boolean } = {}) {
  const { discussionCapabilityHarness } = await import(
    new URL("../../pipeline/test/discussion-capability-harness.mjs", import.meta.url).href
  );
  const cleanup: Array<() => unknown> = [];
  const h = await discussionCapabilityHarness({ after: (fn: () => unknown) => cleanup.push(fn) }, options);
  const address = await h.runtime.app.listen({ host: "127.0.0.1", port: 0 });
  const responses: Array<{ path: string; status: number; body: string }> = [];
  await page.route("**/api/v1/**", async (route) => {
    const url = new URL(route.request().url());
    const response = await fetch(address + url.pathname + url.search, { redirect: "error" });
    const body = await response.text();
    responses.push({ path: url.pathname + url.search, status: response.status, body });
    await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body });
  });
  return {
    h,
    responses,
    async close() {
      await page.unrouteAll({ behavior: "wait" });
      for (const fn of cleanup.reverse()) await fn();
    },
  };
}

test("disabled Discussion collection renders unavailable and no contribution rows", async ({ page }, testInfo) => {
  const api = await service(page, { enabled: false, empty: true });
  try {
    expect((await api.h.collect()).state).toBe("collecting");
    await page.goto("/leaderboards/discussion_answers?ui=api");
    await expect(page.getByRole("heading", { name: "Public read unavailable", exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: "Published contributions" })).toHaveCount(0);
    await expect(page.getByText(/An empty page does not establish zero activity/)).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Measure disabled", exact: true })).toHaveCount(0);
    expect(api.responses.some((value) => value.path.startsWith("/api/v1/boards?") && value.status === 503)).toBe(true);
    expect(await page.locator("body").innerText()).not.toMatch(
      /hasDiscussionsEnabled|discussions_source_unavailable|synthetic-discussion-capability-token/,
    );
    await page.screenshot({ path: testInfo.outputPath("discussion-source-disabled.png"), fullPage: true });
    await testInfo.attach("actual-public-responses", {
      body: JSON.stringify(api.responses, null, 2),
      contentType: "application/json",
    });
  } finally {
    await api.close();
  }
});

test("enabled empty Discussions render an explicit unmeasured empty page", async ({ page }, testInfo) => {
  const api = await service(page, { enabled: true, empty: true });
  try {
    expect((await api.h.collect()).state).toBe("published");
    await page.goto("/leaderboards/discussion_answers?ui=api");
    await expect(page.getByRole("region", { name: "Published contributions" })).toBeVisible();
    await expect(page.getByRole("rowheader")).toHaveCount(0);
    await expect(
      page.getByText(
        "No public rows are available in this selection. An empty page does not establish zero activity.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(0);
    const board = api.responses.find((value) => value.path.startsWith("/api/v1/boards?") && value.status === 200);
    expect(board).toBeDefined();
    expect(JSON.parse(board!.body).rows).toEqual([]);
    const health = (await api.h.runtime.app.inject("/api/v1/health")).json();
    expect(health.sources[0].currentCollection.state).toBe("no_activity_in_window");
    expect(health.sources[0].state).toBe("partial");
    await page.screenshot({ path: testInfo.outputPath("discussion-enabled-empty.png"), fullPage: true });
    await testInfo.attach("actual-public-responses", {
      body: JSON.stringify(api.responses, null, 2),
      contentType: "application/json",
    });
  } finally {
    await api.close();
  }
});

test("disabling a previously published Discussion retains its author credit with degraded source health", async ({
  page,
}, testInfo) => {
  const api = await service(page);
  try {
    expect((await api.h.collect()).state).toBe("published");
    const initial = (await api.h.runtime.app.inject("/api/v1/health")).json();
    await page.goto(`/leaderboards/discussion_answers?ui=api&snapshot=${initial.snapshotId}`);
    const contributions = page.getByRole("region", { name: "Published contributions" });
    await expect(contributions.getByRole("rowheader")).toHaveCount(1);
    const author = contributions.getByRole("link", { name: "synthetic-303", exact: true });
    await expect(author).toBeVisible();
    const before = await contributions.innerText();
    api.h.state.enabled = false;
    expect((await api.h.collect()).state).toBe("collecting");
    const finished = page.waitForResponse(
      (response) => response.url().includes("/api/v1/boards?") && response.status() === 200,
    );
    await page.getByRole("button", { name: "Recheck current publication controls", exact: true }).click();
    await finished;
    await expect(contributions).toHaveText(before, { useInnerText: true });
    await expect(contributions.getByRole("rowheader")).toHaveCount(1);
    await expect(author).toBeVisible();
    await expect(contributions.getByRole("link", { name: "synthetic-202", exact: true })).toHaveCount(0);
    await expect(contributions.getByRole("link", { name: "synthetic-101", exact: true })).toHaveCount(0);
    expect(new URL(page.url()).searchParams.get("snapshot")).toBe(initial.snapshotId);
    const health = (await api.h.runtime.app.inject(`/api/v1/health?snapshot=${initial.snapshotId}`)).json();
    expect(health.sources[0].currentCollection.state).toBe("degraded");
    expect(health.lastSuccessfulPublish).toEqual(initial.lastSuccessfulPublish);
    await expect(page.getByRole("region", { name: "Current source freshness" })).toContainText("Stale or degraded");
    await page.screenshot({ path: testInfo.outputPath("discussion-retained-after-disable.png"), fullPage: true });
    await testInfo.attach("actual-public-responses", {
      body: JSON.stringify(api.responses, null, 2),
      contentType: "application/json",
    });
  } finally {
    await api.close();
  }
});
