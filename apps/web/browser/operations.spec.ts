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
  for (const file of ["001_ingestion", "002_snapshots", "003_collection"])
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
  await db.query(
    "INSERT INTO leaderboard_ingestion.inbox(delivery_id,body_hash,envelope,state,attempts,reason_code) VALUES($1,$2,$3::jsonb,'quarantined',3,'source_unavailable')",
    [
      id,
      "a".repeat(64),
      JSON.stringify({ repositoryId: 9, installationId: 1, subjectId: "private-synthetic-subject" }),
    ],
  );
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
    await route.fulfill({
      status: response.status,
      headers: Object.fromEntries(response.headers),
      body: await response.text(),
    });
  });
  return {
    id,
    db,
    revoke: () => {
      allowed = false;
    },
    close: async () => {
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
