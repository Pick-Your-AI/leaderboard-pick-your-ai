import { test as base, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { build } from "vite";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const test = base.extend<{}, { configuredApp: string }>({
  configuredApp: [
    async ({}, use) => {
      const directory = await mkdtemp(join(tmpdir(), "lb-editorial-dimensions-"));
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
const at = Date.parse("2026-10-19T12:00:00.000Z");

async function fixture(page: Page, directory: string, stock = false) {
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
  const input = participationHistorySource();
  const app = createService({ source: stock ? { read: input.source.read } : input.source });
  const calls: URL[] = [];
  let hold: { wait: Promise<void>; release: () => void } | null = null;
  await page.route("**/api/v1/**", async (route) => {
    const url = new URL(route.request().url());
    calls.push(url);
    const response = await app.inject({ method: "GET", url: url.pathname + url.search });
    if (hold && url.pathname.endsWith("participation-history")) await hold.wait;
    await route.fulfill({ status: response.statusCode, headers: response.headers, body: response.body });
  });
  const { attachSyntheticEvidenceState } = await import(
    new URL("../../../tests/fixtures/evidence-intake.mjs", import.meta.url).href
  );
  const { nominateSpotlight, decideSpotlight, projectSpotlights } = await import(
    new URL("../../controls/src/editorial.mjs", import.meta.url).href
  );
  const { proposeRotation, decideRotation, projectRotation } = await import(
    new URL("../../controls/src/editorial-rotation.mjs", import.meta.url).href
  );
  // Actual pure intake, nomination and sidecar transitions over synthetic inputs.
  // Independent HTTP/SQLite tests cover durable route authorization and reopen.
  const state: any = {
    profiles: { "101": { public: true, bio: "Consented synthetic dimension bio" } },
    requests: {},
    audit: [],
  };
  for (let i = 0; i < 3; i++)
    state.requests[`claim-${i}`] = {
      id: `claim-${i}`,
      owner: "101",
      kind: "evidence",
      status: "accepted",
      version: 1,
      scope: "Synthetic reviewed contribution",
      detail: "Private fixture detail",
      policyVersion: "synthetic-dimension-policy",
      locator: `https://github.com/synthetic-editorial/example/issues/${i + 1}`,
      category: "Research",
      collaborators: {},
      history: [
        {
          id: `accept-${i}`,
          actor: "104",
          action: "accepted",
          version: 1,
          at: at - 10000,
          policyVersion: "synthetic-dimension-policy",
        },
      ],
    };
  attachSyntheticEvidenceState(state);
  const owner = { actorId: "101", roles: [] },
    reviewer = { actorId: "104", roles: ["reviewer"] };
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) {
    const n = nominateSpotlight(state, owner, { claimId: `claim-${i}`, consent: true }, at - 5000);
    ids.push(n.id);
    decideSpotlight(
      state,
      reviewer,
      n.id,
      {
        version: 1,
        action: "accept",
        reason: "Private fixture reason",
        publicExplanation: `Original selection ${i + 1}`,
        conflict: false,
      },
      at - 4000 + i,
    );
    const proposal = proposeRotation(
      state,
      owner,
      {
        nominationId: n.id,
        version: null,
        consent: true,
        workstreams:
          i === 0 ? ["A evidence review", "B contributor support"] : i === 1 ? ["B contributor support"] : [],
        behindScenes: i === 2,
        newcomerPeriod: i === 0 ? { start: "2026-01-01T00:00:00.000Z", end: "2026-10-18T00:00:00.000Z" } : null,
      },
      at,
      () => true,
    );
    decideRotation(
      state,
      reviewer,
      n.id,
      {
        version: proposal.version,
        action: "accept",
        reason: "Private dimension reason",
        publicExplanation: `Dimension description ${i + 1}`,
        conflict: false,
      },
      at + 1,
      () => true,
    );
  }
  let failure = false,
    dimensionCalls = 0;
  await page.route("**/controls/spotlights", (route) => route.fulfill({ json: projectSpotlights(state, () => true) }));
  await page.route("**/controls/spotlight-rotation", (route) => {
    dimensionCalls++;
    return route.fulfill(
      failure ? { status: 503, json: { code: "unavailable" } } : { json: projectRotation(state, () => true) },
    );
  });
  return {
    state,
    ids,
    calls,
    dimensionCalls: () => dimensionCalls,
    setFailure: (value: boolean) => {
      failure = value;
    },
    describe: (index: number, fields: { workstreams: string[]; behindScenes: boolean; newcomerPeriod: null }) => {
      const id = ids[index]!;
      const proposal = proposeRotation(
        state,
        owner,
        { nominationId: id, version: state.spotlightRotations[id]?.version ?? null, consent: true, ...fields },
        at + 3,
        () => true,
      );
      return decideRotation(
        state,
        reviewer,
        id,
        {
          version: proposal.version,
          action: "accept",
          reason: "Independent synthetic amendment",
          publicExplanation: `Dimension description ${index + 1}`,
          conflict: false,
        },
        at + 4,
        () => true,
      );
    },
    withdraw: (index: number) =>
      decideRotation(
        state,
        owner,
        ids[index],
        {
          version: state.spotlightRotations[ids[index]!].version,
          action: "withdraw",
          reason: "Owner withdraws separate dimension consent",
        },
        at + 2,
        () => false,
      ),
    holdHistory: () => {
      let release!: () => void;
      const wait = new Promise<void>((done) => {
        release = done;
      });
      hold = { wait, release };
      return hold;
    },
    close: async () => {
      hold?.release();
      await page.unrouteAll({ behavior: "wait" });
      await app.close();
    },
  };
}
const section = (page: Page) => page.getByRole("region", { name: "Editorial spotlights", exact: true });
async function enter(page: Page) {
  await page.goto("/?ui=api");
  await section(page).getByRole("button", { name: "Explore editorial dimensions", exact: true }).click();
}

test("explicit entry mounts actual reviewed dimensions and pinned dated history with manual keyboard rotation", async ({
  page,
  configuredApp,
}) => {
  const f = await fixture(page, configuredApp);
  try {
    await page.clock.install();
    await page.goto("/?ui=api");
    await expect(section(page).getByText("Original selection 1", { exact: true })).toBeVisible();
    expect(f.dimensionCalls()).toBe(0);
    expect(f.calls.some((url) => url.pathname.endsWith("participation-history"))).toBe(false);
    await section(page).getByRole("button", { name: "Explore editorial dimensions", exact: true }).click();
    await expect(section(page)).toContainText("Dimension spotlight 1 of 3.");
    await expect(section(page).getByRole("article")).toContainText("Dimension description 1");
    await expect(section(page).getByRole("article")).toContainText("inside this exact period");
    await expect(section(page).getByRole("article")).toContainText("2026-01-01T00:00:00.000Z");
    await expect(section(page).getByRole("article")).toContainText("2026-10-18T00:00:00.000Z");
    const next = section(page).getByRole("button", { name: "Next dimension spotlight", exact: true });
    await next.focus();
    await page.keyboard.press("Enter");
    await expect(section(page).getByRole("article")).toContainText("Dimension description 2");
    await page.clock.fastForward(5000);
    await expect(section(page).getByRole("article")).toContainText("Dimension description 2");
    await page.keyboard.press("Enter");
    await expect(section(page).getByRole("article")).toContainText("Dimension description 3");
    const history = f.calls.find((url) => url.pathname.endsWith("participation-history"))!;
    expect(history.searchParams.get("snapshot")).toBe("synthetic-history-selected");
    expect(history.searchParams.has("repository")).toBe(false);
    await section(page).getByRole("button", { name: "Return to category-only spotlights", exact: true }).click();
    await expect(section(page).getByText("Original selection 1", { exact: true })).toBeVisible();
  } finally {
    await f.close();
  }
});

test("withdrawal during a delayed history response uses the final public projection and cannot resurrect the card", async ({
  page,
  configuredApp,
}) => {
  const f = await fixture(page, configuredApp);
  try {
    const held = f.holdHistory();
    await enter(page);
    await expect.poll(() => f.calls.filter((url) => url.pathname.endsWith("participation-history")).length).toBe(1);
    f.withdraw(0);
    held.release();
    await expect(section(page)).toContainText("Dimension spotlight 1 of 2.");
    await expect(section(page)).not.toContainText("Dimension description 1");
    await expect(section(page)).not.toContainText("inside this exact period");
    await expect(section(page).getByRole("article")).toContainText("Dimension description 2");
  } finally {
    await f.close();
  }
});

test("failed refresh clears positives, retains keyboard recovery and returns only after a current read", async ({
  page,
  configuredApp,
}) => {
  const f = await fixture(page, configuredApp);
  try {
    await page.clock.install();
    await enter(page);
    await expect(section(page)).toContainText("Dimension spotlight 1 of 3.");
    await section(page).getByRole("button", { name: "Next dimension spotlight", exact: true }).focus();
    f.setFailure(true);
    await page.clock.fastForward(30000);
    await expect(section(page).getByRole("alert")).toHaveText(
      "Current dimension selections are unavailable. Previous history results have been cleared.",
    );
    await expect(section(page).getByRole("article")).toHaveCount(0);
    await expect(
      section(page).getByRole("heading", { name: "Reviewed editorial dimensions", exact: true }),
    ).toBeFocused();
    f.setFailure(false);
    f.withdraw(0);
    await section(page).getByRole("button", { name: "Retry dimension read", exact: true }).click();
    await expect(section(page)).toContainText("Dimension spotlight 1 of 2.");
    await expect(section(page)).not.toContainText("Dimension description 1");
  } finally {
    await f.close();
  }
});

test("unknown stock history stays visibly dated and the mounted view fits narrow reduced-motion layouts", async ({
  page,
  configuredApp,
}) => {
  const f = await fixture(page, configuredApp, true);
  try {
    await page.setViewportSize({ width: 320, height: 720 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await enter(page);
    await expect(section(page)).toContainText(
      "History assessment unknown for this period. No newcomer status is asserted.",
    );
    await expect(section(page).getByRole("article")).not.toContainText("inside this exact period");
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "200%";
    });
    await expect(section(page).getByRole("button", { name: "Next dimension spotlight", exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const accessibility = await new AxeBuilder({ page }).include('[aria-labelledby="editorial-title"]').analyze();
    expect(accessibility.violations).toEqual([]);
  } finally {
    await f.close();
  }
});

test("the initial displayed nomination survives an earlier added lane before any manual navigation", async ({
  page,
  configuredApp,
}) => {
  const f = await fixture(page, configuredApp);
  try {
    f.withdraw(1);
    f.withdraw(2);
    f.describe(0, { workstreams: ["Z current description"], behindScenes: false, newcomerPeriod: null });
    await page.clock.install();
    await enter(page);
    await expect(section(page).getByRole("article")).toContainText("Dimension description 1");
    f.describe(1, { workstreams: ["A earlier lane"], behindScenes: false, newcomerPeriod: null });
    await page.clock.fastForward(30000);
    await expect(section(page)).toContainText("Dimension spotlight 2 of 2.");
    await expect(section(page).getByRole("article")).toContainText("Dimension description 1");
    f.withdraw(0);
    await page.clock.fastForward(30000);
    await expect(section(page)).toContainText("Dimension spotlight 1 of 1.");
    await expect(section(page).getByRole("article")).toContainText("Dimension description 2");
  } finally {
    await f.close();
  }
});

test("mounted owner proposal, independent review and withdrawal preserve exact bindings and stale-error input", async ({
  page,
  configuredApp,
}) => {
  const f = await fixture(page, configuredApp);
  const { proposeRotation, decideRotation, projectRotation, rotationQueue } = await import(
    new URL("../../controls/src/editorial-rotation.mjs", import.meta.url).href
  );
  const id = f.ids[0]!;
  for (const other of f.ids.slice(1)) {
    delete f.state.spotlights[other];
    delete f.state.spotlightRotations[other];
  }
  delete f.state.spotlightRotations[id];
  const originalNomination = structuredClone(f.state.spotlights[id]);
  const owner = { actorId: "101", roles: [] as string[] },
    reviewer = { actorId: "104", roles: ["reviewer"] };
  let actor = owner,
    eligible = true,
    malformedLabel: string | null = null;
  const csrf = "s".repeat(43),
    writes: Array<{ path: string; body: Record<string, unknown>; csrf?: string }> = [];
  await page.route("**/controls/**", async (route) => {
    const req = route.request(),
      path = new URL(req.url()).pathname;
    if (req.method() === "POST") {
      const body = req.postDataJSON() as Record<string, unknown>,
        sentCsrf = req.headers()["x-csrf-token"];
      writes.push({ path, body, ...(sentCsrf ? { csrf: sentCsrf } : {}) });
      if (sentCsrf !== csrf) return route.fulfill({ status: 403, json: { error: "Invalid CSRF" } });
      try {
        const record =
          path === "/controls/spotlight-rotation"
            ? proposeRotation(f.state, actor, body, at + 10, () => eligible)
            : path === `/controls/spotlight-rotation/${id}`
              ? decideRotation(f.state, actor, id, body, at + 11, () => eligible)
              : null;
        return route.fulfill(
          record
            ? { status: path.endsWith(id) ? 200 : 201, json: { record } }
            : { status: 404, json: { error: "Unexpected route" } },
        );
      } catch (error) {
        const failure = error as { status?: number; message?: string };
        return route.fulfill({ status: failure.status ?? 500, json: { error: failure.message ?? "Controls failed" } });
      }
    }
    const result = rotationQueue(f.state, actor, () => eligible);
    if (malformedLabel && result.records[0]) result.records[0].workstreams = [malformedLabel];
    const responses: Record<string, unknown> = {
      "/controls/session": { ...actor, csrf, expires: Date.now() + 600000 },
      "/controls/profile": {
        bio: "Consented synthetic dimension bio",
        highlights: [],
        public: true,
        suppressed: false,
      },
      "/controls/requests": { requests: [] },
      "/controls/invitations": { invitations: [] },
      "/controls/evidence-terms": {},
      "/controls/spotlights/queue": { nominations: Object.values(f.state.spotlights) },
      "/controls/spotlight-rotation/queue": result,
      "/controls/spotlight-rotation": projectRotation(f.state, () => eligible),
    };
    return route.fulfill({ json: responses[path] ?? {} });
  });
  const panel = () => page.getByRole("region", { name: "Editorial dimension consent and review", exact: true });
  try {
    await page.goto("/account");
    await expect(panel().getByRole("button", { name: "Submit dimension proposal", exact: true })).toBeVisible();
    const consent = panel().getByRole("checkbox", { name: /^I consent to these exact public descriptions/ });
    await expect(consent).not.toBeChecked();
    await expect(
      panel().getByRole("checkbox", { name: /^I consent to a reviewed behind-the-scenes/ }),
    ).not.toBeChecked();
    await expect(panel().getByRole("checkbox", { name: /^I consent to a publicly dated newcomer/ })).not.toBeChecked();
    await panel()
      .getByRole("textbox", { name: /^Editorial workstream descriptions/ })
      .fill("Evidence 🌟\ne\u0301ditorial review");
    await panel().getByRole("button", { name: "Submit dimension proposal", exact: true }).click();
    expect(writes).toHaveLength(0);
    await consent.check();
    await panel().getByRole("button", { name: "Submit dimension proposal", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Service confirmed:" })).toBeVisible();
    expect(writes[0]).toEqual({
      path: "/controls/spotlight-rotation",
      csrf,
      body: {
        nominationId: id,
        version: null,
        consent: true,
        workstreams: ["Evidence 🌟", "e\u0301ditorial review"],
        behindScenes: false,
        newcomerPeriod: null,
      },
    });
    expect(f.state.spotlightRotations[id].status).toBe("pending");
    for (const invalid of ["\uD800", "\uDFFF"]) {
      malformedLabel = invalid;
      await page.reload();
      await expect(panel().getByRole("alert")).toHaveText(
        "Declarations could not be read. Reload before changing them; no success is confirmed.",
      );
      await expect(panel().getByRole("button", { name: "Record dimension decision" })).toHaveCount(0);
    }
    malformedLabel = null;
    actor = reviewer;
    await page.goto("/admin");
    await expect(panel()).toContainText(
      `Bound nomination version: ${originalNomination.version}. Bound contribution: claim-0; version 1.`,
    );
    await expect(panel().locator("code")).toHaveText(f.state.spotlightRotations[id].digest);
    await expect(
      panel().getByRole("link", { name: "Open the bound contribution source", exact: true }),
    ).toHaveAttribute("href", f.state.requests["claim-0"].locator);
    await expect(panel().getByRole("combobox", { name: "Dimension decision", exact: true })).toHaveValue("reject");
    await expect(
      panel().getByRole("checkbox", { name: /^I independently reviewed the exact descriptions/ }),
    ).not.toBeChecked();
    await panel().getByRole("combobox", { name: "Dimension decision", exact: true }).selectOption("accept");
    await panel()
      .getByLabel("Private dimension decision reason", { exact: true })
      .fill("Independent review retained after a stale reply");
    await panel()
      .getByLabel("Public dimension explanation", { exact: true })
      .fill("Synthetic public classification rationale");
    await panel()
      .getByRole("checkbox", { name: /^I independently reviewed the exact descriptions/ })
      .check();
    proposeRotation(
      f.state,
      owner,
      {
        nominationId: id,
        version: 1,
        consent: true,
        workstreams: ["Concurrent revised description 🌟"],
        behindScenes: false,
        newcomerPeriod: null,
      },
      at + 12,
      () => true,
    );
    await panel().getByRole("button", { name: "Record dimension decision", exact: true }).click();
    await expect(page.getByRole("alert")).toHaveText("The receipt or policy changed. Reload before trying again.");
    await expect(panel().getByLabel("Private dimension decision reason", { exact: true })).toHaveValue(
      "Independent review retained after a stale reply",
    );
    expect(writes.at(-1)?.body.version).toBe(1);
    expect(f.state.spotlightRotations[id].status).toBe("pending");
    await expect(page.getByRole("status").filter({ hasText: "Service confirmed:" })).toHaveCount(0);
    await page.reload();
    await expect(panel()).toContainText("Concurrent revised description 🌟");
    await expect(panel().locator("code")).toHaveText(f.state.spotlightRotations[id].digest);
    await panel().getByRole("combobox", { name: "Dimension decision", exact: true }).selectOption("accept");
    await panel()
      .getByLabel("Private dimension decision reason", { exact: true })
      .fill("Reviewed the changed exact declaration and linked source");
    await panel()
      .getByLabel("Public dimension explanation", { exact: true })
      .fill("Public rationale for the current declaration");
    await panel()
      .getByRole("checkbox", { name: /^I independently reviewed the exact descriptions/ })
      .check();
    await panel().getByRole("button", { name: "Record dimension decision", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Service confirmed:" })).toBeVisible();
    expect(writes.at(-1)).toMatchObject({
      path: `/controls/spotlight-rotation/${id}`,
      csrf,
      body: {
        version: 2,
        action: "accept",
        conflict: false,
        reason: "Reviewed the changed exact declaration and linked source",
        publicExplanation: "Public rationale for the current declaration",
      },
    });
    expect(projectRotation(f.state, () => true).candidates).toHaveLength(1);
    actor = owner;
    eligible = false;
    await page.goto("/account");
    await expect(panel()).toContainText(
      "Current matching contribution context is unavailable or changed. Review is disabled; owner withdrawal remains available.",
    );
    await panel()
      .getByLabel("Private withdrawal reason", { exact: true })
      .fill("Withdraw separate consent after source eligibility was lost");
    await panel().getByRole("button", { name: "Withdraw dimension consent", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Service confirmed:" })).toBeVisible();
    expect(writes.at(-1)).toMatchObject({
      path: `/controls/spotlight-rotation/${id}`,
      csrf,
      body: { version: 3, action: "withdraw", reason: "Withdraw separate consent after source eligibility was lost" },
    });
    expect(f.state.spotlightRotations[id].status).toBe("withdrawn");
    expect(projectRotation(f.state, () => true).candidates).toHaveLength(0);
    expect(f.state.spotlights[id]).toEqual(originalNomination);
    await expect(panel().getByRole("button", { name: "Withdraw dimension consent", exact: true })).toHaveCount(0);
  } finally {
    await f.close();
  }
});

test("an admitted v1 query or unsupported fragment cannot hide owner withdrawal or another valid declaration", async ({
  page,
  configuredApp,
}) => {
  const { proposeRotation, decideRotation, rotationQueue } = await import(
    new URL("../../controls/src/editorial-rotation.mjs", import.meta.url).href
  );
  const { attachSyntheticEvidenceIntake } = await import(
    new URL("../../../tests/fixtures/evidence-intake.mjs", import.meta.url).href
  );
  const { locator } = await import(new URL("../../controls/src/store.mjs", import.meta.url).href);
  for (const suffix of ["?context=review", "#unsupported-review-fragment"]) {
    const f = await fixture(page, configuredApp);
    const id = f.ids[0]!,
      other = f.ids[1]!,
      owner = { actorId: "101", roles: [] as string[] },
      reviewer = { actorId: "104", roles: ["reviewer"] },
      csrf = "q".repeat(43);
    let actor = reviewer;
    const originalNomination = structuredClone(f.state.spotlights[id]);
    const proposal = proposeRotation(
      f.state,
      owner,
      {
        nominationId: id,
        version: f.state.spotlightRotations[id].version,
        consent: true,
        workstreams: ["Reviewed source context"],
        behindScenes: false,
        newcomerPeriod: null,
      },
      at + 10,
      () => true,
    );
    const source = f.state.requests["claim-0"].locator + suffix;
    expect(locator(source)).toBe(source);
    f.state.requests["claim-0"].locator = source;
    attachSyntheticEvidenceIntake(f.state.requests["claim-0"]);
    expect(
      rotationQueue(f.state, reviewer, () => true).records.find((r: any) => r.id === id).currentContext,
    ).toMatchObject({
      state: "current",
      sourceUrl: source,
    });
    const writes: unknown[] = [];
    await page.route("**/controls/**", async (route) => {
      const req = route.request(),
        path = new URL(req.url()).pathname;
      if (req.method() === "POST") {
        const body = req.postDataJSON();
        writes.push({ path, body, csrf: req.headers()["x-csrf-token"] });
        if (path !== `/controls/spotlight-rotation/${id}` || req.headers()["x-csrf-token"] !== csrf)
          return route.fulfill({ status: 403, json: { error: "Unexpected fixture request" } });
        const record = decideRotation(f.state, actor, id, body, at + 11, () => true);
        return route.fulfill({ json: { record } });
      }
      const responses: Record<string, unknown> = {
        "/controls/session": { ...actor, csrf, expires: Date.now() + 600000 },
        "/controls/profile": { ...f.state.profiles["101"], highlights: [], suppressed: false },
        "/controls/requests": { requests: [] },
        "/controls/invitations": { invitations: [] },
        "/controls/evidence-terms": {},
        "/controls/spotlights/queue": { nominations: Object.values(f.state.spotlights) },
        "/controls/spotlight-rotation/queue": rotationQueue(f.state, actor, () => true),
      };
      return route.fulfill({ json: responses[path] ?? {} });
    });
    const panel = () => page.getByRole("region", { name: "Editorial dimension consent and review", exact: true });
    const entry = (entryId: string) =>
      panel()
        .getByRole("article")
        .filter({
          has: page.getByRole("heading", { name: `Dimension declaration for ${entryId}`, exact: true }),
        });
    try {
      await page.goto("/admin");
      await expect(entry(id)).toContainText("Current matching contribution context is unavailable or changed.");
      await expect(entry(id).getByRole("button", { name: "Record dimension decision", exact: true })).toHaveCount(0);
      await expect(entry(id).getByRole("link")).toHaveCount(0);
      await expect(
        entry(other).getByRole("link", { name: "Open the bound contribution source", exact: true }),
      ).toBeVisible();
      await expect(panel().getByRole("alert")).toHaveCount(0);
      actor = owner;
      await page.goto("/account");
      await expect(entry(id).getByRole("button", { name: "Withdraw dimension consent", exact: true })).toBeVisible();
      await entry(id)
        .getByLabel("Private withdrawal reason", { exact: true })
        .fill("Withdraw despite unavailable optional link");
      await entry(id).getByRole("button", { name: "Withdraw dimension consent", exact: true }).click();
      await expect(page.getByRole("status").filter({ hasText: "Service confirmed:" })).toBeVisible();
      expect(writes).toEqual([
        {
          path: `/controls/spotlight-rotation/${id}`,
          csrf,
          body: { version: proposal.version, action: "withdraw", reason: "Withdraw despite unavailable optional link" },
        },
      ]);
      expect(f.state.spotlightRotations[id].status).toBe("withdrawn");
      expect(f.state.spotlights[id]).toEqual(originalNomination);
      await expect(entry(other).getByRole("button", { name: "Withdraw dimension consent", exact: true })).toBeVisible();
    } finally {
      await f.close();
    }
  }
});
