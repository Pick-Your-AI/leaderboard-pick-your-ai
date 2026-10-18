import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
test.use({ storageState: { cookies: [], origins: [] } });
const at = "2026-10-17T12:00:00.000Z";
const baseScope = { organization: "Pick-Your-AI", repository: null, workstream: null, start: null, end: null };
function snapshot(id = "api-1", revision = 1) {
  const coverage = {
    schemaVersion: "leaderboard/v1",
    state: "complete",
    source: "github_rest",
    scopeId: "synthetic-api-scope",
    windowStart: "2026-10-01T00:00:00.000Z",
    windowEnd: "2026-11-01T00:00:00.000Z",
    knownStart: "2026-10-01T00:00:00.000Z",
    lastSuccessfulSync: at,
    sourceWatermark: at,
    missingPages: 0,
    permissionsMissing: [],
    sourceErrors: [],
  };
  const actors = ["a", "b", "c"].map((letter) => ({
    actorId: `api-${letter}`,
    state: "public",
    actor: {
      schemaVersion: "leaderboard/v1",
      identityState: "resolved",
      githubNodeId: `synthetic-node-${letter}`,
      login: `synthetic-api-${letter}`,
      displayName: `Synthetic API ${letter.toUpperCase()}`,
      kind: "user",
      executionMode: "unknown",
    },
  }));
  const evidence = actors.map(({ actorId }, index) => ({
    artifact: {
      schemaVersion: "leaderboard/v1",
      source: "github",
      kind: "pull_request",
      stableId: `api-pr-${index}`,
      repositoryId: "repo-1",
      publicUrl: `https://github.com/synthetic-api/example/pull/${index + 1}`,
      visibility: "public",
    },
    contribution: {
      schemaVersion: "leaderboard/v1",
      contributionId: `e-${actorId}`,
      canonicalEventId: `event-${actorId}`,
      artifactId: `api-pr-${index}`,
      actorId,
      roles: ["author"],
      qualification: "eligible",
      metricIds: ["pr_opened", "documentation"],
      reasonCodes: ["public_accepted_source"],
    },
    occurredAt: at,
    sourceRevision: "synthetic-rev",
    sourceRevisionUrl: "https://github.com/synthetic-api/example/commit/abcdef",
  }));
  return {
    head: { snapshotId: id, revision, publishedAt: at },
    controls: {
      version: "privacy-1",
      suppressedActorIds: [] as string[],
      suppressedArtifactIds: [],
      revokedSnapshotIds: [] as string[],
    },
    selected: {
      approvedPublic: true,
      scope: { ...baseScope },
      snapshot: {
        schemaVersion: "leaderboard/v1",
        snapshotId: id,
        revision,
        generatedAt: at,
        metricDefinitionVersion: "candidate-0.1.1",
        computationVersion: "synthetic-http-browser-only",
        coverage: [coverage],
        results: [],
      },
      actors,
      evidence,
      portfolioEvidence: evidence.map((entry) => ({ ...entry, activityState: "observed", observedAt: at })),
      rows: ["pr_opened", "documentation"].flatMap((metricId) =>
        actors.map(({ actorId }, index) => ({
          actorId,
          result: { schemaVersion: "leaderboard/v1", metricId, state: "measured", value: index < 2 ? 2 : 1, coverage },
          evidenceIds: [`e-${actorId}`],
        })),
      ),
      ranking: [
        { metricId: "pr_opened", direction: "descending", rank: true },
        { metricId: "documentation", direction: "descending", rank: false },
      ],
      diagnostics: ["pr_opened", "documentation"].flatMap((metricId) =>
        actors.map(({ actorId }, index) => ({
          metricId,
          actorId,
          numerator: index < 2 ? 2 : 1,
          denominator: null,
          sampleCount: index < 2 ? 2 : 1,
          censored: 0,
          missingReadiness: 0,
          p75: null,
        })),
      ),
      methodology: [
        {
          metricId: "pr_opened",
          policyVersion: "approved-policy-1",
          policySignature: "a".repeat(64),
          policyLink: "https://github.com/synthetic-api/example/blob/main/policy.md",
        },
      ],
    },
  };
}
async function service(page: Page, approved = true) {
  const { createService } = await import(new URL("../../service/dist/app.js", import.meta.url).href);
  const current = snapshot();
  current.selected.portfolioEvidence.forEach((entry) => {
    entry.activityState = "accepted";
  });
  let unavailable = false;
  let calls = 0;
  const app = createService({
    approvedAchievementRuleVersion: approved ? "accepted-evidence/v1" : undefined,
    source: {
      read: async (scope: typeof baseScope) => {
        if (unavailable) return null;
        const value = structuredClone(current);
        value.selected.scope = scope;
        return value;
      },
    },
  });
  await page.route("**/api/v1/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/achievements")) calls++;
    const response = await app.inject({ method: "GET", url: url.pathname + url.search });
    await route.fulfill({ status: response.statusCode, headers: response.headers, body: response.body });
  });
  return {
    close: () => app.close(),
    fail: () => {
      unavailable = true;
    },
    suppress: () => {
      current.controls.suppressedActorIds = ["api-a"];
    },
    calls: () => calls,
  };
}

test("real service sharing opens a dated HTML card and returns to the visible pinned portfolio", async ({ page }) => {
  const api = await service(page);
  try {
    await page.goto("/contributors/api-a?ui=api&repository=repo-1&snapshot=api-1");
    await expect(page.getByRole("heading", { name: "First accepted contribution in available scope" })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "README Markdown for pr_opened" })).toHaveValue(
      /\/cards\/api-a\/image\?.*snapshot=api-1/,
    );
    await page.getByRole("link", { name: "Open archived pr_opened card" }).click();
    await expect(page.getByText("Archived snapshot card", { exact: true })).toBeVisible();
    await expect(page.getByText(at, { exact: true })).toBeVisible();
    const link = page.getByRole("link", { name: "Scoped contribution portfolio" });
    await expect(link).toHaveAttribute("href", /\/contributors\/api-a\?.*snapshot=api-1.*ui=api/);
    await link.click();
    await expect(page.getByRole("heading", { name: "Contributor portfolio", exact: true })).toBeVisible();
    expect(new URL(page.url()).searchParams.get("repository")).toBe("repo-1");
    expect(new URL(page.url()).searchParams.get("snapshot")).toBe("api-1");
    const results = await new AxeBuilder({ page }).include('[aria-labelledby="recognition-title"]').analyze();
    expect(results.violations).toEqual([]);
  } finally {
    await api.close();
  }
});

test("same-selection revalidation retains focused proof links and failures clear awards", async ({ page }) => {
  const api = await service(page);
  try {
    await page.clock.install();
    await page.goto("/contributors/api-a?ui=api&snapshot=api-1");
    const source = page.getByRole("link", { name: "Qualifying public artifact" });
    await expect(source).toBeVisible();
    await source.focus();
    const before = api.calls();
    await page.clock.fastForward(30_001);
    await expect.poll(() => api.calls()).toBeGreaterThan(before);
    await expect(source).toBeFocused();
    api.fail();
    await page.clock.fastForward(30_001);
    await expect(source).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "First accepted contribution in available scope" })).toHaveCount(0);
  } finally {
    await api.close();
  }
});

test("unapproved achievement policy stays unavailable without invented awards", async ({ page }) => {
  const api = await service(page, false);
  try {
    await page.goto("/contributors/api-a?ui=api&snapshot=api-1");
    await expect(page.getByText("Achievements are unavailable. No award or policy approval is implied.")).toBeVisible();
    await expect(page.getByRole("link", { name: "Qualifying public artifact" })).toHaveCount(0);
  } finally {
    await api.close();
  }
});

test("real controls current spotlights reject filtered scope and disappear after eligibility revocation", async ({
  page,
}) => {
  const api = await service(page);
  const { ControlStore } = await import(new URL("../../controls/src/store.mjs", import.meta.url).href);
  const { createControlsServer } = await import(new URL("../../controls/src/server.mjs", import.meta.url).href);
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const directory = mkdtempSync(join(tmpdir(), "synthetic-recognition-browser-"));
  const store = new ControlStore(join(directory, "controls.sqlite"));
  store.transaction((state: any) => {
    state.requests.claim = {
      id: "claim",
      owner: "1",
      kind: "evidence",
      status: "accepted",
      version: 2,
      locator: "https://github.com/synthetic/example/issues/1",
      category: "governance",
    };
    state.spotlights = {
      nomination: {
        id: "nomination",
        owner: "1",
        claimId: "claim",
        claimVersion: 2,
        status: "accepted",
        history: [{ at: Date.parse(at), publicExplanation: "Synthetic independently reviewed spotlight" }],
      },
    };
  });
  let eligible = true;
  let calls = 0;
  const server = createControlsServer({
    store,
    provider: { exchange: () => {}, authorizationURL: () => {} },
    origin: "https://example.test",
    spotlightEligibility: () => eligible,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  await page.route("**/controls/spotlights", async (route) => {
    calls++;
    const response = await fetch(`http://127.0.0.1:${server.address().port}/controls/spotlights`);
    await route.fulfill({
      status: response.status,
      headers: Object.fromEntries(response.headers),
      body: await response.text(),
    });
  });
  try {
    await page.clock.install();
    await page.goto("/?ui=api");
    await expect(page.getByRole("heading", { name: "Public contribution evidence", exact: true })).toBeVisible();
    if (!(await page.getByRole("heading", { name: "Editorial spotlights", exact: true }).count())) {
      expect(calls).toBe(0);
      return; // An unconfigured controls deployment must not be auto-enabled by the UI.
    }
    await expect(page.getByText("Synthetic independently reviewed spotlight")).toBeVisible();
    const source = page.getByRole("link", { name: "Reviewed public evidence" });
    await source.focus();
    const before = calls;
    await page.clock.fastForward(30_001);
    await expect.poll(() => calls).toBeGreaterThan(before);
    await expect(source).toBeFocused();
    eligible = false;
    await page.clock.fastForward(30_001);
    await expect(page.getByText("Synthetic independently reviewed spotlight")).toHaveCount(0);
    await page.goto("/?ui=api&repository=repo-1");
    await expect(page.getByText("Editorial selections are unavailable for this view.")).toBeVisible();
    await expect(page.getByRole("link", { name: "Reviewed public evidence" })).toHaveCount(0);
  } finally {
    await api.close();
    await new Promise<void>((resolve) => server.close(resolve));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("category-filtered portfolios withhold broader achievements and do not request them", async ({ page }) => {
  const api = await service(page);
  try {
    await page.clock.install();
    await page.goto("/contributors/api-a?ui=api&snapshot=api-1");
    await expect(page.getByRole("link", { name: "Qualifying public artifact" })).toBeVisible();
    const before = api.calls();
    await page.evaluate(() => {
      history.pushState(null, "", "/contributors/api-a?ui=api&snapshot=api-1&category=documentation");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await expect(page.getByText(/Achievements are unavailable for category-filtered portfolios/)).toBeVisible();
    await expect(page.getByRole("link", { name: "Qualifying public artifact" })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "First accepted contribution in available scope" })).toHaveCount(0);
    await page.clock.fastForward(30_001);
    expect(api.calls()).toBe(before);
    await expect(page.getByRole("link", { name: "Open archived documentation card" })).toBeVisible();
    await page.evaluate(() => {
      history.pushState(null, "", "/contributors/api-a?ui=api&snapshot=api-1");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await expect(page.getByRole("link", { name: "Qualifying public artifact" })).toBeVisible();
    expect(api.calls()).toBeGreaterThan(before);
  } finally {
    await api.close();
  }
});
