import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test.use({ storageState: { cookies: [], origins: [] } });

/** All control responses cross the real protected HTTP handler. Publication
 * references come from the native dispatcher, SQL snapshots and private store. */
async function service(page: Page, options: { quarantine?: boolean; empty?: boolean; zeroQuota?: boolean } = {}) {
  const { createHash } = await import("node:crypto");
  const { createPipeline } = await import(new URL("../../pipeline/src/index.mjs", import.meta.url).href);
  const { components, clock, fixtureId } = await import(
    new URL("../../pipeline/test/harness.mjs", import.meta.url).href
  );
  const { operatorHarness, operatorScopes, insertOperatorDelivery } = await import(
    new URL("../../pipeline/test/operator-harness.mjs", import.meta.url).href
  );
  const cleanup: Array<() => unknown> = [];
  const h = await operatorHarness(
    { after: (fn: () => unknown) => cleanup.push(fn) },
    {
      webhookDispatch: true,
      configure: (config: any) => {
        config.scopes = operatorScopes;
      },
      ...(options.empty ? { payloads: [] } : {}),
      ...(options.zeroQuota
        ? {
            quotaHeaders: {
              "x-ratelimit-resource": "core",
              "x-ratelimit-remaining": "0",
              "x-ratelimit-limit": "5000",
              "x-ratelimit-used": "5000",
            },
          }
        : {}),
    },
  );
  const deliveryId = fixtureId(1);
  if (options.quarantine) {
    await insertOperatorDelivery(h);
    const failing = new components.ingestion.InboxStore(h.db, 1);
    expect(await failing.fail(await failing.claim(), "source_unavailable", true)).toBe(true);
  }
  const token = "a".repeat(43),
    csrf = "b".repeat(43);
  h.controlsStore.transaction((state: any) => {
    state.sessions[createHash("sha256").update(token).digest("base64url")] = {
      actorId: "201",
      csrf,
      roles: ["operator"],
      roleVersion: "synthetic-roster-1",
      expires: Date.now() + 900_000,
    };
  });
  let allowed = true,
    runtime = h.runtime;
  const requestCounts = { health: 0, replayResult: 0, writes: 0 };
  let held: { kind: "health" | "result"; reached: () => void; release: () => void; wait: Promise<void> } | null = null;
  const start = async () => {
    const server = components.controls.createControlsServer({
      store: h.controlsStore,
      origin: "https://controls.synthetic.invalid",
      operations: runtime.operations,
      provider: {
        exchange() {
          throw Error("Established synthetic sessions only");
        },
        authorizationURL() {
          throw Error("Established synthetic sessions only");
        },
      },
      rolesForActor: (actorId: string) => ({
        roles: actorId === "201" ? ["operator"] : [],
        version: "synthetic-roster-1",
      }),
      authorizeRepository: async ({ actorId, repositoryId }: any) => ({
        allowed: allowed && actorId === "201" && repositoryId === 2,
        policyVersion: "synthetic-operator-policy",
        revision: "grant-1",
      }),
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return server;
  };
  let server = await start();
  await page.route("**/controls/**", async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    if (path.endsWith("/health")) requestCounts.health++;
    if (path.includes("/replays/")) requestCounts.replayResult++;
    if (request.method() === "POST") requestCounts.writes++;
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method: request.method(),
      headers: {
        cookie: `__Host-controls_session=${token}`,
        origin: "https://controls.synthetic.invalid",
        ...(request.method() === "POST"
          ? { "content-type": "application/json", "x-csrf-token": request.headers()["x-csrf-token"] ?? "" }
          : {}),
      },
      ...(request.method() === "POST" ? { body: request.postData() } : {}),
    });
    const body = await response.text();
    const delay = held;
    if (delay && (delay.kind === "health" ? path.endsWith("/health") : path.includes("/replays/"))) {
      delay.reached();
      await delay.wait;
    }
    await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body });
  });
  return {
    h,
    deliveryId,
    requestCounts,
    revoke() {
      allowed = false;
    },
    async quiet() {
      expect((await runtime.runOnce({ cutoff: clock() })).state).toBe("published");
    },
    async failSource() {
      h.setCollectionFailure(true);
      expect((await runtime.runOnce({ cutoff: clock() })).state).toBe("collecting");
    },
    async observeQuota() {
      await h.options.githubClient.forRepository(2).rest("installation:1", "/repos/synthetic-org/synthetic-repo");
    },
    async restartAndPublish() {
      const stale = await runtime.inbox.claim();
      expect(stale).toBeTruthy();
      await h.db.query(
        "UPDATE leaderboard_ingestion.inbox SET lease_until=clock_timestamp()-interval '1 second' WHERE delivery_id=$1",
        [deliveryId],
      );
      await new Promise<void>((resolve) => server.close(resolve));
      await runtime.stop();
      await h.reopenDatabase();
      runtime = await createPipeline(h.options);
      cleanup.push(() => runtime.stop());
      h.runtime = runtime;
      server = await start();
      expect(await runtime.inbox.complete(stale)).toBe(false);
      const lease = await runtime.inbox.claim();
      expect(lease.token).not.toBe(stale.token);
      expect(await runtime.inbox.complete(lease)).toBe(true);
      expect(await runtime.inbox.complete(lease)).toBe(false);
      expect(await runtime.dispatchOnce()).toBe("processed");
      expect(await runtime.dispatchOnce()).toBe("idle");
    },
    suppress() {
      h.controlsStore.transaction((state: any) => {
        state.profiles["101"] = { ...state.profiles["101"], suppressed: true };
      });
    },
    holdRead(kind: "health" | "result") {
      let reached = () => {},
        release = () => {};
      const ready = new Promise<void>((resolve) => {
        reached = resolve;
      });
      const wait = new Promise<void>((resolve) => {
        release = resolve;
      });
      held = { kind, reached, release, wait };
      return {
        ready,
        release: () => {
          release();
          held = null;
        },
      };
    },
    async close() {
      held?.release();
      await new Promise<void>((resolve) => server.close(resolve));
      for (const close of cleanup.reverse()) await close();
    },
  };
}

async function load(page: Page) {
  await page.goto("/admin");
  await page.getByLabel("Repository numeric ID").fill("2");
  await page.getByRole("button", { name: "Load protected diagnostics" }).click();
  await expect(page.getByRole("button", { name: "Read current operator health" })).toBeVisible();
}
async function queue(page: Page) {
  await page.getByRole("combobox", { name: "Replay reason", exact: true }).selectOption("source_recovered");
  const confirmation = page.getByRole("checkbox", { name: /Queue delivery/ });
  await confirmation.focus();
  await page.keyboard.press("Space");
  await expect(confirmation).toBeChecked();
  await page.getByRole("button", { name: "Queue audited inbox replay" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText(/Replay queued. Receipt/)).toBeVisible();
  await page.getByRole("button", { name: "Load protected diagnostics" }).click();
  await expect(page.getByRole("button", { name: /Read verified replay result for delivery/ })).toBeVisible();
}

test("an audited browser replay survives worker restart and reads every actual publication revision", async ({
  page,
}) => {
  const api = await service(page, { quarantine: true });
  try {
    await page.setViewportSize({ width: 320, height: 800 });
    await load(page);
    await queue(page);
    const read = page.getByRole("button", { name: /Read verified replay result for delivery/ });
    await read.click();
    const result = page.getByRole("region", { name: "Verified replay result", exact: true });
    await expect(result.getByRole("heading", { name: "Replay result: queued" })).toBeVisible();
    await expect(result.getByRole("list", { name: "Verified publication revisions" })).toHaveCount(0);
    await api.restartAndPublish();
    await read.focus();
    await page.keyboard.press("Enter");
    await expect(result.getByRole("heading", { name: "Replay result: published" })).toBeVisible();
    await expect(result.getByRole("listitem")).toHaveCount(2);
    const references = (
      await api.h.db.query(
        "SELECT scope_key,snapshot_id,revision FROM leaderboard_pipeline.snapshots ORDER BY scope_key",
      )
    ).rows;
    for (const reference of references) {
      await expect(result).toContainText(reference.scope_key);
      await expect(result).toContainText(reference.snapshot_id);
      await expect(result).toContainText(`Revision ${reference.revision}`);
    }
    expect(
      (await api.h.db.query("SELECT count(*)::integer AS count FROM leaderboard_ingestion.replay_receipts")).rows[0]
        .count,
    ).toBe(1);
    expect(
      (await api.h.db.query("SELECT count(*)::integer AS count FROM leaderboard_ingestion.replay_processing_results"))
        .rows[0].count,
    ).toBe(1);
    expect(
      (await api.h.db.query("SELECT count(*)::integer AS count FROM leaderboard_ingestion.observations")).rows[0].count,
    ).toBe(1);
    expect(api.requestCounts.writes).toBe(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    const before = { ...api.h.githubReads };
    await page.getByRole("button", { name: "Read current operator health" }).click();
    const health = page.getByRole("region", { name: "Operator health observations", exact: true });
    await expect(health.getByText("Collector state: progress.", { exact: true })).toBeVisible();
    await expect(health.getByRole("listitem")).toHaveCount(2);
    expect(api.h.githubReads).toEqual(before);
    await expect(result).toHaveCount(0);
    await expect(page.getByText(/SYNTHETIC_ISSUE_1|synthetic-test-token|sourceUrl/)).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  } finally {
    await api.close();
  }
});

test("health distinguishes an unattempted empty inbox, a fresh empty source and a failed collector read", async ({
  page,
}) => {
  const api = await service(page, { empty: true });
  try {
    await load(page);
    const read = page.getByRole("button", { name: "Read current operator health" });
    const health = page.getByRole("region", { name: "Operator health observations", exact: true });
    await read.click();
    await expect(health.getByText("Collector state: unknown.", { exact: true })).toBeVisible();
    await api.quiet();
    await read.click();
    await expect(health.getByText("Collector state: quiet.", { exact: true })).toBeVisible();
    await expect(health).toContainText("reported zero items and expected zero items");
    await api.failSource();
    await read.click();
    await expect(health.getByText("Collector state: disconnected.", { exact: true })).toBeVisible();
    await expect(health).toContainText("last collector read failed");
    await expect(page.getByText(/synthetic unavailable source|api.synthetic.invalid/)).toHaveCount(0);
    expect(api.requestCounts).toEqual({ health: 3, replayResult: 0, writes: 0 });
  } finally {
    await api.close();
  }
});

test("quota zero remains zero while unobserved resources remain unknown without a new source request", async ({
  page,
}) => {
  const api = await service(page, { zeroQuota: true });
  try {
    await api.observeQuota();
    const before = { ...api.h.githubReads };
    await load(page);
    await page.getByRole("button", { name: "Read current operator health" }).click();
    const core = page.getByRole("region", { name: "Quota core", exact: true });
    await expect(core.getByRole("heading", { name: "core: observed" })).toBeVisible();
    await expect(core.locator("dt", { hasText: "Observed remaining" }).locator("+ dd")).toHaveText("0");
    await expect(
      page
        .getByRole("region", { name: "Quota graphql", exact: true })
        .getByRole("heading", { name: "graphql: unknown" }),
    ).toBeVisible();
    expect(api.h.githubReads).toEqual(before);
    expect(api.requestCounts).toEqual({ health: 1, replayResult: 0, writes: 0 });
  } finally {
    await api.close();
  }
});

test("current suppression withholds previously verified replay references and failure clears private health", async ({
  page,
}) => {
  const api = await service(page, { quarantine: true });
  try {
    await load(page);
    await queue(page);
    await api.restartAndPublish();
    const read = page.getByRole("button", { name: /Read verified replay result for delivery/ });
    await read.click();
    const result = page.getByRole("region", { name: "Verified replay result", exact: true });
    await expect(result.getByRole("listitem")).toHaveCount(2);
    api.suppress();
    await read.click();
    await expect(result.getByRole("heading", { name: "Replay result: unavailable" })).toBeVisible();
    await expect(result.getByRole("listitem")).toHaveCount(0);
    await page.getByRole("button", { name: "Read current operator health" }).click();
    await expect(page.getByRole("region", { name: "Operator health observations", exact: true })).toContainText(
      "Publication state: unavailable",
    );
    api.revoke();
    await page.getByRole("button", { name: "Read current operator health" }).click();
    await expect(page.getByRole("alert")).toContainText("No health or publication success is inferred");
    await expect(page.getByRole("region", { name: "Operator health observations", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Read verified replay result for delivery/ })).toHaveCount(0);
    expect(api.requestCounts.writes).toBe(1);
  } finally {
    await api.close();
  }
});

for (const kind of ["health", "result"] as const) {
  for (const change of ["repository", "visibility"] as const) {
    test(`a late ${kind} response cannot restore private state after ${change} changes`, async ({ page }) => {
      const api = await service(page, { quarantine: kind === "result" });
      try {
        await load(page);
        if (kind === "result") await queue(page);
        const hold = api.holdRead(kind);
        const button =
          kind === "health"
            ? page.getByRole("button", { name: "Read current operator health" })
            : page.getByRole("button", { name: /Read verified replay result for delivery/ });
        await button.click();
        await hold.ready;
        if (change === "repository") await page.getByLabel("Repository numeric ID").fill("3");
        else
          await page.evaluate(() => {
            Object.defineProperty(document, "hidden", { configurable: true, value: true });
            document.dispatchEvent(new Event("visibilitychange"));
          });
        const completed = page.waitForResponse((response) =>
          kind === "health" ? response.url().endsWith("/health") : response.url().includes("/replays/"),
        );
        hold.release();
        await completed;
        await expect(page.getByRole("region", { name: "Operator health observations", exact: true })).toHaveCount(0);
        await expect(page.getByRole("region", { name: "Verified replay result", exact: true })).toHaveCount(0);
        await expect(page.getByRole("button", { name: "Read current operator health" })).toHaveCount(0);
        if (change === "repository")
          await expect(page.getByRole("button", { name: "Load protected diagnostics" })).toBeEnabled();
        else {
          await expect(page.getByRole("heading", { name: "Sign in required" })).toBeVisible();
          await expect(page.getByRole("group", { name: "Authorized administration" })).toHaveCount(0);
        }
        expect(api.requestCounts.writes).toBe(kind === "result" ? 1 : 0);
      } finally {
        await api.close();
      }
    });
  }
}
