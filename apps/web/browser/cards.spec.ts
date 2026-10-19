import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test.use({ storageState: { cookies: [], origins: [] } });
const path = "/api/v1/cards/101";
const query = "?metric=pr_merged&snapshot=synthetic-pending-1";

async function service(
  page: Page,
  options: { sourceUrl?: string; repository?: string; login?: string; projects?: string[] } = {},
) {
  const { createService } = await import(new URL("../../service/dist/app.js", import.meta.url).href);
  const { readFixture } = await import(new URL("../../../tests/fixtures/pending-metric.mjs", import.meta.url).href);
  const value = readFixture();
  if (options.sourceUrl !== undefined) value.selected.evidence[0].artifact.publicUrl = options.sourceUrl;
  if (options.login !== undefined) value.selected.actors[0].actor.login = options.login;
  if (options.repository !== undefined) {
    value.selected.scope.repository = options.repository;
    for (const entry of [...value.selected.evidence, ...value.selected.pendingEvidence])
      entry.artifact.repositoryId = options.repository;
    for (const coverage of [
      ...value.selected.snapshot.coverage,
      ...value.selected.rows.map((row: { result: { coverage: { scopeId: string } } }) => row.result.coverage),
    ])
      coverage.scopeId = options.repository;
  }
  if (options.projects !== undefined)
    Object.assign(value.selected.scope, {
      schemaVersion: "public-scope/v2",
      context: "current",
      projects: options.projects,
    });
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

const longSourceUrl = `https://github.com/synthetic-org/${"W".repeat(100)}/pull/1`;
const longRepository = "W".repeat(200);
const wideLogin = "界".repeat(100);
const completeProjects = Array.from({ length: 100 }, (_, index) => "W".repeat(125) + String(index).padStart(3, "0"));

for (const scenario of [
  { name: "long safe source URL", options: { sourceUrl: longSourceUrl }, params: {}, expected: longSourceUrl },
  {
    name: "long canonical repository",
    options: { repository: longRepository },
    params: { repository: longRepository },
    expected: longRepository,
  },
  { name: "wide Unicode login", options: { login: wideLogin }, params: {}, expected: wideLogin },
  {
    name: "complete maximum Project selection",
    options: { projects: completeProjects },
    params: { context: "current", project: completeProjects.join(",") },
    expected: completeProjects.join(", "),
    abbreviatesVisibleText: true,
  },
]) {
  test(`the actual SVG retains and fits the ${scenario.name}`, async ({ page }) => {
    const app = await service(page, scenario.options);
    try {
      const params = new URLSearchParams({ metric: "pr_merged", snapshot: "synthetic-pending-1", ...scenario.params });
      const response = await page.goto(path + "/image?" + params);
      expect(response?.status()).toBe(200);
      await page.evaluate(() => document.fonts.ready);
      const rendered = await page.locator("svg").evaluate((element) => {
        const svg = element as SVGSVGElement;
        const view = svg.viewBox.baseVal;
        return {
          width: view.width,
          height: view.height,
          title: svg.querySelector("title")!.textContent,
          description: svg.querySelector("desc")!.textContent,
          text: Array.from(svg.querySelectorAll("text"), (line) => line.textContent).join(""),
          boxes: Array.from(svg.querySelectorAll("text"), (line) => {
            const box = line.getBBox();
            return { text: line.textContent, x: box.x, y: box.y, width: box.width, height: box.height };
          }),
        };
      });
      expect.soft(rendered.description).toContain(scenario.expected);
      if ("abbreviatesVisibleText" in scenario) {
        expect.soft(rendered.height).toBeLessThanOrEqual(1024);
        expect.soft(rendered.text).toContain("… [full text in description]");
        await expect(page.getByRole("img")).toHaveAccessibleName(`${rendered.title} ${rendered.description}`);
      } else expect.soft(rendered.text).toContain(scenario.expected);
      expect(rendered.description).toContain("Archived snapshot: 2026-10-17T12:00:00.000Z");
      expect(rendered.description).toContain("Dated evidence, not a live activity or productivity claim.");
      for (const box of rendered.boxes) {
        expect.soft(box.x, box.text ?? "").toBeGreaterThanOrEqual(0);
        expect.soft(box.y, box.text ?? "").toBeGreaterThanOrEqual(0);
        expect.soft(box.x + box.width, box.text ?? "").toBeLessThanOrEqual(rendered.width);
        expect.soft(box.y + box.height, box.text ?? "").toBeLessThanOrEqual(rendered.height);
      }
      await expect(page.locator("svg script, svg foreignObject, svg image, svg a")).toHaveCount(0);
    } finally {
      await app.close();
    }
  });
}

test("SVG free-text abbreviation cannot split an admitted surrogate pair", async ({ page }) => {
  const login = "A".repeat(111) + "😀" + "Z".repeat(20);
  const app = await service(page, { login });
  try {
    expect((await page.goto(path + "/image" + query))?.status()).toBe(200);
    const description = await page.locator("svg desc").textContent();
    expect(description).toContain("A".repeat(111));
    expect(description).not.toContain("\uFFFD");
    expect(description).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
    expect(description).toContain("…");
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
