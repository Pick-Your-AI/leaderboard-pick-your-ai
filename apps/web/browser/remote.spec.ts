import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { readFile } from "node:fs/promises";

// These are synthetic service-provider inputs, never production data.
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
    knownStart: null,
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
      metricIds: ["pr_merged", "documentation"],
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
      rows: ["pr_merged", "documentation"].flatMap((metricId) =>
        actors.map(({ actorId }, index) => ({
          actorId,
          result: { schemaVersion: "leaderboard/v1", metricId, state: "measured", value: index < 2 ? 2 : 1, coverage },
          evidenceIds: [`e-${actorId}`],
        })),
      ),
      ranking: [
        { metricId: "pr_merged", direction: "descending", rank: true },
        { metricId: "documentation", direction: "descending", rank: false },
      ],
      diagnostics: ["pr_merged", "documentation"].flatMap((metricId) =>
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
          metricId: "pr_merged",
          policyVersion: "approved-policy-1",
          policySignature: "a".repeat(64),
          policyLink: "https://github.com/synthetic-api/example/blob/main/policy.md",
        },
      ],
      disabledMetrics: [] as Array<{ id: string; reason: string; policyVersion: string; policyLink: string | null }>,
    },
  };
}
async function service(
  page: Page,
  options: { holdUpdates?: boolean; resetUpdates?: boolean; holdFirstBoard?: boolean } = {},
) {
  // Dynamic path avoids coupling the web TypeScript project to server source.
  // CI builds all packages before browser tests. Requests use the actual Fastify
  // handler, contract projection, query checks and signed cursor implementation.
  const serverModule = new URL("../../service/dist/app.js", import.meta.url).href;
  const { createService } = await import(serverModule);
  let current = snapshot();
  const snapshots = new Map([[current.head.snapshotId, current]]);
  let unavailable = false;
  let wrongHealthScope = false;
  let wrongDisabledScope = false;
  let disabledMetrics = snapshot().selected.disabledMetrics;
  const app = createService({
    now: () => Date.parse(at),
    cursorSecret: "synthetic-browser-cursor-secret-0001",
    source: {
      async read(scope: typeof baseScope, pin: string | null) {
        if (unavailable) throw Error("SENSITIVE_SYNTHETIC_PROVIDER_FAILURE");
        const chosen = pin ? snapshots.get(pin) : current;
        if (!chosen) return null;
        const result = structuredClone(chosen);
        result.selected.scope = { ...scope };
        result.head = structuredClone(current.head);
        result.controls = structuredClone(current.controls);
        result.selected.disabledMetrics = structuredClone(disabledMetrics);
        return result;
      },
    },
  });
  const calls: URL[] = [];
  const healthResponses: { status: number; conditional: string | null }[] = [];
  let releaseBoard = () => {};
  let boardRequested = () => {};
  let boardSettled = () => {};
  let heldBoard = false;
  const firstBoard = new Promise<void>((resolve) => {
    boardRequested = resolve;
  });
  const settledBoard = new Promise<void>((resolve) => {
    boardSettled = resolve;
  });
  const boardGate = new Promise<void>((resolve) => {
    releaseBoard = resolve;
  });
  let releaseUpdates = () => {};
  const updateGate = options.holdUpdates
    ? new Promise<void>((resolve) => {
        releaseUpdates = resolve;
      })
    : Promise.resolve();
  await page.route("**/api/v1/**", async (route) => {
    const url = new URL(route.request().url());
    calls.push(url);
    const headers = route.request().headers();
    if (wrongHealthScope && url.pathname.endsWith("/health")) delete headers["if-none-match"];
    if (url.pathname.endsWith("/updates")) {
      await updateGate;
      if (options.resetUpdates) headers["last-event-id"] = "0:expired:privacy-0";
    }
    const response = await app.inject({ method: "GET", url: url.pathname + url.search, headers });
    let body = response.body;
    if (wrongDisabledScope && url.pathname.endsWith("/boards") && response.statusCode === 503) {
      const invalid = JSON.parse(body);
      invalid.scope.repository = "another-repository";
      body = JSON.stringify(invalid);
    }
    if (wrongHealthScope && url.pathname.endsWith("/health") && response.statusCode === 200) {
      const invalid = JSON.parse(body);
      invalid.scope.repository = "another-repository";
      body = JSON.stringify(invalid);
    }
    if (url.pathname.endsWith("/health"))
      healthResponses.push({ status: response.statusCode, conditional: headers["if-none-match"] ?? null });
    const hold = options.holdFirstBoard && url.pathname.endsWith("/boards") && !heldBoard;
    if (hold) {
      heldBoard = true;
      boardRequested();
      await boardGate;
    }
    try {
      await route.fulfill({ status: response.statusCode, headers: response.headers, body });
    } finally {
      if (hold) boardSettled();
    }
  });
  return {
    calls,
    healthResponses,
    releaseUpdates: () => releaseUpdates(),
    firstBoard,
    settledBoard,
    releaseBoard: () => releaseBoard(),
    wrongDisabledScope() {
      wrongDisabledScope = true;
    },
    disableMetric(policyLink: string | null = "https://github.com/synthetic-api/example/blob/main/policy.md") {
      disabledMetrics = [{ id: "pr_merged", reason: "policy_withdrawn", policyVersion: "review-v1", policyLink }];
    },
    mixedActors() {
      current.selected.actors[1]!.actor.executionMode = "automated";
      current.selected.actors[2]!.actor.kind = "bot";
      current.selected.actors[2]!.actor.executionMode = "automated";
    },
    observedOnly() {
      current.selected.rows = [];
      current.selected.evidence = [];
    },
    manyPortfolio() {
      const first = current.selected.portfolioEvidence[0]!;
      current.selected.portfolioEvidence = Array.from({ length: 205 }, (_, index) => ({
        ...structuredClone(first),
        artifact: {
          ...first.artifact,
          stableId: `many-${index}`,
          publicUrl: `https://github.com/synthetic-api/example/pull/${index + 1}`,
        },
        contribution: {
          ...first.contribution,
          contributionId: `many-${String(index).padStart(3, "0")}`,
          artifactId: `many-${index}`,
        },
        activityState: index % 2 ? "pending" : "observed",
      }));
    },
    activityHistory() {
      const [first, second, third] = current.selected.portfolioEvidence;
      current.selected.rows = [];
      current.selected.evidence = [];
      current.selected.portfolioEvidence = Array.from({ length: 205 }, (_, index) => ({
        ...structuredClone(first!),
        artifact: {
          ...first!.artifact,
          stableId: `burst-${index}`,
          publicUrl: `https://github.com/synthetic-api/example/pull/${index + 1}`,
        },
        contribution: {
          ...first!.contribution,
          canonicalEventId: `burst-event-${index}`,
          contributionId: `burst-proof-${String(index).padStart(3, "0")}`,
          artifactId: `burst-${index}`,
        },
        occurredAt: new Date(Date.parse(at) - 2 * 3600000 + index * 1000).toISOString(),
        observedAt: at,
      }));
      current.selected.portfolioEvidence.push(
        { ...structuredClone(second!), activityState: "pending", occurredAt: "2026-10-17T11:00:00.000Z" },
        { ...structuredClone(third!), activityState: "accepted" },
      );
    },
    activityMetadataBurst() {
      const [first, other] = current.selected.portfolioEvidence;
      current.selected.rows = [];
      current.selected.evidence = [];
      current.selected.ranking.push({ metricId: "labels_applied", direction: "descending", rank: false });
      current.selected.portfolioEvidence = Array.from({ length: 205 }, (_, index) => ({
        ...structuredClone(first!),
        artifact: {
          ...first!.artifact,
          kind: "issue",
          stableId: `metadata-${index}`,
          repositoryId: `repo-${index}`,
          publicUrl: `https://github.com/synthetic-api/example/issues/${index + 1}`,
        },
        contribution: {
          ...first!.contribution,
          roles: ["triager"],
          metricIds: ["labels_applied"],
          canonicalEventId: `metadata-event-${index}`,
          contributionId: `metadata-proof-${String(index).padStart(3, "0")}`,
          artifactId: `metadata-${index}`,
        },
        occurredAt: "2026-10-17T08:00:00.0009-04:00",
        observedAt: "2026-10-18T12:00:00.000Z",
      }));
      current.selected.portfolioEvidence.push({
        ...structuredClone(other!),
        activityState: "accepted",
        occurredAt: "2026-10-17T12:00:00.0001Z",
      });
    },
    async legacyActivityCursor() {
      return (await app.inject("/api/v1/activity?snapshot=api-1&limit=100")).json().nextCursor as string;
    },
    async close() {
      releaseUpdates();
      releaseBoard();
      await page.unrouteAll({ behavior: "wait" });
      await app.close();
    },
    next(revision = 2) {
      current = snapshot(`api-${revision}`, revision);
      current.selected.rows[0]!.result.value = (revision - 1) * 10;
      snapshots.set(current.head.snapshotId, current);
    },
    suppress() {
      current.controls.version = "privacy-2";
      current.controls.suppressedActorIds = ["api-a"];
    },
    revoke() {
      current.controls.version = "privacy-3";
      current.controls.revokedSnapshotIds = ["api-1"];
    },
    fail() {
      unavailable = true;
    },
    stale() {
      current.selected.snapshot.coverage[0]!.lastSuccessfulSync = "2026-10-17T11:00:00.000Z";
    },
    recover() {
      unavailable = false;
      current.selected.snapshot.coverage[0]!.lastSuccessfulSync = at;
    },
    wrongHealthScope() {
      wrongHealthScope = true;
    },
  };
}

test("disabled API board retains the exact historical policy without presenting a measured zero", async ({
  page,
}, testInfo) => {
  const api = await service(page);
  api.disableMetric();
  try {
    await page.goto("/leaderboards/pr_merged?ui=api&repository=repo-1&snapshot=api-1");
    const notice = page.getByRole("alert");
    await expect(notice).toBeVisible();
    await expect(notice.getByRole("link", { name: "Historical policy source", exact: true })).toHaveAttribute(
      "href",
      "https://github.com/synthetic-api/example/blob/main/policy.md",
    );
    await expect(notice).toContainText("review-v1");
    await expect(notice).toContainText("This measure is currently disabled.");
    await expect(page.getByRole("table")).toHaveCount(0);
    expect(
      api.calls.some(
        (url) =>
          url.pathname.endsWith("/boards") &&
          url.searchParams.get("snapshot") === "api-1" &&
          url.searchParams.get("repository") === "repo-1",
      ),
    ).toBe(true);
    await testInfo.attach("disabled-board-policy", { body: await page.screenshot(), contentType: "image/png" });
  } finally {
    await api.close();
  }
});

test("unaffected API board remains measured and discloses the other disabled metric policy", async ({
  page,
}, testInfo) => {
  const api = await service(page);
  api.disableMetric();
  try {
    await page.goto("/leaderboards/documentation?ui=api&repository=repo-1&snapshot=api-1");
    await expect(page.getByRole("row", { name: /Synthetic API A/ }).locator("strong")).toHaveText("2");
    const provenance = page.getByRole("region", { name: "Snapshot provenance" });
    await expect(provenance.getByRole("link", { name: "Historical policy source", exact: true })).toHaveAttribute(
      "href",
      "https://github.com/synthetic-api/example/blob/main/policy.md",
    );
    await expect(provenance).toContainText("review-v1");
    await expect(provenance).toContainText("This measure is currently disabled.");
    await expect(page.getByRole("alert")).toHaveCount(0);
    await testInfo.attach("unaffected-board-policy", { body: await page.screenshot(), contentType: "image/png" });
  } finally {
    await api.close();
  }
});

for (const link of [null, "https://user:secret@github.com/synthetic-api/example/issues/1?private=value"]) {
  test(`disabled API board makes ${link === null ? "absent" : "unsafe"} historical policy link explicitly unavailable`, async ({
    page,
  }) => {
    const api = await service(page);
    api.disableMetric(link);
    try {
      await page.goto("/leaderboards/pr_merged?ui=api&repository=repo-1&snapshot=api-1");
      const notice = page.getByRole("alert");
      await expect(notice).toContainText("Historical policy link unavailable.");
      await expect(notice).toContainText("review-v1");
      await expect(notice.getByRole("link", { name: "Historical policy source" })).toHaveCount(0);
      await expect(page.locator("body")).not.toContainText("secret");
      await expect(page.locator("body")).not.toContainText("private=value");
    } finally {
      await api.close();
    }
  });
}

test("disabled API board rejects a policy response belonging to another scope", async ({ page }) => {
  const api = await service(page);
  api.disableMetric();
  api.wrongDisabledScope();
  try {
    await page.goto("/leaderboards/pr_merged?ui=api&repository=repo-1&snapshot=api-1");
    const notice = page.getByRole("alert");
    await expect(notice).toContainText("api_scope_mismatch");
    await expect(notice.getByRole("link", { name: "Historical policy source" })).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText("review-v1");
    await expect(page.getByRole("table")).toHaveCount(0);
  } finally {
    await api.close();
  }
});

test("late disabled API board response cannot restore policy after navigating to measures", async ({ page }) => {
  const api = await service(page, { holdFirstBoard: true });
  api.disableMetric();
  try {
    await page.goto("/leaderboards/pr_merged?ui=api&repository=repo-1&snapshot=api-1");
    await api.firstBoard;
    await page
      .getByRole("navigation", { name: "Primary", exact: true })
      .getByRole("link", { name: "Measures", exact: true })
      .click();
    await expect(page).toHaveURL(/\/leaderboards\?/);
    await expect(page.getByRole("heading", { level: 1, name: "Measures" })).toBeVisible();
    api.releaseBoard();
    await api.settledBoard;
    await expect(page.getByRole("link", { name: "Historical policy source" })).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText("review-v1");
    await expect(page.getByRole("alert")).toHaveCount(0);
  } finally {
    await api.close();
  }
});

test("API polling fallback uses conditional health, holds new rankings and reports stale or failed checks truthfully", async ({
  page,
}) => {
  await page.addInitScript(() =>
    Object.defineProperty(window, "EventSource", { value: undefined, configurable: true }),
  );
  await page.clock.install({ time: new Date(at) });
  await page.clock.pauseAt(new Date(Date.parse(at) + 1000));
  const api = await service(page);
  try {
    await page.goto("/leaderboards/pr_merged?ui=api&repository=repo-1&workstream=triage&actors=user&limit=1");
    const freshness = page.getByRole("region", { name: "Current source freshness" });
    const provenance = page.getByRole("region", { name: "Snapshot provenance" });
    const actor = page.getByRole("link", { name: "Synthetic API A", exact: true });
    await expect(actor).toBeVisible();
    await expect(freshness).toContainText("Update connection: Polling for updates.");
    await expect(freshness).toContainText("Source freshness: Recently reconciled.");
    await page.clock.runFor(3000);
    await expect
      .poll(() => api.healthResponses.some((entry) => entry.status === 304 && entry.conditional !== null))
      .toBe(true);
    expect(api.calls.filter((url) => url.pathname.endsWith("/updates"))).toHaveLength(0);
    expect(
      api.calls
        .filter((url) => url.pathname.endsWith("/health"))
        .every(
          (url) =>
            url.searchParams.get("actors") === "user" &&
            url.searchParams.get("repository") === "repo-1" &&
            url.searchParams.get("workstream") === "triage" &&
            !["snapshot", "cursor", "metric", "limit"].some((key) => url.searchParams.has(key)),
        ),
    ).toBe(true);
    await actor.focus();
    api.next();
    await page.clock.runFor(3000);
    await expect(page.getByText("Update held: snapshot api-2 is available.")).toBeVisible();
    await expect(provenance).toContainText("Snapshot api-1");
    await expect(actor).toBeFocused();
    await expect(page.getByRole("row", { name: /Synthetic API A/ }).locator("strong")).toHaveText("2");
    await page.getByRole("button", { name: "Apply new snapshot" }).click();
    await expect(provenance).toContainText("Snapshot api-2");
    await expect(page.getByRole("row", { name: /Synthetic API A/ }).locator("strong")).toHaveText("10");
    api.stale();
    await page.clock.runFor(3000);
    await expect(freshness).toContainText("Source freshness: Stale or degraded.");
    const lastSuccess = await freshness.locator("time").getAttribute("datetime");
    api.fail();
    await page.clock.runFor(3000);
    await expect(freshness).toContainText("Update connection: Update checks unavailable.");
    await expect(freshness).toContainText("Source freshness: Unknown.");
    await expect(freshness.locator("time")).toHaveAttribute("datetime", lastSuccess!);
    api.recover();
    await page.clock.runFor(6000);
    await expect(freshness).toContainText("Source freshness: Recently reconciled.");
    expect(await freshness.locator("time").getAttribute("datetime")).not.toBe(lastSuccess);
    api.wrongHealthScope();
    await page.clock.runFor(3000);
    await expect(freshness).toContainText("Source freshness: Unknown.");
    await expect(freshness).toContainText("Update checks unavailable");
  } finally {
    await api.close();
  }
});

test("real SSE reset rechecks pinned privacy before the next poll, and visibility resume recovers missed publication changes", async ({
  page,
}) => {
  await page.clock.install({ time: new Date(at) });
  await page.clock.pauseAt(new Date(Date.parse(at) + 1000));
  const api = await service(page, { holdUpdates: true, resetUpdates: true });
  try {
    await page.goto("/leaderboards/pr_merged?ui=api&snapshot=api-1&repository=repo-1");
    const freshness = page.getByRole("region", { name: "Current source freshness" });
    const provenance = page.getByRole("region", { name: "Snapshot provenance" });
    const actor = page.getByRole("link", { name: "Synthetic API A", exact: true });
    await expect(actor).toBeVisible();
    await expect(freshness).toContainText("Source freshness: Recently reconciled.");
    await expect.poll(() => api.calls.filter((url) => url.pathname.endsWith("/updates")).length).toBe(1);
    const initialHealth = api.healthResponses.length;
    api.next();
    api.suppress();
    api.releaseUpdates();
    await expect(actor).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Synthetic API B", exact: true })).toBeVisible();
    await expect(provenance).toContainText("Snapshot api-1");
    await expect(provenance).toContainText("privacy-2");
    await expect(freshness).toContainText("Source freshness: Unknown.");
    expect(api.healthResponses).toHaveLength(initialHealth);
    expect(
      api.calls
        .filter((url) => url.pathname.endsWith("/updates"))
        .every(
          (url) =>
            url.searchParams.get("repository") === "repo-1" &&
            !url.searchParams.has("snapshot") &&
            !url.searchParams.has("cursor"),
        ),
    ).toBe(true);
    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", { value: true, configurable: true });
      Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect(freshness).toContainText("Paused while this page is hidden");
    const pausedCalls = api.calls.length;
    api.next(3);
    api.revoke();
    await page.clock.runFor(60000);
    expect(api.calls).toHaveLength(pausedCalls);
    await page.evaluate(() => {
      Reflect.deleteProperty(document, "hidden");
      Reflect.deleteProperty(document, "visibilityState");
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect(page.getByRole("alert")).toContainText("Selection expired or revoked");
    await expect(page.getByRole("link", { name: "Synthetic API B", exact: true })).toHaveCount(0);
    await expect(freshness).toContainText("Source freshness: Recently reconciled.");
    await page.getByRole("link", { name: "Restart from the current publication" }).click();
    await expect(provenance).toContainText("Snapshot api-3");
    await expect(page.getByRole("row", { name: /Synthetic API A/ }).locator("strong")).toHaveText("20");
  } finally {
    await api.close();
  }
});

test("actor selections persist through controls and board-to-profile navigation", async ({ page }) => {
  const api = await service(page);
  api.mixedActors();
  try {
    await page.goto("/leaderboards/pr_merged?ui=api&metric=pr_merged&actors=user&limit=1");
    const provenance = page.getByRole("region", { name: "Snapshot provenance" });
    await expect(provenance).toContainText("User accounts");
    await page.getByText("Exact scope and snapshot", { exact: true }).click();
    const control = page.getByRole("combobox", { name: "Activity selection" });
    await expect(control).toHaveValue("user");
    await expect(page.getByText(/These views may overlap/)).toBeVisible();
    await control.selectOption("automation");
    await page.getByRole("button", { name: "Read exact scope" }).click();
    await expect(provenance).toContainText("Automation");
    const next = page.getByRole("link", { name: "Next cursor page" });
    await expect(next).toHaveAttribute("href", /actors=automation/);
    await expect(page.getByRole("link", { name: "Synthetic API B", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Synthetic API A", exact: true })).toHaveCount(0);
    await page.getByRole("link", { name: "Synthetic API B", exact: true }).click();
    await expect(page).toHaveURL(/actors=automation/);
    await expect(provenance).toContainText("Automation");
    await expect(page.getByRole("heading", { name: "Synthetic API B", exact: true })).toBeVisible();
    await page.setViewportSize({ width: 360, height: 800 });
    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBeTruthy();
    expect(
      api.calls
        .filter((url) => url.pathname.endsWith("/boards"))
        .at(-1)!
        .searchParams.get("actors"),
    ).toBe("automation");
  } finally {
    await api.close();
  }
});

test("real service handler: exact scope, dense ties, cursors and pinned board → profile → evidence after head advances", async ({
  page,
}) => {
  const api = await service(page);
  try {
    const query =
      "?ui=api&organization=Pick-Your-AI&repository=repo-1&workstream=triage&start=2026-10-01T00%3A00%3A00.000Z&end=2026-11-01T00%3A00%3A00.000Z&limit=1";
    await page.goto(`/leaderboards/pr_merged${query}`);
    await expect(page.getByRole("link", { name: "Synthetic API A", exact: true })).toBeVisible();
    const request = api.calls.find((call) => call.pathname.endsWith("/boards"))!;
    expect(Object.fromEntries(request.searchParams)).toMatchObject({
      organization: "Pick-Your-AI",
      repository: "repo-1",
      workstream: "triage",
      metric: "pr_merged",
      limit: "1",
      start: "2026-10-01T00:00:00.000Z",
      end: "2026-11-01T00:00:00.000Z",
    });
    const nextHref = await page.getByRole("link", { name: "Next cursor page" }).getAttribute("href");
    expect(new URL(nextHref!, page.url()).searchParams.get("snapshot")).toBe("api-1");
    api.next();
    await page.getByRole("link", { name: "Synthetic API A", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Contributor portfolio" })).toBeFocused();
    await expect(page.getByText("Stable actor api-a", { exact: false })).toBeVisible();
    await page.getByRole("link", { name: "e-api-a", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Contribution evidence" })).toBeFocused();
    await expect(page.getByRole("link", { name: "Open public source artifact" })).toHaveAttribute(
      "href",
      "https://github.com/synthetic-api/example/pull/1",
    );
    const evidenceCalls = api.calls.filter((call) => call.pathname.endsWith("/evidence/e-api-a"));
    expect(evidenceCalls.length).toBeGreaterThan(0);
    expect(
      evidenceCalls.every(
        (call) =>
          call.searchParams.get("snapshot") === "api-1" &&
          call.searchParams.get("repository") === "repo-1" &&
          call.searchParams.get("workstream") === "triage",
      ),
    ).toBe(true);
    await page.goto(nextHref!);
    await expect(page.getByRole("link", { name: "Synthetic API B", exact: true })).toBeVisible();
    await expect(page.getByRole("cell", { name: "1", exact: true })).toBeVisible();
    expect(
      api.calls
        .filter((call) => call.searchParams.has("cursor"))
        .every((call) => call.searchParams.get("limit") === "1" && call.searchParams.get("snapshot") === "api-1"),
    ).toBe(true);
    for (const format of ["JSON", "CSV"]) {
      const download = page.waitForEvent("download");
      await page.getByRole("button", { name: `Download current ${format} page` }).click();
      const file = await download;
      const body = await readFile((await file.path())!, "utf8");
      expect(body).toContain("api-1");
      expect(body).toContain("synthetic-api-b");
      const call = api.calls.filter((call) => call.pathname.endsWith("/exports")).at(-1)!;
      expect(Object.fromEntries(call.searchParams)).toMatchObject({
        repository: "repo-1",
        workstream: "triage",
        metric: "pr_merged",
        limit: "1",
        snapshot: "api-1",
        format: format.toLowerCase(),
      });
      expect(call.searchParams.get("cursor")).toBe(new URL(nextHref!, page.url()).searchParams.get("cursor"));
    }
    expect(
      (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations,
    ).toEqual([]);
  } finally {
    await api.close();
  }
});

test("current suppression revalidates pinned evidence and failed reads never substitute fixtures or stale actors", async ({
  page,
}) => {
  const api = await service(page);
  try {
    await page.goto("/contributions/e-api-a?ui=api&snapshot=api-1");
    await expect(page.getByRole("link", { name: "Open public source artifact" })).toBeVisible();
    api.next();
    api.suppress();
    await page.getByRole("button", { name: "Recheck current publication controls" }).click();
    await expect(page.getByRole("alert")).toContainText("Public record unavailable");
    await expect(page.getByRole("link", { name: "Open public source artifact" })).toHaveCount(0);
    await page.goto("/leaderboards/pr_merged?ui=api&snapshot=api-1");
    await expect(page.getByRole("link", { name: "Synthetic API B", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Synthetic API A", exact: true })).toHaveCount(0);
    api.fail();
    await page.getByRole("button", { name: "Recheck current publication controls" }).click();
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page.getByRole("link", { name: "Synthetic API B", exact: true })).toHaveCount(0);
    await expect(page.getByRole("complementary", { name: "Synthetic data notice" })).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText("SENSITIVE_SYNTHETIC_PROVIDER_FAILURE");
    await expect(page.locator("body")).not.toContainText("Aster (synthetic)");
  } finally {
    await api.close();
  }
});

test("descriptive policy stays unranked; API media and supported reference pages use actual response metadata", async ({
  page,
}) => {
  const api = await service(page);
  try {
    await page.setViewportSize({ width: 360, height: 900 });
    await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
    await page.goto("/leaderboards/documentation?ui=api");
    await expect(page.getByText("Descriptive values; no rank is assigned.")).toBeVisible();
    await expect(page.getByRole("cell", { name: /Unranked/ })).toHaveCount(3);
    await expect(
      page.getByText("Numerator 2; denominator unknown; samples 2;", { exact: false }).first(),
    ).toBeVisible();
    await expect(page.getByRole("checkbox", { name: /Follow while/ })).toBeDisabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    for (const route of [
      "/leaderboards",
      "/methodology/pr_merged",
      "/coverage",
      "/activity",
      "/contributors",
      "/live",
    ]) {
      await page.goto(`${route}?ui=api${route === "/live" ? "&metric=pr_merged" : ""}`);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expect(page.getByRole("status").filter({ hasText: /Loading/ })).toHaveCount(0);
      if (route === "/methodology/pr_merged") {
        await expect(page.getByRole("region", { name: "Snapshot provenance" })).toHaveCount(0);
        await expect(page.getByText("UI metadata version", { exact: true })).toBeVisible();
        await expect(page.getByText("No published policy signature supplied for this selection.")).toBeVisible();
      } else if (route !== "/leaderboards")
        await expect(page.getByRole("region", { name: "Snapshot provenance" })).toBeVisible();
      expect(
        (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations,
      ).toEqual([]);
    }
  } finally {
    await api.close();
  }
});

test("successful same-selection background recheck preserves keyboard DOM; suppression still removes the focused actor", async ({
  page,
}) => {
  const api = await service(page);
  try {
    await page.goto("/leaderboards/pr_merged?ui=api&snapshot=api-1");
    const actor = page.getByRole("link", { name: "Synthetic API A", exact: true });
    await actor.focus();
    const count = api.calls.length;
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect.poll(() => api.calls.length).toBeGreaterThan(count);
    await expect(page.getByText("Rechecking…")).toHaveCount(0);
    await expect(actor).toBeFocused();
    api.suppress();
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(actor).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Synthetic API B", exact: true })).toBeVisible();
  } finally {
    await api.close();
  }
});

test("API follow releases a removed actor's obsolete focus hold after a privacy recheck", async ({
  page,
}, testInfo) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.addInitScript(() =>
    Object.defineProperty(window, "EventSource", { value: undefined, configurable: true }),
  );
  const api = await service(page);
  try {
    await page.goto("/leaderboards/pr_merged?ui=api");
    const follow = page.getByRole("checkbox", { name: /Follow while/ });
    const provenance = page.getByRole("region", { name: "Snapshot provenance" });
    const actor = page.getByRole("link", { name: "Synthetic API A", exact: true });
    await expect(actor).toBeVisible();
    await expect(follow).not.toBeChecked();
    await follow.check();
    await page.mouse.move(0, 0);
    await actor.focus();

    api.next();
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page.getByText("Update held: snapshot api-2 is available.")).toBeVisible();
    await expect(provenance).toContainText("Snapshot api-1");
    await expect(actor).toBeFocused();
    await expect(follow).toBeChecked();

    api.suppress();
    // A click would move focus before removal and conceal an obsolete hold.
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(actor).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Synthetic API B", exact: true })).toBeVisible();
    await testInfo.attach("removed-focus-follow-observation.json", {
      body: JSON.stringify({
        activeElement: await page.evaluate(() => ({
          tag: document.activeElement?.tagName,
          text: document.activeElement === document.body ? null : document.activeElement?.textContent,
        })),
        followChecked: await follow.isChecked(),
        provenance: await provenance.innerText(),
        suppressedActorCount: await actor.count(),
      }),
      contentType: "application/json",
    });
    await expect(provenance).toContainText("Snapshot api-2");
    await expect(provenance).toContainText("privacy-2");
    await expect(follow).toBeChecked();
    await expect(actor).toHaveCount(0);
  } finally {
    await api.close();
  }
});

test("API follow keeps a removed actor's update held until the pointer leaves the board", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.addInitScript(() =>
    Object.defineProperty(window, "EventSource", { value: undefined, configurable: true }),
  );
  const api = await service(page);
  try {
    await page.goto("/leaderboards/pr_merged?ui=api");
    const follow = page.getByRole("checkbox", { name: /Follow while/ });
    const provenance = page.getByRole("region", { name: "Snapshot provenance" });
    const actor = page.getByRole("link", { name: "Synthetic API A", exact: true });
    const survivor = page.getByRole("link", { name: "Synthetic API B", exact: true });
    await expect(actor).toBeVisible();
    await follow.check();
    await page.mouse.move(0, 0);
    await actor.focus();

    api.next();
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page.getByText("Update held: snapshot api-2 is available.")).toBeVisible();
    await expect(provenance).toContainText("Snapshot api-1");
    await page.getByRole("columnheader", { name: "Rank", exact: true }).hover();
    await expect(actor).toBeFocused();

    api.suppress();
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(actor).toHaveCount(0);
    await expect(survivor).toBeVisible();
    await expect(provenance).toContainText("privacy-2");
    await expect(page.getByText("Rechecking…")).toHaveCount(0);
    expect(await page.getByRole("table").evaluate((element) => element.matches(":hover"))).toBe(true);

    // Observe the settled privacy response across five frame/task boundaries
    // and at least 250 ms; an immediate assertion could precede the apply effect.
    const held = await provenance.evaluate(async (element) => {
      const observations = [];
      for (let frame = 0; frame < 5; frame++) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 50)));
        observations.push({ connected: element.isConnected, text: element.textContent });
      }
      return observations;
    });
    for (const observation of held) {
      expect(observation.connected).toBe(true);
      expect(observation.text).toContain("Snapshot api-1");
      expect(observation.text).toContain("privacy-2");
    }
    expect(
      api.calls.some((call) => call.pathname.endsWith("/boards") && call.searchParams.get("snapshot") === "api-2"),
    ).toBe(false);
    expect(await page.getByRole("table").evaluate((element) => element.matches(":hover"))).toBe(true);
    await expect(follow).toBeChecked();

    await page.mouse.move(0, 0);
    await expect(provenance).toContainText("Snapshot api-2");
    await expect(provenance).toContainText("privacy-2");
    await expect(follow).toBeChecked();
    await expect(actor).toHaveCount(0);
  } finally {
    await api.close();
  }
});

test("new heads remain held until applied; unsupported query is rejected before any provider read", async ({
  page,
}) => {
  const api = await service(page);
  try {
    await page.goto("/leaderboards/pr_merged?ui=api");
    await expect(page.getByRole("link", { name: "Synthetic API A", exact: true })).toBeVisible();
    api.next();
    await page.getByRole("button", { name: "Recheck current publication controls" }).click();
    await expect(page.getByText("Update held: snapshot api-2 is available.")).toBeVisible();
    await expect(page.getByRole("row", { name: /Synthetic API A/ })).toContainText("2");
    await page.getByRole("button", { name: "Apply new snapshot" }).click();
    await expect(page.getByRole("row", { name: /Synthetic API A/ })).toContainText("10");
    const count = api.calls.length;
    await page.goto("/leaderboards/pr_merged?ui=api&repository=repo-1&repository=repo-2");
    await expect(page.getByRole("alert")).toContainText("unsupported_or_duplicate_filter");
    expect(api.calls.length).toBe(count);
    await page.goto("/leaderboards/pr_merged?ui=api&metric=documentation");
    await expect(page.getByRole("alert")).toContainText("conflicting_metric_selection");
    expect(api.calls.length).toBe(count);
  } finally {
    await api.close();
  }
});

test("page exports enforce current suppression and revoked export errors clear previously displayed data", async ({
  page,
}) => {
  const api = await service(page);
  try {
    await page.goto("/leaderboards/pr_merged?ui=api&snapshot=api-1");
    await expect(page.getByRole("link", { name: "Synthetic API A", exact: true })).toBeVisible();
    api.suppress();
    const exported = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download current CSV page" }).click();
    const file = await exported;
    expect(await readFile((await file.path())!, "utf8")).not.toContain("synthetic-api-a");
    await expect(page.getByRole("link", { name: "Synthetic API A", exact: true })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Synthetic API B", exact: true })).toBeVisible();
    api.revoke();
    await page.getByRole("button", { name: "Download current JSON page" }).click();
    await expect(page.getByRole("alert")).toContainText("Selection expired or revoked");
    await expect(page.getByRole("link", { name: "Synthetic API B", exact: true })).toHaveCount(0);
  } finally {
    await api.close();
  }
});

test("observed-only directory has accessible search/category pages with stable snapshot and no rank requirement", async ({
  page,
}) => {
  const api = await service(page);
  api.observedOnly();
  try {
    await page.goto("/contributors?ui=api&limit=1");
    await expect(page.getByRole("heading", { name: "Contributor directory", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Synthetic API A", exact: true })).toBeVisible();
    await expect(page.getByText(/1 observed; 0 in progress; 0 independently accepted/).first()).toBeVisible();
    api.next();
    await page.getByRole("link", { name: "Next contributors page" }).click();
    await expect(page.getByRole("link", { name: "Synthetic API B", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { level: 1 })).toBeFocused();
    expect(new URL(page.url()).searchParams.get("snapshot")).toBe("api-1");
    await page.goBack();
    await expect(page.getByRole("link", { name: "Synthetic API A", exact: true })).toBeVisible();
    expect(new URL(page.url()).searchParams.get("snapshot")).toBe("api-1");
    await page.getByRole("searchbox", { name: "Public username" }).fill("synthetic-api-c");
    await page.getByRole("combobox", { name: "Contribution category" }).selectOption("documentation");
    await page.getByRole("button", { name: "Filter contributions" }).click();
    await expect(page.getByRole("link", { name: "Synthetic API C", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Next contributors page" })).toHaveCount(0);
    expect(
      api.calls
        .filter((url) => url.pathname.endsWith("/contributors"))
        .at(-1)!
        .searchParams.get("category"),
    ).toBe("documentation");
    expect(
      (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations,
    ).toEqual([]);
  } finally {
    await api.close();
  }
});

test("profile pages navigate beyond 100 equal-time records and fail closed when controls change", async ({ page }) => {
  const api = await service(page);
  api.manyPortfolio();
  try {
    await page.goto("/contributors/api-a?ui=api&category=documentation&limit=100");
    await expect(page.getByRole("link", { name: "many-000", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "many-099", exact: true })).toBeVisible();
    await expect(page.getByText(/205 public evidence records/)).toBeVisible();
    await page.getByRole("link", { name: "Next timeline page" }).click();
    await expect(page.getByRole("link", { name: "many-100", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "many-000", exact: true })).toHaveCount(0);
    await expect(page.getByRole("heading", { level: 1 })).toBeFocused();
    await page.getByRole("link", { name: "Next timeline page" }).click();
    await expect(page.getByRole("link", { name: "many-204", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Next timeline page" })).toHaveCount(0);
    await page.goBack();
    await expect(page.getByRole("link", { name: "many-100", exact: true })).toBeVisible();
    api.suppress();
    await page.getByRole("button", { name: "Recheck current publication controls" }).click();
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page.getByRole("link", { name: "many-100", exact: true })).toHaveCount(0);
  } finally {
    await api.close();
  }
});

test("activity uses its public feed API, compact bursts and all source proofs with pinned category and Back navigation", async ({
  page,
}) => {
  const api = await service(page);
  api.activityHistory();
  try {
    await page.goto("/activity?ui=api&category=documentation&repository=repo-1&limit=100");
    await expect(page.getByRole("heading", { name: "Public activity", exact: true })).toBeVisible();
    const groups = page.getByRole("list", { name: "Public activity groups" }).locator(":scope > li");
    await expect(groups).toHaveCount(3);
    await expect(groups.nth(0)).toContainText("Independently accepted work");
    await expect(groups.nth(1)).toContainText("In-progress work");
    await expect(groups.nth(2)).toContainText("205 artifacts · 205 canonical facts · 205 evidence records");
    await expect(groups.nth(2)).toContainText("200 more artifacts in this group");
    await expect(groups.nth(2).getByRole("list", { name: "Artifact preview" }).getByRole("listitem")).toHaveCount(5);
    await expect(groups.nth(2)).toContainText("Collection occurred after the action");
    expect(api.calls.some((call) => call.pathname === "/api/v1/boards")).toBe(false);
    expect(
      api.calls
        .filter((call) => call.pathname === "/api/v1/activity-bursts")
        .every((call) => call.searchParams.get("category") === "documentation" && !call.searchParams.has("metric")),
    ).toBe(true);
    await page.getByRole("link", { name: "Explore 205 source proofs" }).click();
    await expect(page.getByRole("heading", { name: "Public activity", exact: true })).toBeFocused();
    await expect(page.getByRole("list", { name: "Grouped source proofs" }).locator(":scope > li")).toHaveCount(100);
    const nextHref = await page.getByRole("link", { name: "Next source proofs page" }).getAttribute("href");
    expect(new URL(nextHref!, page.url()).searchParams.get("snapshot")).toBe("api-1");
    expect(new URL(nextHref!, page.url()).searchParams.get("category")).toBe("documentation");
    api.next();
    await page.getByRole("link", { name: "Next source proofs page" }).click();
    await expect(page.getByRole("list", { name: "Grouped source proofs" }).locator(":scope > li")).toHaveCount(100);
    await page.getByRole("link", { name: "Next source proofs page" }).click();
    await expect(page.getByRole("list", { name: "Grouped source proofs" }).locator(":scope > li")).toHaveCount(5);
    await expect(page.getByRole("link", { name: "Next source proofs page" })).toHaveCount(0);
    const proof = page
      .getByRole("list", { name: "Grouped source proofs" })
      .getByRole("link", { name: /^burst-proof-/ })
      .first();
    await proof.click();
    await expect(page.getByRole("heading", { name: "Contribution evidence", exact: true })).toBeFocused();
    await page.goBack();
    await expect(page.getByRole("list", { name: "Grouped source proofs" }).locator(":scope > li")).toHaveCount(5);
    expect(new URL(page.url()).searchParams.get("snapshot")).toBe("api-1");
    await page.getByRole("link", { name: "Return to this snapshot’s activity" }).click();
    await expect(page.getByRole("link", { name: "Explore 205 source proofs" })).toBeVisible();
    await page.getByRole("combobox", { name: "Contribution category" }).selectOption("pr_merged");
    await page.getByRole("button", { name: "Filter contributions" }).click();
    expect(new URL(page.url()).searchParams.get("category")).toBe("pr_merged");
    await expect(page.getByRole("link", { name: "Explore 205 source proofs" })).toBeVisible();
    expect(
      (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations,
    ).toEqual([]);
  } finally {
    await api.close();
  }
});

test("activity holds new publications and preserves focused proof links and scroll during recheck, then removes suppressed work", async ({
  page,
}) => {
  const api = await service(page);
  api.activityHistory();
  try {
    await page.setViewportSize({ width: 360, height: 700 });
    await page.goto("/activity?ui=api");
    const explore = page.getByRole("link", { name: "Explore 205 source proofs" });
    await explore.scrollIntoViewIfNeeded();
    await explore.focus();
    const readingPosition = (await explore.boundingBox())!.y;
    const calls = api.calls.length;
    api.next();
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect.poll(() => api.calls.length).toBeGreaterThan(calls);
    await expect(page.getByText("Rechecking…")).toHaveCount(0);
    await expect(explore).toBeFocused();
    // Native scroll anchoring may adjust scrollY when the held-update notice grows above the feed.
    // Preserve the reader’s actual viewport position, not an obsolete document offset.
    expect(Math.abs((await explore.boundingBox())!.y - readingPosition)).toBeLessThanOrEqual(1);
    await expect(page.getByText("Update held: snapshot api-2 is available.")).toBeVisible();
    await expect(page.getByRole("checkbox", { name: /Follow while/ })).not.toBeChecked();
    const overflow = await page.evaluate(() => ({
      viewport: innerWidth,
      width: document.documentElement.scrollWidth,
      elements: [...document.querySelectorAll("main *")]
        .filter((element) => element.getBoundingClientRect().right > innerWidth + 1)
        .slice(0, 8)
        .map((element) => ({ tag: element.tagName, className: element.className })),
    }));
    expect(overflow, "activity filter controls must not widen the mobile viewport").toMatchObject({
      width: overflow.viewport,
      elements: [],
    });
    api.suppress();
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(explore).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Synthetic API B", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Synthetic API A", exact: true })).toHaveCount(0);
    expect(
      (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations,
    ).toEqual([]);
  } finally {
    await api.close();
  }
});

test("cross-repository metadata compaction keeps other work visible and supports keyboard expansion, all subgroup pages and held returns", async ({
  page,
}, testInfo) => {
  const api = await service(page);
  api.activityMetadataBurst();
  try {
    await page.setViewportSize({ width: 360, height: 700 });
    await page.goto("/activity?ui=api&limit=100");
    const groups = page.getByRole("list", { name: "Public activity groups" }).locator(":scope > li");
    await expect(groups).toHaveCount(2);
    await expect(groups.nth(0)).toContainText("205 repository groups in one UTC hour");
    await expect(groups.nth(0)).toContainText("Received public activity");
    await expect(groups.nth(1)).toContainText("Synthetic API B · Independently accepted work");
    await expect(groups.nth(0).getByRole("list", { name: "Artifact preview" }).getByRole("listitem")).toHaveCount(5);
    await expect(groups.nth(0).locator('time[datetime="2026-10-17T08:00:00.0009-04:00"]')).toBeVisible();
    await expect(groups.nth(0).locator('time[datetime="2026-10-18T12:00:00.000Z"]')).toBeVisible();
    await expect(groups.nth(0)).toContainText("Collection occurred after the action");
    expect(api.calls.some((call) => call.pathname === "/api/v1/activity-bursts")).toBe(true);
    await testInfo.attach("compact-activity-feed", {
      body: await page.getByRole("list", { name: "Public activity groups" }).screenshot(),
      contentType: "image/png",
    });

    const expand = page.getByRole("link", { name: "Explore 205 repository groups" });
    await expand.scrollIntoViewIfNeeded();
    await expand.focus();
    const position = (await expand.boundingBox())!.y;
    const calls = api.calls.length;
    api.next();
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect.poll(() => api.calls.length).toBeGreaterThan(calls);
    await expect(page.getByText("Rechecking…")).toHaveCount(0);
    await expect(page.getByText("Update held: snapshot api-2 is available.")).toBeVisible();
    await expect(expand).toBeFocused();
    expect(Math.abs((await expand.boundingBox())!.y - position)).toBeLessThanOrEqual(1);
    await expect(page.getByRole("checkbox", { name: /Follow while/ })).not.toBeChecked();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { name: "Public activity", exact: true })).toBeFocused();
    expect(new URL(page.url()).pathname).toMatch(/^\/activity\/bursts\/[a-f0-9]{64}$/);
    expect(new URL(page.url()).searchParams.get("snapshot")).toBe("api-1");
    const members = page.getByRole("list", { name: "Burst repository groups" }).locator(":scope > li");
    await expect(members).toHaveCount(100);
    const source = members.first().getByRole("link", { name: "Explore 1 source proofs" });
    const originalProofHref = await source.getAttribute("href");
    expect(new URL(originalProofHref!, page.url()).pathname).toMatch(/^\/activity\/[a-f0-9]{64}$/);
    await source.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { name: "Public activity", exact: true })).toBeFocused();
    await expect(page.getByRole("list", { name: "Grouped source proofs" }).locator(":scope > li")).toHaveCount(1);
    await expect(page.getByRole("link", { name: /^metadata-proof-/ })).toBeVisible();
    await page.goBack();
    await expect(members).toHaveCount(100);
    await expect(page.getByRole("heading", { name: "Public activity", exact: true })).toBeFocused();
    for (const count of [100, 5]) {
      await page.getByRole("link", { name: "Next repository groups page" }).focus();
      await page.keyboard.press("Enter");
      await expect(members).toHaveCount(count);
      expect(new URL(page.url()).searchParams.get("snapshot")).toBe("api-1");
    }
    await expect(page.getByRole("link", { name: "Next repository groups page" })).toHaveCount(0);
    await page.getByRole("link", { name: "Return to this snapshot’s activity" }).focus();
    await page.keyboard.press("Enter");
    await expect(expand).toBeVisible();
    await expect(page.getByRole("heading", { name: "Public activity", exact: true })).toBeFocused();
    expect(new URL(page.url()).searchParams.get("snapshot")).toBe("api-1");

    // A pre-existing bookmark uses its unchanged v1 group cursor, never the wrapper endpoint.
    const cursor = await api.legacyActivityCursor();
    const beforeLegacy = api.calls.length;
    await page.goto(`/activity?ui=api&limit=100&snapshot=api-1&cursor=${encodeURIComponent(cursor)}`);
    await expect(groups).toHaveCount(100);
    expect(
      api.calls
        .slice(beforeLegacy)
        .some((call) => call.pathname === "/api/v1/activity" && call.searchParams.get("cursor") === cursor),
    ).toBe(true);
    await page.goto("/activity?ui=api&limit=100&snapshot=api-1");
    await expect(expand).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(
      (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations,
    ).toEqual([]);
    api.suppress();
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(expand).toHaveCount(0);
    await expect(groups).toHaveCount(1);
    await expect(groups.first()).toContainText("Synthetic API B · Independently accepted work");
  } finally {
    await api.close();
  }
});

for (const moveFocusDuringRead of [false, true])
  test(
    moveFocusDuringRead
      ? "manual API snapshot application respects focus moved away during its pending read"
      : "manual API snapshot application preserves its exact keyboard control during and after the read",
    async ({ page }) => {
      await page.addInitScript(() =>
        Object.defineProperty(window, "EventSource", { value: undefined, configurable: true }),
      );
      await page.clock.install({ time: new Date(at) });
      await page.clock.pauseAt(new Date(Date.parse(at) + 1000));
      const api = await service(page);
      let release = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let requested = 0;
      await page.route("**/api/v1/boards?**", async (route) => {
        if (new URL(route.request().url()).searchParams.get("snapshot") === "api-2") {
          requested += 1;
          await gate;
        }
        await route.fallback();
      });
      try {
        await page.goto("/leaderboards/pr_merged?ui=api&repository=repo-1");
        const provenance = page.getByRole("region", { name: "Snapshot provenance" });
        await expect(provenance).toContainText("Snapshot api-1");
        await expect(page.getByRole("checkbox", { name: /Follow while/ })).not.toBeChecked();
        api.next();
        await page.evaluate(() => window.dispatchEvent(new Event("focus")));
        await expect(page.getByText("Update held: snapshot api-2 is available.")).toBeVisible();
        const apply = page.getByRole("button", { name: "Apply new snapshot" });
        const originalControl = await apply.elementHandle();
        expect(originalControl).not.toBeNull();
        await apply.focus();
        await expect(apply).toBeFocused();
        await apply.press("Enter");
        await expect.poll(() => requested).toBe(1);
        await expect(apply).toHaveAttribute("aria-disabled", "true");
        await page.keyboard.press("Enter");
        expect(requested).toBe(1);
        const recheck = page.getByRole("button", { name: "Recheck current publication controls" });
        if (moveFocusDuringRead) {
          await recheck.focus();
          await expect(recheck).toBeFocused();
        } else {
          expect(
            await originalControl!.evaluate((element) => ({
              connected: element.isConnected,
              focused: document.activeElement === element,
            })),
          ).toEqual({ connected: true, focused: true });
        }
        release();
        await expect(provenance).toContainText("Snapshot api-2");
        await expect(page.getByRole("row", { name: /Synthetic API A/ }).locator("strong")).toHaveText("10");
        if (moveFocusDuringRead) await expect(recheck).toBeFocused();
        else
          expect(
            await originalControl!.evaluate((element) => ({
              connected: element.isConnected,
              focused: document.activeElement === element,
            })),
          ).toEqual({ connected: true, focused: true });
        if (moveFocusDuringRead) await expect(apply).toHaveCount(0);
        else await expect(apply).toHaveAttribute("aria-disabled", "true");
        expect(requested).toBe(1);
        if (!moveFocusDuringRead) {
          await page.keyboard.press("Enter");
          expect(requested).toBe(1);
        }
        await expect(page.getByRole("checkbox", { name: /Follow while/ })).not.toBeChecked();
      } finally {
        release();
        await api.close();
      }
    },
  );

// These are real public-service requests with a controlled browser clock. Gates
// delay delivery to that service; they never rewrite a successful response.
async function pacedUpdatePage(page: Page) {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.addInitScript(() =>
    Object.defineProperty(window, "EventSource", { value: undefined, configurable: true }),
  );
  await page.clock.install({ time: new Date(at) });
  await page.clock.pauseAt(new Date(Date.parse(at) + 1000));
  const api = await service(page);
  try {
    await page.goto("/leaderboards/pr_merged?ui=api&repository=repo-1");
    const provenance = page.getByRole("region", { name: "Snapshot provenance" });
    await expect(provenance).toContainText("Snapshot api-1");
    await expect(page.getByRole("region", { name: "Current source freshness" })).toContainText(
      "Source freshness: Recently reconciled.",
    );
    await expect(page.getByText("Rechecking…", { exact: true })).toHaveCount(0);
    await page.evaluate(() => {
      const node = document.querySelector('.visually-hidden[role="status"]');
      if (!node) throw new Error("The polite snapshot summary region is missing.");
      const records: Array<{ text: string; at: number }> = [];
      Reflect.set(window, "syntheticSnapshotSummaryRecords", records);
      let previous = node.textContent?.trim() ?? "";
      new MutationObserver(() => {
        const text = node.textContent?.trim() ?? "";
        if (text !== previous && text) records.push({ text, at: performance.now() });
        // Clearing and then repeating the same text is another update, not a
        // duplicate that this observation helper is allowed to discard.
        previous = text;
      }).observe(node, { childList: true, subtree: true, characterData: true });
    });
    return {
      api,
      provenance,
      apply: page.getByRole("button", { name: "Apply new snapshot", exact: true }),
      follow: page.getByRole("checkbox", { name: /Follow while/ }),
      summary: page.locator('.visually-hidden[role="status"]'),
      summaries: () =>
        page.evaluate(
          () => Reflect.get(window, "syntheticSnapshotSummaryRecords") as Array<{ text: string; at: number }>,
        ),
      boardReads: (pin: string) =>
        api.calls.filter((url) => url.pathname.endsWith("/boards") && url.searchParams.get("snapshot") === pin).length,
      async refresh() {
        const before = api.calls.length;
        await page.evaluate(() => window.dispatchEvent(new Event("focus")));
        await expect.poll(() => api.calls.length).toBeGreaterThan(before);
        await expect(page.getByText("Rechecking…", { exact: true })).toHaveCount(0);
      },
    };
  } catch (error) {
    await api.close();
    throw error;
  }
}
async function holdSnapshotRead(page: Page, pin: string) {
  let release = () => {};
  let reached = () => {};
  let count = 0;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const requested = new Promise<void>((resolve) => {
    reached = resolve;
  });
  await page.route("**/api/v1/boards?**", async (route) => {
    if (new URL(route.request().url()).searchParams.get("snapshot") === pin) {
      count += 1;
      reached();
      await gate;
    }
    await route.fallback();
  });
  return { requested, release: () => release(), count: () => count };
}
const snapshotSummary = (pin: string) => "Updated to snapshot " + pin + ".";

for (const moveFocusDuringRead of [false, true])
  test(
    moveFocusDuringRead
      ? "automatic API resume preserves the Follow destination after focused Apply loses focus during the read"
      : "automatic API resume preserves the exact focused but unactivated Apply control",
    async ({ page }) => {
      const view = await pacedUpdatePage(page);
      const gate = await holdSnapshotRead(page, "api-2");
      try {
        await view.follow.check();
        await page.emulateMedia({ reducedMotion: "reduce" });
        await expect(view.follow).toBeDisabled();
        view.api.next();
        await view.refresh();
        await expect(page.getByText("Update held: snapshot api-2 is available.")).toBeVisible();
        await view.apply.focus();
        const original = await view.apply.elementHandle();
        if (!original) throw new Error("The focused Apply control is missing.");
        await page.emulateMedia({ reducedMotion: "no-preference" });
        await gate.requested;
        await expect(view.apply).toHaveAttribute("aria-disabled", "true");
        expect(await original.evaluate((node) => node.isConnected && document.activeElement === node)).toBe(true);
        await expect(view.summary).toBeEmpty();
        await expect(page.getByText("Loading current public data…", { exact: true })).toBeVisible();
        await expect(page.getByRole("status")).toHaveCount(1);
        await page.keyboard.press("Enter");
        expect(gate.count()).toBe(1);
        const destination = await view.follow.elementHandle();
        if (!destination) throw new Error("The Follow destination is missing.");
        if (moveFocusDuringRead) {
          await page.keyboard.press("Tab");
          await expect(view.follow).toBeFocused();
          await expect(view.apply).toHaveCount(0);
        }
        gate.release();
        await expect(view.provenance).toContainText("Snapshot api-2");
        await expect(page.getByRole("row", { name: /Synthetic API A/ }).locator("strong")).toHaveText("10");
        await expect(view.summary).toHaveText(snapshotSummary("api-2"));
        await expect
          .poll(async () => (await view.summaries()).map((entry) => entry.text))
          .toEqual([snapshotSummary("api-2")]);
        await expect(view.follow).toBeChecked();
        expect(gate.count()).toBe(1);
        if (moveFocusDuringRead) {
          expect(await destination.evaluate((node) => node.isConnected && document.activeElement === node)).toBe(true);
          await expect(view.apply).toHaveCount(0);
        } else {
          expect(await original.evaluate((node) => node.isConnected && document.activeElement === node)).toBe(true);
          await page.keyboard.press("Tab");
          await expect(view.follow).toBeFocused();
          await expect(view.apply).toHaveCount(0);
        }
      } finally {
        gate.release();
        await view.api.close();
      }
    },
  );

test("automatic API batches coalesce only unstarted heads and give each applied snapshot one spaced summary", async ({
  page,
}) => {
  const view = await pacedUpdatePage(page);
  const second = await holdSnapshotRead(page, "api-2");
  const fourth = await holdSnapshotRead(page, "api-4");
  try {
    await view.follow.check();
    view.api.next();
    await view.refresh();
    await second.requested;
    view.api.next(3);
    second.release();
    await expect(view.provenance).toContainText("Snapshot api-2");
    await expect
      .poll(async () => (await view.summaries()).map((entry) => entry.text))
      .toEqual([snapshotSummary("api-2")]);
    expect(view.boardReads("api-3")).toBe(0);
    view.api.next(4);
    await view.refresh();
    await expect(page.getByText("Update held: snapshot api-4 is available.")).toBeVisible();
    await page.clock.runFor(999);
    await expect(view.provenance).toContainText("Snapshot api-2");
    await expect(page.getByRole("row", { name: /Synthetic API A/ }).locator("strong")).toHaveText("10");
    expect(view.boardReads("api-3")).toBe(0);
    expect(fourth.count()).toBe(0);
    await page.clock.runFor(1);
    await fourth.requested;
    fourth.release();
    await expect(view.provenance).toContainText("Snapshot api-4");
    await expect(page.getByRole("row", { name: /Synthetic API A/ }).locator("strong")).toHaveText("30");
    await expect
      .poll(async () => (await view.summaries()).map((entry) => entry.text))
      .toEqual([snapshotSummary("api-2"), snapshotSummary("api-4")]);
    const summaries = await view.summaries();
    expect(summaries[1]!.at - summaries[0]!.at).toBeGreaterThanOrEqual(1000);
    expect(view.boardReads("api-3")).toBe(0);
    expect(fourth.count()).toBe(1);
    const currentReads = view.boardReads("api-4");
    await view.refresh();
    expect(view.boardReads("api-4")).toBeGreaterThan(currentReads);
    expect((await view.summaries()).map((entry) => entry.text)).toEqual([
      snapshotSummary("api-2"),
      snapshotSummary("api-4"),
    ]);
  } finally {
    second.release();
    fourth.release();
    await view.api.close();
  }
});

test("a slow API batch starts the next announcement interval only after its matching ready result", async ({
  page,
}) => {
  const view = await pacedUpdatePage(page);
  const second = await holdSnapshotRead(page, "api-2");
  const third = await holdSnapshotRead(page, "api-3");
  try {
    await view.follow.check();
    view.api.next();
    await view.refresh();
    await second.requested;
    view.api.next(3);
    await page.clock.runFor(1500);
    expect(third.count()).toBe(0);
    expect(await view.summaries()).toEqual([]);
    second.release();
    await expect(view.provenance).toContainText("Snapshot api-2");
    await expect
      .poll(async () => (await view.summaries()).map((entry) => entry.text))
      .toEqual([snapshotSummary("api-2")]);
    await page.clock.runFor(999);
    expect(third.count()).toBe(0);
    await expect(view.provenance).toContainText("Snapshot api-2");
    await page.clock.runFor(1);
    await third.requested;
    third.release();
    await expect(view.provenance).toContainText("Snapshot api-3");
    await expect
      .poll(async () => (await view.summaries()).map((entry) => entry.text))
      .toEqual([snapshotSummary("api-2"), snapshotSummary("api-3")]);
    const summaries = await view.summaries();
    expect(summaries[1]!.at - summaries[0]!.at).toBeGreaterThanOrEqual(1000);
    expect(second.count()).toBe(1);
    expect(third.count()).toBe(1);
  } finally {
    second.release();
    third.release();
    await view.api.close();
  }
});

test("manual API cooldown is visible, guards activation without queuing, and applies the exact eligible target", async ({
  page,
}) => {
  const view = await pacedUpdatePage(page);
  const fourth = await holdSnapshotRead(page, "api-4");
  try {
    view.api.next();
    await view.refresh();
    await view.apply.focus();
    await page.keyboard.press("Enter");
    await expect(view.provenance).toContainText("Snapshot api-2");
    await expect
      .poll(async () => (await view.summaries()).map((entry) => entry.text))
      .toEqual([snapshotSummary("api-2")]);
    view.api.next(3);
    await view.refresh();
    await expect(view.apply).toHaveAttribute("aria-disabled", "true");
    await expect(
      page.getByText("Another snapshot is available. Apply will be ready shortly;", { exact: false }),
    ).toBeVisible();
    await page.keyboard.press("Enter");
    expect(view.boardReads("api-3")).toBe(0);
    view.api.next(4);
    await view.refresh();
    await page.clock.runFor(999);
    await expect(view.apply).toHaveAttribute("aria-disabled", "true");
    expect(fourth.count()).toBe(0);
    await page.keyboard.press("Enter");
    expect(fourth.count()).toBe(0);
    await page.clock.runFor(1);
    await expect(view.apply).toHaveAttribute("aria-disabled", "false");
    await expect(view.follow).not.toBeChecked();
    expect(fourth.count()).toBe(0);
    await page.keyboard.press("Enter");
    await fourth.requested;
    view.api.next(5);
    fourth.release();
    await expect(view.provenance).toContainText("Snapshot api-4");
    await expect(page.getByRole("row", { name: /Synthetic API A/ }).locator("strong")).toHaveText("30");
    await expect
      .poll(async () => (await view.summaries()).map((entry) => entry.text))
      .toEqual([snapshotSummary("api-2"), snapshotSummary("api-4")]);
    await expect(page.getByText("Update held: snapshot api-5 is available.")).toBeVisible();
    expect(view.boardReads("api-3")).toBe(0);
    expect(view.boardReads("api-5")).toBe(0);
    expect(fourth.count()).toBe(1);
    const summaries = await view.summaries();
    expect(summaries[1]!.at - summaries[0]!.at).toBeGreaterThanOrEqual(1000);
  } finally {
    fourth.release();
    await view.api.close();
  }
});

test("source invalidation cancels an API application and applies current suppression before any pacing delay", async ({
  page,
}) => {
  const view = await pacedUpdatePage(page);
  const second = await holdSnapshotRead(page, "api-2");
  try {
    view.api.next();
    await view.refresh();
    await view.apply.focus();
    await page.keyboard.press("Enter");
    await second.requested;
    view.api.next(3);
    view.api.suppress();
    const before = await page.evaluate(() => performance.now());
    await view.refresh();
    await expect(view.provenance).toContainText("Snapshot api-1");
    await expect(view.provenance).toContainText("privacy-2");
    await expect(page.getByRole("link", { name: "Synthetic API A", exact: true })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Synthetic API B", exact: true })).toBeVisible();
    expect(await page.evaluate(() => performance.now())).toBe(before);
    second.release();
    await page.clock.runFor(1000);
    await expect(view.provenance).toContainText("Snapshot api-1");
    expect(await view.summaries()).toEqual([]);
    expect(second.count()).toBe(1);
    await expect(page.getByText("Update held: snapshot api-3 is available.")).toBeVisible();
    await view.apply.focus();
    await page.keyboard.press("Enter");
    await expect(view.provenance).toContainText("Snapshot api-3");
    await expect
      .poll(async () => (await view.summaries()).map((entry) => entry.text))
      .toEqual([snapshotSummary("api-3")]);
    await expect(page.getByRole("link", { name: "Synthetic API A", exact: true })).toHaveCount(0);
  } finally {
    second.release();
    await view.api.close();
  }
});

test("a failed API application remains an error until explicit recovery and never silently reads the old pin", async ({
  page,
}) => {
  const view = await pacedUpdatePage(page);
  const second = await holdSnapshotRead(page, "api-2");
  try {
    view.api.next();
    await view.refresh();
    const oldReads = view.boardReads("api-1");
    await view.apply.focus();
    await page.keyboard.press("Enter");
    await second.requested;
    view.api.fail();
    second.release();
    await expect(page.getByRole("alert")).toContainText("public_projection_unavailable");
    await expect(view.provenance).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Synthetic API A", exact: true })).toHaveCount(0);
    expect(await view.summaries()).toEqual([]);
    expect(view.boardReads("api-1")).toBe(oldReads);
    await page.clock.runFor(1000);
    await expect(page.getByRole("alert")).toContainText("public_projection_unavailable");
    expect(view.boardReads("api-1")).toBe(oldReads);
    view.api.recover();
    view.api.next(3);
    await page.getByRole("button", { name: "Retry this selection", exact: true }).click();
    await expect(view.provenance).toContainText("Snapshot api-1");
    await expect(page.getByText("Update held: snapshot api-3 is available.")).toBeVisible();
    expect(second.count()).toBe(1);
    expect(await view.summaries()).toEqual([]);
    await view.apply.focus();
    await page.keyboard.press("Enter");
    await expect(view.provenance).toContainText("Snapshot api-3");
    await expect
      .poll(async () => (await view.summaries()).map((entry) => entry.text))
      .toEqual([snapshotSummary("api-3")]);
  } finally {
    second.release();
    await view.api.close();
  }
});

for (const cancel of ["navigation", "hidden"] as const)
  test(
    "an in-flight API application is discarded on " + cancel + " without replaying its target or summary",
    async ({ page }) => {
      const view = await pacedUpdatePage(page);
      const second = await holdSnapshotRead(page, "api-2");
      try {
        view.api.next();
        await view.refresh();
        await view.apply.focus();
        await page.keyboard.press("Enter");
        await second.requested;
        if (cancel === "navigation") {
          await page
            .getByRole("navigation", { name: "Primary" })
            .getByRole("link", { name: "Methodology", exact: true })
            .click();
          await expect(page).toHaveURL(/\/methodology(?:\?|$)/);
        } else {
          await page.evaluate(() => {
            Object.defineProperty(document, "hidden", { value: true, configurable: true });
            Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
            document.dispatchEvent(new Event("visibilitychange"));
          });
          await expect(view.provenance).toHaveCount(0);
        }
        const oldReads = view.boardReads("api-1");
        second.release();
        await page.clock.runFor(1000);
        expect(await view.summaries()).toEqual([]);
        expect(second.count()).toBe(1);
        if (cancel === "navigation") {
          await expect(page).toHaveURL(/\/methodology(?:\?|$)/);
          await expect(page.getByRole("link", { name: "Synthetic API A", exact: true })).toHaveCount(0);
        } else {
          expect(view.boardReads("api-1")).toBe(oldReads);
          view.api.next(3);
          await page.evaluate(() => {
            Reflect.deleteProperty(document, "hidden");
            Reflect.deleteProperty(document, "visibilityState");
            document.dispatchEvent(new Event("visibilitychange"));
          });
          await expect(view.provenance).toContainText("Snapshot api-1");
          await expect(page.getByText("Update held: snapshot api-3 is available.")).toBeVisible();
          await expect(view.follow).not.toBeChecked();
          expect(second.count()).toBe(1);
          expect(await view.summaries()).toEqual([]);
        }
      } finally {
        second.release();
        await view.api.close();
      }
    },
  );
