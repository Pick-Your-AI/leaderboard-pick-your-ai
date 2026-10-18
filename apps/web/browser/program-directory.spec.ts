import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { readFileSync } from "node:fs";
import type { PublicScope } from "@pick-your-ai/contracts";

test.use({ storageState: { cookies: [], origins: [] } });
const deployed = JSON.parse(readFileSync(new URL("../public/program-directory.json", import.meta.url), "utf8"));
const synthetic = {
  ...deployed,
  version: "SYNTHETIC program navigation fixture",
  repositories: [{ id: "2", name: "synthetic-shared-repository" }],
  programs: [
    {
      id: "android",
      name: "SYNTHETIC Android program",
      projectId: "PVT_A",
      projectNumber: 4,
      repositoryIds: ["2"],
      fieldNames: ["Status", "Acceptance Gate"],
    },
    {
      id: "apple",
      name: "SYNTHETIC Apple program",
      projectId: "PVT_B=",
      projectNumber: 5,
      repositoryIds: ["2"],
      fieldNames: ["Status", "Readiness"],
    },
    {
      id: "unapproved",
      name: "SYNTHETIC unavailable program",
      projectId: "PVT_UNAPPROVED",
      projectNumber: 6,
      repositoryIds: [],
      fieldNames: [],
    },
  ],
};

// Actual service projection of explicit synthetic publication inputs; not a GitHub membership collection.
async function fixture(page: Page, configuration = synthetic) {
  const { createService } = await import(new URL("../../service/dist/app.js", import.meta.url).href);
  const { scopeFixture } = await import(new URL("../../../tests/fixtures/public-scope.mjs", import.meta.url).href);
  let unavailable = false,
    suppressed = false;
  const calls: URL[] = [];
  const app = createService({
    source: {
      async read(scope: PublicScope) {
        if (unavailable) throw Error("SYNTHETIC program source unavailable");
        if (scope.projects?.includes("PVT_UNAPPROVED")) return null;
        const value = scopeFixture(scope);
        if (suppressed) {
          value.controls.suppressedActorIds = ["102"];
          value.controls.version = "synthetic-program-suppression-v2";
        }
        return value;
      },
    },
  });
  await page.route("**/program-directory.json", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify(configuration) }),
  );
  await page.route("**/api/v1/**", async (route) => {
    const url = new URL(route.request().url());
    calls.push(url);
    const result = await app.inject({ method: "GET", url: url.pathname + url.search });
    await route.fulfill({ status: result.statusCode, headers: result.headers, body: result.body });
  });
  return {
    calls,
    fail() {
      unavailable = true;
    },
    suppress() {
      suppressed = true;
    },
    async close() {
      await page.unrouteAll({ behavior: "wait" });
      await app.close();
    },
  };
}
const directory = (page: Page) => page.getByRole("region", { name: "Program discovery", exact: true });

test("deployed five-program metadata is discoverable without a publication and preserves distinct native vocabulary", async ({
  page,
}, info) => {
  const api = await fixture(page, deployed);
  try {
    api.fail();
    await page.setViewportSize({ width: 320, height: 800 });
    await page.goto("/programs?ui=api");
    await expect(directory(page)).toContainText("5 configured programs");
    for (const program of deployed.programs)
      await expect(directory(page).getByRole("link", { name: program.name, exact: true })).toBeVisible();
    expect(api.calls.every((url) => url.pathname.endsWith("/metrics"))).toBe(true);
    const android = directory(page).getByRole("link", {
      name: "Pick Your AI — Android Application Delivery",
      exact: true,
    });
    await android.focus();
    await page.keyboard.press("Enter");
    await expect(directory(page)).toContainText("PVT_kwDOFHg4Xc4BnbMJ");
    await directory(page).getByText("Status and custom fields", { exact: true }).click();
    await expect(directory(page)).toContainText("Acceptance Gate");
    await expect(directory(page)).not.toContainText("Research Confidence");
    await expect(
      directory(page).getByRole("link", { name: "Contributors with event-time membership", exact: true }),
    ).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    expect(
      (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations,
    ).toEqual([]);
    await page.screenshot({ path: info.outputPath("program-directory-320px.png"), fullPage: true });
  } finally {
    await api.close();
  }
});

test("program contributor links preserve selected dates and roles, change membership explicitly and discard old pins", async ({
  page,
}) => {
  const api = await fixture(page);
  try {
    await page.goto(
      "/programs/android?ui=api&repository=old&workstream=old&project=old&context=current&role=author&actors=user&snapshot=old-pin&start=2026-10-01T00:00:00.000Z&end=2026-10-18T00:00:00.000Z",
    );
    const link = directory(page).getByRole("link", { name: "Contributors with event-time membership", exact: true });
    await expect(link).toBeVisible();
    await link.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { name: "Contributor directory", exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: "Snapshot provenance" })).toContainText("PVT_A");
    const params = new URL(page.url()).searchParams;
    expect(Object.fromEntries(params)).toMatchObject({
      project: "PVT_A",
      context: "event",
      role: "author",
      actors: "user",
      start: "2026-10-01T00:00:00.000Z",
      end: "2026-10-18T00:00:00.000Z",
    });
    for (const key of ["repository", "workstream", "snapshot", "proof", "cursor"]) expect(params.has(key)).toBe(false);
    await page.goBack();
    await directory(page).getByRole("link", { name: "Pick-Your-AI/synthetic-shared-repository", exact: true }).click();
    await expect(page.getByRole("region", { name: "Snapshot provenance" })).toBeVisible();
    const request = api.calls.filter((url) => url.pathname.endsWith("/contributors")).at(-1)!;
    expect(Object.fromEntries(request.searchParams)).toMatchObject({
      project: "PVT_A",
      context: "current",
      repository: "2",
      role: "author",
    });
  } finally {
    await api.close();
  }
});

test("overlapping programs request one canonical union and current privacy still filters its contributor view", async ({
  page,
}) => {
  const api = await fixture(page, { ...synthetic, programs: synthetic.programs.slice(0, 2) });
  try {
    await page.goto("/programs?ui=api");
    await expect(directory(page)).toContainText("separate program totals must not be added together");
    await directory(page).getByRole("link", { name: "All listed programs — current membership", exact: true }).click();
    await expect(
      page.getByText("2 contributors with public evidence in this selection.", { exact: false }),
    ).toBeVisible();
    const request = api.calls.filter((url) => url.pathname.endsWith("/contributors")).at(-1)!;
    expect(request.searchParams.get("project")).toBe("PVT_A,PVT_B=");
    expect(request.searchParams.get("repository")).toBeNull();
    await expect(page.getByRole("link", { name: "synthetic-pending-102", exact: true })).toHaveCount(1);
    await page.getByRole("link", { name: "Permalink to this snapshot", exact: true }).click();
    api.suppress();
    await page.getByRole("button", { name: "Recheck current publication controls", exact: true }).click();
    await expect(
      page.getByRole("link", { name: "synthetic-pending-102", exact: true, includeHidden: true }),
    ).toHaveCount(0);
    await expect(
      page.getByText("1 contributors with public evidence in this selection.", { exact: false }),
    ).toBeVisible();
  } finally {
    await api.close();
  }
});

test("configured but unapproved programs and malformed directories never become invented zero or replacement metadata", async ({
  page,
}) => {
  const api = await fixture(page);
  try {
    await page.goto("/programs/unapproved?ui=api");
    await directory(page).getByRole("link", { name: "Contributors with event-time membership", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("Public record unavailable");
    await expect(page.getByText("0 contributors with public evidence", { exact: false })).toHaveCount(0);
    await page.goto("/programs/unknown?ui=api");
    await expect(page.getByRole("alert")).toContainText("unknown_program");
    await expect(directory(page)).toHaveCount(0);
    await page.unroute("**/program-directory.json");
    await page.route("**/program-directory.json", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: '{"schemaVersion":"program-directory/v1","schemaVersion":"discarded"}',
      }),
    );
    await page.goto("/programs?ui=api");
    await expect(page.getByRole("alert")).toContainText("invalid_program_directory");
    await expect(directory(page)).toHaveCount(0);
    await expect(page.getByText("SYNTHETIC Android program", { exact: true })).toHaveCount(0);
  } finally {
    await api.close();
  }
});
