import { test, expect } from "@playwright/test";

test.use({ storageState: { cookies: [], origins: [] } });

test("configuration operating drill uses independent source observations, two operators and durable public controls", async ({
  page,
}, testInfo) => {
  const { configurationOperatingHarness } = await import(
    new URL("../../pipeline/test/configuration-operating-harness.mjs", import.meta.url).href
  );
  const drill = await configurationOperatingHarness();
  let currentUser: any;
  const http: Array<{ method: string; path: string; status: number }> = [];
  const checkpoints: Array<Record<string, unknown>> = [];
  await page.route("**/controls/**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const response = await fetch(drill.controlsAddress + url.pathname + url.search, {
      method: req.method(),
      redirect: "manual",
      headers: {
        cookie: currentUser?.cookie ?? "",
        origin: "https://controls.synthetic.invalid",
        ...(req.method() === "POST"
          ? { "content-type": "application/json", "x-csrf-token": req.headers()["x-csrf-token"] ?? "" }
          : {}),
      },
      ...(req.method() === "POST" ? { body: req.postData()! } : {}),
    });
    http.push({ method: req.method(), path: url.pathname, status: response.status });
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
  const admin = async (user: any) => {
    currentUser = user;
    await page.goto("/admin");
    await expect(page.getByRole("heading", { name: "Configuration and operations", exact: true })).toBeVisible();
    await expect(page.getByText(new RegExp(`Verified GitHub account ID: ${user.actorId}\\.`))).toBeVisible();
  };
  const article = (version: string) =>
    page.locator("article").filter({ has: page.getByRole("heading", { name: new RegExp(`^${version} ·`) }) });
  const checkpoint = (stage: string) => {
    const state = drill.configuration();
    checkpoints.push({
      stage,
      revision: state.revision,
      activeDigest: state.active?.digest,
      history: state.history,
      sourceReads: drill.sourceReads,
      activeSource: state.active?.source,
    });
  };
  const preview = async (version: string) => {
    const row = article(version);
    await row.getByRole("checkbox", { name: /^Source-test proposal/ }).check();
    await row.getByRole("button", { name: "Preview configuration", exact: true }).click();
    await expect(row.getByRole("heading", { name: `${version} · previewed`, exact: true })).toBeVisible();
    await expect(row.getByRole("heading", { name: "Source-tested coverage preview", exact: true })).toBeVisible();
  };
  const approveActivate = async (version: string, approver: any, owner: any) => {
    await admin(approver);
    await article(version)
      .getByRole("checkbox", { name: /^I have no conflict and approve configuration digest/ })
      .check();
    await article(version).getByRole("button", { name: "Approve tested preview", exact: true }).click();
    await expect(article(version).getByRole("heading", { name: `${version} · approved`, exact: true })).toBeVisible();
    await admin(owner);
    await article(version)
      .getByRole("checkbox", { name: new RegExp(`^Activate ${version}, digest`) })
      .check();
    await article(version).getByRole("button", { name: "Activate approved configuration", exact: true }).click();
    await expect(article(version).getByRole("heading", { name: `${version} · activated`, exact: true })).toBeVisible();
  };
  const board = async (metric: string, pin = "") => {
    const response = await fetch(
      `${drill.publicAddress}/api/v1/boards?metric=${metric}${pin ? `&snapshot=${pin}` : ""}`,
    );
    return { status: response.status, data: await response.json() };
  };
  try {
    const owner = await drill.login("201"),
      approver = await drill.login("202"),
      reader = await drill.login("303");
    expect(new Set([owner.actorId, approver.actorId, reader.actorId]).size).toBe(3);
    expect((await drill.request("/controls/configuration")).status).toBe(401);
    expect((await drill.request("/controls/configuration", { user: reader })).status).toBe(403);
    const propose = { baseRevision: 0, version: "denied", document: drill.document };
    expect(
      (await drill.request("/controls/configuration/proposals", { user: owner, input: propose, csrf: "wrong" })).status,
    ).toBe(403);
    expect(
      (
        await drill.request("/controls/configuration/proposals", {
          user: owner,
          input: propose,
          requestOrigin: "https://unapproved.synthetic.invalid",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await drill.request("/controls/profile", {
          user: owner,
          input: { actorId: "202", bio: "", public: true, highlights: [] },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await drill.request("/controls/profile", {
          user: owner,
          input: { bio: "", public: true, highlights: ["https://unapproved.synthetic.invalid/account"] },
        })
      ).status,
    ).toBe(400);
    expect(drill.configuration()).toBeUndefined();

    await test.step("independent canary rejects mismatched repository, Project schema and permission", async () => {
      for (const kind of ["repository", "project", "permission"] as const) {
        const document = structuredClone(drill.document);
        if (kind === "repository") document.repositories[0].id = "99";
        if (kind === "project") document.projects[0].fields[0].type = "TEXT";
        if (kind === "permission")
          drill.alterSource((value: any) => {
            value.installation.permissions.issues = "none";
          });
        const created = await drill.request("/controls/configuration/proposals", {
          user: owner,
          input: { baseRevision: 0, version: `invalid-${kind}`, document },
        });
        expect(created.status).toBe(201);
        const response = await drill.request(`/controls/configuration/proposals/${created.data.id}/preview`, {
          user: owner,
          input: { version: created.data.versionNumber },
        });
        expect(response.status).toBe(409);
        expect(drill.configuration().revision).toBe(0);
        drill.alterSource(() => {});
      }
    });
    const before = await board("issues_opened"),
      unaffected = await board("pr_opened");
    expect(before.status).toBe(200);
    expect(unaffected.status).toBe(200);
    expect(before.data.rows.length).toBeGreaterThan(0);
    expect(unaffected.data.rows.length).toBeGreaterThan(0);

    await test.step("mounted controls propose, preview and independently approve one immutable source-tested version", async () => {
      await admin(owner);
      await page.getByRole("textbox", { name: "New configuration version", exact: true }).fill("operating-v1");
      await page
        .getByRole("textbox", { name: "Configuration document (JSON)", exact: true })
        .fill(JSON.stringify(drill.document));
      await page.getByRole("checkbox", { name: /^Create a proposal against active revision/ }).check();
      await page.getByRole("button", { name: "Create configuration proposal", exact: true }).click();
      await expect(
        article("operating-v1").getByRole("heading", { name: "operating-v1 · proposed", exact: true }),
      ).toBeVisible();
      await preview("operating-v1");
      const proposed: any = Object.values(drill.configuration().proposals).find(
        (p: any) => p.version === "operating-v1",
      );
      expect(
        (
          await drill.request(`/controls/configuration/proposals/${proposed.id}/approve`, {
            user: owner,
            input: { version: proposed.versionNumber, previewDigest: proposed.preview.digest, conflict: false },
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await drill.request(`/controls/configuration/proposals/${proposed.id}/activate`, {
            user: owner,
            input: { version: proposed.versionNumber, approvalId: "not-an-approval" },
          })
        ).status,
      ).toBe(409);
      await approveActivate("operating-v1", approver, owner);
      expect(drill.configuration().revision).toBe(1);
      expect(drill.configuration().active.owner).toBe("201");
      expect(drill.configuration().active.approval.actor).toBe("202");
      expect(drill.configuration().active.source.projects[0].fields[0].type).toBe("SINGLE_SELECT");
      checkpoint("source-tested activation");
    });

    await test.step("an outage permits only a restrictive disable and mounted public UI retains historical policy", async () => {
      drill.setSourceAvailable(false);
      const reads = drill.sourceReads;
      await page.getByRole("combobox", { name: "Metric to disable", exact: true }).selectOption("issues_opened");
      await page
        .getByRole("textbox", { name: /^Public disable explanation/ })
        .fill("Synthetic source outage; issue measure paused for review.");
      await page.getByRole("textbox", { name: "Disable proposal version", exact: true }).fill("operating-disable");
      await page.getByRole("checkbox", { name: /^Propose disabling issues_opened against revision/ }).check();
      await page.getByRole("button", { name: "Propose metric disable", exact: true }).click();
      await expect(
        article("operating-disable").getByRole("heading", { name: "operating-disable · proposed", exact: true }),
      ).toBeVisible();
      await preview("operating-disable");
      await approveActivate("operating-disable", approver, owner);
      expect(drill.sourceReads).toBe(reads);
      expect(drill.configuration().active.source.restrictiveOverlay).toBe(true);
      expect(drill.configuration().active.preview.before.enabledMetricIds).toEqual(["issues_opened", "pr_opened"]);
      expect(drill.configuration().active.preview.after.enabledMetricIds).toEqual(["pr_opened"]);
      expect(drill.configuration().active.preview.after.repositoryIds).toEqual(
        drill.configuration().active.preview.before.repositoryIds,
      );
      expect(drill.configuration().active.preview.after.projectFieldIds).toEqual(
        drill.configuration().active.preview.before.projectFieldIds,
      );
      expect(drill.configuration().revision).toBe(2);
      const disabled = await board("issues_opened", before.data.snapshotId);
      expect(disabled.status).toBe(503);
      expect(disabled.data.error).toBe("metric_disabled");
      expect(disabled.data.disabledMetrics.find((row: any) => row.id === "issues_opened")).toMatchObject({
        policyVersion: "synthetic-policy-v1",
        policyLink: "https://github.com/synthetic-org/synthetic-repo/issues/100",
      });
      const retained = await board("pr_opened", unaffected.data.snapshotId);
      expect(retained.status).toBe(200);
      expect(retained.data.rows).toEqual(unaffected.data.rows);
      await page.goto(`/leaderboards/issues_opened?ui=api&snapshot=${before.data.snapshotId}`);
      await expect(page.getByRole("heading", { name: "Measure disabled", exact: true })).toBeVisible();
      await expect(page.getByText("Historical policy version: synthetic-policy-v1.", { exact: true })).toBeVisible();
      await expect(page.getByRole("link", { name: "Historical policy source", exact: true })).toHaveAttribute(
        "href",
        "https://github.com/synthetic-org/synthetic-repo/issues/100",
      );
      await expect(page.getByText(/Values are unavailable, not zero/)).toBeVisible();
      await testInfo.attach("disabled-historical-policy", {
        body: await page
          .getByRole("alert")
          .filter({ has: page.getByRole("heading", { name: "Measure disabled", exact: true }) })
          .screenshot(),
        contentType: "image/png",
      });
      checkpoint("restrictive outage disable");
    });

    await test.step("real database and server reopen preserve denial, then rollback requires fresh successful source verification", async () => {
      const durable = structuredClone(drill.configuration());
      await drill.restart();
      expect(drill.configuration()).toEqual(durable);
      expect((await board("issues_opened", before.data.snapshotId)).status).toBe(503);
      expect((await board("pr_opened", unaffected.data.snapshotId)).data.rows).toEqual(unaffected.data.rows);
      await admin(owner);
      await article("operating-v1")
        .getByRole("textbox", { name: "Rollback proposal version", exact: true })
        .fill("operating-restored");
      await article("operating-v1")
        .getByRole("checkbox", { name: /^Propose restoring digest/ })
        .check();
      await article("operating-v1").getByRole("button", { name: "Propose restoration", exact: true }).click();
      await expect(
        article("operating-restored").getByRole("heading", { name: "operating-restored · proposed", exact: true }),
      ).toBeVisible();
      const restoration: any = Object.values(drill.configuration().proposals).find(
        (p: any) => p.version === "operating-restored",
      );
      const denied = await drill.request(`/controls/configuration/proposals/${restoration.id}/preview`, {
        user: owner,
        input: { version: restoration.versionNumber },
      });
      expect(denied.status).toBe(500);
      expect(drill.configuration().revision).toBe(2);
      drill.setSourceAvailable(true);
      await preview("operating-restored");
      await approveActivate("operating-restored", approver, owner);
      expect(drill.configuration().revision).toBe(3);
      for (const proposal of Object.values(drill.configuration().proposals) as any[]) {
        if (proposal.status !== "activated") continue;
        expect(proposal.history.map((event: any) => event.action)).toEqual([
          "proposed",
          "previewed",
          "approved",
          "activated",
        ]);
        expect(proposal.history.map((event: any) => event.actor)).toEqual(["201", "201", "202", "201"]);
        expect(
          proposal.history.every((event: any) => event.digest === proposal.digest && event.proposalId === proposal.id),
        ).toBe(true);
      }
      expect(drill.configuration().active.rollbackOf).toBe(
        durable.proposals[
          Object.keys(durable.proposals).find((id) => durable.proposals[id].version === "operating-v1")!
        ].digest,
      );
      expect((await board("issues_opened", before.data.snapshotId)).data.rows).toEqual(before.data.rows);
      expect((await board("pr_opened", unaffected.data.snapshotId)).data.rows).toEqual(unaffected.data.rows);
      checkpoint("verified restoration after durable reopen");
    });

    await test.step("host secret replacement, stable identities and current membership preserve direct denials", async () => {
      const prior = await drill.login("201", owner);
      expect(prior.cookie).not.toBe(owner.cookie);
      expect((await drill.request("/controls/session", { user: owner })).status).toBe(401);
      await drill.rotateHostSecret(false);
      expect((await drill.login("201")).status).toBe(502);
      await drill.rotateHostSecret(true);
      const rotated = await drill.login("201");
      expect(rotated.actorId).toBe("201");
      expect((await drill.request("/controls/configuration", { user: rotated })).status).toBe(200);
      drill.revoke("201");
      expect((await drill.request("/controls/configuration", { user: rotated })).status).toBe(401);
      expect((await drill.request("/controls/configuration", { user: approver })).status).toBe(200);
      expect(drill.configuration().revision).toBe(3);
      const stored = JSON.stringify(drill.h.controlsStore.read());
      expect(stored).not.toContain("synthetic-oauth-secret-");
      expect(stored).not.toContain("synthetic-identity-");
      expect(
        await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } })),
      ).not.toContain("synthetic-oauth-secret-");
    });
    await testInfo.attach("configuration-operating-receipt", {
      body: JSON.stringify(
        {
          schemaVersion: "synthetic-configuration-operating-drill/v1",
          qualification:
            "Local real handlers and stores with synthetic source, policy and identity providers; no actual GitHub grant or deployment.",
          fixtureSHA256: drill.operatingSourceHash,
          checkpoints,
          sourceObservations: drill.receipts,
          sourceRequests: drill.sourceRequests,
          identityRequests: drill.identityEvents,
          directHttp: drill.controlRequests,
          http,
          browserVersion: page.context().browser()!.version(),
        },
        null,
        2,
      ),
      contentType: "application/json",
    });
  } finally {
    try {
      await testInfo.attach("configuration-operating-final-observations", {
        body: JSON.stringify(
          {
            fixtureSHA256: drill.operatingSourceHash,
            checkpoints,
            currentConfiguration: drill.configuration(),
            sourceObservations: drill.receipts,
            identityRequests: drill.identityEvents,
            directHttp: drill.controlRequests,
            http,
          },
          null,
          2,
        ),
        contentType: "application/json",
      });
    } finally {
      await drill.close();
    }
  }
});
