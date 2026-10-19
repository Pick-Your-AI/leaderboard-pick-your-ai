import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test.use({ storageState: { cookies: [], origins: [] } });
const pin = "synthetic-pending-1";
const path = `/contributors/101?ui=api&snapshot=${pin}&category=pr_merged`;
const at = "2026-10-17T12:00:00.000Z";

async function fixture(page: Page, count: number, projects: string[]) {
  // Synthetic provider inputs through the actual service, parser and cursor.
  // Native receipt authority is independently exercised by the pipeline tests.
  const { createService } = await import(new URL("../../service/dist/app.js", import.meta.url).href);
  const { projectFixture } = await import(
    new URL("../../../tests/fixtures/public-project-context.mjs", import.meta.url).href
  );
  const input = projectFixture({ count, projects });
  const app = createService({
    now: () => Date.parse(at),
    source: {
      async read() {
        return structuredClone(input);
      },
    },
  });
  let corrupt = false;
  const calls: URL[] = [];
  const pages: { bytes: number; count: number; ids: string[]; nextCursor: string | null }[] = [];
  await page.route("**/api/v1/**", async (route) => {
    const url = new URL(route.request().url());
    calls.push(url);
    const response = await app.inject({ method: "GET", url: url.pathname + url.search });
    let body = response.body;
    if (url.pathname === "/api/v1/contributors/101" && response.statusCode === 200) {
      const parsed = response.json();
      pages.push({
        bytes: Buffer.byteLength(body),
        count: parsed.evidenceCount,
        ids: parsed.evidenceIds,
        nextCursor: parsed.nextCursor,
      });
      if (corrupt) {
        parsed.timeline[0].projectContext.schemaVersion = "public-project-context/v2";
        body = JSON.stringify(parsed);
      }
    }
    await route.fulfill({ status: response.statusCode, headers: response.headers, body });
  });
  return {
    input,
    calls,
    pages,
    corrupt: () => {
      corrupt = true;
    },
    close: () => app.close(),
  };
}

test("maximum Project membership uses ten headings, one expansion and twenty references or scope IDs", async ({
  page,
}) => {
  const projects = Array.from({ length: 100 }, (_, index) => `${String(index).padStart(3, "0")}${"x".repeat(125)}`);
  const api = await fixture(page, 100, projects);
  try {
    await page.setViewportSize({ width: 320, height: 900 });
    await page.goto(`${path}&limit=100`);
    const groups = page.getByRole("region", { name: "Project groups on this timeline page" });
    await expect(groups).toBeVisible();
    await expect(groups.getByRole("heading", { level: 4 })).toHaveCount(10);
    expect(api.pages[0]!.bytes).toBeLessThanOrEqual(2_000_000);
    expect(api.pages[0]!.count).toBe(100);
    expect(api.pages[0]!.ids.length).toBeGreaterThan(20);
    expect(api.pages[0]!.ids.length).toBeLessThan(100);
    await expect(groups.getByText("Project name and link not supplied.", { exact: true })).toHaveCount(10);
    await expect(groups.getByRole("link")).toHaveCount(0);
    const opener = groups.getByRole("button", { name: `Project ${projects[0]}`, exact: true });
    await opener.focus();
    await page.keyboard.press("Enter");
    await expect(groups.getByRole("heading", { level: 3 })).toBeFocused();
    await expect(groups.locator('[aria-expanded="true"]')).toHaveCount(1);
    const references = groups.getByRole("list", { name: "Project evidence references" });
    await expect(references.locator(":scope > li")).toHaveCount(20);
    await expect(
      groups.getByText(`${api.pages[0]!.ids.length} evidence records on this timeline page.`, { exact: true }),
    ).toHaveCount(10);
    await groups.getByRole("button", { name: "Next reference page" }).click();
    await expect(groups.getByRole("heading", { level: 3 })).toBeFocused();
    await expect(references.getByRole("link").first()).toHaveText(api.pages[0]!.ids[20]!);
    await groups.getByRole("button", { name: "View verified Project scope" }).first().click();
    await expect(references).toHaveCount(0);
    const scopeIds: string[] = [];
    for (let index = 0; index < 5; index++) {
      const list = groups.getByRole("list");
      await expect(list.locator(":scope > li")).toHaveCount(20);
      scopeIds.push(...(await list.locator(":scope > li").allTextContents()));
      if (index < 4) await groups.getByRole("button", { name: "Next scope page" }).click();
    }
    expect(scopeIds).toEqual(projects);
    await expect(groups.getByRole("button", { name: "Next scope page" })).toBeDisabled();
    await groups.getByRole("button", { name: "Back to group references" }).click();
    await expect(references.getByRole("link").first()).toHaveText(api.pages[0]!.ids[20]!);
    await groups.getByRole("button", { name: `Project ${projects[1]}`, exact: true }).click();
    await expect(groups.locator('[aria-expanded="true"]')).toHaveCount(1);
    await expect(references.getByRole("link").first()).toHaveText(api.pages[0]!.ids[0]!);
    const names = await groups.getByRole("heading", { level: 4 }).allTextContents();
    for (let index = 1; index < 10; index++) {
      await groups.getByRole("button", { name: "Next group page" }).focus();
      await page.keyboard.press("Enter");
      await expect(groups.getByRole("heading", { level: 3 })).toBeFocused();
      await expect(groups.getByRole("heading", { level: 4 })).toHaveCount(10);
      await expect(groups.locator('[aria-expanded="true"]')).toHaveCount(0);
      names.push(...(await groups.getByRole("heading", { level: 4 }).allTextContents()));
    }
    expect(names).toEqual(projects.map((id) => `Project ${id}`));
    await expect(groups.getByRole("button", { name: "Next group page" })).toBeDisabled();
    expect(await groups.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    expect(
      (
        await new AxeBuilder({ page })
          .include('section[aria-label="Project groups on this timeline page"]')
          .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
          .analyze()
      ).violations,
    ).toEqual([]);
  } finally {
    await api.close();
  }
});

test("Project grouping keeps unknown and scoped-empty separate across complete timeline pages and proof Back navigation", async ({
  page,
}) => {
  const api = await fixture(page, 4, ["PVT_A", "PVT_B"]);
  for (const list of [api.input.selected.evidence, api.input.selected.portfolioEvidence]) {
    list[1].projectContext.projects = [];
    Object.assign(list[2].projectContext, { state: "unknown", projects: [], projectScope: [], observedAt: null });
    delete list[3].projectContext;
  }
  try {
    await page.goto(`${path}&limit=2`);
    const groups = page.getByRole("region", { name: "Project groups on this timeline page" });
    await expect(groups.getByRole("heading", { level: 4 })).toHaveCount(3);
    await groups.getByRole("button", { name: "No membership in verified scope", exact: true }).click();
    await expect(groups.getByText(/No membership in this event’s verified Project scope/)).toBeVisible();
    const proof = groups.getByRole("list", { name: "Project evidence references" }).getByRole("link").first();
    const href = await proof.getAttribute("href");
    expect(new URL(href!, page.url()).searchParams.get("snapshot")).toBe(pin);
    await proof.click();
    await expect(page.getByRole("heading", { name: "Contribution evidence", level: 1 })).toBeVisible();
    expect(new URL(page.url()).searchParams.get("snapshot")).toBe(pin);
    await page.goBack();
    await expect(groups.getByRole("heading", { level: 4 })).toHaveCount(3);
    await page.getByRole("link", { name: "Next timeline page", exact: true }).click();
    await expect(groups.getByRole("heading", { level: 4 })).toHaveCount(1);
    await groups.getByRole("button", { name: "Project membership unavailable", exact: true }).click();
    await expect(groups.getByRole("list", { name: "Project evidence references" }).getByRole("link")).toHaveCount(2);
    await expect(groups.getByRole("button", { name: "View verified Project scope" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Next timeline page", exact: true })).toHaveCount(0);
    expect(api.pages.at(-1)!.count).toBe(4);
    await page.goBack();
    await expect(groups.getByRole("heading", { level: 4 })).toHaveCount(3);
    await expect(groups.locator('[aria-expanded="true"]')).toHaveCount(0);
  } finally {
    await api.close();
  }
});

test("a pinned profile removes withdrawn Project references and rejects a malformed new context before rendering", async ({
  page,
}) => {
  const api = await fixture(page, 3, ["PVT_A", "PVT_B"]);
  try {
    await page.goto(`${path}&limit=100`);
    const groups = page.getByRole("region", { name: "Project groups on this timeline page" });
    await groups.getByRole("button", { name: "Project PVT_A", exact: true }).click();
    const removed = api.input.selected.evidence[0].contribution.contributionId;
    await expect(groups.getByRole("link", { name: removed, exact: true })).toBeVisible();
    api.input.controls.suppressedContributionIds = [removed];
    api.input.controls.version = "synthetic-unit-withdrawal";
    const calls = api.calls.length;
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect.poll(() => api.calls.length).toBeGreaterThan(calls);
    await expect(page.getByText("Rechecking…")).toHaveCount(0);
    await expect(page.getByRole("link", { name: removed, exact: true })).toHaveCount(0);
    await expect(groups.getByText("2 evidence records on this timeline page.", { exact: true })).toHaveCount(2);
    api.corrupt();
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(groups).toHaveCount(0);
    await expect(page.getByText("invalid_api_response", { exact: false })).toBeVisible();
    expect(new URL(page.url()).searchParams.get("snapshot")).toBe(pin);
  } finally {
    await api.close();
  }
});

async function recheckSameProofs(page: Page, api: Awaited<ReturnType<typeof fixture>>) {
  const before = api.pages.length;
  const ids = api.pages.at(-1)!.ids;
  const count = api.pages.at(-1)!.count;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect.poll(() => api.pages.length).toBeGreaterThan(before);
  await expect(page.getByText("Rechecking…")).toHaveCount(0);
  expect(api.pages.at(-1)!.ids).toEqual(ids);
  expect(api.pages.at(-1)!.count).toBe(count);
  expect(new URL(page.url()).searchParams.get("snapshot")).toBe(pin);
}

test("a valid Project membership recheck resets an out-of-range group page without changing proof identity", async ({
  page,
}) => {
  const projects = Array.from({ length: 100 }, (_, index) => `PVT_${String(index).padStart(3, "0")}`);
  const api = await fixture(page, 1, projects);
  try {
    await page.goto(`${path}&limit=100`);
    const groups = page.getByRole("region", { name: "Project groups on this timeline page" });
    await expect(groups.getByRole("heading", { level: 4 })).toHaveCount(10);
    for (let index = 0; index < 9; index++) await groups.getByRole("button", { name: "Next group page" }).click();
    await expect(groups.getByText("Groups 91–100 of 100 on this timeline page.", { exact: true })).toBeVisible();
    await recheckSameProofs(page, api);
    await expect(groups.getByText("Groups 91–100 of 100 on this timeline page.", { exact: true })).toBeVisible();
    for (const list of [api.input.selected.evidence, api.input.selected.portfolioEvidence])
      for (const proof of list) proof.projectContext.projects = projects.slice(0, 2);
    await recheckSameProofs(page, api);
    await test
      .info()
      .attach("valid-recheck-group-state", { body: await groups.innerText(), contentType: "text/plain" });
    await expect(groups.getByRole("heading", { level: 4 })).toHaveCount(2);
    await expect(groups.getByText("Groups 1–2 of 2 on this timeline page.", { exact: true })).toBeVisible();
    await expect(groups.getByRole("button", { name: `Project ${projects[0]}`, exact: true })).toBeVisible();
    await expect(groups.getByRole("button", { name: `Project ${projects[1]}`, exact: true })).toBeVisible();
  } finally {
    await api.close();
  }
});

test("a valid Project membership recheck resets reference paging while preserving unique timeline proofs", async ({
  page,
}) => {
  const api = await fixture(page, 30, ["PVT_A"]);
  try {
    await page.goto(`${path}&limit=100`);
    const groups = page.getByRole("region", { name: "Project groups on this timeline page" });
    const open = groups.getByRole("button", { name: "Project PVT_A", exact: true });
    await open.click();
    await groups.getByRole("button", { name: "Next reference page" }).click();
    const references = groups.getByRole("list", { name: "Project evidence references" });
    await expect(references.getByRole("link")).toHaveCount(10);
    await expect(references.getByRole("link").first()).toHaveText(api.pages[0]!.ids[20]!);
    await recheckSameProofs(page, api);
    await expect(references.getByRole("link").first()).toHaveText(api.pages[0]!.ids[20]!);
    for (const list of [api.input.selected.evidence, api.input.selected.portfolioEvidence])
      for (let index = 20; index < list.length; index++) list[index].projectContext.projects = [];
    await recheckSameProofs(page, api);
    await test
      .info()
      .attach("valid-recheck-reference-state", { body: await groups.innerText(), contentType: "text/plain" });
    await expect(groups.locator('[aria-expanded="true"]')).toHaveCount(0);
    await expect(references).toHaveCount(0);
    await open.click();
    await expect(references.getByRole("link")).toHaveCount(20);
    await expect(references.getByRole("link").first()).toHaveText(api.pages[0]!.ids[0]!);
    await expect(groups.getByText("References 1–20 of 20 on this timeline page.", { exact: true })).toBeVisible();
    await expect(groups.getByRole("button", { name: "No membership in verified scope", exact: true })).toBeVisible();
  } finally {
    await api.close();
  }
});

test("a valid Project scope recheck resets the previous scope page and disclosure", async ({ page }) => {
  const projects = Array.from({ length: 100 }, (_, index) => `PVT_${String(index).padStart(3, "0")}`);
  const api = await fixture(page, 1, projects);
  for (const list of [api.input.selected.evidence, api.input.selected.portfolioEvidence])
    for (const proof of list) proof.projectContext.projects = [projects[0]];
  try {
    await page.goto(`${path}&limit=100`);
    const groups = page.getByRole("region", { name: "Project groups on this timeline page" });
    const open = groups.getByRole("button", { name: `Project ${projects[0]}`, exact: true });
    await open.click();
    await groups.getByRole("button", { name: "View verified Project scope" }).click();
    for (let index = 0; index < 4; index++) await groups.getByRole("button", { name: "Next scope page" }).click();
    await expect(groups.getByText("Scope IDs 81–100 of 100.", { exact: true })).toBeVisible();
    await recheckSameProofs(page, api);
    await expect(groups.getByText("Scope IDs 81–100 of 100.", { exact: true })).toBeVisible();
    for (const list of [api.input.selected.evidence, api.input.selected.portfolioEvidence])
      for (const proof of list) proof.projectContext.projectScope = projects.slice(0, 2);
    await recheckSameProofs(page, api);
    await test
      .info()
      .attach("valid-recheck-scope-state", { body: await groups.innerText(), contentType: "text/plain" });
    await expect(
      groups.getByRole("heading", { name: "Verified Project scope for this evidence", exact: true }),
    ).toHaveCount(0);
    await expect(groups.locator('[aria-expanded="true"]')).toHaveCount(0);
    await open.click();
    await groups.getByRole("button", { name: "View verified Project scope" }).click();
    await expect(groups.getByText("Scope IDs 1–2 of 2.", { exact: true })).toBeVisible();
    expect(await groups.getByRole("list").locator(":scope > li").allTextContents()).toEqual(projects.slice(0, 2));
    for (const list of [api.input.selected.evidence, api.input.selected.portfolioEvidence])
      for (const proof of list)
        Object.assign(proof.projectContext, { state: "unknown", projects: [], projectScope: [], observedAt: null });
    await recheckSameProofs(page, api);
    await expect(
      groups.getByRole("heading", { name: "Verified Project scope for this evidence", exact: true }),
    ).toHaveCount(0);
    const unavailable = groups.getByRole("button", { name: "Project membership unavailable", exact: true });
    await expect(unavailable).toHaveAttribute("aria-expanded", "false");
    await unavailable.click();
    await expect(groups.getByRole("button", { name: "View verified Project scope" })).toHaveCount(0);
    for (const list of [api.input.selected.evidence, api.input.selected.portfolioEvidence])
      for (const proof of list) delete proof.projectContext;
    await recheckSameProofs(page, api);
    await expect(unavailable).toHaveAttribute("aria-expanded", "false");
    await unavailable.click();
    await expect(groups.getByText("Project membership unavailable for this evidence.", { exact: true })).toBeVisible();
    await expect(groups.getByRole("link")).toHaveCount(1);
  } finally {
    await api.close();
  }
});
