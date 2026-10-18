import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { evidenceService } from "./evidenceHarness.ts";

// Actual service handlers with explicitly synthetic inputs; no production data.
test.use({ storageState: { cookies: [], origins: [] } });
const at = "2026-10-17T12:00:00.000Z";
const selectedBoard = "/leaderboards/pr_merged?ui=api&repository=repo-1&workstream=triage&actors=user&limit=1";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() =>
    Object.defineProperty(window, "EventSource", { value: undefined, configurable: true }),
  );
  await page.clock.install({ time: new Date(at) });
  await page.clock.pauseAt(new Date(Date.parse(at) + 1000));
});

for (const failure of ["source failure", "offline transport"] as const) {
  test(`${failure} preserves a dated snapshot reference, clears personal content and retries the exact pin`, async ({
    page,
  }) => {
    const api = await evidenceService(page);
    let disconnected = false;
    await page.route("**/api/v1/boards?**", async (route) => {
      if (disconnected) await route.abort("internetdisconnected");
      else await route.fallback();
    });
    try {
      await page.goto(selectedBoard);
      const actor = page.getByRole("link", { name: "Synthetic API A", exact: true });
      await expect(actor).toBeVisible();
      await expect
        .poll(() =>
          api.calls
            .filter((url) => url.pathname.endsWith("/boards"))
            .at(-1)
            ?.searchParams.get("snapshot"),
        )
        .toBe("api-1");
      api.next();
      if (failure === "source failure") api.fail();
      else disconnected = true;
      await page.getByRole("button", { name: "Recheck current publication controls" }).click();
      const error = page.getByRole("alert");
      await expect(error.getByRole("heading", { name: "Public read unavailable", exact: true })).toBeVisible();
      await expect(actor).toHaveCount(0);
      await expect(page.getByRole("link", { name: "e-api-a", exact: true })).toHaveCount(0);
      await expect(error.getByRole("heading", { name: "Last verified snapshot", exact: true })).toBeVisible();
      await expect(error).toContainText("api-1");
      await expect(error.locator("time")).toHaveAttribute("datetime", at);
      await expect(page.getByText("SENSITIVE_SYNTHETIC_PROVIDER_FAILURE", { exact: false })).toHaveCount(0);
      api.recover();
      disconnected = false;
      const retry = error.getByRole("button", { name: "Retry this selection", exact: true });
      await retry.focus();
      await page.keyboard.press("Enter");
      await expect(actor).toBeVisible();
      await expect(page.getByRole("region", { name: "Snapshot provenance" })).toContainText("api-1");
      await expect(page.getByRole("row").filter({ has: actor }).locator("strong")).toHaveText("2");
      const retried = api.calls.filter((url) => url.pathname.endsWith("/boards")).at(-1)!;
      expect(Object.fromEntries(retried.searchParams)).toMatchObject({
        snapshot: "api-1",
        repository: "repo-1",
        workstream: "triage",
        actors: "user",
        limit: "1",
      });
      await expect(page.getByText("Update held: snapshot api-2 is available.", { exact: true })).toBeVisible();

      // A different scope must never borrow the previous scope's successful receipt.
      api.fail();
      await page.getByText("Exact scope and snapshot", { exact: true }).click();
      await page.getByLabel("repository", { exact: true }).fill("repo-2");
      await page.getByRole("button", { name: "Read exact scope", exact: true }).click();
      await expect(error).toBeVisible();
      await expect(error.getByRole("heading", { name: "Last verified snapshot", exact: true })).toHaveCount(0);
      await expect(actor).toHaveCount(0);
      api.recover();
      await error.getByRole("button", { name: "Retry this selection", exact: true }).click();
      await expect(page.getByRole("region", { name: "Snapshot provenance" })).toContainText("api-2");
      await expect(actor).toHaveCount(0);
      await expect(
        page.getByText(
          "No public rows are available in this selection. An empty page does not establish zero activity.",
          { exact: true },
        ),
      ).toBeVisible();
      expect(
        api.calls
          .filter((url) => url.pathname.endsWith("/boards"))
          .at(-1)
          ?.searchParams.get("repository"),
      ).toBe("repo-2");
    } finally {
      await api.close();
    }
  });
}

test("rate limiting has accessible feedback and a keyboard recovery at a narrow viewport", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  const api = await evidenceService(page);
  let limited = false;
  await page.route("**/api/v1/boards?**", async (route) => {
    if (limited)
      await route.fulfill({
        status: 429,
        contentType: "application/json",
        body: JSON.stringify({ error: "rate_limited" }),
      });
    else await route.fallback();
  });
  try {
    await page.goto(selectedBoard);
    const actor = page.getByRole("link", { name: "Synthetic API A", exact: true });
    await expect(actor).toBeVisible();
    limited = true;
    await page.getByRole("button", { name: "Recheck current publication controls" }).click();
    const error = page.getByRole("alert");
    await expect(error.getByRole("heading", { name: "Requests temporarily limited", exact: true })).toBeVisible();
    await expect(error).toContainText("Wait before retrying this selection.");
    await expect(error.locator("time")).toHaveAttribute("datetime", at);
    await expect(actor).toHaveCount(0);
    await page.clock.resume();
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    limited = false;
    await error.getByRole("button", { name: "Retry this selection", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(actor).toBeVisible();
    await expect(error).toHaveCount(0);
  } finally {
    await api.close();
  }
});

test("a pending initial public read shows loading without invented contributor data or a prior receipt", async ({
  page,
}) => {
  const api = await evidenceService(page);
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/v1/boards?**", async (route) => {
    await pending;
    await route.fallback();
  });
  try {
    await page.goto(selectedBoard);
    await expect(page.getByRole("status").filter({ hasText: "Loading current public data" })).toBeVisible();
    await expect(page.getByRole("table")).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Synthetic API A", exact: true })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Last verified snapshot", exact: true })).toHaveCount(0);
    await expect(page.getByRole("complementary", { name: "Synthetic data notice" })).toHaveCount(0);
    release();
    await expect(page.getByRole("link", { name: "Synthetic API A", exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: "Snapshot provenance" })).toContainText("api-1");
  } finally {
    release();
    await api.close();
  }
});

for (const field of ["generatedAt", "head.publishedAt"] as const) {
  test(`an invalid ${field} response cannot replace the last verified snapshot`, async ({ page }) => {
    const api = await evidenceService(page);
    try {
      const response = page.waitForResponse((value) => new URL(value.url()).pathname === "/api/v1/boards");
      await page.goto(selectedBoard);
      const original = await (await response).json();
      const actor = page.getByRole("link", { name: "Synthetic API A", exact: true });
      await expect(actor).toBeVisible();
      const invalidDate = "2026-02-30T00:00:00Z";
      const malformed =
        field === "generatedAt"
          ? { ...original, generatedAt: invalidDate }
          : { ...original, head: { ...original.head, publishedAt: invalidDate } };
      await page.route("**/api/v1/boards?**", (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(malformed),
        }),
      );
      await page.getByRole("button", { name: "Recheck current publication controls" }).click();
      const error = page.getByRole("alert");
      await expect(error).toContainText("invalid_api_response");
      await expect(actor).toHaveCount(0);
      await expect(error.getByRole("heading", { name: "Last verified snapshot", exact: true })).toBeVisible();
      await expect(error.locator("time")).toHaveAttribute("datetime", at);
      await expect(error).not.toContainText(invalidDate);
    } finally {
      await api.close();
    }
  });
}

test("a failed wall retains only its dated snapshot reference and retries the frozen pin", async ({ page }) => {
  const api = await evidenceService(page);
  try {
    await page.goto("/live?ui=api&mode=frozen&boards=pr_merged&snapshot=api-1&repository=repo-1&format=overlay");
    const actor = page.getByRole("link", { name: "Synthetic API A", exact: true });
    await expect(actor).toBeVisible();
    api.next();
    api.fail();
    await page.getByRole("button", { name: "Recheck current publication controls" }).click();
    await expect(page.getByText("PUBLIC READ LOST — DISPLAY CLEARED", { exact: true })).toBeVisible();
    const error = page.getByRole("alert");
    await expect(error.getByRole("heading", { name: "Last verified snapshot", exact: true })).toBeVisible();
    await expect(error).toContainText("api-1");
    await expect(error.locator("time")).toHaveAttribute("datetime", at);
    await expect(actor).toHaveCount(0);
    await expect(page.getByRole("table")).toHaveCount(0);
    await expect(page.locator(".api-wall-provenance")).toHaveCount(0);
    await expect(page.getByText("Recently reconciled", { exact: true })).toHaveCount(0);
    api.recover();
    await page.getByRole("button", { name: "Retry frozen snapshot", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(actor).toBeVisible();
    await expect(page.getByRole("region", { name: "Snapshot provenance" })).toContainText("api-1");
    await expect(page.getByRole("row").filter({ has: actor }).locator("strong")).toHaveText("2");
    expect(
      Object.fromEntries(api.calls.filter((url) => url.pathname.endsWith("/boards")).at(-1)!.searchParams),
    ).toMatchObject({ snapshot: "api-1", repository: "repo-1" });
  } finally {
    await api.close();
  }
});

for (const query of ["mode=cycle&boards=not-a-metric", "mode=bogus"] as const) {
  test(`invalid prototype wall ${query} keeps its banner, landmarks and narrow-screen accessibility`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 900 });
    await page.clock.resume();
    await page.goto(`/live?ui=prototype&${query}`);
    await expect(page.getByRole("complementary", { name: "Synthetic data notice" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
    await expect(page.getByRole("main")).toHaveCount(1);
    await expect(page.getByRole("table")).toHaveCount(0);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  });
}

test("a response rejected by the registry cannot replace the last verified snapshot date", async ({ page }) => {
  const api = await evidenceService(page);
  try {
    const response = page.waitForResponse((value) => new URL(value.url()).pathname === "/api/v1/boards");
    await page.goto(selectedBoard);
    const original = await (await response).json();
    const actor = page.getByRole("link", { name: "Synthetic API A", exact: true });
    await expect(actor).toBeVisible();
    const rejectedDate = "2026-10-18T09:00:00.000Z";
    await page.route("**/api/v1/boards?**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ...original, generatedAt: rejectedDate, metricDefinitionVersion: "unaccepted-policy" }),
      });
    });
    await page.getByRole("button", { name: "Recheck current publication controls" }).click();
    const error = page.getByRole("alert");
    await expect(error).toContainText("metric_definition_unavailable");
    await expect(actor).toHaveCount(0);
    await expect(error.getByRole("heading", { name: "Last verified snapshot", exact: true })).toBeVisible();
    await expect(error.locator("time")).toHaveAttribute("datetime", at);
    await expect(error).not.toContainText(rejectedDate);
  } finally {
    await api.close();
  }
});

test("an initially missing pinned snapshot has no invented data or previous receipt and can restart explicitly", async ({
  page,
}) => {
  const api = await evidenceService(page);
  try {
    await page.goto(`${selectedBoard}&snapshot=missing-snapshot`);
    const error = page.getByRole("alert");
    await expect(error.getByRole("heading", { name: "Selection expired or revoked", exact: true })).toBeVisible();
    await expect(error.getByRole("heading", { name: "Last verified snapshot", exact: true })).toHaveCount(0);
    await expect(page.getByRole("table")).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Synthetic API A", exact: true })).toHaveCount(0);
    await expect(page.getByRole("complementary", { name: "Synthetic data notice" })).toHaveCount(0);
    await error.getByRole("button", { name: "Retry this selection", exact: true }).click();
    await expect(error.getByRole("heading", { name: "Selection expired or revoked", exact: true })).toBeVisible();
    await expect
      .poll(() =>
        api.calls
          .filter((url) => url.pathname.endsWith("/boards"))
          .at(-1)
          ?.searchParams.get("snapshot"),
      )
      .toBe("missing-snapshot");
    await error.getByRole("link", { name: "Restart from the current publication", exact: true }).click();
    await expect(page.getByRole("link", { name: "Synthetic API A", exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: "Snapshot provenance" })).toContainText("api-1");
    await expect(page).not.toHaveURL(/snapshot=missing-snapshot/);
  } finally {
    await api.close();
  }
});
