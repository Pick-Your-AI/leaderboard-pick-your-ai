import { test, expect } from "@playwright/test";

test.use({ storageState: { cookies: [], origins: [] } });

test("operator drill retains actual replay and applied exclusion receipts across interrupted commits and reopen", async ({
  page,
}, testInfo) => {
  const { operatorOperatingHarness, operatorDrillFixtureHash } = await import(
    new URL("../../pipeline/test/operator-operating-harness.mjs", import.meta.url).href
  );
  const drill = await operatorOperatingHarness();
  let user: any;
  const http: Array<{ method: string; path: string; status: number }> = [];
  const checkpoints: Array<Record<string, unknown>> = [];
  const hostDecisions: Array<Record<string, unknown>> = [];
  const board = async (pin = "") => {
    const response = await fetch(
      `${drill.publicAddress}/api/v1/boards?metric=issues_opened${pin ? `&snapshot=${pin}` : ""}`,
    );
    expect(response.status).toBe(200);
    return response.json();
  };
  const account = async (id: string, admin = false) => {
    user = drill.users[id];
    await page.goto(admin ? "/admin" : "/account");
    await expect(page.getByText(new RegExp(`Verified GitHub account ID: ${id}\\.`))).toBeVisible();
  };
  const loadOperations = async () => {
    await account("201", true);
    await page.getByLabel("Repository numeric ID").fill("2");
    await page.getByRole("button", { name: "Load protected diagnostics", exact: true }).click();
    await expect(page.getByRole("button", { name: "Read current operator health", exact: true })).toBeVisible();
  };
  const receipt = (id: string) =>
    page.locator("article").filter({ has: page.getByRole("heading", { name: `Receipt ${id}`, exact: true }) });
  try {
    await page.route("**/controls/**", async (route) => {
      const request = route.request(),
        url = new URL(request.url());
      const response = await fetch(drill.controlsAddress + url.pathname + url.search, {
        method: request.method(),
        redirect: "error",
        headers: {
          cookie: user?.cookie ?? "",
          origin: drill.fixture.origin,
          ...(request.method() === "POST"
            ? { "content-type": "application/json", "x-csrf-token": request.headers()["x-csrf-token"] ?? "" }
            : {}),
        },
        ...(request.method() === "POST" ? { body: request.postData()! } : {}),
      });
      http.push({ method: request.method(), path: url.pathname, status: response.status });
      await route.fulfill({
        status: response.status,
        headers: Object.fromEntries(response.headers),
        body: await response.text(),
      });
    });
    await page.route("**/api/v1/**", async (route) => {
      const url = new URL(route.request().url());
      const response = await fetch(drill.publicAddress + url.pathname + url.search, { redirect: "error" });
      http.push({ method: "GET", path: url.pathname, status: response.status });
      await route.fulfill({
        status: response.status,
        headers: Object.fromEntries(response.headers),
        body: await response.text(),
      });
    });
    const before = await board();
    expect(before.rows.map((row: any) => row.actorId).sort()).toEqual(["101", "102"]);
    const unaffected = before.rows.find((row: any) => row.actorId === "102");
    const initial = await drill.checkpoint("before any operation");
    expect(initial.replayReceipts).toHaveLength(0);
    expect(initial.corrections).toHaveLength(0);
    checkpoints.push(initial);

    await test.step("anonymous and wrong-scope readers cannot replay; the actual form requires scoped confirmation", async () => {
      await page.goto("/admin");
      await expect(page.getByRole("button", { name: "Load protected diagnostics", exact: true })).toHaveCount(0);
      expect((await drill.request("/controls/operations/2")).status).toBe(401);
      expect((await drill.request("/controls/operations/2", { user: drill.users["303"] })).status).toBe(403);
      expect((await drill.request("/controls/operations/3", { user: drill.users["201"] })).status).toBe(403);
      const status = await drill.request("/controls/operations/2", { user: drill.users["201"] });
      expect(status.status).toBe(200);
      expect(status.data.quarantined).toHaveLength(1);
      const row = status.data.quarantined[0];
      const input = {
        deliveryId: row.deliveryId,
        expectedRevision: row.revision,
        reason: "source_recovered",
        confirmed: true,
      };
      expect(
        (await drill.request("/controls/operations/2/replay", { user: drill.users["201"], input, csrf: "wrong" }))
          .status,
      ).toBe(403);
      expect(
        (
          await drill.request("/controls/operations/2/replay", {
            user: drill.users["201"],
            input: { ...input, confirmed: false },
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await drill.request("/controls/operations/2/replay", {
            user: drill.users["201"],
            input: { ...input, expectedRevision: "0".repeat(64) },
          })
        ).status,
      ).toBe(409);
      expect((await drill.checkpoint("after replay denials")).replayReceipts).toHaveLength(0);
      await loadOperations();
      await page.getByRole("combobox", { name: "Replay reason", exact: true }).selectOption("source_recovered");
      await page.getByRole("button", { name: "Queue audited inbox replay", exact: true }).click();
      expect((await drill.checkpoint("unconfirmed form")).replayReceipts).toHaveLength(0);
      await page.getByRole("checkbox", { name: /Queue delivery/ }).check();
      await page.getByRole("button", { name: "Queue audited inbox replay", exact: true }).focus();
      await page.keyboard.press("Enter");
      await expect(page.getByText(/Replay queued. Receipt/)).toBeVisible();
    });

    await test.step("the durable replay survives a stale worker and exposes only its verified resulting publications", async () => {
      await page.getByRole("button", { name: "Load protected diagnostics", exact: true }).click();
      const read = page.getByRole("button", { name: /Read verified replay result for delivery/ });
      await read.click();
      await expect(page.getByRole("heading", { name: "Replay result: queued", exact: true })).toBeVisible();
      const queued = await drill.checkpoint("replay queued");
      expect(queued.replayReceipts).toHaveLength(1);
      expect(queued.replayResults).toHaveLength(0);
      expect(queued.replayReceipts[0].audit).toMatchObject({
        operatorId: "201",
        repositoryId: 2,
        reason: "source_recovered",
        resultingRevision: null,
      });
      expect(queued.replayReceipts[0].audit.beforeRevision).not.toBe(queued.replayReceipts[0].audit.queuedRevision);
      checkpoints.push(queued);
      hostDecisions.push(await drill.restartQueuedReplay());
      await loadOperations();
      await page.getByRole("button", { name: /Read verified replay result for delivery/ }).click();
      const region = page.getByRole("region", { name: "Verified replay result", exact: true });
      await expect(region.getByRole("heading", { name: "Replay result: published", exact: true })).toBeVisible();
      const references = (
        await drill.db.query(
          `SELECT publication.scope_key,publication.snapshot_id,snapshot.revision
          FROM leaderboard_ingestion.replay_processing_results AS processed
          JOIN leaderboard_ingestion.outbox AS notice ON notice.event_key=processed.event_key
          JOIN leaderboard_pipeline.dispatch_publications AS publication
            ON publication.operation_key=notice.operation->>'operationKey'
          JOIN leaderboard_pipeline.snapshots AS snapshot
            ON snapshot.snapshot_id=publication.snapshot_id AND snapshot.scope_key=publication.scope_key
          WHERE processed.receipt_id=$1 ORDER BY publication.scope_key`,
          [queued.replayReceipts[0].receipt_id],
        )
      ).rows;
      expect(references).toHaveLength(2);
      hostDecisions.push({ replayReceiptId: queued.replayReceipts[0].receipt_id, publicationReferences: references });
      for (const ref of references) {
        await expect(region).toContainText(ref.scope_key);
        await expect(region).toContainText(ref.snapshot_id);
        await expect(region).toContainText(`Revision ${ref.revision}`);
      }
      const published = await drill.checkpoint("replay published after physical store reopen");
      expect(published.replayReceipts).toEqual(queued.replayReceipts);
      expect(published.replayResults).toHaveLength(1);
      checkpoints.push(published);
      await testInfo.attach("operator-replay-result", { body: await region.screenshot(), contentType: "image/png" });
    });

    await test.step("a mounted correction request stays pending until the specialist capability actually applies exclusion", async () => {
      await account("101");
      await page.getByRole("combobox", { name: "Request kind", exact: true }).selectOption("correction");
      await page.getByRole("textbox", { name: "Details", exact: true }).fill(drill.fixture.correction.reason);
      await page
        .getByRole("textbox", { name: "Public GitHub source URL", exact: true })
        .fill(drill.fixture.correction.locator);
      await page.getByRole("button", { name: "Submit request", exact: true }).click();
      await expect(page.getByRole("heading", { name: /^Receipt / })).toHaveCount(1);
      const requests = Object.values(drill.store.read().requests) as any[];
      expect(requests).toHaveLength(1);
      const requested = requests[0];
      await expect(receipt(requested.id)).toContainText("correction · pending · version 1");
      expect((await board(before.snapshotId)).rows.map((row: any) => row.actorId).sort()).toEqual(["101", "102"]);
      expect((await drill.checkpoint("only requested")).corrections).toHaveLength(0);
      await account("201", true);
      await expect(receipt(requested.id)).toContainText("Acceptance requires verified specialist downstream handling");
      expect(
        (
          await drill.request(`/controls/requests/${requested.id}/review`, {
            user: drill.users["201"],
            input: { version: requested.version, decision: "accept", reason: "Synthetic review", conflict: false },
          })
        ).status,
      ).toBe(409);
      expect((await drill.request(`/controls/requests/${requested.id}`, { user: drill.users["303"] })).status).toBe(
        404,
      );
      const approval = await drill.approveCorrection(requested.id);
      hostDecisions.push({
        boundary: "explicit synthetic specialist host approval, not a browser Apply control",
        approval,
      });
      const operation = approval.operation;
      await expect(drill.apply({ ...operation, operatorId: "101" })).rejects.toThrow("correction_not_authorized");
      await expect(drill.apply({ ...operation, approvalReceipt: "unreviewed" })).rejects.toThrow(
        "correction_not_authorized",
      );
      drill.setAllowed(false);
      await expect(drill.apply(operation)).rejects.toThrow("correction_not_authorized");
      drill.setAllowed(true);
      const baseline = await drill.checkpoint("before specialist application");
      drill.interruptSql();
      await expect(drill.apply(operation)).rejects.toThrow("synthetic_correction_sql_interruption");
      const aborted = await drill.checkpoint("SQL transaction interrupted before commit");
      expect(aborted.corrections).toEqual(baseline.corrections);
      expect(aborted.receipts).toEqual(baseline.receipts);
      expect(aborted.controls).toEqual(baseline.controls);
      expect((await board(before.snapshotId)).rows.map((row: any) => row.actorId).sort()).toEqual(["101", "102"]);
      checkpoints.push(aborted);
      drill.interruptControls();
      await expect(drill.apply(operation)).rejects.toThrow("synthetic_controls_publication_interruption");
      const interrupted = await drill.checkpoint("SQL correction committed; private acknowledgement interrupted");
      expect(interrupted.corrections).toHaveLength(1);
      expect(interrupted.controls.requests[requested.id].status).toBe("pending");
      const appliedReceipts = interrupted.receipts.filter((r: any) => r.kind === "correction_applied");
      expect(appliedReceipts).toHaveLength(1);
      expect(interrupted.corrections[0].document).toMatchObject({
        operation,
        fact: {
          id: operation.factId,
          state: "excluded",
          revision: approval.binding.factRevision + 1,
          correctionReceipt: operation.approvalReceipt,
        },
      });
      expect((await board(before.snapshotId)).rows).toEqual([unaffected]);
      checkpoints.push(interrupted);
      await drill.reopen("committed exclusion with interrupted private acknowledgement");
      expect((await board(before.snapshotId)).rows).toEqual([unaffected]);
      const applied = await drill.apply(operation);
      expect(applied).toMatchObject({ requestId: requested.id, status: "applied" });
      expect(await drill.apply(operation)).toEqual(applied);
      await expect(drill.apply({ ...operation, expectedVersion: operation.expectedVersion + 1 })).rejects.toThrow();
      const final = await drill.checkpoint("exact retry acknowledged applied exclusion");
      expect(final.corrections).toEqual(interrupted.corrections);
      expect(final.receipts).toEqual(interrupted.receipts);
      expect(final.controls.requests[requested.id]).toMatchObject({
        status: "applied",
        version: requested.version + 1,
      });
      expect(
        final.controls.requests[requested.id].history.filter((e: any) => e.action === "pipeline-correction-applied"),
      ).toEqual([
        expect.objectContaining({ actor: "201", version: requested.version + 1, receiptId: applied.receiptId }),
      ]);
      await account("101");
      await expect(receipt(requested.id)).toContainText("correction · applied · version 2");
      await receipt(requested.id).getByText("Audit history", { exact: true }).click();
      await expect(receipt(requested.id)).toContainText(applied.receiptId);
      await testInfo.attach("operator-applied-correction-receipt", {
        body: await receipt(requested.id).screenshot(),
        contentType: "image/png",
      });
      checkpoints.push(final);
      const cutoff = new Date().toISOString();
      expect((await drill.runtime.runOnce({ cutoff })).state).toBe("published");
      const recalculated = await board();
      // A fresh publication advances only the three recorded coverage clocks;
      // the historical pin above retains the complete original row byte values.
      expect(recalculated.rows).toEqual([
        {
          ...unaffected,
          result: {
            ...unaffected.result,
            coverage: {
              ...unaffected.result.coverage,
              windowEnd: cutoff,
              lastSuccessfulSync: cutoff,
              sourceWatermark: cutoff,
            },
          },
        },
      ]);
      hostDecisions.push({ initialBoard: before, freshCutoff: cutoff, recalculatedBoard: recalculated });
      await page.goto(`/leaderboards/issues_opened?ui=api&snapshot=${recalculated.snapshotId}`);
      await expect(page.getByRole("region", { name: "Published contributions", exact: true })).toBeVisible();
      await expect(page.getByRole("link", { name: "synthetic-bob", exact: true })).toHaveCount(1);
      await expect(page.getByRole("link", { name: "synthetic-alice", exact: true })).toHaveCount(0);
      await expect(page.getByText(drill.fixture.correction.reason, { exact: true })).toHaveCount(0);
      expect(JSON.stringify(recalculated)).not.toContain(operation.approvalReceipt);
      expect(JSON.stringify(recalculated)).not.toContain(requested.id);
    });
    await testInfo.attach("operator-operating-receipt", {
      body: Buffer.from(
        JSON.stringify(
          {
            schemaVersion: "synthetic-operator-operating-drill/v1",
            qualification:
              "Actual local HTTP/SQLite/PGlite and mounted replay/request/readback; synthetic established sessions, source and specialist host approval. No new browser Apply control or real grant.",
            fixtureSHA256: operatorDrillFixtureHash,
            browserVersion: page.context().browser()?.version(),
            checkpoints,
            hostDecisions,
            faults: drill.faults,
            reopens: drill.reopens,
            authorizations: drill.authorizations,
            directHttp: drill.directHttp,
            http,
          },
          null,
          2,
        ),
      ),
      contentType: "application/json",
    });
  } finally {
    try {
      await testInfo.attach("operator-operating-final-observations", {
        body: Buffer.from(
          JSON.stringify(
            {
              checkpoint: await drill.checkpoint("finally"),
              faults: drill.faults,
              reopens: drill.reopens,
              authorizations: drill.authorizations,
              directHttp: drill.directHttp,
              http,
            },
            null,
            2,
          ),
        ),
        contentType: "application/json",
      });
    } finally {
      await drill.close();
    }
  }
});
