import { test, expect, type Page } from "@playwright/test";
import { evidenceService } from "./evidenceHarness.ts";

test.use({ storageState: { cookies: [], origins: [] } });

const scope = {
  organization: "Pick-Your-AI",
  repository: "repo-1",
  workstream: "triage",
  start: "2026-10-01T00:00:00.000Z",
  end: "2026-11-01T00:00:00.000Z",
  actors: "user",
  limit: "1",
};
const boardUrl = `/leaderboards/pr_merged?${new URLSearchParams({ ...scope, ui: "api" })}`;

async function expectSnapshot(page: Page, id: string) {
  await expect(page.getByRole("region", { name: "Snapshot provenance" })).toContainText(`Snapshot ${id} ·`);
}

test("API board Back and Forward restore the displayed snapshot after a newer publication", async ({ page }) => {
  const api = await evidenceService(page);
  try {
    await page.goto(boardUrl);
    await expect(page.getByRole("link", { name: "Synthetic API A", exact: true })).toBeVisible();
    await expectSnapshot(page, "api-1");
    await page.getByRole("link", { name: "Synthetic API A", exact: true }).press("Enter");
    await expect(page.getByRole("heading", { name: "Contributor portfolio", exact: true })).toBeFocused();
    api.next();
    await page.goBack();
    await expect(page.getByRole("heading", { name: "Contribution board", exact: true })).toBeFocused();
    await expectSnapshot(page, "api-1");
    expect(Object.fromEntries(new URL(page.url()).searchParams)).toMatchObject({ ...scope, snapshot: "api-1" });
    await page.goForward();
    await expect(page.getByRole("heading", { name: "Contributor portfolio", exact: true })).toBeFocused();
    await expectSnapshot(page, "api-1");
    expect(Object.fromEntries(new URL(page.url()).searchParams)).toMatchObject({ ...scope, snapshot: "api-1" });
  } finally {
    await api.close();
  }
});

test("API primary navigation and a copied route preserve the displayed snapshot and exact scope", async ({ page }) => {
  const api = await evidenceService(page);
  try {
    await page.goto(boardUrl);
    await expect(page.getByRole("link", { name: "Synthetic API A", exact: true })).toBeVisible();
    const measures = page
      .getByRole("navigation", { name: "Primary" })
      .getByRole("link", { name: "Measures", exact: true });
    const href = new URL((await measures.getAttribute("href"))!, page.url());
    expect(Object.fromEntries(href.searchParams)).toMatchObject({ ...scope, snapshot: "api-1" });
    api.next();
    await measures.press("Enter");
    await expect(page.getByRole("heading", { name: "Measures", exact: true })).toBeFocused();
    await expect(page.getByRole("status").filter({ hasText: "98 of 98" })).toBeVisible();
    const copied = page.url();
    await page.goto(copied);
    await expect(page.getByRole("status").filter({ hasText: "98 of 98" })).toBeVisible();
    expect(Object.fromEntries(new URL(page.url()).searchParams)).toMatchObject({ ...scope, snapshot: "api-1" });
    await page.getByRole("link", { name: "PRs merged", exact: true }).press("Enter");
    await expectSnapshot(page, "api-1");
    expect(Object.fromEntries(new URL(page.url()).searchParams)).toMatchObject({ ...scope, snapshot: "api-1" });
    await page.getByText("Exact scope and snapshot", { exact: true }).click();
    await page.getByRole("textbox", { name: "snapshot", exact: true }).fill("");
    await page.getByRole("button", { name: "Read exact scope", exact: true }).click();
    await expectSnapshot(page, "api-2");
    expect(new URL(page.url()).searchParams.has("snapshot")).toBe(false);
  } finally {
    await api.close();
  }
});

test("API full-page wall navigation keeps the prior board reproducible", async ({ page }) => {
  const api = await evidenceService(page);
  try {
    await page.goto(boardUrl);
    await expect(page.getByRole("link", { name: "Synthetic API A", exact: true })).toBeVisible();
    api.next();
    await page
      .getByRole("navigation", { name: "Primary" })
      .getByRole("link", { name: "Live", exact: true })
      .press("Enter");
    await expect(page.getByRole("heading", { name: "Public live wall", exact: true })).toBeVisible();
    expect(Object.fromEntries(new URL(page.url()).searchParams)).toMatchObject({ ...scope, snapshot: "api-1" });
    await page.goBack();
    await expectSnapshot(page, "api-1");
    expect(Object.fromEntries(new URL(page.url()).searchParams)).toMatchObject({ ...scope, snapshot: "api-1" });
  } finally {
    await api.close();
  }
});

test("API visitors discover all five journeys through department and ordinary-language searches", async ({ page }) => {
  const api = await evidenceService(page);
  try {
    await page.goto(`/?${new URLSearchParams({ ...scope, ui: "api" })}`);
    await expectSnapshot(page, "api-1");
    for (const [department, query, metric, label] of [
      ["delivery", "merged pull requests", "pr_merged", "PRs merged"],
      ["lines", "additions and deletions", "pr_lines_changed", "Lines changed through authored PRs"],
      ["triage", "label applications", "labels_applied", "Labels applied"],
      ["research", "research decisions", "decision_records", "Decision records contributed"],
      ["review", "review participation", "prs_reviewed", "PRs reviewed"],
    ]) {
      await page
        .getByRole("navigation", { name: "Primary" })
        .getByRole("link", { name: "Measures", exact: true })
        .press("Enter");
      await page.getByRole("searchbox", { name: "Search definitions", exact: true }).fill(query!);
      await page.getByRole("combobox", { name: "Department", exact: true }).selectOption(department!);
      await page.getByRole("button", { name: "Search measures", exact: true }).press("Enter");
      const entry = page.getByRole("listitem").filter({ has: page.getByRole("link", { name: label!, exact: true }) });
      await expect(entry).toBeVisible();
      await entry.getByRole("link", { name: "Method sheet", exact: true }).press("Enter");
      await expect(page.getByRole("heading", { level: 1, name: "Methodology", exact: true })).toBeFocused();
      await expect(page.getByText("Candidate state/date combinations", { exact: true })).toBeVisible();
      const url = new URL(page.url());
      expect(url.pathname).toBe(`/methodology/${metric}`);
      expect(Object.fromEntries(url.searchParams)).toMatchObject({ ...scope, snapshot: "api-1", metric });
      expect(url.searchParams.has("q")).toBe(false);
      expect(url.searchParams.has("department")).toBe(false);
      await expect(page.getByRole("complementary", { name: "Synthetic data notice" })).toHaveCount(0);
    }
  } finally {
    await api.close();
  }
});

test("prototype visitors can independently reach all five contribution journeys with visible scoped URLs", async ({
  page,
}) => {
  const selected = {
    period: "90d",
    repo: "syn-repo-website",
    project: "syn-proj-web",
    actor: "all",
    snapshot: "syn-r41",
  };
  const overview = `/?${new URLSearchParams({ ...selected, ui: "prototype" })}`;
  for (const [label, metric, heading] of [
    ["PRs merged", "pr_merged", "PRs merged"],
    ["Lines changed", "pr_lines_changed", "Lines changed through authored PRs"],
    ["Triage", "labels_applied", "Labels applied"],
    ["Research", "decision_records", "Decision records contributed"],
    ["Review", "prs_reviewed", "PRs reviewed"],
  ]) {
    await page.goto(overview);
    await expect(
      page.getByRole("heading", { level: 1, name: "Contributions, with evidence", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("navigation", { name: "Primary" })
      .getByRole("link", { name: "Leaderboards", exact: true })
      .press("Enter");
    const entry = page.locator("p").filter({ hasText: "Journeys:" }).getByRole("link", { name: label!, exact: true });
    await entry.press("Enter");
    await expect(page.getByRole("heading", { level: 1, name: heading!, exact: true })).toBeFocused();
    const url = new URL(page.url());
    expect(url.pathname).toBe(`/leaderboards/${metric}`);
    expect(Object.fromEntries(url.searchParams)).toMatchObject(selected);
    await expect(page.getByRole("region", { name: "Scope", exact: true })).toBeVisible();
    for (const [control, value] of [
      ["Period", selected.period],
      ["Repository", selected.repo],
      ["Program", selected.project],
      ["Snapshot", selected.snapshot],
    ])
      await expect(page.getByRole("combobox", { name: control!, exact: true })).toHaveValue(value!);
    await expect(page.getByRole("alert").filter({ hasText: "Some link parameters could not be used" })).toHaveCount(0);
    const copied = page.url();
    await page.goBack();
    await expect(page.getByRole("heading", { level: 1, name: "Leaderboards", exact: true })).toBeFocused();
    await page.goForward();
    await expect(page.getByRole("heading", { level: 1, name: heading!, exact: true })).toBeFocused();
    await page.goto(copied);
    await expect(page.getByRole("heading", { level: 1, name: heading!, exact: true })).toBeVisible();
    expect(Object.fromEntries(new URL(page.url()).searchParams)).toMatchObject(selected);
  }
});
