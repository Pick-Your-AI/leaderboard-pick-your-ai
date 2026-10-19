import { expect, test, type Page } from "@playwright/test";

const selection = "ui=prototype&period=all&actor=all&snapshot=syn-r42";
const board = (metric = "pr_merged") => `/leaderboards/${metric}?${selection}`;

async function expectFixture(page: Page) {
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Fixture explanation:");
  await expect(dialog.locator(".receipt-row").first()).toBeVisible();
  return dialog;
}

test("existing board proof remains a working fixture explanation", async ({ page }) => {
  await page.goto(board());
  await page.locator(".proof-link").first().click();
  await expectFixture(page);
});

test("a ranked count opens its own evidence with keyboard focus restored on close", async ({ page }) => {
  await page.goto(board());
  const row = page.locator(".board-table tbody tr").first();
  await expect(row).toBeVisible();
  const count = row.locator('td[data-label="Ranked value"] a');
  await expect(count).toHaveCount(1);
  const original = await count.innerText();
  await count.focus();
  await page.keyboard.press("Enter");
  await expectFixture(page);
  expect(new URL(page.url()).searchParams.get("snapshot")).toBe("syn-r42");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(count).toBeFocused();
  await expect(count).toHaveText(original);
});

test("every displayed LOC count links to the same scoped fixture rows", async ({ page }) => {
  await page.goto(board("pr_lines_changed"));
  const row = page.locator(".board-table tbody tr").first();
  await expect(row).toBeVisible();
  const proof = await row.locator(".proof-link").getAttribute("href");
  const cells = row.locator("td.numeric");
  let checked = 0;
  for (const cell of await cells.all()) {
    if (!/^\d/.test((await cell.innerText()).trim())) continue;
    const link = cell.getByRole("link");
    await expect(link).toHaveCount(1);
    await expect(link).toHaveAttribute("href", proof!);
    checked++;
  }
  expect(checked).toBeGreaterThanOrEqual(5);
  await row.locator('td[data-label="Excluded lines"] a').click();
  const dialog = await expectFixture(page);
  await dialog.locator(".receipt-row-main a").first().click();
  await expect(page.getByText("Lines changed", { exact: true })).toBeVisible();
  await expect(page.getByText("Fixture explanation", { exact: true })).toBeVisible();
});

test("overview counts carry the displayed snapshot to a fresh recipient's explanation", async ({ page, browser }) => {
  await page.goto(`/?${selection}`);
  const value = page.locator(".mini-board .numeric").first();
  await expect(value).toBeVisible();
  const link = value.getByRole("link");
  await expect(link).toHaveCount(1);
  const href = new URL((await link.getAttribute("href"))!, page.url());
  expect(href.searchParams.get("snapshot")).toBe("syn-r42");
  expect(href.searchParams.get("period")).toBe("all");
  expect(href.searchParams.get("actor")).toBe("all");
  const context = await browser.newContext();
  try {
    const recipient = await context.newPage();
    await recipient.goto(href.href);
    await expect(recipient.getByRole("complementary", { name: "Synthetic data notice" })).toBeVisible();
    await expectFixture(recipient);
  } finally {
    await context.close();
  }
});

test("a profile pending count opens its fixture using actual touch input", async ({ browser, baseURL }) => {
  if (!baseURL) throw new Error("The touch journey requires the configured browser base URL.");
  const context = await browser.newContext({
    baseURL,
    viewport: { width: 360, height: 900 },
    hasTouch: true,
    isMobile: true,
  });
  try {
    const page = await context.newPage();
    await page.goto(`/contributors/synthetic-fern?${selection}`);
    const pending = page.locator('td[data-label="Pending"] a').first();
    await expect(pending).toBeVisible();
    await pending.tap();
    const dialog = await expectFixture(page);
    await expect(dialog.getByRole("heading", { name: "Pending, not ranked", exact: true })).toBeVisible();
    await expect(dialog).toContainText("Fern (synthetic)");
    expect(new URL(page.url()).searchParams.get("snapshot")).toBe("syn-r42");
  } finally {
    await context.close();
  }
});

test("directory counts explain exact records while deleted and suppressed identities remain neutral", async ({
  page,
}) => {
  await page.goto(`/contributors?${selection}`);
  const entry = page.locator(".directory-entry").filter({ hasText: "Deleted account" });
  await expect(entry).toHaveCount(1);
  const count = entry.getByRole("link", { name: /\d+ contributions? in scope/ });
  await expect(count).toHaveCount(1);
  const expected = Number((await count.innerText()).match(/^\d+/)![0]);
  await count.click();
  const dialog = await expectFixture(page);
  await expect(dialog.getByRole("heading", { name: "Contributions: Deleted account", exact: true })).toBeVisible();
  await expect(dialog.locator(".receipt-row")).toHaveCount(expected);
  await expect(dialog).not.toContainText("Iris");
  await expect(page.locator("body")).not.toContainText("Hazel");
});

test("a wall count opens the displayed frozen board's fixture explanation", async ({ page }) => {
  await page.goto(`/live?${selection}&mode=frozen&boards=pr_merged&interval=30`);
  const cell = page.locator(".wall-table tbody tr td.numeric").first();
  await expect(cell).toBeVisible();
  const count = cell.getByRole("link");
  await expect(count).toHaveCount(1);
  await count.click();
  await expectFixture(page);
  expect(new URL(page.url()).pathname).toBe("/leaderboards/pr_merged");
  expect(new URL(page.url()).searchParams.get("snapshot")).toBe("syn-r42");
});

test("actor-filtered profiles offer only counts included by the visible actor scope", async ({ page }) => {
  for (const [login, actor] of [
    ["synthetic-ci-bot", "user"],
    ["synthetic-aster", "automation"],
  ]) {
    await page.goto(`/contributors/${login}?ui=prototype&period=all&snapshot=syn-r42&actor=${actor}`);
    await expect(page.getByRole("heading", { name: "Measures by family", exact: true })).toBeVisible();
    await expect(page.getByText("No measured activity in this scope", { exact: true })).toBeVisible();
    await expect(page.locator('.family-measures td[data-label="Counted"] a')).toHaveCount(0);
  }
  await page.goto(`/contributors/synthetic-ci-bot?${selection}`);
  await page.locator('.family-measures td[data-label="Counted"] a').first().click();
  const dialog = await expectFixture(page);
  await expect(dialog).toContainText("synthetic-ci-bot");
});

test("deleted-account board count explanations preserve their neutral public label", async ({ page }) => {
  await page.goto(board("issues_opened"));
  const row = page.locator(".board-table tbody tr").filter({ hasText: "Deleted account" });
  await expect(row).toHaveCount(1);
  await expect(row).not.toContainText("Iris");
  await expect(row.locator(".proof-link")).toHaveAccessibleName(/Deleted account/);
  const count = row.locator('td[data-label="Ranked value"] a');
  await expect(count).toHaveAccessibleName(/Deleted account/);
  await count.click();
  const dialog = await expectFixture(page);
  await expect(dialog.getByRole("heading", { name: "Evidence: Deleted account", exact: true })).toBeVisible();
  await expect(dialog).not.toContainText("Iris");
});

test("directory count history keeps the exact repository records and excludes corrected source rows", async ({
  page,
}) => {
  await page.goto(`/contributors?${selection}&repo=syn-repo-research&q=birch`);
  const count = page.getByRole("link", { name: /^3 contributions in scope for Birch/ });
  await expect(count).toBeVisible();
  await count.focus();
  await page.keyboard.press("Enter");
  const dialog = await expectFixture(page);
  const links = dialog.locator(".receipt-row-main a");
  await expect(links).toHaveCount(3);
  const hrefs = await links.evaluateAll((nodes) => nodes.map((node) => (node as HTMLAnchorElement).href));
  expect(hrefs.map((href) => new URL(href).pathname).sort()).toEqual([
    "/contributions/syn-c-021",
    "/contributions/syn-c-022",
    "/contributions/syn-c-028",
  ]);
  for (const href of hrefs) {
    const url = new URL(href);
    expect(url.searchParams.get("repo")).toBe("syn-repo-research");
    expect(url.searchParams.get("snapshot")).toBe("syn-r42");
  }
  await page.goBack();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(count).toBeFocused();
  await page.goForward();
  await expectFixture(page);
  await expect(page.getByLabel("Find a contributor")).toHaveValue("birch");
});

test("count links bind the actual served snapshot during a rebuilding request", async ({ page }) => {
  await page.goto("/leaderboards/pr_merged?ui=prototype&period=all&actor=all&snapshot=syn-r44-rebuilding");
  const count = page.locator('.board-table td[data-label="Ranked value"] a').first();
  await expect(count).toBeVisible();
  const url = new URL((await count.getAttribute("href"))!, page.url());
  expect(url.searchParams.get("snapshot")).toBe("syn-r42");
  await count.click();
  await expectFixture(page);
  expect(new URL(page.url()).searchParams.get("snapshot")).toBe("syn-r42");
});

test("a held board count stays bound to its displayed snapshot after a newer head arrives", async ({ page }) => {
  await page.clock.install();
  await page.goto("/leaderboards/prs_reviewed?ui=prototype&period=all&actor=all");
  await page.clock.runFor(200);
  const count = page.locator('.board-table td[data-label="Ranked value"] a').first();
  await expect(count).toBeVisible();
  const value = await count.innerText();
  await page.clock.runFor(20_000);
  await expect(page.getByRole("button", { name: "Apply updates", exact: true })).toBeVisible();
  expect(new URL((await count.getAttribute("href"))!, page.url()).searchParams.get("snapshot")).toBe("syn-r42");
  await count.click();
  await expectFixture(page);
  await expect(count).toHaveText(value);
  expect(new URL(page.url()).searchParams.get("snapshot")).toBe("syn-r42");
});

for (const [surface, path, selector] of [
  ["board", "/leaderboards/issues_opened", '.board-table td[data-label="Ranked value"] a'],
  ["overview", "/", ".mini-board .numeric a"],
  ["directory", "/contributors", ".directory-entry .count-link"],
  ["profile", "/contributors/synthetic-birch", '.family-measures td[data-label="Counted"] a'],
] as const) {
  test(`${surface} count links retain their displayed scope while a replacement read is pending`, async ({ page }) => {
    await page.clock.install({ time: new Date("2026-10-18T15:00:00Z") });
    await page.goto(`${path}?${selection}`);
    const count = page.locator(selector).first();
    await expect(count).toBeVisible();
    const originalHref = await count.getAttribute("href");
    const originalText = await count.innerText();
    await page.clock.pauseAt(new Date("2026-10-18T15:01:00Z"));
    await page.getByRole("combobox", { name: "Repository", exact: true }).selectOption("syn-repo-research");
    await expect(page.getByRole("combobox", { name: "Repository", exact: true })).toHaveValue("syn-repo-research");
    await expect(count).toHaveText(originalText);
    await expect(count).toHaveAttribute("href", originalHref!);
    await page.clock.runFor(200);
    if (surface === "board") {
      await expect(count).toHaveCount(0);
      await expect(page.getByText("Nothing observed, but coverage is incomplete", { exact: true })).toBeVisible();
      return;
    }
    await expect(count).toHaveAttribute("href", /repo=syn-repo-research/);
    expect(new URL((await count.getAttribute("href"))!, page.url()).searchParams.get("snapshot")).toBe("syn-r42");
    await count.click();
    await page.clock.runFor(200);
    await expectFixture(page);
    expect(new URL(page.url()).searchParams.get("repo")).toBe("syn-repo-research");
  });
}
