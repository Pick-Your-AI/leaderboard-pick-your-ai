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
