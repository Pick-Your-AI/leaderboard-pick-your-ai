import { test, expect } from "@playwright/test";
// Exercise the real service projection and client rendering with synthetic engine input.
test.use({ storageState: { cookies: [], origins: [] } });
test("real API board keeps 14 accepted and 3 pending separate and applies current controls to a pin", async ({
  page,
}) => {
  const { createService } = await import(new URL("../../service/dist/app.js", import.meta.url).href);
  const { readFixture, at } = await import(new URL("../../../tests/fixtures/pending-metric.mjs", import.meta.url).href);
  const input = readFixture();
  const app = createService({
    now: () => Date.parse(at),
    source: {
      async read() {
        return structuredClone(input);
      },
    },
  });
  try {
    await page.route("**/api/v1/**", async (route) => {
      const url = new URL(route.request().url());
      const response = await app.inject({ method: "GET", url: url.pathname + url.search });
      await route.fulfill({ status: response.statusCode, headers: response.headers, body: response.body });
    });
    await page.goto("/leaderboards/pr_merged?ui=api&snapshot=synthetic-pending-1");
    const row = page
      .getByRole("row")
      .filter({ has: page.getByRole("link", { name: "synthetic-pending-101", exact: true }) });
    await expect(row).toContainText("14 accepted");
    await expect(row).toContainText("3 pending (partial coverage)");
    await expect(row).toContainText("pending work is not ranked");
    await expect(row.getByRole("cell").first()).toHaveText("2");
    await expect(row).not.toContainText("17 accepted");
    input.controls.version = "synthetic-controls-2";
    input.controls.suppressedArtifactIds.push(input.selected.pendingEvidence[0].artifact.stableId);
    await page.reload();
    await expect(row).toContainText("14 accepted");
    await expect(row).toContainText("Pending unknown");
    await expect(row).not.toContainText("3 pending");
    await expect(row.getByRole("cell").first()).toHaveText("2");
  } finally {
    await app.close();
  }
});
