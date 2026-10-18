import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
test.use({ storageState: { cookies: [], origins: [] } });
const start = "2026-10-04T00:00:00.000Z",
  end = "2026-10-19T00:00:00.000Z";
const selected = `start=${start}&end=${end}`;
const first = "2026-10-04T23:59:59.999999999Z";
async function service(page: Page) {
  const { createService } = await import(new URL("../../service/dist/app.js", import.meta.url).href);
  const { participationFixture } = await import(
    new URL("../../../tests/fixtures/participation.mjs", import.meta.url).href
  );
  const current = participationFixture();
  let unavailable = false,
    legacy = false,
    calls = 0;
  const app = createService({
    source: {
      read: async (scope: typeof current.selected.scope) => {
        if (unavailable) return null;
        const result = structuredClone(current);
        result.selected.scope = scope;
        return result;
      },
    },
  });
  await page.route("**/api/v1/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/v1/contributors/101") calls++;
    const response = await app.inject({ method: "GET", url: url.pathname + url.search });
    let body = response.body;
    if (legacy && url.pathname === "/api/v1/contributors/101" && response.statusCode === 200) {
      const profile = response.json();
      delete profile.activitySummary;
      body = JSON.stringify(profile);
    }
    await route.fulfill({ status: response.statusCode, headers: response.headers, body });
  });
  return {
    async close() {
      await page.unrouteAll({ behavior: "wait" });
      await app.close();
    },
    calls: () => calls,
    suppress: () => {
      current.controls.suppressedActorIds = ["101"];
    },
    fail: () => {
      unavailable = true;
    },
    legacy: () => {
      legacy = true;
    },
  };
}

test("participation uses all profile evidence, retains bounded scope across pages, and links pinned proof", async ({
  page,
}) => {
  const api = await service(page);
  try {
    await page.goto(`/contributors/101?ui=api&${selected}&limit=1`);
    const summary = page.locator('[aria-labelledby="participation-title"]');
    await expect(summary.getByRole("heading", { name: "Participation in this snapshot" })).toBeVisible();
    await expect(
      summary.getByText("3 active calendar weeks out of 3; complete selected coverage.", { exact: true }),
    ).toBeVisible();
    await expect(
      summary.getByText("14 dated evidence records; 0 with unknown metric dates.", { exact: true }),
    ).toBeVisible();
    await expect(summary.getByText(/Newcomer status is unknown/)).toBeVisible();
    await page.getByRole("link", { name: "Next timeline page" }).click();
    await expect(
      summary.getByText("3 active calendar weeks out of 3; complete selected coverage.", { exact: true }),
    ).toBeVisible();
    const proof = summary.getByRole("link", { name: first, exact: true });
    await expect(proof).toHaveAttribute("href", /snapshot=synthetic-pending-1/);
    expect(new URL((await proof.getAttribute("href")) ?? "", page.url()).searchParams.has("cursor")).toBe(false);
    const audit = await new AxeBuilder({ page }).include('[aria-labelledby="participation-title"]').analyze();
    expect(audit.violations).toEqual([]);
    await proof.click();
    await expect(page.getByRole("heading", { name: "Contribution evidence", exact: true })).toBeVisible();
    expect(new URL(page.url()).searchParams.get("start")).toBe(start);
    expect(new URL(page.url()).searchParams.get("end")).toBe(end);
    expect(new URL(page.url()).searchParams.get("snapshot")).toBe("synthetic-pending-1");
  } finally {
    await api.close();
  }
});

test("all-time and legacy publications show explicit unknowns and fit a narrow viewport", async ({ page }) => {
  const api = await service(page);
  try {
    await page.setViewportSize({ width: 320, height: 780 });
    await page.goto("/contributors/101?ui=api");
    const summary = page.locator('[aria-labelledby="participation-title"]');
    await expect(
      summary.getByText("All-time selection has no calendar-week denominator.", { exact: true }),
    ).toBeVisible();
    await expect(
      summary.getByText("3 active calendar weeks; partial evidence coverage.", { exact: true }),
    ).toBeVisible();
    expect(await summary.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
    api.legacy();
    await page.reload();
    await expect(
      summary.getByText("Participation data is unavailable for this publication.", { exact: true }),
    ).toBeVisible();
    await expect(summary.getByText(/Newcomer status is unknown/)).toBeVisible();
    await expect(summary.getByRole("link", { name: first, exact: true })).toHaveCount(0);
  } finally {
    await api.close();
  }
});

for (const denied of ["suppressed", "source unavailable"] as const) {
  test(`current ${denied} clears every retained participation detail`, async ({ page }) => {
    const api = await service(page);
    try {
      await page.clock.install();
      await page.goto(`/contributors/101?ui=api&${selected}&snapshot=synthetic-pending-1`);
      await expect(page.getByRole("heading", { name: "Participation in this snapshot" })).toBeVisible();
      const before = api.calls();
      if (denied === "suppressed") api.suppress();
      else api.fail();
      await page.clock.fastForward(30_001);
      await expect.poll(() => api.calls()).toBeGreaterThan(before);
      await expect(page.getByRole("heading", { name: "Participation in this snapshot" })).toHaveCount(0);
      await expect(page.getByRole("link", { name: first, exact: true })).toHaveCount(0);
      await expect(page.getByText(/14 dated evidence records/)).toHaveCount(0);
    } finally {
      await api.close();
    }
  });
}
