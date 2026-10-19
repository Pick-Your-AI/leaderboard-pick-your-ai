import { expect, test, type Page } from "@playwright/test";

const selection = "ui=prototype&period=all&actor=all&snapshot=syn-r42&repo=syn-repo-website";
const neutralProof = "record:syn-c-032";
const identities = /synthetic-iris|Iris \(synthetic\)|syn-actor-9/;
const routes = ["/contributors", "/leaderboards/issues_opened"] as const;

async function expectNeutralTargets(page: Page) {
  const targets = await page.locator("a[href]").evaluateAll((links) => links.map((link) => link.getAttribute("href")));
  expect(targets.join("\n")).not.toMatch(identities);
  expect(await page.locator("body").ariaSnapshot()).not.toMatch(identities);
  await expect(page.locator('a[href^="/contributors/synthetic-iris"]')).toHaveCount(0);
}

async function expectAnonymousProof(page: Page) {
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: /^(Contributions|Evidence): Deleted account$/ })).toBeVisible();
  await expect(dialog.locator(".receipt-row")).toHaveCount(1);
  const receipt = dialog.locator(".receipt-row-main a");
  await expect(receipt).toHaveText("Reported: stale banner never clears");
  const href = new URL((await receipt.getAttribute("href"))!, page.url());
  expect(href.pathname).toBe("/contributions/syn-c-032");
  expect(href.searchParams.get("snapshot")).toBe("syn-r42");
  expect(href.searchParams.get("repo")).toBe("syn-repo-website");
  await expect(dialog.getByRole("link", { name: "Open as a full page", exact: true })).toHaveCount(0);
  await expectNeutralTargets(page);
  return dialog;
}

test("anonymous overview and wall counts expose only their displayed contribution selector", async ({ page }) => {
  for (const [route, rows] of [
    ["/", ".mini-board li"],
    ["/live", ".wall-table tbody tr"],
  ] as const) {
    await page.goto(`${route}?${selection}${route === "/live" ? "&mode=frozen&boards=issues_opened&interval=30" : ""}`);
    const entry = page.locator(rows).filter({ hasText: "Deleted account" });
    await expect(entry).toHaveCount(1);
    const count = entry.getByRole("link");
    await expect(count).toHaveCount(1);
    const href = new URL((await count.getAttribute("href"))!, page.url());
    expect(href.pathname).toBe("/leaderboards/issues_opened");
    expect(Object.fromEntries(href.searchParams)).toEqual({
      period: "all",
      actor: "all",
      snapshot: "syn-r42",
      repo: "syn-repo-website",
      proof: neutralProof,
      ui: "prototype",
    });
    await expectNeutralTargets(page);
    await count.click();
    await expectAnonymousProof(page);
  }
});

for (const route of routes) {
  test(`a copied anonymous ${route} proof opens its exact receipt in a fresh context`, async ({ page, browser }) => {
    await page.goto(`${route}?${selection}`);
    const entry = page.locator(route === "/contributors" ? ".directory-entry" : ".board-table tbody tr").filter({
      hasText: "Deleted account",
    });
    const count = entry.locator(".count-link");
    await expect(count).toHaveCount(1);
    const copied = new URL((await count.getAttribute("href"))!, page.url());
    expect(copied.searchParams.get("proof")).toBe(neutralProof);
    const context = await browser.newContext();
    try {
      const recipient = await context.newPage();
      await recipient.goto(copied.href);
      await expect(recipient.getByRole("complementary", { name: "Synthetic data notice" })).toBeVisible();
      const dialog = await expectAnonymousProof(recipient);
      await dialog.locator(".receipt-row-main a").click();
      await expect(
        recipient.getByRole("heading", { name: "Reported: stale banner never clears", exact: true }),
      ).toBeVisible();
      await expect(
        recipient.getByText("Source no longer public; the link was removed.", { exact: true }),
      ).toBeVisible();
      await expect(recipient.locator('a[href^="https://synthetic.example/"]')).toHaveCount(0);
      await expectNeutralTargets(recipient);
    } finally {
      await context.close();
    }
  });
}

test("deleted, suppressed and unknown login proof aliases all fail with the same generic explanation", async ({
  page,
}) => {
  for (const route of routes) {
    for (const selector of ["synthetic-iris", "synthetic-hazel", "synthetic-nobody"]) {
      await page.goto(`${route}?${selection}&proof=${encodeURIComponent(selector)}`);
      const dialog = page.getByRole("dialog");
      await expect(dialog.getByRole("heading", { name: "Evidence not found", exact: true })).toBeVisible();
      await expect(
        dialog.getByText("No public contribution explanation is available for this selection.", { exact: true }),
      ).toBeVisible();
      await expect(dialog.locator(".receipt-row")).toHaveCount(0);
      await expect(dialog.getByRole("link")).toHaveCount(0);
      expect(await dialog.ariaSnapshot()).not.toContain(selector);
    }
  }
});

test("record proof selectors cannot borrow another contributor, an excluded record or an unknown record", async ({
  page,
}) => {
  for (const route of routes) {
    for (const selector of ["record:syn-c-033", "record:syn-c-024", "record:missing"]) {
      await page.goto(`${route}?${selection}&proof=${encodeURIComponent(selector)}`);
      const dialog = page.getByRole("dialog");
      await expect(dialog.getByRole("heading", { name: "Evidence not found", exact: true })).toBeVisible();
      await expect(dialog.locator(".receipt-row")).toHaveCount(0);
      await expect(dialog.getByRole("link")).toHaveCount(0);
    }
  }
});

test("anonymous proof requires current repository, actor and date membership and history restores the original scope", async ({
  page,
}) => {
  for (const route of routes) {
    const original = `${route}?${selection}&proof=${encodeURIComponent(neutralProof)}`;
    await page.goto(original);
    await expectAnonymousProof(page);
    await page.getByRole("combobox", { name: "Repository", exact: true }).selectOption("syn-repo-research");
    await expect(
      page.getByRole("dialog").getByRole("heading", { name: "Evidence not found", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("dialog").locator(".receipt-row")).toHaveCount(0);
    await page.goBack();
    await expectAnonymousProof(page);
    for (const [key, value] of [
      ["actor", "automation"],
      ["period", "7d"],
    ] as const) {
      const outside = new URL(original, page.url());
      outside.searchParams.set(key, value);
      await page.goto(outside.href);
      const dialog = page.getByRole("dialog");
      await expect(dialog.getByRole("heading", { name: "Evidence not found", exact: true })).toBeVisible();
      await expect(dialog.locator(".receipt-row")).toHaveCount(0);
      await expect(dialog.getByRole("link")).toHaveCount(0);
    }
  }
});
