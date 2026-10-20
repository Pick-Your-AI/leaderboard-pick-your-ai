import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { metricRegistryV1 } from "@pick-your-ai/metrics";
import type { PublicScope } from "@pick-your-ai/contracts";

test.use({ storageState: { cookies: [], origins: [] } });
const at = "2026-10-18T21:00:00.000Z";
const pin = "accepted-overview-snapshot";
type WorkState = "observed" | "pending" | "accepted" | "unknown";
const mixed: WorkState[] = ["observed", "accepted", "pending", "accepted", "unknown", "accepted", "accepted"];

// Synthetic provider inputs pass through the actual service projection and
// activity grouping before reaching the browser. Only explicit failure controls
// below replace the status or metadata of an otherwise real service response.
async function service(page: Page, states = mixed, unknownLastAction = false) {
  const actors = states.map((_, index) => ({
    actorId: `overview-actor-${index}`,
    state: "public",
    actor: {
      schemaVersion: "leaderboard/v1",
      identityState: "resolved",
      githubNodeId: `synthetic-overview-node-${index}`,
      login: `synthetic-overview-${index}`,
      displayName: `Synthetic contributor ${index}`,
      kind: "user",
      executionMode: "unknown",
    },
  }));
  const portfolioEvidence = states.map((activityState, index) => ({
    artifact: {
      schemaVersion: "leaderboard/v1",
      source: "github",
      kind: "pull_request",
      stableId: `overview-artifact-${index}`,
      repositoryId: "overview-repository",
      publicUrl: `https://github.com/synthetic-overview/example/pull/${index + 1}`,
      visibility: "public",
    },
    contribution: {
      schemaVersion: "leaderboard/v1",
      contributionId: `overview-proof-${index}`,
      canonicalEventId: `overview-event-${index}`,
      artifactId: `overview-artifact-${index}`,
      actorId: actors[index]!.actorId,
      roles: ["author"],
      qualification: "eligible",
      metricIds: ["pr_opened"],
      reasonCodes: ["synthetic_public_work"],
    },
    occurredAt:
      unknownLastAction && index === states.length - 1
        ? null
        : new Date(Date.parse(at) - (index + 1) * 60_000).toISOString(),
    observedAt: at,
    activityState,
    sourceRevision: "synthetic-overview-revision",
    sourceRevisionUrl: "https://github.com/synthetic-overview/example/commit/abcdef",
  }));
  let suppressed = false;
  const { createService } = await import(new URL("../../service/dist/app.js", import.meta.url).href);
  const app = createService({
    now: () => Date.parse(at),
    cursorSecret: "synthetic-overview-cursor-secret-0001",
    source: {
      async read(scope: PublicScope, snapshot: string | null) {
        if (snapshot !== null && snapshot !== pin) return null;
        return {
          head: { snapshotId: pin, revision: 1, publishedAt: at },
          controls: {
            version: suppressed ? "overview-controls-2" : "overview-controls-1",
            suppressedActorIds: suppressed ? actors.map((actor) => actor.actorId) : [],
            suppressedArtifactIds: [],
            revokedSnapshotIds: [],
          },
          selected: {
            approvedPublic: true,
            scope: { ...scope },
            actors,
            rows: [],
            evidence: [],
            portfolioEvidence,
            ranking: [{ metricId: "pr_opened", direction: "descending", rank: false }],
            snapshot: {
              schemaVersion: "leaderboard/v1",
              snapshotId: pin,
              revision: 1,
              generatedAt: at,
              metricDefinitionVersion: metricRegistryV1.policy_version,
              computationVersion: "synthetic-overview-browser-only",
              coverage: [],
              results: [],
            },
          },
        };
      },
    },
  });
  const proof = await app.inject(`/api/v1/activity?snapshot=${pin}&limit=20`);
  expect(proof.statusCode, proof.body).toBe(200);
  expect(proof.json().totalGroups).toBe(states.length);
  const calls: URL[] = [];
  const canceled: URL[] = [];
  page.on("requestfailed", (request) => {
    if (request.url().includes("/api/v1/activity")) canceled.push(new URL(request.url()));
  });
  const gates = new Map<string, { promise: Promise<void>; release: () => void }>();
  let activityFailure = false;
  let changedMetadata: Record<string, unknown> | null = null;
  await page.route("**/api/v1/**", async (route) => {
    const url = new URL(route.request().url());
    calls.push(url);
    const response = await app.inject({ method: "GET", url: url.pathname + url.search });
    const gate = gates.get(url.pathname);
    if (gate) await gate.promise;
    if (url.pathname === "/api/v1/activity" && activityFailure) {
      await route.fulfill({ status: 503, contentType: "application/json", body: '{"code":"public_read_unavailable"}' });
    } else if (url.pathname === "/api/v1/activity" && changedMetadata) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ...response.json(), ...changedMetadata }),
      });
    } else await route.fulfill({ status: response.statusCode, headers: response.headers, body: response.body });
  });
  return {
    calls,
    canceled,
    activityCalls: () => calls.filter((url) => url.pathname === "/api/v1/activity"),
    hold(path = "/api/v1/activity") {
      let release = () => {};
      const promise = new Promise<void>((resolve) => {
        release = resolve;
      });
      gates.set(path, { promise, release });
    },
    release(path = "/api/v1/activity") {
      gates.get(path)?.release();
      gates.delete(path);
    },
    failActivity() {
      activityFailure = true;
    },
    changeMetadata(value: Record<string, unknown>) {
      changedMetadata = value;
    },
    suppressActors() {
      suppressed = true;
    },
    async close() {
      for (const gate of gates.values()) gate.release();
      await page.unrouteAll({ behavior: "wait" });
      await app.close();
    },
  };
}

const preview = (page: Page) => page.getByRole("region", { name: "Recent accepted work", exact: true });
const recheck = (page: Page) => page.getByRole("button", { name: "Recheck current publication controls", exact: true });

test("overview previews at most three explicitly accepted groups in the service action order", async ({ page }) => {
  const api = await service(page);
  try {
    await page.goto(`/?ui=api&snapshot=${pin}`);
    const section = preview(page);
    await expect(section).toBeVisible();
    await expect(section.getByRole("heading", { level: 3 })).toHaveText([
      "Synthetic contributor 1",
      "Synthetic contributor 3",
      "Synthetic contributor 5",
    ]);
    await expect(section.getByText(/Synthetic contributor [0246]/)).toHaveCount(0);
    await expect(section).toContainText("first 20 public activity groups");
    await expect(section).toContainText("not a complete accepted-work count");
    expect(api.activityCalls()).toHaveLength(1);
    expect(api.activityCalls()[0]!.searchParams.get("limit")).toBe("20");
    expect(api.activityCalls()[0]!.searchParams.get("snapshot")).toBe(pin);
  } finally {
    await api.close();
  }
});

test("an accepted group beyond the first page does not become a fabricated zero or trigger a scan", async ({
  page,
}) => {
  const states: WorkState[] = [...Array<WorkState>(20).fill("observed"), "accepted"];
  const api = await service(page, states);
  try {
    await page.goto(`/?ui=api&snapshot=${pin}`);
    const section = preview(page);
    await expect(section).toContainText("No independently accepted groups appear in this first page.");
    await expect(section).toContainText("does not establish zero accepted work");
    await expect(section.getByRole("heading", { level: 3 })).toHaveCount(0);
    await expect(section.getByRole("link", { name: "Explore all public activity in this scope" })).toBeVisible();
    expect(api.activityCalls()).toHaveLength(1);
    expect(api.activityCalls()[0]!.searchParams.has("cursor")).toBe(false);
  } finally {
    await api.close();
  }
});

test("preview request and copied proof links share the stabilized pin and full scope with list filters cleared", async ({
  page,
}) => {
  const api = await service(page);
  const scope = {
    organization: "Pick-Your-AI",
    repository: "overview-repository",
    workstream: "T6",
    context: "current",
    project: "PVT_A,PVT_B=",
    role: "author,reviewer",
    actors: "user",
    start: "2026-10-18T00:00:00.000Z",
    end: "2026-10-19T00:00:00.000Z",
  };
  try {
    // A newer publication head does not invalidate the exact historical selection.
    api.changeMetadata({ head: { snapshotId: "newer-overview-head", revision: 2, publishedAt: at } });
    await page.goto(
      `/?${new URLSearchParams({ ...scope, ui: "api", tz: "America/New_York", limit: "37", category: "review", search: "unrelated", cursor: "AA.BB" })}`,
    );
    const section = preview(page);
    await expect(section.getByRole("heading", { level: 3 })).toHaveCount(3);
    const calls = api.activityCalls();
    expect(calls).toHaveLength(1);
    for (const [key, value] of Object.entries(scope)) expect(calls[0]!.searchParams.get(key)).toBe(value);
    expect(calls[0]!.searchParams.get("snapshot")).toBe(pin);
    expect(calls[0]!.searchParams.get("limit")).toBe("20");
    for (const key of ["cursor", "category", "search", "department", "q"])
      expect(calls[0]!.searchParams.has(key)).toBe(false);
    for (const href of await section
      .getByRole("link")
      .evaluateAll((links) => links.map((link) => (link as HTMLAnchorElement).href))) {
      const url = new URL(href);
      for (const [key, value] of Object.entries(scope)) expect(url.searchParams.get(key)).toBe(value);
      expect(url.searchParams.get("snapshot")).toBe(pin);
      expect(url.searchParams.get("tz")).toBe("America/New_York");
      for (const key of ["cursor", "category", "search", "department", "q"])
        expect(url.searchParams.has(key)).toBe(false);
    }
    const proofs = section.getByRole("link", { name: "View group proofs", exact: true }).first();
    await proofs.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("list", { name: "Grouped source proofs", exact: true })).toBeVisible();
    const copied = page.url();
    await page.reload();
    await expect(page.getByRole("list", { name: "Grouped source proofs", exact: true })).toBeVisible();
    expect(page.url()).toBe(copied);
  } finally {
    await api.close();
  }
});

test("rechecking clears prior contributor groups immediately while delayed or failed activity preserves useful health", async ({
  page,
}) => {
  const api = await service(page);
  try {
    await page.goto(`/?ui=api&snapshot=${pin}`);
    await expect(preview(page).getByRole("heading", { level: 3 })).toHaveCount(3);
    api.hold("/api/v1/health");
    api.hold();
    await recheck(page).click();
    await expect(preview(page).getByRole("status")).toContainText("Checking recent accepted work");
    await expect(preview(page).getByRole("heading", { level: 3 })).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Explore contribution departments" })).toBeVisible();
    api.release("/api/v1/health");
    await expect.poll(() => api.activityCalls().length).toBe(2);
    await expect(preview(page).getByRole("status")).toContainText("Checking recent accepted work");
    await expect(page.getByRole("region", { name: "Explore contribution departments" })).toBeVisible();
    api.failActivity();
    api.release();
    await expect(preview(page).getByRole("status")).toContainText("Recent accepted work is unavailable");
    await expect(preview(page).getByRole("heading", { level: 3 })).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Explore contribution departments" })).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(0);
  } finally {
    await api.close();
  }
});

test("a superseded activity response cannot restore contributors after current privacy controls suppress them", async ({
  page,
}) => {
  const api = await service(page);
  api.hold();
  try {
    await page.goto(`/?ui=api&snapshot=${pin}`);
    await expect.poll(() => api.activityCalls().length).toBe(1);
    await expect(page.getByRole("region", { name: "Explore contribution departments" })).toBeVisible();
    api.suppressActors();
    await recheck(page).click();
    await expect.poll(() => api.activityCalls().length).toBe(2);
    await expect.poll(() => api.canceled.length).toBe(1);
    api.release();
    await expect(preview(page)).toContainText("No independently accepted groups appear in this first page.");
    await expect(page.getByText(/Synthetic contributor/)).toHaveCount(0);
  } finally {
    await api.close();
  }
});

test("navigation aborts the outstanding overview activity read before entering the catalog", async ({ page }) => {
  const api = await service(page);
  api.hold();
  try {
    await page.goto(`/?ui=api&snapshot=${pin}`);
    await expect.poll(() => api.activityCalls().length).toBe(1);
    await page.getByRole("link", { name: "All metric definitions", exact: true }).click();
    await expect(page.getByRole("region", { name: "Metric discovery", exact: true })).toBeVisible();
    await expect.poll(() => api.canceled.length).toBe(1);
    const boundary = api.calls.length;
    api.release();
    await expect(preview(page)).toHaveCount(0);
    await expect(page.getByText(/Synthetic contributor/)).toHaveCount(0);
    await page.getByRole("combobox", { name: "Department", exact: true }).selectOption("research");
    expect(api.activityCalls()).toHaveLength(1);
    expect(api.calls.slice(boundary).every((url) => url.pathname === "/api/v1/metrics")).toBe(true);
  } finally {
    await api.close();
  }
});

test("hiding the page retires delayed contributor data and resuming checks current privacy controls", async ({
  page,
}) => {
  const api = await service(page);
  try {
    await page.goto(`/?ui=api&snapshot=${pin}`);
    await expect(preview(page).getByRole("heading", { level: 3 })).toHaveCount(3);
    api.hold();
    await recheck(page).click();
    await expect.poll(() => api.activityCalls().length).toBe(2);
    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", { value: true, configurable: true });
      Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect(preview(page)).toHaveCount(0);
    await expect.poll(() => api.canceled.length).toBe(1);
    api.suppressActors();
    api.release();
    await expect(page.getByText(/Synthetic contributor/)).toHaveCount(0);
    await page.evaluate(() => {
      Reflect.deleteProperty(document, "hidden");
      Reflect.deleteProperty(document, "visibilityState");
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect(preview(page)).toContainText("No independently accepted groups appear in this first page.");
    await expect(page.getByText(/Synthetic contributor/)).toHaveCount(0);
  } finally {
    await api.close();
  }
});

test("an initially hidden overview defers contributor activity until the page becomes visible", async ({ page }) => {
  const api = await service(page);
  await page.addInitScript(() => {
    Object.defineProperty(document, "hidden", { value: true, configurable: true });
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
  });
  try {
    await page.goto(`/?ui=api&snapshot=${pin}`);
    await expect(page.getByRole("region", { name: "Explore contribution departments" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Snapshot provenance" })).toHaveCount(0);
    expect(api.activityCalls()).toHaveLength(0);
    await expect(page.getByText(/Synthetic contributor/)).toHaveCount(0);
    await page.evaluate(() => {
      Reflect.deleteProperty(document, "hidden");
      Reflect.deleteProperty(document, "visibilityState");
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect(preview(page).getByRole("heading", { level: 3 })).toHaveCount(3);
    expect(api.activityCalls()).toHaveLength(1);
  } finally {
    await api.close();
  }
});

for (const [field, value] of Object.entries({
  snapshotId: "different-pin",
  revision: 2,
  generatedAt: "2026-10-18T20:00:00.000Z",
  metricDefinitionVersion: "different-definition",
  computationVersion: "different-computation",
  policyVersion: "different-controls",
})) {
  test(`activity with mismatched ${field} cannot accompany the displayed health selection`, async ({ page }) => {
    const api = await service(page);
    api.changeMetadata({ [field]: value });
    try {
      await page.goto(`/?ui=api&snapshot=${pin}`);
      await expect(preview(page).getByRole("status")).toContainText("Recent accepted work is unavailable");
      await expect(page.getByRole("region", { name: "Explore contribution departments" })).toBeVisible();
      await expect(page.getByText(/Synthetic contributor/)).toHaveCount(0);
      await expect(page.getByRole("alert")).toHaveCount(0);
    } finally {
      await api.close();
    }
  });
}

test("unknown action dates stay unknown in a keyboard-accessible 320px accepted-work preview", async ({
  page,
}, testInfo) => {
  const api = await service(page, ["accepted", "accepted", "accepted"], true);
  try {
    await page.setViewportSize({ width: 320, height: 900 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(`/?ui=api&snapshot=${pin}`);
    const section = preview(page);
    await expect(section.getByRole("heading", { level: 3 })).toHaveCount(3);
    await expect(section).toContainText("Latest source action: Unknown; no action date is inferred");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    expect(
      (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations,
    ).toEqual([]);
    await section.screenshot({ path: testInfo.outputPath("accepted-work-320px.png") });
    const activity = section.getByRole("link", { name: "Explore all public activity in this scope", exact: true });
    await activity.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("list", { name: "Public activity groups", exact: true })).toBeVisible();
  } finally {
    await api.close();
  }
});
