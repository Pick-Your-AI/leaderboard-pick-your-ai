import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test.use({ storageState: { cookies: [], origins: [] } });
const path = "/api/v1/cards/101";
const query = "?metric=pr_merged&snapshot=synthetic-pending-1";

async function service(page: Page) {
  const { createService } = await import(new URL("../../service/dist/app.js", import.meta.url).href);
  const { readFixture } = await import(new URL("../../../tests/fixtures/pending-metric.mjs", import.meta.url).href);
  const value = readFixture();
  const app = createService({ source: { read: async () => structuredClone(value) } });
  await page.route("**/api/v1/cards/**", async (route) => {
    const url = new URL(route.request().url());
    const response = await app.inject({ method: "GET", url: url.pathname + url.search });
    await route.fulfill({ status: response.statusCode, headers: response.headers, body: response.body });
  });
  return app;
}

test("the actual HTML card exposes measure context as semantic terms and definitions", async ({ page }) => {
  const app = await service(page);
  try {
    await page.goto(path + query);
    await expect(page.getByRole("heading", { name: "PRs merged", exact: true })).toBeVisible();
    for (const [label, value] of [
      ["Unit", "PR objects"],
      ["Aggregation", "count_distinct_eligible_units"],
      ["Samples", "14"],
      ["Numerator", "unknown"],
      ["Pending", "3 (partial)"],
      ["Value class", "qualified"],
    ] as const) {
      const definition = page
        .locator("dt")
        .filter({ hasText: new RegExp("^" + label + "$") })
        .locator("+ dd");
      await expect(definition).toHaveText(value);
      await expect(definition).toBeVisible();
    }
    await expect(page.getByRole("link", { name: "Scoped contribution portfolio" })).toHaveAttribute(
      "href",
      /snapshot=synthetic-pending-1.*metric=pr_merged.*ui=api/,
    );
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  } finally {
    await app.close();
  }
});

test("the actual passive SVG keeps every measure-context line inside its measured canvas", async ({ page }) => {
  const app = await service(page);
  try {
    await page.goto(path + "/image" + query);
    await expect(page.locator("svg text").filter({ hasText: "Unit: PR objects" })).toBeVisible();
    await expect(page.locator("svg desc")).toContainText("Pending: 3 (partial); Value class: qualified");
    await page.evaluate(() => document.fonts.ready);
    const geometry = await page.locator("svg").evaluate((element) => {
      const svg = element as SVGSVGElement;
      const view = svg.viewBox.baseVal;
      return {
        width: view.width,
        height: view.height,
        boxes: Array.from(svg.querySelectorAll("text"), (line) => {
          const box = line.getBBox();
          return { text: line.textContent, x: box.x, y: box.y, width: box.width, height: box.height };
        }),
      };
    });
    expect(geometry.boxes.some((box) => box.text?.includes("Samples: 14"))).toBe(true);
    expect(geometry.boxes.at(-1)?.text).toContain("not a live activity or productivity claim");
    for (const box of geometry.boxes) {
      expect(box.x, box.text ?? "").toBeGreaterThanOrEqual(0);
      expect(box.y, box.text ?? "").toBeGreaterThanOrEqual(0);
      expect(box.x + box.width, box.text ?? "").toBeLessThanOrEqual(geometry.width);
      expect(box.y + box.height, box.text ?? "").toBeLessThanOrEqual(geometry.height);
    }
    await expect(page.locator("svg script, svg foreignObject, svg image, svg a")).toHaveCount(0);
  } finally {
    await app.close();
  }
});
