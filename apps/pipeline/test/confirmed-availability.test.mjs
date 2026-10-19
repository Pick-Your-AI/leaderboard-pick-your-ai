import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { createPipeline } from "../src/index.mjs";
import { harness, getBoard, components, clock, fixtureId, boardUrl } from "./harness.mjs";

test("failed second confirmation retains the durable confirmed head and exact recovery advances it", async (t) => {
  const h = await harness(t);
  const first = await h.runtime.runOnce();
  const pin = first.publications[0].snapshotId;
  const cutoff = clock();
  const transaction = h.controlsStore.transaction.bind(h.controlsStore);
  h.controlsStore.transaction = (change, options) =>
    transaction((state) => {
      change(state);
      throw Error("synthetic_confirmation_failure");
    }, options);
  await assert.rejects(h.runtime.runOnce({ cutoff }), /synthetic_confirmation_failure/);
  h.controlsStore.transaction = transaction;
  assert.equal((await h.db.query("SELECT count(*)::int AS n FROM leaderboard_pipeline.snapshots")).rows[0].n, 2);
  const unconfirmed = (await h.db.query("SELECT snapshot_id FROM leaderboard_pipeline.heads")).rows[0].snapshot_id;
  const retained = await getBoard(h.runtime);
  assert.equal(retained.snapshotId, pin);
  assert.equal(retained.head.snapshotId, pin);
  assert.equal((await getBoard(h.runtime, `&snapshot=${pin}`)).head.snapshotId, pin);
  assert.equal((await h.runtime.app.inject(`${boardUrl}&snapshot=${unconfirmed}`)).statusCode, 410);
  for (const path of [
    boardUrl,
    "/api/v1/contributors",
    "/api/v1/exports?metric=issues_opened&format=json",
    "/api/v1/updates",
    "/api/v1/health",
    `/api/v1/evidence/${retained.rows[0].evidenceIds[0]}?snapshot=${pin}`,
  ]) {
    const response = await h.runtime.app.inject(path);
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.body.includes(unconfirmed), false);
    assert.doesNotMatch(response.body, /pipelineHeads|pipelinePublications|inputHash|baselineHash|candidatePolicy/);
  }
  assert.equal(h.controlsStore.db.prepare("SELECT count(*) AS n FROM policy_preview_inputs").get().n, 1);
  await h.reopenDatabase();
  const reopened = new components.controls.ControlStore(join(h.directory, "controls.sqlite"));
  const restarted = await createPipeline({ ...h.options, controlsStore: reopened });
  try {
    assert.equal((await getBoard(restarted)).snapshotId, pin);
    assert.equal((await getBoard(restarted, `&snapshot=${pin}`)).head.snapshotId, pin);
  } finally {
    await restarted.stop();
    reopened.close();
  }
  const retry = await h.runtime.runOnce({ cutoff });
  assert.equal(retry.publications[0].changed, false);
  const pinned = await getBoard(h.runtime, `&snapshot=${pin}`);
  assert.equal(pinned.snapshotId, pin);
  assert.equal(pinned.head.snapshotId, retry.publications[0].snapshotId);
  assert.equal(pinned.head.revision, 2);
  assert.equal(retry.publications[0].comparisonInput.state, "retained");
  assert.equal(h.controlsStore.db.prepare("SELECT count(*) AS n FROM policy_preview_inputs").get().n, 2);
});

async function failRebuildConfirmation(h) {
  const cutoff = clock();
  const transaction = h.controlsStore.transaction.bind(h.controlsStore);
  h.controlsStore.transaction = (change, options) =>
    transaction((state) => {
      change(state);
      throw Error("synthetic_confirmation_failure");
    }, options);
  try {
    await assert.rejects(h.runtime.runOnce({ cutoff }), /synthetic_confirmation_failure/);
  } finally {
    h.controlsStore.transaction = transaction;
  }
  return cutoff;
}

test("retained confirmed fallback applies current actor, artifact, correction and source revocation fences", async (t) => {
  const h = await harness(t);
  await h.runtime.runOnce();
  const initial = await getBoard(h.runtime);
  const pin = initial.snapshotId;
  await failRebuildConfirmation(h);
  h.controlsStore.transaction(
    (state) => {
      state.profiles["102"] = { suppressed: true, public: false, bio: "", highlights: [] };
    },
    { publish: true },
  );
  assert.deepEqual(
    (await getBoard(h.runtime)).rows.map((row) => row.actorId),
    ["101"],
  );
  assert.deepEqual(
    (await getBoard(h.runtime, `&snapshot=${pin}`)).rows.map((row) => row.actorId),
    ["101"],
  );
  const requestId = fixtureId(250);
  const factId = initial.rows.find((row) => row.actorId === "101").evidenceIds[0];
  h.controlsStore.transaction((state) => {
    state.requests[requestId] = {
      id: requestId,
      kind: "correction",
      owner: "102",
      locator: "https://github.com/synthetic-org/synthetic-repo/issues/1",
      status: "pending",
      version: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      history: [],
    };
  });
  await h.runtime.applyCorrection({
    requestId,
    expectedVersion: 1,
    factId,
    operatorId: "201",
    approvalReceipt: "synthetic-correction-approval",
  });
  assert.deepEqual((await getBoard(h.runtime)).rows, []);
  assert.equal((await h.runtime.app.inject(`/api/v1/evidence/${factId}?snapshot=${pin}`)).statusCode, 404);
  // The correction affects the current projection immediately, even before a
  // successful rebuild. A subsequent rebuild advances past the failed revision.
  const recovered = (await h.runtime.runOnce()).publications[0];
  assert.equal(recovered.revision, 3);
  assert.deepEqual((await getBoard(h.runtime)).rows, []);
  await failRebuildConfirmation(h);
  await h.db.transaction(async (tx) => {
    await tx.query(
      "SELECT repository_id FROM leaderboard_ingestion.repository_access WHERE repository_id=2 FOR UPDATE",
    );
    await tx.query(
      "INSERT INTO leaderboard_ingestion.object_suppressions(repository_id,subject_id,reason) VALUES(2,'SYNTHETIC_ISSUE_2','deleted') ON CONFLICT DO NOTHING",
    );
  });
  h.controlsStore.transaction(
    (state) => {
      state.profiles["102"].suppressed = false;
    },
    { publish: true },
  );
  assert.deepEqual((await getBoard(h.runtime)).rows, []);
  assert.deepEqual((await getBoard(h.runtime, `&snapshot=${pin}`)).rows, []);
  assert.equal(await h.runtime.collection.suppress(fixtureId(251), "a".repeat(64), 1, [2], "revoked"), "accepted");
  assert.equal((await h.runtime.app.inject(boardUrl)).statusCode, 503);
  assert.equal((await h.runtime.app.inject(`${boardUrl}&snapshot=${pin}`)).statusCode, 410);
  assert.equal((await h.runtime.app.inject("/api/v1/updates")).statusCode, 503);
});

test("retained confirmed fallback requires current exact configuration and applies metric and repository controls", async (t) => {
  let approved = true;
  const h = await harness(t, { verifyConfiguration: async () => approved });
  await h.runtime.runOnce();
  const pin = (await getBoard(h.runtime)).snapshotId;
  await failRebuildConfirmation(h);
  approved = false;
  assert.equal((await h.runtime.app.inject(boardUrl)).statusCode, 503);
  approved = true;
  const changed = structuredClone(h.config);
  changed.policies[0].policy.rank = false;
  changed.policies[0].signature = components.metrics.stableJSON(changed.policies[0].policy);
  const other = await createPipeline({ ...h.options, config: changed });
  t.after(() => other.stop());
  assert.equal((await other.app.inject(boardUrl)).statusCode, 503);
  assert.equal((await other.app.inject(`${boardUrl}&snapshot=${pin}`)).statusCode, 410);
  assert.equal((await getBoard(h.runtime)).snapshotId, pin);
  h.controlsStore.transaction(
    (state) => {
      state.configuration = {
        revision: 1,
        proposals: {},
        history: [],
        active: {
          version: "synthetic-control-v1",
          digest: "a".repeat(64),
          approval: { id: "synthetic-control-approval" },
          document: {
            repositories: h.config.repositories.map((repository) => ({
              id: String(repository.id),
              installationId: String(repository.installationId),
              slug: repository.slug,
              capabilities: repository.families,
            })),
            projects: [],
            metrics: [
              {
                id: "issues_opened",
                enabled: false,
                reason: "synthetic_disabled",
                policyVersion: "synthetic-policy-v1",
                policyLink: "https://github.com/synthetic-org/synthetic-repo/issues/100",
              },
            ],
          },
        },
      };
    },
    { publish: true },
  );
  const disabled = await h.runtime.app.inject(boardUrl);
  assert.equal(disabled.statusCode, 503);
  assert.equal(disabled.json().error, "metric_disabled");
  h.controlsStore.transaction(
    (state) => {
      state.configuration.revision++;
      state.configuration.active.document.repositories = [];
    },
    { publish: true },
  );
  assert.equal((await h.runtime.app.inject(boardUrl)).statusCode, 503);
  assert.equal((await h.runtime.app.inject(`${boardUrl}&snapshot=${pin}`)).statusCode, 503);
});

test("legacy version-only confirmation cannot authorize a head or historical pin without exact rerun", async (t) => {
  const h = await harness(t);
  const cutoff = clock();
  const first = (await h.runtime.runOnce({ cutoff })).publications[0];
  h.controlsStore.transaction((state) => {
    delete state.pipelineHeads;
    state.pipelinePublications[first.snapshotId] = {
      configurationVersion: h.config.version,
      controlsConfigurationRevision: 0,
    };
  });
  assert.equal((await h.runtime.app.inject(boardUrl)).statusCode, 503);
  assert.equal((await h.runtime.app.inject(`${boardUrl}&snapshot=${first.snapshotId}`)).statusCode, 410);
  const recovered = (await h.runtime.runOnce({ cutoff })).publications[0];
  assert.equal(recovered.snapshotId, first.snapshotId);
  assert.equal(recovered.changed, false);
  assert.equal((await getBoard(h.runtime)).snapshotId, first.snapshotId);
  assert.equal((await h.db.query("SELECT count(*)::int AS n FROM leaderboard_pipeline.snapshots")).rows[0].n, 1);
  assert.doesNotMatch(JSON.stringify(h.controlsStore.publicSnapshot()), /pipelineHeads|pipelinePublications/);
});

for (const change of ["suppression", "approval"])
  test(`fallback rechecks current ${change} after awaited read I/O`, async (t) => {
    let approved = true;
    const h = await harness(t, { verifyConfiguration: async () => approved });
    await h.runtime.runOnce();
    await failRebuildConfirmation(h);
    const transaction = h.db.transaction;
    let changed = false;
    h.db.transaction = (work) =>
      transaction((tx) =>
        work({
          query: async (sql, params) => {
            const result = await tx.query(sql, params);
            if (
              !changed &&
              sql
                .replace(/\s+/g, " ")
                .startsWith(
                  "SELECT subject_id FROM leaderboard_ingestion.object_suppressions WHERE repository_id=ANY($1::bigint[])",
                )
            ) {
              changed = true;
              if (change === "approval") approved = false;
              else
                h.controlsStore.transaction(
                  (state) => {
                    state.profiles["101"] = { suppressed: true, public: false, bio: "", highlights: [] };
                  },
                  { publish: true },
                );
            }
            return result;
          },
        }),
      );
    const response = await h.runtime.app.inject(boardUrl);
    assert.equal(changed, true);
    assert.equal(response.statusCode, change === "approval" ? 503 : 200);
    if (change === "suppression")
      assert.deepEqual(
        response.json().rows.map((row) => row.actorId),
        ["102"],
      );
  });

// Bound choreography waits so a missing interception fails and releases its
// publication instead of stranding the test process in harness cleanup.
async function confirmationStep(promise, label) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`confirmation fixture timed out: ${label}`)), 30_000);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

test("delayed older confirmation cannot roll a newer confirmed head back", { timeout: 60_000 }, async (t) => {
  const h = await harness(t);
  let entered, release;
  const reached = new Promise((resolve) => {
    entered = resolve;
  });
  const resume = new Promise((resolve) => {
    release = resolve;
  });
  const transaction = h.db.transaction;
  let paused = false;
  h.db.transaction = async (work) => {
    let publishing = false;
    const result = await transaction((tx) =>
      work({
        query: async (sql, params) => {
          const result = await tx.query(sql, params);
          if (sql.includes("INSERT INTO leaderboard_pipeline.snapshots")) publishing = true;
          return result;
        },
      }),
    );
    if (publishing && !paused) {
      paused = true;
      entered();
      await resume;
    }
    return result;
  };
  const firstRun = h.runtime.runOnce();
  try {
    await confirmationStep(reached, "older publication committed");
    const newer = await createPipeline(h.options);
    t.after(() => newer.stop());
    const second = (await newer.runOnce({ cutoff: clock() })).publications[0];
    assert.equal(second.revision, 2);
    assert.equal((await getBoard(newer)).snapshotId, second.snapshotId);
    release();
    const first = (await confirmationStep(firstRun, "older confirmation resumed")).publications[0];
    assert.equal(first.revision, 1);
    assert.equal((await getBoard(h.runtime)).snapshotId, second.snapshotId);
    const pinned = await getBoard(h.runtime, `&snapshot=${first.snapshotId}`);
    assert.equal(pinned.snapshotId, first.snapshotId);
    assert.equal(pinned.head.snapshotId, second.snapshotId);
  } finally {
    release();
    await confirmationStep(firstRun, "older publication cleanup");
  }
});

test(
  "a confirmation advancing during a read retries instead of advertising the stale head",
  { timeout: 60_000 },
  async (t) => {
    const h = await harness(t);
    const first = (await h.runtime.runOnce()).publications[0];
    let entered, release;
    const reached = new Promise((resolve) => {
      entered = resolve;
    });
    const resume = new Promise((resolve) => {
      release = resolve;
    });
    const transaction = h.db.transaction;
    let paused = false,
      advanceOnRead = false,
      advanced = false,
      pending;
    h.db.transaction = async (work) => {
      let publishing = false;
      const result = await transaction((tx) =>
        work({
          query: async (sql, params) => {
            const result = await tx.query(sql, params);
            if (sql.includes("INSERT INTO leaderboard_pipeline.snapshots")) publishing = true;
            if (
              advanceOnRead &&
              !advanced &&
              sql
                .replace(/\s+/g, " ")
                .startsWith(
                  "SELECT subject_id FROM leaderboard_ingestion.object_suppressions WHERE repository_id=ANY($1::bigint[])",
                )
            ) {
              advanced = true;
              release();
              await confirmationStep(pending, "new confirmation during read");
            }
            return result;
          },
        }),
      );
      if (publishing && !paused) {
        paused = true;
        entered();
        await resume;
      }
      return result;
    };
    pending = h.runtime.runOnce({ cutoff: clock() });
    try {
      await confirmationStep(reached, "new publication committed");
      advanceOnRead = true;
      const board = await getBoard(h.runtime);
      assert.equal(advanced, true);
      const second = (await confirmationStep(pending, "new confirmation resumed")).publications[0];
      assert.equal(board.snapshotId, second.snapshotId);
      assert.equal(board.head.revision, 2);
      assert.equal((await getBoard(h.runtime, `&snapshot=${first.snapshotId}`)).head.snapshotId, second.snapshotId);
    } finally {
      release();
      await confirmationStep(pending, "new publication cleanup");
    }
  },
);
