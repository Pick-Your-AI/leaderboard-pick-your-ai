import { test, expect, type Browser, type Page, type TestInfo } from "@playwright/test";
import { evidenceService } from "./evidenceHarness.ts";

test.use({ storageState: { cookies: [], origins: [] } });

const selected = {
  period: "90d",
  repo: "syn-repo-website",
  project: "syn-proj-web",
  actor: "all",
  snapshot: "syn-r41",
};

async function readInFreshRecipient(
  browser: Browser,
  source: Page,
  copied: string,
  heading: string,
  info: TestInfo,
  recipientMode: "api" | null = null,
  scope: Record<string, string> = selected,
  snapshotControl = true,
) {
  const origin = new URL(source.url()).origin;
  const context = await browser.newContext({
    storageState: {
      cookies: [],
      origins: recipientMode ? [{ origin, localStorage: [{ name: "pyai.ui.mode", value: recipientMode }] }] : [],
    },
  });
  try {
    const recipient = await context.newPage();
    await recipient.goto(new URL(copied, source.url()).href);
    await expect(recipient.getByRole("heading", { level: 1 })).toHaveCount(1);
    await info.attach("fresh-recipient-state", {
      contentType: "application/json",
      body: JSON.stringify({
        copied,
        recipientModeBeforeNavigation: recipientMode,
        finalUrl: recipient.url(),
        heading: await recipient.getByRole("heading", { level: 1 }).textContent(),
        storedMode: await recipient.evaluate(() => localStorage.getItem("pyai.ui.mode")),
      }),
    });
    await expect(recipient.getByRole("complementary", { name: "Synthetic data notice" })).toBeVisible();
    await expect(recipient.getByRole("heading", { level: 1, name: heading, exact: true })).toBeVisible();
    expect(Object.fromEntries(new URL(recipient.url()).searchParams)).toMatchObject({ ...scope, ui: "prototype" });
    if (scope.snapshot && snapshotControl) {
      await expect(recipient.getByRole("combobox", { name: "Snapshot", exact: true })).toHaveValue(scope.snapshot);
    }
  } finally {
    await context.close();
  }
}

for (const recipientMode of [null, "api"] as const) {
  test(`a copied prototype navigation URL overrides ${recipientMode ?? "absent"} recipient mode`, async ({
    page,
    browser,
  }, info) => {
    await page.goto(`/?${new URLSearchParams({ ...selected, ui: "prototype" })}`);
    await expect(page.getByRole("heading", { name: "Contributions, with evidence", exact: true })).toBeVisible();
    await page
      .getByRole("navigation", { name: "Primary" })
      .getByRole("link", { name: "Leaderboards", exact: true })
      .press("Enter");
    await expect(page.getByRole("heading", { name: "Leaderboards", exact: true })).toBeFocused();
    await readInFreshRecipient(browser, page, page.url(), "Leaderboards", info, recipientMode);
  });
}

test("a copied predefined walkthrough link selects synthetic data in a fresh API recipient", async ({
  page,
  browser,
}, info) => {
  await page.goto("/prototype?ui=prototype");
  const link = page.getByRole("link", { name: "PRs merged board", exact: true });
  await expect(link).toBeVisible();
  await readInFreshRecipient(browser, page, (await link.getAttribute("href"))!, "PRs merged", info, "api", {});
});

test("a copied displayed guide URL selects the same partial-history prototype for a fresh recipient", async ({
  page,
  browser,
}, info) => {
  await page.goto("/prototype?ui=prototype");
  const row = page
    .getByRole("region", { name: "Required states", exact: true })
    .getByRole("listitem")
    .filter({ has: page.getByRole("link", { name: "Partial history", exact: true }) });
  const displayed = await row.locator("span").innerText();
  await readInFreshRecipient(browser, page, displayed, "PRs merged", info, null, { repo: selected.repo });
  await expect(row.getByRole("link")).toHaveAttribute("href", displayed);
});

test("a prototype selected from stored preference makes its current address reproducible", async ({
  page,
  browser,
}, info) => {
  await page.addInitScript(() => {
    localStorage.setItem("pyai.ui.mode", "prototype");
    history.replaceState({ entryLength: history.length, marker: "prototype-sharing" }, "", location.href);
  });
  await page.goto(`/leaderboards/pr_merged?${new URLSearchParams(selected)}#shared-board`);
  await expect(page.getByRole("heading", { name: "PRs merged", exact: true })).toBeVisible();
  const entry = await page.evaluate(() => ({ length: history.length, state: history.state }));
  expect(entry.state).toEqual({ entryLength: entry.length, marker: "prototype-sharing" });
  expect(new URL(page.url()).hash).toBe("#shared-board");
  await readInFreshRecipient(browser, page, page.url(), "PRs merged", info);
  const original = page.url();
  await page.getByRole("combobox", { name: "Period", exact: true }).selectOption("7d");
  await page.goBack();
  await expect(page).toHaveURL(original);
  await expect(page.getByRole("combobox", { name: "Period", exact: true })).toHaveValue("90d");
  expect(await page.evaluate(() => history.state)).toEqual(entry.state);
  await page.goForward();
  await expect(page.getByRole("combobox", { name: "Period", exact: true })).toHaveValue("7d");
  expect(new URL(page.url()).searchParams.get("ui")).toBe("prototype");
  expect(await page.evaluate(() => history.length)).toBe(entry.length + 1);
});

test("an explicit prototype scope edit remains reproducible without the sender's storage", async ({
  page,
  browser,
}, info) => {
  await page.goto(`/leaderboards/pr_merged?${new URLSearchParams({ ...selected, ui: "prototype" })}`);
  await expect(page.getByRole("heading", { name: "PRs merged", exact: true })).toBeVisible();
  await page.getByRole("combobox", { name: "Period", exact: true }).selectOption("7d");
  await readInFreshRecipient(browser, page, page.url(), "PRs merged", info, null, { ...selected, period: "7d" });
});

test("the displayed and clipboard wall URL reproduce the frozen prototype in a fresh API recipient", async ({
  page,
  browser,
}, info) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto(`/live?${new URLSearchParams({ ...selected, ui: "prototype" })}`);
  await expect(page.getByRole("heading", { name: "Live wall", exact: true })).toBeVisible();
  await page.getByRole("radio", { name: /Frozen snapshot/ }).check();
  const checked = page.locator(".wall-config input[type=checkbox]:checked");
  while (await checked.count()) await checked.first().uncheck();
  await page.getByRole("checkbox", { name: "PRs merged", exact: true }).check();
  await page.getByRole("spinbutton", { name: "Seconds per page (minimum 20)", exact: true }).fill("45");
  await page.getByRole("combobox", { name: "Format", exact: true }).selectOption("portrait");
  await page.getByRole("button", { name: "Copy URL", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Wall URL copied." })).toBeVisible();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  const displayed = (await page.locator(".wall-url .mono").textContent())!;
  expect(copied).toBe(new URL(displayed, page.url()).href);
  await readInFreshRecipient(
    browser,
    page,
    copied,
    "PRs merged",
    info,
    "api",
    { ...selected, mode: "frozen", boards: "pr_merged", interval: "45", format: "portrait" },
    false,
  );
  expect(await page.getByRole("link", { name: "Open the wall", exact: true }).getAttribute("href")).toBe(displayed);
});

test("an explicit API URL keeps API data even when the sender has a prototype preference", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("pyai.ui.mode", "prototype"));
  const api = await evidenceService(page);
  try {
    await page.goto("/leaderboards/pr_merged?ui=api&organization=Pick-Your-AI&repository=repo-1");
    await expect(page.getByRole("heading", { name: "Contribution board", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Synthetic API A", exact: true })).toBeVisible();
    await expect(page.getByRole("complementary", { name: "Synthetic data notice" })).toHaveCount(0);
    expect(new URL(page.url()).searchParams.get("ui")).toBe("api");
    expect(await page.evaluate(() => localStorage.getItem("pyai.ui.mode"))).toBe("api");
  } finally {
    await api.close();
  }
});

test("a stored prototype preference preserves the native account and administration entry points", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("pyai.ui.mode", "prototype"));
  for (const [path, heading] of [
    ["/account/", "Your account"],
    ["/admin", "Protected administration"],
  ]) {
    await page.goto(path!);
    await expect(page.getByRole("heading", { name: heading!, exact: true })).toBeVisible();
    await expect(page.getByRole("complementary", { name: "Synthetic data notice" })).toHaveCount(0);
    expect(new URL(page.url()).searchParams.has("ui")).toBe(false);
  }
});
