import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { syntheticBrowserIntake, syntheticEvidenceTerms } from "./controls-intake-fixtures.ts";
const id = "11111111-1111-1111-1111-111111111111";
async function controls(
  page: Page,
  roles: string[] = [],
  expires = Date.now() + 600000,
  actorId: unknown = "1",
  receiptOwner = "2",
) {
  const writes: Array<{ path: string; body: Record<string, unknown>; csrf: string | undefined }> = [];
  await page.route("**/controls/**", async (route) => {
    const req = route.request(),
      path = new URL(req.url()).pathname;
    if (req.method() === "POST") {
      writes.push({ path, body: req.postDataJSON(), csrf: req.headers()["x-csrf-token"] });
      await route.fulfill({ json: { id, status: "pending", version: 1 } });
      return;
    }
    const responses: Record<string, unknown> = {
      "/controls/session": { actorId, csrf: "a".repeat(43), roles, expires },
      "/controls/evidence-terms": { terms: syntheticEvidenceTerms },
      "/controls/profile": { bio: "Saved bio", highlights: [], public: false, suppressed: false },
      "/controls/requests": {
        requests: [
          {
            id,
            owner: receiptOwner,
            kind: "evidence",
            status: "pending",
            version: 3,
            detail: "Evidence for independent review",
            history: [],
            collaborators: {},
            intake: syntheticBrowserIntake(receiptOwner),
            intakeEligibility: { state: "awaiting_review" },
          },
        ],
      },
      "/controls/invitations": { invitations: [] },
      "/controls/configuration": { revision: 0, proposals: {} },
      "/controls/spotlights/queue": { nominations: [] },
      "/controls/spotlight-rotation/queue": { schemaVersion: "editorial-dimensions/v1", records: [] },
    };
    await route.fulfill({ json: responses[path] ?? {} });
  });
  return writes;
}

for (const width of [320, 360, 768, 1024, 1280]) {
  for (const colorScheme of ["light", "dark"] as const) {
    for (const path of ["/account", "/admin"] as const) {
      test(`protected ${path} WCAG 2.2 and reflow at ${width}px in ${colorScheme}`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        await page.emulateMedia({ colorScheme });
        const writes = await controls(page, path === "/admin" ? ["reviewer"] : []);
        await page.goto(path);
        if (path === "/account") {
          await expect(page.getByLabel("Bio (up to 500 characters)")).toHaveValue("Saved bio");
          await expect(page.getByRole("button", { name: "Save profile", exact: true })).toBeVisible();
        } else {
          await expect(page.getByText("Evidence for independent review", { exact: true })).toBeVisible();
          await expect(page.getByRole("button", { name: "Record review decision", exact: true })).toBeVisible();
        }
        await expect(
          page.getByRole("heading", { name: "Editorial dimension consent and review", exact: true }),
        ).toBeVisible();
        await expect(page.getByText("Checking current dimension declarations…", { exact: true })).toHaveCount(0);
        await expect(page.getByRole("alert")).toHaveCount(0);
        await expect(page.locator("html")).toHaveCSS("color-scheme", colorScheme);

        const reflow = await page.evaluate(() => ({
          viewportWidth: window.innerWidth,
          contentWidth: document.documentElement.scrollWidth,
        }));
        expect.soft(reflow.contentWidth).toBeLessThanOrEqual(reflow.viewportWidth + 1);
        const scan = await new AxeBuilder({ page })
          .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"])
          .analyze();
        expect(scan.violations).toEqual([]);
        expect(writes).toHaveLength(0);
      });
    }
  }
}

for (const { description, actorId, path } of [
  { description: "numeric", actorId: 1, path: "/account" },
  { description: "singleton array", actorId: ["1"], path: "/admin" },
  { description: "terminal newline", actorId: "1\n", path: "/admin" },
]) {
  test(`protected session ${description} identity is refused before private reads`, async ({ page }, testInfo) => {
    const requests: string[] = [];
    page.on("request", (request) => {
      const pathname = new URL(request.url()).pathname;
      if (pathname.startsWith("/controls/")) requests.push(`${request.method()} ${pathname}`);
    });
    const writes = await controls(page, ["reviewer"], Date.now() + 600000, actorId, "1");
    const response = page.waitForResponse((result) => new URL(result.url()).pathname === "/controls/session");
    await page.goto(path);
    await response;
    await expect(
      page.getByRole("heading", { name: path === "/admin" ? "Protected administration" : "Your account", exact: true }),
    ).toBeVisible();
    await expect(page.getByText("Checking your controls session…", { exact: true })).toHaveCount(0);
    await testInfo.attach("protected-session-observation", {
      contentType: "application/json",
      body: Buffer.from(
        JSON.stringify({
          actorId,
          path,
          requests,
          errors: await page.getByRole("alert").allTextContents(),
          verifiedIdentityCount: await page.getByText("Verified GitHub account ID:", { exact: false }).count(),
          ownReceiptCount: await page.getByText("Evidence for independent review", { exact: true }).count(),
          reviewButtonCount: await page.getByRole("button", { name: "Record review decision" }).count(),
          profileButtonCount: await page.getByRole("button", { name: "Save profile" }).count(),
          writes,
        }),
      ),
    });
    await expect(page.getByRole("alert")).toHaveText("Invalid or expired controls session.");
    await expect(page.getByRole("heading", { name: "Sign in required" })).toBeVisible();
    await expect(page.getByText("Verified GitHub account ID:", { exact: false })).toHaveCount(0);
    await expect(page.getByText("Evidence for independent review", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Record review decision" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Save profile" })).toHaveCount(0);
    expect(requests).toEqual(["GET /controls/session"]);
    expect(writes).toHaveLength(0);
  });
}

test("protected session canonical owner keeps account receipts without a self-review action", async ({ page }) => {
  const writes = await controls(page, ["reviewer"], Date.now() + 600000, "1", "1");
  await page.goto("/account");
  await expect(page.getByRole("heading", { name: `Receipt ${id}`, exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save profile" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Record review decision" })).toHaveCount(0);
  await page.getByRole("link", { name: "Administration", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Protected administration", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: `Receipt ${id}`, exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Record review decision" })).toHaveCount(0);
  expect(writes).toHaveLength(0);
});

test("anonymous account stays protected even in prototype mode", async ({ page }) => {
  await page.route("**/controls/session", (r) =>
    r.fulfill({ status: 401, json: { error: "Authentication required" } }),
  );
  await page.goto("/account?ui=prototype");
  await expect(page.getByRole("heading", { name: "Sign in required" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save profile" })).toHaveCount(0);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});
test("account loads persisted profile and submits confirmed writes with CSRF and service receipt", async ({ page }) => {
  const writes = await controls(page);
  await page.goto("/account");
  await expect(page.getByLabel("Bio (up to 500 characters)")).toHaveValue("Saved bio");
  await page.getByLabel("Bio (up to 500 characters)").fill("New bio");
  await page.getByLabel("Replace my optional profile with these values").check();
  await page.getByRole("button", { name: "Save profile" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Service confirmed" })).toContainText("Service confirmed");
  expect(writes[0]).toMatchObject({
    path: "/controls/profile",
    body: { bio: "New bio", highlights: [], public: false },
    csrf: "a".repeat(43),
  });
  await expect(page.getByText("Evidence for independent review")).toHaveCount(0);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});
test("admin denies unprivileged accounts and supports versioned independent review", async ({ page }) => {
  const writes = await controls(page);
  await page.goto("/admin/");
  await expect(page.getByText("This account has no administration role.")).toBeVisible();
  await expect(page.getByText("Evidence for independent review")).toHaveCount(0);
  await page.unrouteAll();
  await controls(page, ["reviewer"]);
  await page.goto("/admin");
  await page.getByLabel("Decision reason").fill("Source does not support this outcome");
  await page.getByLabel(/I have no conflict/).check();
  await page.getByRole("button", { name: "Record review decision" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Service confirmed" })).toContainText("Service confirmed");
  expect(writes).toHaveLength(0);
});

test("locale acceptance submits the explicitly reviewed fact, language, policy and merge revision", async ({
  page,
}) => {
  const writes = await controls(page, ["reviewer"]);
  await page.goto("/admin");
  await page.getByLabel("Review decision").selectOption("accept");
  await page.getByLabel("Source-use review rationale").fill("Synthetic independent review of the permitted source use");
  await page
    .getByLabel("Reviewed source reference 1", { exact: true })
    .fill("https://github.com/synthetic/example/blob/reviewed/rights.md");
  await page.getByLabel("Reviewed source revision 1", { exact: true }).fill("synthetic-rights-revision");
  await page.getByLabel("My independent review establishes permitted source use for this exact claim").check();
  await page.getByLabel("Accept one reviewed language and source revision").check();
  await page.getByLabel("Contribution ID", { exact: true }).fill("synthetic-locale:fr");
  await page.getByLabel("Reviewed merge revision").fill("C".repeat(40));
  await page.getByLabel("Language tag").fill("fr");
  await page.getByLabel("Content category", { exact: true }).fill("documentation");
  await page.getByLabel("Documentation classification policy version").fill("synthetic-locales-v1");
  await page.getByLabel("Approved policy version").fill("synthetic-metric-v1");
  await page.getByLabel("Decision reason").fill("Reviewed the exact public French merge proof");
  await page.getByLabel("I reviewed the source and verified it is public").check();
  await page.getByLabel(/I have no conflict/).check();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.getByRole("button", { name: "Record review decision" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Service confirmed" })).toContainText("Service confirmed");
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({
    path: `/controls/requests/${id}/review`,
    body: {
      version: 3,
      decision: "accept",
      policyVersion: "synthetic-metric-v1",
      sourceReviewedPublic: true,
      sourceUseReview: {
        disposition: "permitted",
        rationale: "Synthetic independent review of the permitted source use",
        references: [
          {
            locator: "https://github.com/synthetic/example/blob/reviewed/rights.md",
            revision: "synthetic-rights-revision",
          },
        ],
      },
      localization: {
        targetFactId: "synthetic-locale:fr",
        sourceRevision: "C".repeat(40),
        locale: "fr",
        category: "documentation",
        policyVersion: "synthetic-locales-v1",
      },
    },
  });
});
test("expired authority clears private content and never reports mutation success", async ({ page }) => {
  await controls(page, ["reviewer"]);
  await page.goto("/admin");
  await expect(page.getByText("Evidence for independent review")).toBeVisible();
  await page.route("**/controls/requests/*/review", (r) => r.fulfill({ status: 403, json: { error: "revoked" } }));
  await page.getByLabel("Decision reason").fill("Review");
  await page.getByLabel(/I have no conflict/).check();
  await page.getByRole("button", { name: "Record review decision" }).click();
  await expect(page.getByRole("heading", { name: "Sign in required" })).toBeVisible();
  await expect(page.getByText("Evidence for independent review")).toHaveCount(0);
  await expect(page.getByText(/Service confirmed/)).toHaveCount(0);
});

test("privacy requests and suppression report actual service receipts without public traffic", async ({ page }) => {
  const writes = await controls(page);
  await page.goto("/account");
  await page.getByLabel("Request kind").selectOption("privacy");
  await page.getByLabel("Details", { exact: true }).fill("Please review my account display.");
  await page.getByRole("button", { name: "Submit request", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Service confirmed" })).toContainText(id);
  expect(writes[0]).toMatchObject({
    path: "/controls/requests",
    body: { kind: "privacy", detail: "Please review my account display." },
  });
  await page.getByLabel("Display choice").selectOption("suppress");
  await page.getByLabel("Apply this choice to my account").check();
  await page.getByRole("button", { name: "Apply display preference" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Service confirmed" })).toContainText(id);
  expect(writes[1]).toMatchObject({ path: "/controls/profile/suppression", body: { suppressed: true } });
});
test("receipt conflict does not retry or claim success", async ({ page }) => {
  const writes = await controls(page, ["reviewer"]);
  await page.route("**/controls/requests/*/review", (route) =>
    route.fulfill({ status: 409, json: { error: "Receipt changed" } }),
  );
  await page.goto("/admin");
  await page.getByLabel("Decision reason").fill("Source review");
  await page.getByLabel(/I have no conflict/).check();
  await page.getByRole("button", { name: "Record review decision" }).click();
  await expect(page.getByRole("alert")).toContainText("Reload before trying again");
  await expect(page.getByText(/Service confirmed/)).toHaveCount(0);
  expect(writes).toHaveLength(0);
});

test("late mutation after hiding cannot restore a private receipt or overwrite a reopened session", async ({
  page,
}) => {
  await controls(page);
  let release!: () => void;
  let started!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const requested = new Promise<void>((resolve) => {
    started = resolve;
  });
  await page.route("**/controls/profile", async (route) => {
    if (route.request().method() === "GET") {
      await route.fallback();
      return;
    }
    started();
    await pending;
    await route.fulfill({ json: { id: "private-late-receipt", saved: true } });
  });
  await page.goto("/account");
  await page.getByLabel("Replace my optional profile with these values").check();
  await page.getByRole("button", { name: "Save profile" }).click();
  await requested;
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  release();
  await expect(page.getByLabel("Bio (up to 500 characters)")).toHaveCount(0);
  await expect(page.getByText(/private-late-receipt/)).toHaveCount(0);
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(page.getByLabel("Bio (up to 500 characters)")).toHaveValue("Saved bio");
  await expect(page.getByText(/private-late-receipt/)).toHaveCount(0);
});

test("editorial nomination decisions require explicit public explanation and current version", async ({ page }) => {
  const writes = await controls(page, ["reviewer"]);
  await page.route("**/controls/spotlights/queue", (r) =>
    r.fulfill({
      json: {
        nominations: [
          { id, owner: "2", claimId: "accepted-evidence", claimVersion: 2, status: "pending", version: 4, history: [] },
        ],
      },
    }),
  );
  await page.goto("/admin");
  await page.getByLabel("Nomination action").selectOption("accept");
  await page.getByLabel("Private decision reason").fill("Independent review complete.");
  await page.getByLabel("Public selection explanation").fill("Reviewed contribution helps new contributors.");
  await page.getByLabel("I independently reviewed this nomination and have no conflict of interest").check();
  await page.getByRole("button", { name: "Record nomination decision" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Service confirmed" })).toContainText("Service confirmed");
  expect(writes[0]).toMatchObject({
    path: `/controls/spotlights/${id}`,
    body: {
      version: 4,
      action: "accept",
      reason: "Independent review complete.",
      publicExplanation: "Reviewed contribution helps new contributors.",
      conflict: false,
    },
  });
});

test("operators preview approve and activate exact configuration bindings then propose a scoped disable", async ({
  page,
}) => {
  await controls(page, ["operator"]);
  const document = {
    repositories: [],
    projects: [],
    metrics: [
      {
        id: "pr_opened",
        enabled: true,
        policyVersion: "policy-v1",
        policyLink: "https://github.com/example/synthetic/blob/main/policy.md",
        reason: "",
      },
    ],
  };
  const proposal = {
    id,
    owner: "2",
    version: "config-v1",
    versionNumber: 1,
    baseRevision: 0,
    status: "proposed",
    digest: "config-digest",
    document,
    history: [],
    preview: {
      digest: "preview-digest",
      configurationDigest: "config-digest",
      baseRevision: 0,
      source: { validUntil: Date.now() + 600000 },
      before: { enabledMetricIds: [] },
      after: { enabledMetricIds: ["pr_opened"] },
    },
    approval: { id: "approval-id", actor: "1", configurationDigest: "config-digest", previewDigest: "preview-digest" },
  };
  const state = { revision: 0, active: null as typeof proposal | null, proposals: { [id]: proposal }, history: [] };
  const writes: Array<{ path: string; body: Record<string, unknown> }> = [];
  await page.route("**/controls/configuration**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "GET") {
      await route.fulfill({ json: state });
      return;
    }
    const body = request.postDataJSON();
    writes.push({ path, body });
    if (path.endsWith("/preview")) {
      proposal.status = "previewed";
      proposal.versionNumber++;
    }
    if (path.endsWith("/approve")) {
      proposal.status = "approved";
      proposal.versionNumber++;
    }
    if (path.endsWith("/activate")) {
      proposal.status = "activated";
      proposal.versionNumber++;
      state.active = proposal;
      state.revision++;
    }
    await route.fulfill({ json: proposal });
  });
  await page.goto("/admin");
  await page.getByLabel(/Source-test proposal config-v1/).check();
  await page.getByRole("button", { name: "Preview configuration", exact: true }).click();
  await expect(page.getByRole("button", { name: "Approve tested preview" })).toBeVisible();
  await page.getByLabel(/I have no conflict and approve configuration digest/).check();
  await page.getByRole("button", { name: "Approve tested preview" }).click();
  await expect(page.getByRole("button", { name: "Activate approved configuration" })).toBeVisible();
  await page.getByLabel(/Activate config-v1, digest/).check();
  await page.getByRole("button", { name: "Activate approved configuration" }).click();
  await expect(page.getByText("Active revision 1.", { exact: false })).toBeVisible();
  expect(writes.slice(0, 3)).toEqual([
    { path: `/controls/configuration/proposals/${id}/preview`, body: { version: 1 } },
    {
      path: `/controls/configuration/proposals/${id}/approve`,
      body: { version: 2, previewDigest: "preview-digest", conflict: false },
    },
    { path: `/controls/configuration/proposals/${id}/activate`, body: { version: 3, approvalId: "approval-id" } },
  ]);
  await page.getByLabel("Public disable explanation").fill("Source quality under review");
  await page.getByLabel("Disable proposal version").fill("config-v2");
  await page.getByLabel(/Propose disabling pr_opened/).check();
  await page.getByRole("button", { name: "Propose metric disable" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Service confirmed" })).toContainText("Service confirmed");
  expect(writes[3]).toMatchObject({
    path: "/controls/configuration/proposals",
    body: {
      baseRevision: 1,
      version: "config-v2",
      document: {
        ...document,
        metrics: [{ ...document.metrics[0], enabled: false, reason: "Source quality under review" }],
      },
    },
  });
});

test("configuration self-approval and stale activation are unavailable and invalid JSON never sends", async ({
  page,
}) => {
  const writes = await controls(page, ["operator"]);
  const proposal = {
    id,
    owner: "1",
    version: "config-v1",
    versionNumber: 2,
    baseRevision: 0,
    status: "previewed",
    digest: "digest",
    document: { repositories: [], projects: [], metrics: [] },
    history: [],
    preview: {
      digest: "preview",
      configurationDigest: "digest",
      baseRevision: 0,
      source: { validUntil: Date.now() + 600000 },
      before: {},
      after: {},
    },
  };
  await page.route("**/controls/configuration", (r) =>
    r.fulfill({ json: { revision: 0, active: null, proposals: { [id]: proposal }, history: [] } }),
  );
  await page.goto("/admin");
  await expect(page.getByText("Another operator must independently approve your proposal.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve tested preview" })).toHaveCount(0);
  await page.getByLabel("New configuration version").fill("invalid-v1");
  await page.getByLabel("Configuration document (JSON)").fill("invalid json");
  await page.getByLabel(/Create a proposal against active revision/).check();
  await page.getByRole("button", { name: "Create configuration proposal" }).click();
  await expect(page.getByRole("alert")).toContainText("Nothing was submitted");
  expect(writes).toHaveLength(0);
  proposal.baseRevision = -1;
  await page.getByRole("button", { name: "Reload receipts" }).click();
  await expect(page.getByText(/This proposal is stale/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Preview configuration", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Activate approved configuration" })).toHaveCount(0);
});
