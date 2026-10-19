import { test as base, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { build } from "vite";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// Build the actual application with explicit public-controls configuration.
// The ordinary deployment's absent configuration must not silently skip the
// positive homepage checks or auto-enable a controls endpoint in production.
const test = base.extend<{}, { configuredApp: string }>({
  configuredApp: [
    async ({}, use) => {
      const directory = await mkdtemp(join(tmpdir(), "lb-discovery-"));
      try {
        await build({
          root: fileURLToPath(new URL("..", import.meta.url)),
          define: { "import.meta.env.VITE_PUBLIC_CONTROLS_BASE": JSON.stringify("/controls") },
          build: { outDir: directory, emptyOutDir: true },
          logLevel: "error",
        });
        await use(directory);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
    { scope: "worker" },
  ],
});
test.use({ storageState: { cookies: [], origins: [] } });
const at = "2026-10-18T12:00:00.000Z";
const pin = "synthetic-history-selected";
const owners = { "research-new": "101", community: "102", "research-old": "103" } as const;

async function fixture(page: Page, directory: string) {
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== new URL(test.info().project.use.baseURL!).origin) return route.fallback();
    const candidate = resolve(directory, "." + url.pathname);
    if (candidate !== directory && !candidate.startsWith(directory + sep)) return route.fallback();
    const file = await stat(candidate)
      .then((entry) => (entry.isFile() ? candidate : null))
      .catch(() => null);
    const target = file ?? join(directory, "index.html");
    const types: Record<string, string> = {
      ".html": "text/html",
      ".js": "text/javascript",
      ".css": "text/css",
      ".svg": "image/svg+xml",
      ".woff2": "font/woff2",
    };
    await route.fulfill({
      contentType: types[extname(target)] ?? "application/octet-stream",
      body: await readFile(target),
    });
  });
  const { createService } = await import(new URL("../../service/dist/app.js", import.meta.url).href);
  const { participationHistorySource } = await import(
    new URL("../../../tests/fixtures/participation-history.mjs", import.meta.url).href
  );
  const history = participationHistorySource();
  // This fixture deliberately has no trusted history capability. The directory
  // and real profile must preserve that unknown state after the entry is used.
  const app = createService({ source: { read: history.source.read } });
  const apiCalls: URL[] = [];
  let healthFailure = false;
  await page.route("**/api/v1/**", async (route) => {
    const url = new URL(route.request().url());
    apiCalls.push(url);
    if (healthFailure && url.pathname.endsWith("/health"))
      return route.fulfill({
        status: 503,
        contentType: "application/json",
        body: '{"code":"public_read_unavailable"}',
      });
    const response = await app.inject({ method: "GET", url: url.pathname + url.search });
    await route.fulfill({ status: response.statusCode, headers: response.headers, body: response.body });
  });
  const { projectSpotlights } = await import(new URL("../../controls/src/editorial.mjs", import.meta.url).href);
  const { attachSyntheticEvidenceIntake } = await import(
    new URL("../../../tests/fixtures/evidence-intake.mjs", import.meta.url).href
  );
  // Synthetic independently accepted/opted-in records bind current intake and
  // source-use review before the actual controls projection. This direct
  // projection is not a controls HTTP acceptance test.
  const state: any = { requests: {}, profiles: {}, spotlights: {} };
  const policyVersion = "synthetic-discovery-v1";
  for (const [id, category, offset] of [
    ["research-new", "Research", 2],
    ["community", "Community", 1],
    ["research-old", "Research", 0],
  ] as const) {
    const owner = owners[id];
    state.requests[id] = attachSyntheticEvidenceIntake({
      id,
      owner,
      kind: "evidence",
      status: "accepted",
      version: 1,
      locator: `https://github.com/synthetic-discovery/example/issues/${offset + 1}`,
      category,
      scope: `Synthetic independently reviewed ${id} claim.`,
      collaborators: {},
      policyVersion,
      history: [{ actor: "104", action: "accepted", at: Date.parse(at) + offset, version: 1, policyVersion }],
    });
    state.profiles[owner] = { public: true, suppressed: false, bio: `Consented synthetic bio ${id}` };
    state.spotlights[id] = {
      id,
      owner,
      claimId: id,
      claimVersion: 1,
      status: "accepted",
      history: [{ at: Date.parse(at) + offset, publicExplanation: `Reviewed explanation ${id}` }],
    };
  }
  let controlsFailure = false;
  let controlsCalls = 0;
  let gate: { wait: Promise<void>; release: () => void } | null = null;
  await page.route("**/controls/spotlights", async (route) => {
    controlsCalls++;
    const result = projectSpotlights(state, () => true);
    const pending = gate;
    if (pending) await pending.wait;
    await route.fulfill(
      controlsFailure ? { status: 503, contentType: "application/json", body: "{}" } : { json: result },
    );
  });
  return {
    state,
    apiCalls,
    controlsCalls: () => controlsCalls,
    failControls: () => {
      controlsFailure = true;
    },
    failHealth: () => {
      healthFailure = true;
    },
    hold: () => {
      let release!: () => void;
      const wait = new Promise<void>((done) => {
        release = done;
      });
      gate = { wait, release };
      return gate;
    },
    close: async () => {
      gate?.release();
      await page.unrouteAll({ behavior: "wait" });
      await app.close();
    },
  };
}
const spotlights = (page: Page) => page.getByRole("region", { name: "Editorial spotlights", exact: true });
const entry = (page: Page) => page.getByRole("region", { name: "First contributions", exact: true });

test("configured organization homepage rotates approved server order only by reader input", async ({
  page,
  configuredApp,
}) => {
  const api = await fixture(page, configuredApp);
  try {
    await page.clock.install();
    await page.goto("/?ui=api");
    const section = spotlights(page);
    await expect(section.getByText("Reviewed explanation community", { exact: true })).toBeVisible();
    await expect(section.getByRole("article")).toHaveCount(1);
    await expect(section).toContainText("Spotlight 1 of 3");
    await section.getByRole("button", { name: "Next spotlight", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(section).toContainText("Reviewed explanation research-old");
    await expect(section.getByRole("button", { name: "Next spotlight", exact: true })).toBeFocused();
    await page.keyboard.press("Space");
    await expect(section).toContainText("Reviewed explanation research-new");
    await page.keyboard.press("Enter");
    await expect(section).toContainText("Reviewed explanation community");
    await section.getByRole("button", { name: "Previous spotlight", exact: true }).click();
    await expect(section).toContainText("Spotlight 3 of 3");
    await expect(section.getByRole("link", { name: "Reviewed public evidence" })).toHaveAttribute(
      "href",
      "https://github.com/synthetic-discovery/example/issues/3",
    );
    const calls = api.controlsCalls();
    await page.clock.fastForward(30_001);
    await expect.poll(api.controlsCalls).toBeGreaterThan(calls);
    await expect(section).toContainText("Reviewed explanation research-new");
    expect(api.apiCalls.some((url) => /\/contributors(?:\/|$)/.test(url.pathname))).toBe(false);
  } finally {
    await api.close();
  }
});

test("same-item refresh preserves proof focus and a removed approved item moves focus to the current heading", async ({
  page,
  configuredApp,
}) => {
  const api = await fixture(page, configuredApp);
  try {
    await page.clock.install();
    await page.goto("/?ui=api");
    const section = spotlights(page);
    const source = section.getByRole("link", { name: "Reviewed public evidence" });
    await source.focus();
    const before = api.controlsCalls();
    await page.clock.fastForward(30_001);
    await expect.poll(api.controlsCalls).toBeGreaterThan(before);
    await expect(source).toBeFocused();
    api.state.profiles[owners.community].suppressed = true;
    await page.clock.fastForward(30_001);
    await expect(section.getByText("Reviewed explanation community", { exact: true })).toHaveCount(0);
    await expect(section.getByRole("heading", { name: "Research", exact: true })).toBeFocused();
    await expect(section).toContainText("Spotlight 1 of 2");
    api.failControls();
    await page.clock.fastForward(30_001);
    await expect(section).toContainText("Editorial selections are unavailable for this view.");
    await expect(section.getByRole("article")).toHaveCount(0);
    await expect(section.getByRole("group", { name: "Editorial spotlight controls", exact: true })).toHaveCount(0);
    await expect(section.getByRole("button", { name: "Previous spotlight", exact: true })).toHaveCount(0);
    await expect(section.getByRole("button", { name: "Next spotlight", exact: true })).toHaveCount(0);
    await expect(section.getByRole("button", { name: "Explore editorial dimensions", exact: true })).toBeEnabled();
    await expect(section.getByRole("button")).toHaveCount(1);
  } finally {
    await api.close();
  }
});

test("single and empty current projections keep explicit availability and disable meaningless rotation", async ({
  page,
  configuredApp,
}) => {
  const api = await fixture(page, configuredApp);
  try {
    api.state.profiles[owners["research-old"]].suppressed = true;
    api.state.profiles[owners["research-new"]].suppressed = true;
    await page.clock.install();
    await page.goto("/?ui=api");
    const section = spotlights(page);
    await expect(section).toContainText("Spotlight 1 of 1");
    await expect(section.getByRole("button", { name: "Next spotlight", exact: true })).toBeDisabled();
    await expect(section.getByRole("button", { name: "Previous spotlight", exact: true })).toBeDisabled();
    api.state.profiles[owners.community].suppressed = true;
    await page.clock.fastForward(30_001);
    await expect(section).toContainText("No currently approved, opted-in spotlights are available.");
    await expect(section.getByRole("article")).toHaveCount(0);
  } finally {
    await api.close();
  }
});

test("hidden and navigated pages clear spotlights and cannot restore a delayed previous selection", async ({
  page,
  configuredApp,
}) => {
  const api = await fixture(page, configuredApp);
  try {
    await page.clock.install();
    await page.goto("/?ui=api");
    await expect(spotlights(page).getByRole("article")).toBeVisible();
    const hold = api.hold();
    const before = api.controlsCalls();
    await page.clock.fastForward(30_001);
    await expect.poll(api.controlsCalls).toBeGreaterThan(before);
    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", { configurable: true, value: true });
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect(page.getByText(/Reviewed explanation/)).toHaveCount(0);
    hold.release();
    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", { configurable: true, value: false });
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect(spotlights(page).getByRole("article")).toBeVisible();
    await entry(page).getByRole("link").click();
    await expect(spotlights(page)).toHaveCount(0);
    await expect(entry(page)).toHaveCount(0);
  } finally {
    await api.close();
  }
});

test("filtered and historical homepages keep the directory entry without reading broader editorial selections", async ({
  page,
  configuredApp,
}) => {
  const api = await fixture(page, configuredApp);
  try {
    const selected = new URLSearchParams({
      ui: "api",
      repository: "2",
      workstream: "T6",
      context: "current",
      project: "PVT_A,PVT_B=",
      role: "author,reviewer",
      actors: "user",
      start: "2026-10-01T00:00:00.000Z",
      end: "2026-10-18T00:00:00.000Z",
      snapshot: pin,
      tz: "America/New_York",
      category: "pr_merged",
      search: "old",
      cursor: "AA.BB",
    });
    await page.goto("/?" + selected);
    const link = entry(page).getByRole("link");
    await expect(link).toBeVisible();
    const url = new URL((await link.getAttribute("href"))!, page.url());
    for (const key of [
      "organization",
      "repository",
      "workstream",
      "context",
      "project",
      "role",
      "actors",
      "start",
      "end",
      "snapshot",
      "tz",
    ])
      expect(url.searchParams.get(key)).toBe(key === "organization" ? "Pick-Your-AI" : selected.get(key));
    for (const key of ["category", "search", "cursor", "newcomer"]) expect(url.searchParams.has(key)).toBe(false);
    await expect(spotlights(page)).toContainText("Editorial selections are unavailable for this view.");
    await expect(spotlights(page).getByRole("button")).toHaveCount(0);
    expect(api.controlsCalls()).toBe(0);
    expect(api.apiCalls.some((call) => /\/contributors(?:\/|$)/.test(call.pathname))).toBe(false);
  } finally {
    await api.close();
  }
});

test("first-contributions entry reaches the existing directory and profile with unknown history kept explicit", async ({
  page,
  configuredApp,
}) => {
  const api = await fixture(page, configuredApp);
  try {
    await page.goto("/?ui=api&repository=2&snapshot=" + pin);
    const link = entry(page).getByRole("link");
    await expect(link).toBeVisible();
    await link.focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/contributors\?/);
    await page.locator('a[href^="/contributors/101?"]').first().click();
    await expect(page.getByRole("region", { name: "Reviewed organization history", exact: true })).toContainText(
      "First qualifying contribution is unknown.",
    );
    await expect(page.getByRole("button", { name: "Inspect first proof", exact: true })).toHaveCount(0);
    expect(new URL(page.url()).searchParams.get("snapshot")).toBe(pin);
    expect(new URL(page.url()).searchParams.get("repository")).toBe("2");
  } finally {
    await api.close();
  }
});

test("homepage discovery remains keyboard-operable and readable at 320px with reduced motion", async ({
  page,
  configuredApp,
}) => {
  const api = await fixture(page, configuredApp);
  try {
    await page.setViewportSize({ width: 320, height: 900 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    api.state.profiles[owners.community].bio = "Synthetic long biography ".repeat(15);
    await page.goto("/?ui=api");
    const next = spotlights(page).getByRole("button", { name: "Next spotlight", exact: true });
    await next.focus();
    await page.keyboard.press("Enter");
    await expect(spotlights(page)).toContainText("Reviewed explanation research-old");
    await expect(next).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const result = await new AxeBuilder({ page })
      .include('[aria-labelledby="editorial-title"]')
      .include('[aria-labelledby="overview-first-contributions-title"]')
      .analyze();
    expect(result.violations).toEqual([]);
    await test.info().attach("overview-discovery-320px", { body: await page.screenshot(), contentType: "image/png" });
    api.failHealth();
    await page.getByRole("button", { name: "Recheck current publication controls", exact: true }).click();
    await expect(entry(page)).toHaveCount(0);
    await expect(spotlights(page)).toHaveCount(0);
  } finally {
    await api.close();
  }
});
