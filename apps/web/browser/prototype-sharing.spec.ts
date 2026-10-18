import { expect, test, type Browser, type Page } from "@playwright/test";

const selected = {
  period: "90d",
  repo: "syn-repo-website",
  project: "syn-proj-web",
  actor: "all",
  snapshot: "syn-r41",
};

async function expectSynthetic(page: Page, scope: Record<string, string> = selected) {
  await expect(page.getByRole("complementary", { name: "Synthetic data notice" })).toBeVisible();
  expect(Object.fromEntries(new URL(page.url()).searchParams)).toMatchObject(scope);
}

async function checkFreshRecipient(
  browser: Browser,
  href: string,
  heading: string,
  scope: Record<string, string> = selected,
) {
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const recipient = await context.newPage();
  const apiReads: string[] = [];
  await context.route("**/api/**", (route) => {
    apiReads.push(route.request().url());
    return route.fulfill({ status: 503, contentType: "application/json", body: "{}" });
  });
  try {
    await recipient.goto(href);
    await expect(recipient.getByRole("heading", { level: 1, name: heading, exact: true })).toBeVisible();
    await expectSynthetic(recipient, scope);
    expect(new URL(recipient.url()).searchParams.get("ui")).toBe("prototype");
    expect(apiReads).toEqual([]);
  } finally {
    await context.close();
  }
}

test("copied prototype navigation links and URLs select the same view for a fresh recipient", async ({
  page,
  browser,
}) => {
  await page.goto(`/leaderboards?${new URLSearchParams({ ...selected, ui: "prototype" })}`);
  await expectSynthetic(page);
  const journey = page
    .locator("p")
    .filter({ hasText: "Journeys:" })
    .getByRole("link", { name: "PRs merged", exact: true });
  const href = new URL((await journey.getAttribute("href"))!, page.url()).href;
  await checkFreshRecipient(browser, href, "PRs merged");
  await journey.press("Enter");
  await expect(page.getByRole("heading", { level: 1, name: "PRs merged", exact: true })).toBeFocused();
  await checkFreshRecipient(browser, page.url(), "PRs merged");
  await page.goBack();
  await expect(page.getByRole("heading", { level: 1, name: "Leaderboards", exact: true })).toBeFocused();
  await page.goForward();
  await expect(page.getByRole("heading", { level: 1, name: "PRs merged", exact: true })).toBeFocused();
  await expectSynthetic(page);
});

test("prototype scope changes preserve a copyable mode when browser storage is unavailable", async ({
  page,
  browser,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", {
      get() {
        throw new DOMException("Storage unavailable", "SecurityError");
      },
    });
  });
  await page.goto(
    `/leaderboards/pr_merged?${new URLSearchParams({ ...selected, period: "30d", ui: "prototype" })}#main`,
  );
  await expect(page.getByRole("heading", { level: 1, name: "PRs merged", exact: true })).toBeVisible();
  await page.getByRole("combobox", { name: "Period", exact: true }).selectOption("90d");
  await expectSynthetic(page);
  await checkFreshRecipient(browser, page.url(), "PRs merged");
});

test("a prototype entry selected from remembered mode has a self-contained current URL", async ({ page, browser }) => {
  await page.goto(`/leaderboards/pr_merged?${new URLSearchParams(selected)}#main`);
  await expectSynthetic(page);
  await expect(page).toHaveURL(/#main$/);
  await checkFreshRecipient(browser, page.url(), "PRs merged");
});

test("the displayed and copied prototype wall URL opens the same frozen view with fresh storage", async ({
  page,
  browser,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      value: {
        async writeText(value: string) {
          Object.defineProperty(window, "copiedWallUrl", { value, configurable: true });
        },
      },
    });
  });
  await page.goto(`/live?${new URLSearchParams({ ...selected, ui: "prototype" })}`);
  await expectSynthetic(page);
  await page.getByRole("radio", { name: /Frozen snapshot/ }).check();
  for (const board of await page.getByRole("checkbox").all()) await board.uncheck();
  await page.getByRole("checkbox", { name: "PRs merged", exact: true }).check();
  const displayed = await page.locator(".wall-url").innerText();
  const href = new URL(displayed, page.url()).href;
  await expect(page.getByRole("link", { name: "Open the wall", exact: true })).toHaveAttribute("href", displayed);
  await page.getByRole("button", { name: "Copy URL", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Wall URL copied." })).toBeVisible();
  expect(await page.evaluate(() => Reflect.get(window, "copiedWallUrl"))).toBe(href);
  await checkFreshRecipient(browser, href, "PRs merged");
});

test("prototype guide URLs preserve the intended source when copied as displayed text", async ({ page, browser }) => {
  await page.goto("/prototype?ui=prototype");
  const row = page
    .getByRole("region", { name: "Required states", exact: true })
    .getByRole("listitem")
    .filter({ has: page.getByRole("link", { name: "Partial history", exact: true }) });
  const displayed = await row.locator("span").innerText();
  await expect(row.getByRole("link")).toHaveAttribute("href", displayed);
  await checkFreshRecipient(browser, new URL(displayed, page.url()).href, "PRs merged", { repo: selected.repo });
});

test("explicit API mode overrides remembered prototype mode", async ({ page }) => {
  await page.route("**/api/**", (route) => route.fulfill({ status: 503, contentType: "application/json", body: "{}" }));
  await page.goto("/?ui=api");
  await expect(
    page.getByRole("heading", { level: 1, name: "Public contribution evidence", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("complementary", { name: "Synthetic data notice" })).toHaveCount(0);
  expect(new URL(page.url()).searchParams.get("ui")).toBe("api");
});
