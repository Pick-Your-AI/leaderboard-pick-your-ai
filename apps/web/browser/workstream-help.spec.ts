import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test.use({ storageState: { cookies: [], origins: [] } });
const profile = "/contributors/101?ui=api&snapshot=fixture-help&repository=2";

async function service(page: Page, count = 3) {
  const { createService } = await import(new URL("../../service/dist/app.js", import.meta.url).href);
  const { publicHelpFixture } = await import(
    new URL("../../../tests/fixtures/workstream-help.mjs", import.meta.url).href
  );
  const current = publicHelpFixture(count);
  const requests: { category: string | null; cursor: string | null; status: number; body: string }[] = [];
  let paused: { category: string; wait: Promise<void>; release: () => void; seen: number; finished: number } | null =
    null;
  const app = createService({
    approvedWorkstreamHelpRuleVersion: "reviewed-cross-workstream-help/v1",
    approvedAchievementRuleVersion: "accepted-evidence/v2",
    cursorSecret: "fixture-browser-help-cursor-secret-000000",
    source: {
      read: async (scope: unknown) => ({
        ...structuredClone(current),
        selected: { ...structuredClone(current.selected), scope },
      }),
    },
  });
  await page.route("**/api/v1/**", async (route) => {
    const url = new URL(route.request().url());
    const help = url.pathname.endsWith("/workstream-help");
    const response = await app.inject({ method: "GET", url: url.pathname + url.search });
    const hold = paused;
    if (help && hold?.category === url.searchParams.get("category")) {
      hold.seen++;
      await hold.wait;
    }
    await route.fulfill({ status: response.statusCode, headers: response.headers, body: response.body });
    if (help)
      requests.push({
        category: url.searchParams.get("category"),
        cursor: url.searchParams.get("cursor"),
        status: response.statusCode,
        body: response.body,
      });
    if (help && hold?.category === url.searchParams.get("category")) hold.finished++;
  });
  return {
    current,
    requests,
    close: () => app.close(),
    pause(category: string) {
      let release!: () => void;
      const wait = new Promise<void>((resolve) => {
        release = resolve;
      });
      paused = { category, wait, release, seen: 0, finished: 0 };
      return release;
    },
    pausedCount: () => paused?.seen ?? 0,
    finishedCount: () => paused?.finished ?? 0,
  };
}

test("real reviewed-help HTTP pages retain proof scope, keyboard focus and accessible narrow presentation", async ({
  page,
}) => {
  const api = await service(page, 21);
  try {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(profile + "&category=maintenance");
    const region = page.getByRole("region", { name: "Reviewed cross-workstream help", exact: true });
    await expect(region.getByText(/21 recorded events in this selection. Page 1./)).toBeVisible();
    await expect(region.getByRole("heading", { level: 4 })).toHaveCount(20);
    expect(api.requests[0]?.status).toBe(200);
    expect(JSON.parse(api.requests[0]!.body).recognitions).toHaveLength(20);
    expect(api.requests.every((entry) => entry.category === "maintenance")).toBe(true);
    const next = region.getByRole("button", { name: "Next help page" });
    await next.focus();
    await page.keyboard.press("Enter");
    await expect(region.getByRole("heading", { name: "Reviewed cross-workstream help", exact: true })).toBeFocused();
    await expect(region.getByText(/21 recorded events in this selection. Page 2./)).toBeVisible();
    await expect(region.getByRole("heading", { level: 4 })).toHaveCount(1);
    const statement = region.getByRole("link", { name: "Read the immutable reviewed help statement" });
    await expect(statement).toHaveAttribute("href", /\/blob\/b{40}\/docs\/workstream-help-[0-9]+\.json$/);
    const proof = region.getByRole("link", { name: "Inspect qualifying contribution" });
    const href = (await proof.getAttribute("href"))!;
    const url = new URL(href, page.url());
    expect(url.searchParams.get("snapshot")).toBe("fixture-help");
    expect(url.searchParams.get("repository")).toBe("2");
    expect(url.searchParams.get("category")).toBe("maintenance");
    expect(url.searchParams.has("cursor")).toBe(false);
    const violations = await new AxeBuilder({ page }).include('[aria-labelledby="workstream-help-title"]').analyze();
    expect(violations.violations).toEqual([]);
    expect(await region.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    await proof.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { name: "Contribution evidence", exact: true })).toBeVisible();
    expect(new URL(page.url()).searchParams.get("snapshot")).toBe("fixture-help");
    expect(new URL(page.url()).searchParams.get("repository")).toBe("2");
  } finally {
    await api.close();
  }
});

test("a current correction invalidates the old help page and restart reads the corrected set", async ({ page }) => {
  const api = await service(page, 21);
  try {
    await page.goto(profile);
    const region = page.getByRole("region", { name: "Reviewed cross-workstream help", exact: true });
    await expect(region.getByText(/21 recorded events in this selection. Page 1./)).toBeVisible();
    const first = JSON.parse(api.requests[0]!.body).recognitions[0].proof.artifactId;
    api.current.controls.suppressedArtifactIds = [first];
    await region.getByRole("button", { name: "Next help page" }).click();
    const error = region.getByText("Reviewed help is unavailable for this selection. Recheck the current evidence.");
    await expect(error).toBeVisible();
    await expect(error).toBeFocused();
    await expect(region.getByRole("link", { name: "Qualifying public artifact" })).toHaveCount(0);
    const restart = region.getByRole("button", { name: "Restart help list" });
    await restart.focus();
    await page.keyboard.press("Enter");
    await expect(region.getByRole("heading", { name: "Reviewed cross-workstream help", exact: true })).toBeFocused();
    await expect(region.getByText(/20 recorded events in this selection. Page 1./)).toBeVisible();
    expect(api.current.controls.version).toBe("fixture-help-controls-1");
    expect(api.requests.some((entry) => entry.status === 400)).toBe(true);
    const last = JSON.parse(api.requests.at(-1)!.body);
    expect(
      last.recognitions.some((entry: { proof: { artifactId: string } }) => entry.proof.artifactId === first),
    ).toBe(false);
  } finally {
    await api.close();
  }
});

test("same-selection refresh preserves a focused proof then current withdrawal clears pinned help", async ({
  page,
}) => {
  const api = await service(page);
  try {
    await page.clock.install();
    await page.goto(profile);
    const region = page.getByRole("region", { name: "Reviewed cross-workstream help", exact: true });
    const proof = region.getByRole("link", { name: "Inspect qualifying contribution" }).first();
    await expect(proof).toBeVisible();
    await proof.focus();
    const before = api.requests.length;
    await page.clock.fastForward(30_001);
    await expect.poll(() => api.requests.length).toBeGreaterThan(before);
    await expect(proof).toBeFocused();
    api.current.controls.suppressedArtifactIds = [
      JSON.parse(api.requests.at(-1)!.body).recognitions[0].proof.artifactId,
    ];
    await page.clock.fastForward(30_001);
    await expect(region.getByText(/2 recorded events in this selection. Page 1./)).toBeVisible();
    api.current.controls.revokedSnapshotIds = ["fixture-help"];
    await page.clock.fastForward(30_001);
    await expect(page.getByRole("link", { name: "Read the immutable reviewed help statement" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Qualifying public artifact" })).toHaveCount(0);
  } finally {
    await api.close();
  }
});

test("an obsolete category response cannot restore help after the selection changes", async ({ page }) => {
  const api = await service(page);
  const release = api.pause("maintenance");
  try {
    await page.goto(profile + "&category=maintenance");
    await expect.poll(() => api.pausedCount()).toBe(1);
    await page.evaluate((url) => {
      history.pushState(null, "", url);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }, profile + "&category=documentation");
    const region = page.getByRole("region", { name: "Reviewed cross-workstream help", exact: true });
    await expect(region.getByText(/0 recorded events in this selection. Page 1./)).toBeVisible();
    release();
    await expect.poll(() => api.finishedCount()).toBe(1);
    await expect(region.getByRole("link", { name: "Inspect qualifying contribution" })).toHaveCount(0);
    await expect(region.getByText(/0 recorded events in this selection. Page 1./)).toBeVisible();
    const older = api.requests.find((entry) => entry.category === "maintenance");
    expect(older?.status).toBe(200);
    expect(JSON.parse(older!.body).recognitions).toHaveLength(3);
    expect(new URL(page.url()).searchParams.get("category")).toBe("documentation");
  } finally {
    release();
    await api.close();
  }
});
