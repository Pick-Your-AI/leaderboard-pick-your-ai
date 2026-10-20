import { test as base, expect, type Page } from "@playwright/test";
import { createControlsJourney, type ControlsJourney } from "./controls-journey-fixture.ts";
import { documentPolicyForApiBase } from "../security-policy.ts";

const test = base.extend<{ journey: ControlsJourney }>({
  journey: async ({ browser }, use) => {
    const journey = await createControlsJourney(browser);
    try {
      await use(journey);
    } finally {
      await journey.close();
    }
  },
});
test.setTimeout(90_000);

async function enterAccount(journey: ControlsJourney, actorId: string) {
  const user = await journey.open(actorId);
  const { page, context } = user;
  const metrics = page.waitForResponse(
    (response) => response.url() === journey.origin + "/api/v1/metrics" && response.request().method() === "GET",
  );
  const document = await page.goto(journey.origin + "/leaderboards?ui=api");
  expect(document?.status()).toBe(200);
  expect(document?.headers()["content-security-policy"]).toBe("frame-ancestors 'none'");
  await expect(page.locator('meta[http-equiv="Content-Security-Policy"]')).toHaveAttribute(
    "content",
    documentPolicyForApiBase("/api/v1"),
  );
  expect((await metrics).status()).toBe(200);
  await expect(page.getByRole("heading", { name: "Measures", exact: true })).toBeVisible();
  await expect(page.getByText("Loading current public data…", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(await context.cookies()).toEqual([]);
  const correction = page.getByRole("link", { name: "Corrections and privacy", exact: true });
  await correction.focus();
  await expect(correction).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Corrections and privacy", exact: true })).toBeVisible();
  const login = page.getByRole("link", { name: "Open configured account authentication", exact: true });
  await expect(login).toHaveAttribute("href", journey.origin + "/controls/auth/login");
  await login.focus();
  await expect(login).toBeFocused();
  const redirectsBefore = journey.authorizationRedirects.length;
  const loginResponse = page.waitForResponse((response) => response.url() === journey.origin + "/controls/auth/login");
  await page.keyboard.press("Enter");
  const redirected = await loginResponse;
  expect(redirected.status()).toBe(302);
  const bridge = new URL(redirected.headers().location!);
  expect(bridge.origin).toBe(journey.origin);
  expect(bridge.pathname).toBe("/__synthetic_controls_provider/authorize");
  expect([...bridge.searchParams.keys()]).toEqual(["state"]);
  await expect(page.getByRole("heading", { name: "Synthetic identity provider", exact: true })).toBeVisible();
  expect(journey.authorizationRedirects.slice(redirectsBefore)).toEqual([
    { status: 302, endpoint: "https://github.com/login/oauth/authorize" },
  ]);
  // The external provider hop is explicitly substituted at loopback. Browser
  // state/cookies and the actual Controls callback remain real; this is not a
  // cross-site SameSite or live OAuth-provider acceptance test.
  const choice = page.getByRole("link", { name: "Continue as synthetic account " + actorId, exact: true });
  await choice.focus();
  await expect(choice).toBeFocused();
  const callback = page.waitForResponse((response) => new URL(response.url()).pathname === "/controls/auth/callback");
  await page.keyboard.press("Enter");
  const returned = await callback;
  expect(returned.status()).toBe(303);
  expect(returned.headers().location).toBe(journey.origin + "/account");
  await expect(page).toHaveURL(journey.origin + "/account");
  await expect(page.getByText("Verified GitHub account ID: " + actorId + ".", { exact: false })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Your request receipts", exact: true })).toBeVisible();
  const cookies = await context.cookies(journey.origin);
  expect(
    cookies.map(({ name, domain, path, secure, httpOnly, sameSite }) => ({
      name,
      domain,
      path,
      secure,
      httpOnly,
      sameSite,
    })),
  ).toEqual([
    {
      name: "__Host-controls_session",
      domain: "127.0.0.1",
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  return user;
}
async function saveProfile(page: Page, bio: string) {
  await page.getByLabel("Bio (up to 500 characters)", { exact: true }).fill(bio);
  await page.getByLabel("Publish this optional profile", { exact: true }).check();
  await page.getByLabel("Replace my optional profile with these values", { exact: true }).check();
  const saved = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/controls/profile" && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Save profile", exact: true }).click();
  expect((await saved).status()).toBe(200);
  await expect(page.getByRole("status").filter({ hasText: "Service confirmed" })).toContainText(
    'Service confirmed: {"saved":true}',
  );
  await expect(page.getByLabel("Bio (up to 500 characters)", { exact: true })).toHaveValue(bio);
}
async function publicProjection(page: Page) {
  return page.evaluate(async () => {
    const response = await fetch("/controls/public", {
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
    });
    return { status: response.status, body: await response.json() };
  });
}
async function suppress(page: Page) {
  await page.getByLabel("Display choice", { exact: true }).selectOption("suppress");
  await page.getByLabel("Apply this choice to my account", { exact: true }).check();
  const saved = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/controls/profile/suppression" && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Apply display preference", exact: true }).click();
  const response = await saved;
  expect(response.status()).toBe(201);
  const receipt: { id: string; status: string; version: number } = await response.json();
  expect(receipt).toEqual({ id: expect.stringMatching(/^[a-f0-9-]{36}$/), status: "applied", version: 1 });
  await expect(page.getByRole("heading", { name: "Receipt " + receipt.id, exact: true })).toBeVisible();
  await expect(page.getByLabel("Display choice", { exact: true })).toHaveValue("suppress");
  return receipt;
}

test("synthetic Controls login persists a correction receipt across SQLite reopen", async ({ journey }) => {
  const { page, context } = await enterAccount(journey, "101");
  await saveProfile(page, "Synthetic owner profile");
  const detail = "Synthetic private correction detail for this local journey only.";
  await page.getByLabel("Request kind", { exact: true }).selectOption("correction");
  await page.getByRole("textbox", { name: "Details", exact: true }).fill(detail);
  const submitted = page.waitForResponse(
    (response) => response.url() === journey.origin + "/controls/requests" && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Submit request", exact: true }).click();
  const response = await submitted;
  expect(response.status()).toBe(201);
  const receipt: { id: string; status: string; version: number } = await response.json();
  expect(receipt).toEqual({ id: expect.stringMatching(/^[a-f0-9-]{36}$/), status: "pending", version: 1 });
  const article = page.getByRole("article").filter({
    has: page.getByRole("heading", { name: "Receipt " + receipt.id, exact: true }),
  });
  await expect(article).toContainText("correction · pending · version 1");
  await expect(article).toContainText(detail);
  const stored = journey.state().requests[receipt.id]!;
  expect(stored).toMatchObject({ ...receipt, owner: "101", kind: "correction", detail });
  expect(stored.history).toEqual([
    expect.objectContaining({ receipt: receipt.id, actor: "101", action: "submitted", version: 1 }),
  ]);
  expect(journey.state().audit.filter((event) => event.receipt === receipt.id)).toEqual(stored.history);
  await article.getByText("Audit history", { exact: true }).click();
  expect(JSON.parse(await article.locator("pre").innerText())).toEqual(stored.history);
  const persisted = journey.state();
  await journey.reopen();
  expect(journey.state()).toEqual(persisted);
  await page.reload();
  await expect(page.getByText("Verified GitHub account ID: 101.", { exact: false })).toBeVisible();
  await expect(article).toContainText("correction · pending · version 1");
  await expect(article).toContainText(detail);
  await article.getByText("Audit history", { exact: true }).click();
  expect(JSON.parse(await article.locator("pre").innerText())).toEqual(stored.history);
  const published = await publicProjection(page);
  expect(published.status).toBe(200);
  expect(JSON.stringify(published.body)).not.toContain(detail);
  expect(JSON.stringify(published.body)).not.toContain(receipt.id);
  expect(
    journey.requests.filter((request) => request.path === "/controls/requests" && request.method === "POST"),
  ).toHaveLength(1);
  expect(journey.exchanges).toEqual(["101"]);

  const signedOut = page.waitForResponse(
    (reply) => reply.url() === journey.origin + "/controls/logout" && reply.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  const logout = await signedOut;
  expect(logout.status()).toBe(200);
  expect(await logout.json()).toEqual({ revoked: true });
  await expect(page.getByRole("status").filter({ hasText: "Session revoked." })).toHaveText("Session revoked.");
  await expect(page.getByRole("heading", { name: "Sign in required", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Submit request", exact: true })).toHaveCount(0);
  expect(await context.cookies(journey.origin)).toEqual([]);
  // The real logout legitimately changes session state. Only later unauthorized
  // work must leave the durable receipt/profile/audit state and revision exact.
  const afterLogout = journey.state();
  const anonymous = await page.evaluate(async () => {
    const reply = await fetch("/controls/requests", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "correction", detail: "Must not create a receipt after logout." }),
    });
    return { status: reply.status, body: await reply.json() };
  });
  expect(anonymous).toEqual({ status: 401, body: { error: "Authentication required" } });
  expect(journey.state()).toEqual(afterLogout);
  journey.assertHealthy();
});

test("self suppression persists and other accounts cannot read or change its owner", async ({ journey }) => {
  const owner = await enterAccount(journey, "101");
  await saveProfile(owner.page, "Synthetic first owner");
  const visible = await publicProjection(owner.page);
  expect(visible.status).toBe(200);
  expect(visible.body.profiles).toContainEqual(expect.objectContaining({ actorId: "101" }));
  const first = await suppress(owner.page);
  expect(journey.state().requests[first.id]).toMatchObject({ ...first, owner: "101", kind: "privacy" });
  expect(journey.state().profiles["101"]?.suppressed).toBe(true);
  const suppressed = await publicProjection(owner.page);
  expect(suppressed.status).toBe(200);
  expect(suppressed.body.profiles).toEqual([]);

  const other = await enterAccount(journey, "202");
  await saveProfile(other.page, "Synthetic second owner");
  await expect(other.page.getByRole("heading", { name: "Receipt " + first.id, exact: true })).toHaveCount(0);
  const beforeDenial = journey.state();
  const denied = await other.page.evaluate(
    async ({ receiptId, ownerId }) => {
      const session = await fetch("/controls/session", {
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
      }).then((response) => response.json());
      const privateReceipt = await fetch("/controls/requests/" + receiptId, {
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
      });
      // Deliberately invalid owner fields use this browser's real session/CSRF.
      // No Cookie or Origin is supplied by the fixture or by this page script.
      const attempt = async (path: string, input: unknown) =>
        (
          await fetch(path, {
            method: "POST",
            credentials: "same-origin",
            cache: "no-store",
            redirect: "error",
            headers: { "content-type": "application/json", "x-csrf-token": session.csrf },
            body: JSON.stringify(input),
          })
        ).status;
      return {
        actorId: session.actorId,
        roles: session.roles,
        receipt: privateReceipt.status,
        suppression: await attempt("/controls/profile/suppression", { actorId: ownerId, suppressed: false }),
        profile: await attempt("/controls/profile", {
          actorId: ownerId,
          bio: "Must not replace another actor",
          highlights: [],
          public: true,
        }),
      };
    },
    { receiptId: first.id, ownerId: "101" },
  );
  expect(denied).toEqual({ actorId: "202", roles: [], receipt: 404, suppression: 400, profile: 400 });
  expect(journey.state()).toEqual(beforeDenial);

  const second = await suppress(other.page);
  const completed = journey.state();
  expect(completed.requests[second.id]).toMatchObject({ ...second, owner: "202", kind: "privacy" });
  expect(completed.profiles["202"]?.suppressed).toBe(true);
  expect(completed.profiles["101"]).toEqual(beforeDenial.profiles["101"]);
  expect(completed.requests[first.id]).toEqual(beforeDenial.requests[first.id]);
  await journey.reopen();
  expect(journey.state()).toEqual(completed);
  await other.page.reload();
  await expect(other.page.getByText("Verified GitHub account ID: 202.", { exact: false })).toBeVisible();
  await expect(other.page.getByRole("heading", { name: "Receipt " + second.id, exact: true })).toBeVisible();
  await expect(other.page.getByRole("heading", { name: "Receipt " + first.id, exact: true })).toHaveCount(0);
  const published = await publicProjection(other.page);
  expect(published.status).toBe(200);
  expect(published.body.profiles).toEqual([]);
  expect(journey.exchanges).toEqual(["101", "202"]);
  expect(
    journey.requests
      .filter((request) => request.method === "POST")
      .every((request) => request.hasCookie && request.origin === journey.origin),
  ).toBe(true);
  journey.assertHealthy();
});
