import { expect, test, type Locator } from "@playwright/test";

async function expectNeutralCount(entry: Locator) {
  const count = entry.getByRole("link");
  await expect(count).toHaveCount(1);
  await expect(count).toHaveAccessibleName("1 contribution in scope for Deleted account. Open fixture explanation");
  await expect(count).toHaveAttribute(
    "href",
    "/contributors?period=all&snapshot=syn-r42&proof=record%3Asyn-c-032&ui=prototype",
  );
  await expect(entry).not.toContainText(/synthetic-iris|Iris \(synthetic\)|syn-actor-9/);
  expect(await entry.ariaSnapshot()).not.toMatch(/synthetic-iris|Iris \(synthetic\)|syn-actor-9/);
}

test.beforeEach(async ({ page }) => {
  await page.goto("/contributors?period=all&snapshot=syn-r42");
  await expect(page.getByRole("heading", { name: "Contributors", exact: true })).toBeVisible();
  await expect(page.locator(".directory-entry").filter({ hasText: "Deleted account" })).toBeVisible();
});

for (const query of ["synthetic-iris", "Iris (synthetic)"]) {
  test(`a deleted contributor cannot be selected by the former identity: ${query}`, async ({ page }) => {
    await page.getByRole("searchbox", { name: "Find a contributor" }).fill(query);
    await expect(page.locator(".directory-entry")).toHaveCount(0);
    await expect(page.getByText("No contributors match", { exact: true })).toBeVisible();
    await expect(page.locator('a[href^="/contributors/synthetic-iris"]')).toHaveCount(0);
  });
}

test("suppressed and unknown identities both produce the same empty directory state", async ({ page }) => {
  for (const query of ["synthetic-hazel", "Hazel (synthetic)", "synthetic-nobody"]) {
    await page.getByRole("searchbox", { name: "Find a contributor" }).fill(query);
    await expect(page.getByText("No contributors match", { exact: true })).toBeVisible();
    await expect(page.locator(".directory-entry")).toHaveCount(0);
    await expect(page.locator('a[href^="/contributors/synthetic-hazel"]')).toHaveCount(0);
  }
});

for (const [login, displayName] of [
  ["synthetic-aster", "Aster (synthetic)"],
  ["synthetic-gale", "Gale (synthetic)"],
] as const) {
  test(`visible contributor search includes ${login} by login and display name`, async ({ page }) => {
    // Gale has only observed or pending work: accepted outcomes are not an inclusion requirement.
    for (const query of [login.toUpperCase(), displayName.toUpperCase()]) {
      await page.getByRole("searchbox", { name: "Find a contributor" }).fill(query);
      await expect(page.locator(".directory-entry")).toHaveCount(1);
      const entry = page.locator(".directory-entry");
      await expect(entry.getByRole("link", { name: `${displayName} @${login}`, exact: true })).toHaveAttribute(
        "href",
        `/contributors/${login}?period=all&snapshot=syn-r42&ui=prototype`,
      );
      const count = entry.getByRole("link", { name: /contributions? in scope for/ });
      await expect(count).toHaveCount(1);
      const countUrl = new URL((await count.getAttribute("href"))!, page.url());
      expect(countUrl.pathname).toBe("/contributors");
      expect(Object.fromEntries(countUrl.searchParams)).toEqual({
        period: "all",
        snapshot: "syn-r42",
        q: query,
        proof: login,
        ui: "prototype",
      });
      await expect(entry.getByRole("link")).toHaveCount(2);
      await expect(entry).toContainText(displayName);
      await expect(page.getByRole("searchbox", { name: "Find a contributor" })).toBeFocused();
    }
  });
}

test("anonymous historical credit remains when the search is empty or cleared", async ({ page }) => {
  const anonymous = page.locator(".directory-entry").filter({ hasText: "Deleted account" });
  await expectNeutralCount(anonymous);

  await page.getByRole("searchbox", { name: "Find a contributor" }).fill("   ");
  await expect(anonymous).toBeVisible();
  await page.getByRole("searchbox", { name: "Find a contributor" }).fill("synthetic-nobody");
  await expect(page.getByText("No contributors match", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Clear the search", exact: true }).click();

  await expect(page).toHaveURL((url) => {
    return (
      url.searchParams.get("period") === "all" &&
      url.searchParams.get("snapshot") === "syn-r42" &&
      !url.searchParams.has("q")
    );
  });
  await expect(page.getByRole("searchbox", { name: "Find a contributor" })).toHaveValue("");
  await expect(anonymous).toBeVisible();
  await expectNeutralCount(anonymous);
  await anonymous.getByRole("link").click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Contributions: Deleted account", exact: true })).toBeVisible();
  await expect(dialog.locator(".receipt-row")).toHaveCount(1);
  await expect(dialog.locator(".receipt-row-main a")).toHaveAttribute("href", /^\/contributions\/syn-c-032\?/);
  await expect(dialog.getByRole("link", { name: "Open as a full page", exact: true })).toHaveCount(0);
  expect(await dialog.ariaSnapshot()).not.toMatch(/synthetic-iris|Iris \(synthetic\)|syn-actor-9/);
  const targets = await page.locator("a[href]").evaluateAll((links) => links.map((link) => link.getAttribute("href")));
  expect(targets.join("\n")).not.toMatch(/synthetic-iris|Iris|syn-actor-9/);
});
