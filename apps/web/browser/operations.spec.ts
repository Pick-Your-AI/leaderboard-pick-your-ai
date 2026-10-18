import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
test.use({ storageState: { cookies: [], origins: [] } });
async function service(page: Page) {
  const { PGlite } = await import("@electric-sql/pglite");
  const { readFile, mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createHash } = await import("node:crypto");
  const { ControlStore } = await import(new URL("../../controls/src/store.mjs", import.meta.url).href);
  const { createControlsServer } = await import(new URL("../../controls/src/server.mjs", import.meta.url).href);
  const { OperatorInbox } = await import(new URL("../../../packages/ingestion/dist/operator.js", import.meta.url).href);
  const engine = new PGlite();
  for (const file of [
    "001_ingestion",
    "002_snapshots",
    "003_collection",
    "004_outbox_dispatch",
    "007_operator_replay_results",
  ])
    await engine.exec(
      await readFile(new URL(`../../../packages/ingestion/sql/${file}.up.sql`, import.meta.url), "utf8"),
    );
  const db = {
    query: (sql: string, params?: unknown[]) => engine.query(sql, params),
    transaction: (fn: any) =>
      engine.transaction((tx: any) => fn({ query: (sql: string, params?: unknown[]) => tx.query(sql, params) })),
  };
  await db.query(
    "INSERT INTO leaderboard_ingestion.repository_access(repository_id,installation_id,state) VALUES(9,1,'public')",
  );
  const id = "11111111-1111-1111-1111-111111111111";
  const addDelivery = (deliveryId: string, receivedAt = "2026-10-01T00:00:00.000Z", repositoryId = 9) =>
    db.query(
      "INSERT INTO leaderboard_ingestion.inbox(delivery_id,body_hash,envelope,state,attempts,reason_code,received_at) VALUES($1,$2,$3::jsonb,'quarantined',3,'source_unavailable',$4)",
      [
        deliveryId,
        "a".repeat(64),
        JSON.stringify({ repositoryId, installationId: 1, subjectId: "private-synthetic-subject" }),
        receivedAt,
      ],
    );
  await addDelivery(id);
  const directory = await mkdtemp(join(tmpdir(), "synthetic-operations-browser-"));
  const store = new ControlStore(join(directory, "controls.sqlite"));
  const token = "a".repeat(43),
    csrf = "b".repeat(43);
  store.transaction((s: any) => {
    s.sessions[createHash("sha256").update(token).digest("base64url")] = {
      actorId: "7",
      csrf,
      roles: ["operator"],
      roleVersion: "1",
      expires: Date.now() + 900000,
    };
  });
  let allowed = true;
  let heldPreview: Promise<void> | null = null;
  let releasePreview = () => {};
  const server = createControlsServer({
    store,
    origin: "https://controls.example.test",
    provider: {
      exchange() {
        throw Error("Unused synthetic OAuth");
      },
      authorizationURL() {
        throw Error("Unused synthetic OAuth");
      },
    },
    rolesForActor: () => ({ roles: ["operator"], version: "1" }),
    operations: new OperatorInbox(db),
    authorizeRepository: async ({ repositoryId }: any) => ({
      allowed: allowed && repositoryId === 9,
      policyVersion: "test-1",
      revision: "grant-1",
    }),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  await page.route("**/controls/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method: request.method(),
      headers: {
        cookie: `__Host-controls_session=${token}`,
        origin: "https://controls.example.test",
        ...(request.method() === "POST"
          ? { "content-type": "application/json", "x-csrf-token": request.headers()["x-csrf-token"] ?? "" }
          : {}),
      },
      ...(request.method() === "POST" ? { body: request.postData() } : {}),
    });
    const responseBody = await response.text();
    if (path.endsWith("/replay-window/preview") && heldPreview) await heldPreview;
    await route.fulfill({
      status: response.status,
      headers: Object.fromEntries(response.headers),
      body: responseBody,
    });
  });
  return {
    id,
    db,
    addDelivery,
    holdPreview: () => {
      heldPreview = new Promise<void>((resolve) => {
        releasePreview = resolve;
      });
      return () => releasePreview();
    },
    revoke: () => {
      allowed = false;
    },
    close: async () => {
      releasePreview();
      await new Promise<void>((resolve) => server.close(resolve));
      store.close();
      await engine.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
test("real operator HTTP and database bridge queues scoped replay and reads durable audit without source payload", async ({
  page,
}) => {
  const api = await service(page);
  try {
    await page.setViewportSize({ width: 320, height: 800 });
    await page.goto("/admin");
    await page.getByLabel("Repository numeric ID").fill("9");
    await page.getByRole("button", { name: "Load protected diagnostics" }).click();
    await expect(page.getByRole("button", { name: "Queue audited inbox replay" })).toBeVisible();
    await expect(page.getByText("private-synthetic-subject")).toHaveCount(0);
    await page.getByLabel("Replay reason").selectOption("source_recovered");
    await page.getByRole("checkbox", { name: /Queue delivery/ }).check();
    await page.getByRole("button", { name: "Queue audited inbox replay" }).click();
    await expect(page.getByText(/Replay queued. Receipt/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Queue audited inbox replay" })).toHaveCount(0);
    await page.getByRole("button", { name: "Load protected diagnostics" }).click();
    await expect(page.getByText(/Resulting publication revision: unknown/)).toBeVisible();
    const rows = await api.db.query("SELECT audit FROM leaderboard_ingestion.replay_receipts");
    expect(rows.rows).toHaveLength(1);
    expect((rows.rows[0] as { audit: unknown }).audit).toMatchObject({
      operatorId: "7",
      repositoryId: 9,
      reason: "source_recovered",
      resultingRevision: null,
    });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  } finally {
    await api.close();
  }
});

async function openWindow(page: Page) {
  await page.goto("/admin");
  await page.getByLabel("Repository numeric ID").fill("9");
  await page.getByRole("button", { name: "Load protected diagnostics" }).click();
  await page.getByLabel("Received from (UTC, inclusive)").fill("2026-10-01T00:00");
  await page.getByLabel("Received until (UTC, exclusive)").fill("2026-10-02T00:00");
}

test("reviewed UTC window queues only selected deliveries, reads every batch receipt and fits a narrow screen", async ({
  page,
}) => {
  const api = await service(page);
  try {
    await api.addDelivery("22222222-2222-2222-2222-222222222222", "2026-10-01T23:59:59.999Z");
    await api.addDelivery("33333333-3333-3333-3333-333333333333", "2026-10-02T00:00:00.000Z");
    await page.setViewportSize({ width: 320, height: 800 });
    await openWindow(page);
    await page.getByRole("button", { name: "Preview retained delivery window" }).click();
    await expect(page.getByText("2 quarantined deliveries selected for review.")).toBeVisible();
    const selection = page.getByRole("list", { name: "Deliveries selected for replay" });
    await expect(selection.getByRole("listitem")).toHaveCount(2);
    await expect(selection).not.toContainText("33333333-3333-3333-3333-333333333333");
    await expect(page.getByText("private-synthetic-subject")).toHaveCount(0);
    expect((await api.db.query("SELECT * FROM leaderboard_ingestion.replay_receipts")).rows).toHaveLength(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    const confirmation = page.getByRole("checkbox", { name: /Queue these 2 deliveries/ });
    await confirmation.focus();
    await page.keyboard.press("Space");
    await expect(confirmation).toBeChecked();
    await page.getByRole("button", { name: "Queue reviewed delivery window" }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByText(/Window replay queued. Batch/)).toContainText("2 durable delivery receipts");
    await expect(selection).toHaveCount(0);
    await page.getByRole("button", { name: "Load protected diagnostics" }).click();
    await expect(page.getByText(/Resulting publication revision: unknown/)).toHaveCount(2);
    await expect(page.getByText(/Batch .* received from 2026-10-01T00:00:00.000Z/)).toHaveCount(2);
    const receipts = (await api.db.query("SELECT audit FROM leaderboard_ingestion.replay_receipts")).rows as Array<{
      audit: any;
    }>;
    expect(receipts).toHaveLength(2);
    expect(new Set(receipts.map((row) => row.audit.batchId)).size).toBe(1);
    for (const { audit } of receipts)
      expect(audit).toMatchObject({ operatorId: "7", repositoryId: 9, batchSize: 2, resultingRevision: null });
  } finally {
    await api.close();
  }
});

test("editing a reviewed window clears confirmation and an empty window offers no replay", async ({ page }) => {
  const api = await service(page);
  try {
    await openWindow(page);
    await page.getByRole("button", { name: "Preview retained delivery window" }).click();
    await page.getByRole("checkbox", { name: /Queue this 1 delivery/ }).check();
    await page.getByLabel("Maximum selected deliveries").fill("10");
    await expect(page.getByRole("button", { name: "Queue reviewed delivery window" })).toHaveCount(0);
    await page.getByRole("button", { name: "Preview retained delivery window" }).click();
    await expect(page.getByRole("checkbox", { name: /Queue this 1 delivery/ })).not.toBeChecked();
    await page.getByLabel("Received from (UTC, inclusive)").fill("2026-09-01T00:00");
    await page.getByLabel("Received until (UTC, exclusive)").fill("2026-09-02T00:00");
    await page.getByRole("button", { name: "Preview retained delivery window" }).click();
    await expect(page.getByText("0 quarantined deliveries selected for review.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Queue reviewed delivery window" })).toHaveCount(0);
    expect((await api.db.query("SELECT * FROM leaderboard_ingestion.replay_receipts")).rows).toHaveLength(0);
  } finally {
    await api.close();
  }
});

test("changed membership and revoked grants clear window state without retrying or queuing a prefix", async ({
  page,
}) => {
  const api = await service(page);
  try {
    await openWindow(page);
    await page.getByRole("button", { name: "Preview retained delivery window" }).click();
    await expect(page.getByText("1 quarantined delivery selected for review.")).toBeVisible();
    await api.addDelivery("22222222-2222-2222-2222-222222222222");
    await page.getByRole("checkbox", { name: /Queue this 1 delivery/ }).check();
    await page.getByRole("button", { name: "Queue reviewed delivery window" }).click();
    await expect(page.getByRole("alert")).toContainText("Window replay was not confirmed");
    await expect(page.getByRole("list", { name: "Deliveries selected for replay" })).toHaveCount(0);
    expect((await api.db.query("SELECT * FROM leaderboard_ingestion.replay_receipts")).rows).toHaveLength(0);
    await openWindow(page);
    await page.getByLabel("Maximum selected deliveries").fill("1");
    await page.getByRole("button", { name: "Preview retained delivery window" }).click();
    await expect(page.getByRole("alert")).toContainText("Nothing was queued by this preview");
    await expect(page.getByRole("button", { name: "Queue reviewed delivery window" })).toHaveCount(0);
    await openWindow(page);
    await page.getByRole("button", { name: "Preview retained delivery window" }).click();
    await expect(page.getByText("2 quarantined deliveries selected for review.")).toBeVisible();
    api.revoke();
    await page.getByRole("checkbox", { name: /Queue these 2 deliveries/ }).check();
    await page.getByRole("button", { name: "Queue reviewed delivery window" }).click();
    await expect(page.getByRole("alert")).toContainText("Window replay was not confirmed");
    await expect(page.getByRole("list", { name: "Deliveries selected for replay" })).toHaveCount(0);
    expect((await api.db.query("SELECT * FROM leaderboard_ingestion.replay_receipts")).rows).toHaveLength(0);
  } finally {
    await api.close();
  }
});

test("a late private window preview cannot restore state after repository selection changes", async ({ page }) => {
  const api = await service(page);
  try {
    await openWindow(page);
    const release = api.holdPreview();
    const pending = page.waitForRequest((request) => request.url().endsWith("/replay-window/preview"));
    await page.getByRole("button", { name: "Preview retained delivery window" }).click();
    await pending;
    await page.getByLabel("Repository numeric ID").fill("8");
    const completion = page.waitForResponse((response) => response.url().endsWith("/replay-window/preview"));
    release();
    await completion;
    await expect(page.getByRole("list", { name: "Deliveries selected for replay" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Queue reviewed delivery window" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Load protected diagnostics" })).toBeEnabled();
    expect((await api.db.query("SELECT * FROM leaderboard_ingestion.replay_receipts")).rows).toHaveLength(0);
  } finally {
    await api.close();
  }
});
test("operator repository denial clears prior private diagnostics without inventing health", async ({ page }) => {
  const api = await service(page);
  try {
    await page.goto("/admin");
    await page.getByLabel("Repository numeric ID").fill("9");
    await page.getByRole("button", { name: "Load protected diagnostics" }).click();
    await expect(page.getByRole("button", { name: "Queue audited inbox replay" })).toBeVisible();
    api.revoke();
    await page.getByRole("button", { name: "Load protected diagnostics" }).click();
    await expect(page.getByRole("alert")).toContainText("Diagnostics unavailable or access changed");
    await expect(page.getByRole("button", { name: "Queue audited inbox replay" })).toHaveCount(0);
    expect((await api.db.query("SELECT * FROM leaderboard_ingestion.replay_receipts")).rows).toHaveLength(0);
  } finally {
    await api.close();
  }
});
