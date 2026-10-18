import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
const id = "11111111-1111-1111-1111-111111111111";
async function controls(page: Page, roles: string[] = [], expires = Date.now() + 600000) {
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
      "/controls/session": { actorId: "1", csrf: "a".repeat(43), roles, expires },
      "/controls/profile": { bio: "Saved bio", highlights: [], public: false, suppressed: false },
      "/controls/requests": {
        requests: [
          {
            id,
            owner: "2",
            kind: "evidence",
            status: "pending",
            version: 3,
            detail: "Evidence for independent review",
            history: [],
            collaborators: {},
          },
        ],
      },
      "/controls/invitations": { invitations: [] },
      "/controls/configuration": { revision: 0, proposals: {} },
      "/controls/spotlights/queue": { nominations: [] },
    };
    await route.fulfill({ json: responses[path] ?? {} });
  });
  return writes;
}
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
  await expect(page.getByRole("status")).toContainText("Service confirmed");
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
  await expect(page.getByRole("status")).toContainText("Service confirmed");
  expect(writes).toHaveLength(0);
});

test("locale acceptance submits the explicitly reviewed fact, language, policy and merge revision", async ({
  page,
}) => {
  const writes = await controls(page, ["reviewer"]);
  await page.goto("/admin");
  await page.getByLabel("Review decision").selectOption("accept");
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
  await expect(page.getByRole("status")).toContainText("Service confirmed");
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({
    path: `/controls/requests/${id}/review`,
    body: {
      version: 3,
      decision: "accept",
      policyVersion: "synthetic-metric-v1",
      sourceReviewedPublic: true,
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
  await expect(page.getByRole("status")).toContainText(id);
  expect(writes[0]).toMatchObject({
    path: "/controls/requests",
    body: { kind: "privacy", detail: "Please review my account display." },
  });
  await page.getByLabel("Display choice").selectOption("suppress");
  await page.getByLabel("Apply this choice to my account").check();
  await page.getByRole("button", { name: "Apply display preference" }).click();
  await expect(page.getByRole("status")).toContainText(id);
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
  await expect(page.getByRole("status")).toContainText("Service confirmed");
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
  await expect(page.getByRole("status")).toContainText("Service confirmed");
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
