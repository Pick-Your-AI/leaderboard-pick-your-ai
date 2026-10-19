import { expect, test, type Browser } from "@playwright/test";

test.use({ storageState: { cookies: [], origins: [] } });

async function readCopiedUrl(browser: Browser, href: string, scope: Record<string, string>) {
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const apiReads: string[] = [];
  await context.route("**/api/**", (route) => {
    apiReads.push(route.request().url());
    return route.fulfill({ status: 503, contentType: "application/json", body: "{}" });
  });
  try {
    const recipient = await context.newPage();
    await recipient.goto(href);
    await expect(recipient.getByRole("heading", { level: 1, name: "PRs merged", exact: true })).toBeVisible();
    await expect(recipient.getByRole("complementary", { name: "Synthetic data notice" })).toBeVisible();
    expect(Object.fromEntries(new URL(recipient.url()).searchParams)).toMatchObject({ ...scope, ui: "prototype" });
    expect(apiReads).toEqual([]);
  } finally {
    await context.close();
  }
}

test("prototype guide URLs retain their source when copied as displayed text", async ({ page, browser }) => {
  await page.goto("/prototype?ui=prototype");
  const row = page
    .getByRole("region", { name: "Required states", exact: true })
    .getByRole("listitem")
    .filter({ has: page.getByRole("link", { name: "Partial history", exact: true }) });
  const displayed = await row.locator("span").innerText();
  await expect(row.getByRole("link")).toHaveAttribute("href", displayed);
  await readCopiedUrl(browser, new URL(displayed, page.url()).href, { repo: "syn-repo-website" });
});

test("prototype scope changes remain copyable when sender storage is unavailable", async ({ page, browser }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", {
      get() {
        throw new DOMException("Storage unavailable", "SecurityError");
      },
    });
  });
  const scope = {
    period: "30d",
    repo: "syn-repo-website",
    project: "syn-proj-web",
    actor: "all",
    snapshot: "syn-r41",
  };
  await page.goto(`/leaderboards/pr_merged?${new URLSearchParams({ ...scope, ui: "prototype" })}#main`);
  await expect(page.getByRole("heading", { level: 1, name: "PRs merged", exact: true })).toBeVisible();
  await page.getByRole("combobox", { name: "Period", exact: true }).selectOption("90d");
  await readCopiedUrl(browser, page.url(), { ...scope, period: "90d" });
});
