import { expect, test } from "@playwright/test";

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
      await expect(page.locator(".directory-entry").getByRole("link")).toHaveAttribute(
        "href",
        `/contributors/${login}?period=all&snapshot=syn-r42&ui=prototype`,
      );
      await expect(page.locator(".directory-entry")).toContainText(displayName);
      await expect(page.getByRole("searchbox", { name: "Find a contributor" })).toBeFocused();
    }
  });
}

test("anonymous historical credit remains when the search is empty or cleared", async ({ page }) => {
  const anonymous = page.locator(".directory-entry").filter({ hasText: "Deleted account" });
  await expect(anonymous.getByRole("link")).toHaveCount(0);
  await expect(anonymous).not.toContainText(/synthetic-iris|Iris \(synthetic\)/);

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
  await expect(anonymous.getByRole("link")).toHaveCount(0);
  await expect(anonymous).not.toContainText(/synthetic-iris|Iris \(synthetic\)/);
});
