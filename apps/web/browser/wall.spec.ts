import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { metricRegistryV1 } from "@pick-your-ai/metrics";

test.use({ storageState: { cookies: [], origins: [] } });
const at = "2026-10-18T03:00:00.000Z";
const scope = { organization: "Pick-Your-AI", repository: null, workstream: null, start: null, end: null };
function snapshot(id = "wall-1", revision = 1) {
  const coverage = {
    schemaVersion: "leaderboard/v1",
    state: "complete",
    source: "github_rest",
    scopeId: "synthetic-wall-scope",
    windowStart: "2026-10-01T00:00:00.000Z",
    windowEnd: "2026-11-01T00:00:00.000Z",
    knownStart: null,
    lastSuccessfulSync: at,
    sourceWatermark: at,
    missingPages: 0,
    permissionsMissing: [],
    sourceErrors: [],
  };
  const actors = Array.from({ length: 15 }, (_, index) => {
    const suffix = String(index + 1).padStart(2, "0");
    return {
      actorId: `wall-${suffix}`,
      state: "public",
      actor: {
        schemaVersion: "leaderboard/v1",
        identityState: "resolved",
        githubNodeId: `synthetic-wall-node-${suffix}`,
        login: `synthetic-wall-${suffix}`,
        displayName: `Wall contributor ${suffix}`,
        kind: "user",
        executionMode: "unknown",
      },
    };
  });
  const evidence = actors.map(({ actorId }, index) => ({
    artifact: {
      schemaVersion: "leaderboard/v1",
      source: "github",
      kind: "pull_request",
      stableId: `wall-pr-${index}`,
      repositoryId: "repo-1",
      publicUrl: `https://github.com/synthetic-wall/example/pull/${index + 1}`,
      visibility: "public",
    },
    contribution: {
      schemaVersion: "leaderboard/v1",
      contributionId: `e-${actorId}`,
      canonicalEventId: `event-${actorId}`,
      artifactId: `wall-pr-${index}`,
      actorId,
      roles: ["author"],
      qualification: "eligible",
      metricIds: ["pr_merged"],
      reasonCodes: ["public_accepted_source"],
    },
    occurredAt: at,
    sourceRevision: "synthetic-wall-revision",
    sourceRevisionUrl: "https://github.com/synthetic-wall/example/commit/abcdef",
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
      scope: { ...scope },
      snapshot: {
        schemaVersion: "leaderboard/v1",
        snapshotId: id,
        revision,
        generatedAt: at,
        metricDefinitionVersion: metricRegistryV1.policy_version,
        computationVersion: "synthetic-wall-browser-only",
        coverage: [coverage],
        results: [],
      },
      actors,
      evidence,
      portfolioEvidence: evidence.map((entry) => ({ ...entry, activityState: "observed", observedAt: at })),
      rows: actors.slice(0, 12).map(({ actorId }, index) => ({
        actorId,
        result: {
          schemaVersion: "leaderboard/v1",
          metricId: "pr_merged",
          state: "measured",
          value: index < 7 ? 5 : 1,
          coverage,
        },
        evidenceIds: [`e-${actorId}`],
      })),
      ranking: [{ metricId: "pr_merged", direction: "descending", rank: true }],
      diagnostics: actors.slice(0, 12).map(({ actorId }, index) => ({
        metricId: "pr_merged",
        actorId,
        numerator: index < 7 ? 5 : 1,
        denominator: null,
        sampleCount: index < 7 ? 5 : 1,
        censored: 0,
        missingReadiness: 0,
        p75: null,
      })),
      methodology: [
        {
          metricId: "pr_merged",
          policyVersion: "synthetic-wall-policy",
          policySignature: "a".repeat(64),
          policyLink: "https://github.com/synthetic-wall/example/blob/main/policy.md",
        },
      ],
    },
  };
}
async function service(page: Page, readDelayMs = 0) {
  // Actual Fastify query/cursor/privacy/registry handlers over explicitly synthetic inputs.
  const module = new URL("../../service/dist/app.js", import.meta.url).href;
  const { createService } = await import(module);
  let current = snapshot(),
    failed = false;
  let healthGate: Promise<void> | null = null;
  let publishAfterHealth = false;
  const history = new Map([[current.head.snapshotId, current]]);
  const publishNext = () => {
    current = snapshot("wall-2", 2);
    current.selected.rows[0]!.result.value = 90;
    history.set("wall-2", current);
  };
  const calls: URL[] = [];
  const app = createService({
    now: () => Date.parse(at),
    cursorSecret: "synthetic-wall-cursor-secret-00001",
    source: {
      async read(selected: typeof scope, pin: string | null) {
        if (readDelayMs) await new Promise((resolve) => setTimeout(resolve, readDelayMs));
        if (failed) throw new Error("SENSITIVE_SYNTHETIC_WALL_FAILURE");
        const chosen = pin ? history.get(pin) : current;
        if (!chosen) return null;
        const result = structuredClone(chosen);
        result.selected.scope = { ...selected };
        result.controls = structuredClone(current.controls);
        result.head = structuredClone(current.head);
        return result;
      },
    },
  });
  await page.route("**/api/v1/**", async (route) => {
    const url = new URL(route.request().url());
    calls.push(url);
    if (url.pathname.endsWith("/health") && healthGate) await healthGate;
    const response = await app.inject({ method: "GET", url: url.pathname + url.search });
    if (url.pathname.endsWith("/health") && publishAfterHealth) {
      publishAfterHealth = false;
      publishNext();
    }
    await route.fulfill({ status: response.statusCode, headers: response.headers, body: response.body });
  });
  return {
    calls,
    close: () => app.close(),
    delayReads(milliseconds: number) {
      readDelayMs = milliseconds;
    },
    next: publishNext,
    publishBetweenHealthAndContent() {
      publishAfterHealth = true;
    },
    suppress() {
      current.controls.version = "privacy-2";
      current.controls.suppressedActorIds = ["wall-01"];
    },
    revoke() {
      current.controls.revokedSnapshotIds = ["wall-1"];
    },
    stale() {
      current.selected.snapshot.coverage[0]!.lastSuccessfulSync = "2026-10-17T00:00:00.000Z";
    },
    fail() {
      failed = true;
    },
    holdHealth() {
      let release!: () => void;
      healthGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return () => {
        healthGate = null;
        release();
      };
    },
  };
}
const wall = (mode: string, extra = "") => `/live?ui=api&mode=${mode}&boards=pr_merged&interval=30${extra}`;
const provenance = (page: Page) => page.getByRole("region", { name: "Snapshot provenance" });
async function next(page: Page) {
  const before = await page.locator(".api-wall-page").textContent();
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await expect(page.locator(".api-wall-page")).not.toHaveText(before!);
  await expect(page.getByRole("button", { name: "Next page", exact: true })).toBeEnabled();
}
async function elapseWithReads(page: Page, milliseconds: number) {
  // The API runs on Node's real clock. Let each response settle before advancing
  // the browser clock past its eight-second deadline; otherwise a healthy read
  // is incorrectly turned into the separate fail-closed timeout scenario.
  for (let elapsed = 0; elapsed < milliseconds; elapsed += 1_000) {
    await page.clock.runFor(Math.min(1_000, milliseconds - elapsed));
    await expect(page.getByRole("button", { name: "Next page", exact: true })).toBeEnabled();
  }
}

test("wall configurator uses the fetched registry and rejects ambiguous display URLs before source reads", async ({
  page,
}) => {
  const api = await service(page);
  try {
    for (const query of [
      "mode=frozen",
      "mode=single&snapshot=wall-1",
      "mode=cycle&mode=single",
      "mode=cycle&interval=1",
      "mode=cycle&boards=pr_merged,pr_merged",
      "mode=cycle&category=delivery",
    ]) {
      await page.goto(`/live?ui=api&${query}`);
      await expect(page.getByRole("alert")).toBeVisible();
    }
    expect(api.calls).toHaveLength(0);
    await page.goto("/live?ui=api&repository=repo-1&actors=user");
    await expect(page.getByRole("heading", { name: "Public live wall" })).toBeVisible();
    await expect(page.getByRole("checkbox", { name: "PRs merged", exact: true })).toBeVisible();
    for (const checkbox of await page.getByRole("checkbox").all()) await checkbox.uncheck();
    await page.getByRole("checkbox", { name: "PRs merged", exact: true }).check();
    await page.getByRole("combobox", { name: "Mode", exact: true }).selectOption("frozen");
    const href = new URL(
      (await page.getByRole("link", { name: "Open the wall", exact: true }).getAttribute("href")) ?? "",
      "http://localhost",
    );
    expect(Object.fromEntries(href.searchParams)).toMatchObject({
      mode: "frozen",
      snapshot: "wall-1",
      actors: "user",
      repository: "repo-1",
      ui: "api",
    });
    await page.getByRole("link", { name: "Open the wall", exact: true }).click();
    await expect(page.getByRole("heading", { name: "PRs merged", exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.fullscreenElement === null)).toBe(true);
    await expect(page.locator("img")).toHaveCount(0);
    expect(
      api.calls.every((url) => ["mode", "boards", "format", "interval"].every((key) => !url.searchParams.has(key))),
    ).toBe(true);
    expect(
      (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations,
    ).toEqual([]);
  } finally {
    await api.close();
  }
});

test("wall visits continued ties and every unranked contributor page before adopting a newer snapshot", async ({
  page,
}) => {
  const api = await service(page);
  try {
    await page.goto(wall("cycle"));
    await expect(page.getByRole("link", { name: "Wall contributor 01", exact: true })).toBeVisible();
    await expect(page.locator(".api-wall-table tbody tr")).toHaveCount(6);
    api.next();
    await page.getByRole("button", { name: "Recheck current publication controls" }).click();
    await expect(page.getByText("Update held: wall-2. Applies after the full page cycle.")).toBeVisible();
    await next(page);
    await expect(
      page.getByText("Page 2 · 12 contributor rows · Rank 1 continues from the previous page"),
    ).toBeVisible();
    await expect(page.getByRole("link", { name: "Wall contributor 07", exact: true })).toBeVisible();
    await expect(provenance(page)).toContainText("Snapshot wall-1");
    await next(page);
    await expect(page.getByRole("heading", { name: "Contributors in this scope", exact: true })).toBeVisible();
    await expect(page.locator(".api-wall-roll li")).toHaveCount(6);
    await next(page);
    await expect(page.getByRole("link", { name: "Wall contributor 07", exact: true })).toBeVisible();
    await next(page);
    await expect(page.locator(".api-wall-roll li")).toHaveCount(3);
    await expect(page.getByRole("link", { name: "Wall contributor 15", exact: true })).toBeVisible();
    await expect(provenance(page)).toContainText("Snapshot wall-1");
    await next(page);
    await expect(provenance(page)).toContainText("Snapshot wall-2");
    await expect(page.getByRole("row", { name: /Wall contributor 01/ })).toContainText("90");
    expect(
      api.calls
        .filter((url) => url.pathname.endsWith("boards") || url.pathname.endsWith("contributors"))
        .every((url) => url.searchParams.get("limit") === "6"),
    ).toBe(true);
  } finally {
    await api.close();
  }
});

for (const stage of ["board", "contributors"] as const) {
  test(`wall rejects a publication-head change between health and ${stage} content`, async ({ page }) => {
    const api = await service(page);
    try {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.goto(wall("cycle"));
      await expect(page.getByRole("link", { name: "Wall contributor 01", exact: true })).toBeVisible();
      if (stage === "contributors") {
        await next(page);
        await next(page);
        await expect(page.getByRole("heading", { name: "Contributors in this scope", exact: true })).toBeVisible();
      }
      api.publishBetweenHealthAndContent();
      await page.getByRole("button", { name: "Recheck current publication controls" }).click();
      await expect(page.getByRole("alert")).toContainText("wall_publication_changed_during_read");
      await expect(page.getByRole("link", { name: /Wall contributor/ })).toHaveCount(0);
      await page.getByRole("button", { name: "Recheck current publication controls" }).click();
      await expect(page.getByRole("alert")).toHaveCount(0);
      await expect(provenance(page)).toContainText("Snapshot wall-1");
      await expect(page.getByText("Update held: wall-2. Applies after the full page cycle.")).toBeVisible();
      await expect(page.getByRole("link", { name: "Wall contributor 01", exact: true })).toBeVisible();
      await expect(page.locator(".api-wall-page")).toContainText("Page 1");
    } finally {
      await api.close();
    }
  });
}

test("frozen wall never advances its snapshot but still removes suppressed contributors and clears failed reads", async ({
  page,
}) => {
  const api = await service(page);
  try {
    await page.clock.install();
    await page.goto(wall("frozen", "&snapshot=wall-1"));
    const first = page.getByRole("link", { name: "Wall contributor 01", exact: true });
    await expect(first).toBeVisible();
    await first.focus();
    const calls = api.calls.length;
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect.poll(() => api.calls.length).toBeGreaterThan(calls);
    await expect(first).toBeFocused();
    api.next();
    await elapseWithReads(page, 61_000);
    await expect(provenance(page)).toContainText("Snapshot wall-1");
    expect(
      api.calls
        .filter((url) => url.pathname.endsWith("boards"))
        .every((url) => url.searchParams.get("snapshot") === "wall-1"),
    ).toBe(true);
    api.suppress();
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(first).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Wall contributor 02", exact: true })).toBeVisible();
    api.fail();
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page.getByText("PUBLIC READ LOST — DISPLAY CLEARED")).toBeVisible();
    await expect(page.getByRole("link", { name: /Wall contributor/ })).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText("SENSITIVE_SYNTHETIC_WALL_FAILURE");
  } finally {
    await api.close();
  }
});

test("automatic page timer survives privacy polls and obeys pause, focus and reduced motion", async ({ page }) => {
  const api = await service(page);
  try {
    await page.clock.install();
    await page.goto(wall("single"));
    await expect(page.getByRole("link", { name: "Wall contributor 01", exact: true })).toBeVisible();
    await page.clock.runFor(20_010);
    await expect(page.getByRole("button", { name: "Next page", exact: true })).toBeEnabled();
    await page.clock.runFor(10_010);
    await expect(page.locator(".api-wall-page")).toContainText("Page 2");
    const actor = page.getByRole("link", { name: "Wall contributor 07", exact: true });
    await actor.focus();
    await elapseWithReads(page, 61_000);
    await expect(page.locator(".api-wall-page")).toContainText("Page 2");
    await expect(actor).toBeFocused();
    await expect(page.locator(".api-wall-announcement")).toHaveText("PRs merged · page 2 · snapshot wall-1.");
    await page.getByRole("button", { name: "Pause wall", exact: true }).click();
    await elapseWithReads(page, 61_000);
    await expect(page.locator(".api-wall-page")).toContainText("Page 2");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.getByRole("button", { name: "Resume wall", exact: true }).click();
    await expect(page.getByText("Paused for reduced motion", { exact: true })).toBeVisible();
    await elapseWithReads(page, 61_000);
    await expect(page.locator(".api-wall-page")).toContainText("Page 2");
    await next(page);
    await expect(page.locator(".api-wall-page")).toContainText("Page 1");
  } finally {
    await api.close();
  }
});

test("a slow page read receives its full visible interval after the page loads", async ({ page }) => {
  const api = await service(page);
  let release: (() => void) | undefined;
  try {
    await page.clock.install();
    await page.goto(wall("single").replace("interval=30", "interval=20"));
    await expect(page.getByRole("link", { name: "Wall contributor 01", exact: true })).toBeVisible();
    release = api.holdHealth();
    await page.getByRole("button", { name: "Next page", exact: true }).click();
    await expect(page.getByRole("button", { name: "Next page", exact: true })).toBeDisabled();
    await page.clock.runFor(6_000);
    await expect(page.locator(".api-wall-page")).toContainText("Page 1");
    release();
    await expect(page.locator(".api-wall-page")).toContainText("Page 2");
    await expect(page.getByRole("button", { name: "Next page", exact: true })).toBeEnabled();
    await elapseWithReads(page, 14_010);
    await expect(page.locator(".api-wall-page")).toContainText("Page 2");
    await elapseWithReads(page, 6_100);
    await expect(page.locator(".api-wall-page")).toContainText("Page 1");
  } finally {
    release?.();
    await api.close();
  }
});

test("a real 20-second page boundary waits for its coincident privacy read instead of disappearing", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const api = await service(page);
  try {
    // No page clock is installed. Start an explicit privacy recheck just before
    // the real minimum page boundary, then let the periodic poll overlap it.
    await page.goto(wall("cycle", "&format=landscape").replace("interval=30", "interval=20"));
    await expect(page.locator(".api-wall-page")).toContainText("Page 1");
    await page.getByRole("button", { name: "Recheck current publication controls" }).focus();
    await page.mouse.move(0, 0);
    await expect(page.locator(".api-wall-state")).toContainText("Automatic page boundaries");
    await page.waitForTimeout(Math.max(0, 18_000 - (await page.evaluate(() => performance.now()))));
    api.delayReads(1_500);
    await page.getByRole("button", { name: "Recheck current publication controls" }).click();
    await expect(page.locator(".api-wall-state")).toContainText("Rechecking controls");
    await expect(page.locator(".api-wall-page")).toContainText("Page 2", { timeout: 15_000 });
    await expect(page.locator(".api-wall-page")).toContainText("Rank 1 continues");
    await expect(provenance(page)).toContainText("wall-1");
  } finally {
    await api.close();
  }
});

for (const actionWhileReading of ["continue", "pause", "interval"] as const) {
  test(`a due rotation respects ${actionWhileReading} during current publication controls`, async ({ page }) => {
    const api = await service(page);
    let release: (() => void) | undefined;
    try {
      await page.clock.install();
      await page.goto(wall("single").replace("interval=30", "interval=20"));
      await expect(page.getByRole("link", { name: "Wall contributor 01", exact: true })).toBeVisible();
      await page.clock.runFor(19_000);
      release = api.holdHealth();
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await expect(page.getByRole("button", { name: "Next page", exact: true })).toBeDisabled();
      await page.clock.runFor(1_010);
      await expect(page.locator(".api-wall-page")).toContainText("Page 1");
      if (actionWhileReading === "pause") await page.getByRole("button", { name: "Pause wall", exact: true }).click();
      if (actionWhileReading === "interval")
        await page.getByRole("combobox", { name: "Page speed", exact: true }).selectOption("60");
      api.suppress();
      release();
      await expect(page.getByRole("button", { name: "Next page", exact: true })).toBeEnabled();
      await expect(page.getByRole("link", { name: "Wall contributor 01", exact: true })).toHaveCount(0);
      await expect(page.locator(".api-wall-page")).toContainText(
        actionWhileReading === "continue" ? "Page 2" : "Page 1",
      );
      if (actionWhileReading !== "continue") {
        if (actionWhileReading === "pause")
          await page.getByRole("button", { name: "Resume wall", exact: true }).click();
        await page.clock.runFor(1_000);
        await expect(page.locator(".api-wall-page")).toContainText("Page 1");
      } else {
        await expect(page.getByRole("link", { name: "Wall contributor 08", exact: true })).toBeVisible();
      }
    } finally {
      release?.();
      await api.close();
    }
  });
}

test("expired cursors recover at the same pin, while revoked snapshots recover only in live mode", async ({ page }) => {
  await page.clock.install();
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const mode of ["single", "frozen"]) {
    const api = await service(page);
    try {
      await page.goto(wall(mode, mode === "frozen" ? "&snapshot=wall-1" : ""));
      await expect(page.getByRole("link", { name: "Wall contributor 01", exact: true })).toBeVisible();
      await next(page);
      api.suppress();
      await page.getByRole("button", { name: "Recheck current publication controls" }).click();
      await expect(page.getByRole("alert")).toContainText("cursor_policy_changed_refetch");
      await expect(page.getByRole("link", { name: /Wall contributor/ })).toHaveCount(0);
      const recoveryRead = page.waitForResponse(
        (response) => new URL(response.url()).pathname.endsWith("/boards") && response.status() === 200,
      );
      await page.clock.runFor(20_000);
      await recoveryRead;
      await expect(page.getByRole("link", { name: "Wall contributor 02", exact: true })).toBeVisible();
      await expect(provenance(page)).toContainText("Snapshot wall-1");
      await expect(page.locator(".api-wall-page")).toContainText("Page 1");
      api.next();
      api.revoke();
      await page.getByRole("button", { name: "Recheck current publication controls" }).click();
      await expect(page.getByRole("alert")).toContainText("snapshot_revoked_refetch");
      await expect(page.getByRole("link", { name: /Wall contributor/ })).toHaveCount(0);
      const calls = api.calls.length;
      await page.clock.runFor(20_000);
      await expect.poll(() => api.calls.length).toBeGreaterThan(calls);
      if (mode === "frozen") {
        await expect(page.getByRole("alert")).toContainText("snapshot_revoked_refetch");
        expect(
          api.calls
            .filter((url) => url.pathname.endsWith("health"))
            .every((url) => url.searchParams.get("snapshot") === "wall-1"),
        ).toBe(true);
        await expect(page.getByRole("link", { name: /Wall contributor/ })).toHaveCount(0);
      } else {
        await expect(provenance(page)).toContainText("Snapshot wall-2");
        await expect(page.getByRole("link", { name: "Wall contributor 01", exact: true })).toBeVisible();
      }
    } finally {
      await page.unroute("**/api/v1/**");
      await api.close();
    }
  }
});

test("wall freshness and controls fit intended landscape, portrait and overlay displays", async ({ page }) => {
  const api = await service(page);
  try {
    api.stale();
    for (const [format, width, height] of [
      ["landscape", 1920, 1080],
      ["landscape", 3840, 2160],
      ["portrait", 1080, 1920],
      ["overlay", 960, 540],
    ] as const) {
      await page.setViewportSize({ width, height });
      await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
      await page.goto(wall("cycle", `&format=${format}`));
      await expect(page.getByText("STALE OR DEGRADED DATA", { exact: true })).toBeVisible();
      await expect(page.getByRole("link", { name: "Wall contributor 01", exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Pause wall", exact: true })).toBeInViewport();
      await expect(page.locator(".api-wall-scope")).toBeInViewport();
      expect(
        await page.evaluate(() => ({
          width: document.documentElement.scrollWidth,
          height: document.documentElement.scrollHeight,
        })),
      ).toEqual({ width, height });
      expect(
        (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations,
      ).toEqual([]);
    }
  } finally {
    await api.close();
  }
});
