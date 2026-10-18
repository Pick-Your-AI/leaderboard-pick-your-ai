import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { harness, getBoard, components, boardUrl, ago, publicScope } from "./harness.mjs";
import { syntheticCheckpointStore } from "../../../packages/github/test/synthetic-client.mjs";
import { createPipeline } from "../src/index.mjs";
import { PipelineDerivedRetirementStore, migratePipelineDerivedRetirement } from "../src/derived-retirement.mjs";

const approved = async () => true;
const stable = components.metrics.stableJSON;
const hash = (value) => createHash("sha256").update(stable(value)).digest("hex");
async function setup(t, extra = {}) {
  const h = await harness(t, extra);
  await h.engine.exec(
    await readFile(
      new URL("../../../packages/ingestion/sql/005_collection_retirement.up.sql", import.meta.url),
      "utf8",
    ),
  );
  await migratePipelineDerivedRetirement(h.db);
  const eraser = new PipelineDerivedRetirementStore(h.db, h.controlsStore);
  const retirement = new components.ingestion.RepositoryRetirementStore(h.db);
  h.eraser = eraser;
  h.retirement = retirement;
  return h;
}
async function retire(h, overrides = {}) {
  const generation = String(
    (await h.db.query("SELECT generation FROM leaderboard_ingestion.repository_access WHERE repository_id=2")).rows[0]
      .generation,
  );
  const input = {
    operationId: "synthetic-derived-retirement",
    repositoryId: 2,
    expectedGeneration: generation,
    policyVersion: "synthetic-retention-v1",
    authorizationReceipt: "synthetic-private-approval",
    operatorId: "synthetic-operator",
    ...overrides,
  };
  await h.retirement.retire(input, approved);
  return input;
}
async function drain(eraser, input, { prefix = "synthetic-batch", limit = 1 } = {}) {
  const receipts = [];
  for (let n = 0; n < 100; n++) {
    const result = await eraser.eraseBatch(input, `${prefix}-${n}`, limit, approved);
    assert.ok(result.selected <= limit);
    assert.ok(result.removed + result.alreadyAbsent <= result.selected);
    receipts.push(result);
    if (result.status !== "applied") return receipts;
  }
  assert.fail("bounded synthetic scope did not reach a disposition");
}
async function pgRows(h, table) {
  return (await h.db.query(`SELECT * FROM leaderboard_pipeline.${table}`)).rows;
}
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function interceptTransactions(h, query) {
  const original = h.db.transaction;
  h.db.transaction = (work) => original((tx) => work({ query: (sql, params) => query(tx, sql, params) }));
  return () => {
    h.db.transaction = original;
  };
}

test("exact permanent authority removes unlinked derived payloads in bounded durable batches, then permits source erasure", async (t) => {
  const h = await setup(t);
  assert.equal((await h.runtime.runOnce()).state, "published");
  const board = await getBoard(h.runtime);
  const preservedAudit = await pgRows(h, "receipts");
  const preservedControls = h.controlsStore.publicSnapshot();
  const input = await retire(h);
  assert.equal((await h.retirement.eraseBatch(input, "synthetic-before-derived", 100, approved)).status, "blocked");
  const receipts = await drain(h.eraser, input);
  assert.equal(receipts.at(-1).status, "owned_scope_erased");
  for (const table of [
    "normalizations",
    "source_artifacts",
    "source_modes",
    "snapshots",
    "heads",
    "frozen_inputs",
    "policy_comparisons",
    "corrections",
  ])
    assert.deepEqual(await pgRows(h, table), [], table);
  for (const table of ["policy_preview_inputs", "policy_previews", "pipeline_aggregate_explanations"])
    assert.equal(h.controlsStore.db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 0, table);
  assert.deepEqual(await pgRows(h, "receipts"), preservedAudit);
  assert.deepEqual(h.controlsStore.publicSnapshot(), preservedControls);
  assert.doesNotMatch(
    JSON.stringify(await pgRows(h, "derived_retirement_manifests")),
    /synthetic-alice|Synthetic collected issue title/,
  );
  const last = receipts.at(-1);
  assert.deepEqual(await h.eraser.eraseBatch(input, last.batchId, 1, approved), last);
  await assert.rejects(h.eraser.eraseBatch(input, last.batchId, 2, approved), /derived_batch_conflict/);
  await assert.rejects(
    h.eraser.eraseBatch(input, "synthetic-extra-empty", 1, approved),
    /derived_scope_disposition_already_recorded/,
  );
  await h.reopenDatabase();
  const reopenedControls = new components.controls.ControlStore(join(h.directory, "controls.sqlite"));
  try {
    const reopened = new PipelineDerivedRetirementStore(h.db, reopenedControls);
    assert.deepEqual(await reopened.eraseBatch(input, last.batchId, 1, approved), last);
  } finally {
    reopenedControls.close();
  }
  const source = await h.retirement.eraseBatch(input, "synthetic-before-derived", 100, approved);
  assert.equal(source.status, "erased");
  assert.equal(source.deletedSourceFacts, 2);
  assert.equal((await h.runtime.app.inject(boardUrl)).statusCode, 503);
  const pinned = await h.runtime.app.inject(`${boardUrl}&snapshot=${board.snapshotId}`);
  assert.equal(pinned.statusCode, 410);
  assert.doesNotMatch(pinned.body, /synthetic-alice|Synthetic collected issue title/);
});

test("unretired, unauthorized, stale or foreign requests never install a SQLite fence or select payloads", async (t) => {
  const h = await setup(t);
  await h.runtime.runOnce();
  const input = {
    operationId: "synthetic-derived-retirement",
    repositoryId: 2,
    expectedGeneration: "1",
    policyVersion: "synthetic-retention-v1",
    authorizationReceipt: "synthetic-private-approval",
    operatorId: "synthetic-operator",
  };
  await assert.rejects(h.eraser.eraseBatch(input, "synthetic-unretired", 1, approved), /unknown_repository_retirement/);
  await assert.rejects(
    h.eraser.eraseBatch(input, "synthetic-denied", 1, async () => false),
    /retirement_not_authorized/,
  );
  assert.equal(
    h.controlsStore.db.prepare("SELECT 1 FROM sqlite_master WHERE name='pipeline_derived_retirements'").get(),
    undefined,
  );
  const accepted = await retire(h);
  const before = await pgRows(h, "snapshots");
  for (const changed of [
    { policyVersion: "synthetic-foreign-policy" },
    { operatorId: "synthetic-other-operator" },
    { expectedGeneration: "999" },
    { repositoryId: 3 },
    { authorizationReceipt: "synthetic-other-approval" },
  ])
    await assert.rejects(
      h.eraser.eraseBatch({ ...accepted, ...changed }, "synthetic-foreign", 1, approved),
      /retirement_operation_conflict/,
    );
  assert.deepEqual(await pgRows(h, "snapshots"), before);
  assert.deepEqual(await pgRows(h, "derived_retirement_manifests"), []);
});

test("dispatch-linked immutable proof remains byte-identical and produces a durable incomplete disposition", async (t) => {
  const h = await setup(t);
  await h.runtime.runOnce();
  const board = await getBoard(h.runtime);
  const snapshot = (await pgRows(h, "snapshots"))[0];
  await h.db.query(
    "INSERT INTO leaderboard_pipeline.dispatch_publications(operation_key,scope_key,snapshot_id) VALUES($1,$2,$3)",
    ["synthetic-causal-operation", snapshot.scope_key, snapshot.snapshot_id],
  );
  const before = {};
  for (const table of [
    "dispatch_publications",
    "snapshots",
    "frozen_inputs",
    "normalizations",
    "source_artifacts",
    "source_modes",
    "heads",
    "receipts",
  ])
    before[table] = await pgRows(h, table);
  const controlsBefore = h.controlsStore.read();
  const localBefore = Object.fromEntries(
    ["policy_preview_inputs", "pipeline_aggregate_explanations", "policy_previews"].map((table) => [
      table,
      h.controlsStore.db.prepare(`SELECT * FROM ${table}`).all(),
    ]),
  );
  const input = await retire(h);
  const results = await drain(h.eraser, input);
  assert.equal(results.length, 1);
  assert.equal(results[0].status, "blocked");
  assert.equal(results[0].retainedReason, "retained_dispatch_authority");
  assert.equal(results[0].removed, 0);
  for (const [table, rows] of Object.entries(before)) assert.deepEqual(await pgRows(h, table), rows, table);
  assert.deepEqual(h.controlsStore.read(), controlsBefore);
  for (const [table, rows] of Object.entries(localBefore))
    assert.deepEqual(h.controlsStore.db.prepare(`SELECT * FROM ${table}`).all(), rows, table);
  await h.reopenDatabase();
  assert.deepEqual(await h.eraser.eraseBatch(input, results[0].batchId, 1, approved), results[0]);
  assert.equal((await h.runtime.app.inject(`${boardUrl}&snapshot=${board.snapshotId}`)).statusCode, 410);
  assert.equal((await h.retirement.eraseBatch(input, "synthetic-still-retained", 100, approved)).status, "blocked");
  assert.equal(
    (await pgRows(h, "derived_retirement_receipts")).some((r) => r.document.status === "owned_scope_erased"),
    false,
  );
});

test("SQLite deletion committed before a PostgreSQL acknowledgement failure resumes exactly after reopening", async (t) => {
  const h = await setup(t);
  await h.runtime.runOnce();
  const input = await retire(h);
  for (const [batchId, expectedStage] of [
    ["synthetic-registration-interrupted", "register_snapshot"],
    ["synthetic-local-interrupted", "preview_inputs"],
  ]) {
    let interrupted = false;
    const restore = interceptTransactions(h, async (tx, sql, params) => {
      if (
        !interrupted &&
        sql.includes("INSERT INTO leaderboard_pipeline.derived_retirement_receipts") &&
        JSON.parse(params[2]).stage === expectedStage
      ) {
        interrupted = true;
        throw new Error("synthetic_postgres_acknowledgement_failure");
      }
      return tx.query(sql, params);
    });
    try {
      await assert.rejects(
        h.eraser.eraseBatch(input, batchId, 1, approved),
        /synthetic_postgres_acknowledgement_failure/,
      );
    } finally {
      restore();
    }
    assert.equal(interrupted, true);
    const manifest = (await pgRows(h, "derived_retirement_manifests")).find((row) => row.batch_id === batchId);
    assert.equal(manifest.document.stage, expectedStage);
    assert.equal(
      (await pgRows(h, "derived_retirement_receipts")).some((row) => row.batch_id === batchId),
      false,
    );
    const local = h.controlsStore.db
      .prepare("SELECT * FROM pipeline_derived_retirement_batches WHERE batch_id=?")
      .get(batchId);
    assert.equal(local.manifest_hash, manifest.document_hash);
    if (expectedStage === "preview_inputs")
      assert.equal(h.controlsStore.db.prepare("SELECT count(*) AS n FROM policy_preview_inputs").get().n, 0);
    await assert.rejects(h.eraser.eraseBatch(input, "synthetic-competing-batch", 1, approved), /derived_batch_pending/);
    await h.reopenDatabase();
    const reopenedControls = new components.controls.ControlStore(join(h.directory, "controls.sqlite"));
    try {
      const reopened = new PipelineDerivedRetirementStore(h.db, reopenedControls);
      const result = await reopened.eraseBatch(input, batchId, 1, approved);
      assert.equal(result.stage, expectedStage);
      assert.equal(result.removed, expectedStage === "preview_inputs" ? 1 : 0);
      assert.deepEqual(await reopened.eraseBatch(input, batchId, 1, approved), result);
      assert.deepEqual(
        h.controlsStore.db.prepare("SELECT * FROM pipeline_derived_retirement_batches WHERE batch_id=?").get(batchId),
        local,
      );
    } finally {
      reopenedControls.close();
    }
  }
  assert.equal((await drain(h.eraser, input, { prefix: "synthetic-remainder" })).at(-1).status, "owned_scope_erased");
});

test("revocation after the SQLite commit leaves an explicit pending manifest rather than a false cross-store rollback", async (t) => {
  const h = await setup(t);
  await h.runtime.runOnce();
  const input = await retire(h);
  await h.eraser.eraseBatch(input, "synthetic-register", 1, approved);
  const batchId = "synthetic-revoked-ack";
  const authorize = async () =>
    !h.controlsStore.db.prepare("SELECT 1 FROM pipeline_derived_retirement_batches WHERE batch_id=?").get(batchId);
  await assert.rejects(h.eraser.eraseBatch(input, batchId, 1, authorize), /retirement_not_authorized/);
  assert.equal(h.controlsStore.db.prepare("SELECT count(*) AS n FROM policy_preview_inputs").get().n, 0);
  assert.equal(
    (await pgRows(h, "derived_retirement_receipts")).some((row) => row.batch_id === batchId),
    false,
  );
  assert.equal(
    (await pgRows(h, "derived_retirement_manifests")).some((row) => row.batch_id === batchId),
    true,
  );
  const result = await h.eraser.eraseBatch(input, batchId, 1, approved);
  assert.equal(result.removed, 1);
  assert.equal(result.alreadyAbsent, 0);
});

test(
  "a normalizer already running at permanent retirement cannot recreate erased derived rows",
  { timeout: 30000 },
  async (t) => {
    const entered = deferred(),
      release = deferred();
    let held = false;
    const h = await setup(t, {
      normalizerFactory(options) {
        const normalizer = components.github.createGithubEvidenceNormalizer({
          client: options.githubClient,
          source: options.sourceId,
          allowedRepositoryIds: [2],
          isSynthetic: true,
        });
        return async (value) => {
          const output = await normalizer(value);
          if (!held) {
            held = true;
            entered.resolve();
            await release.promise;
          }
          return output;
        };
      },
    });
    const operation = h.runtime.runOnce().then(
      (result) => ({ result }),
      (error) => ({ error }),
    );
    try {
      await Promise.race([
        entered.promise,
        operation.then((outcome) => {
          throw outcome.error ?? new Error("Synthetic worker ended before the held boundary");
        }),
      ]);
      const input = await retire(h);
      assert.equal((await drain(h.eraser, input)).at(-1).status, "owned_scope_erased");
      assert.equal(
        (await h.retirement.eraseBatch(input, "synthetic-collected-source", 100, approved)).status,
        "erased",
      );
    } finally {
      release.resolve();
    }
    const outcome = await operation;
    assert.match(outcome.error?.message ?? "", /derived_fact_binding_missing|pipeline_repository_retired/);
    for (const table of ["normalizations", "source_modes", "source_artifacts", "snapshots"])
      assert.deepEqual(await pgRows(h, table), [], table);
  },
);

test(
  "a delayed SQL publication acknowledgement cannot recapture private data or confirmations after erasure",
  { timeout: 30000 },
  async (t) => {
    const h = await setup(t);
    const entered = deferred(),
      release = deferred();
    const original = h.db.transaction;
    let held = false;
    h.db.transaction = async (work) => {
      let published = false;
      const result = await original((tx) =>
        work({
          query: (sql, params) => {
            if (sql.includes("INSERT INTO leaderboard_pipeline.snapshots")) published = true;
            return tx.query(sql, params);
          },
        }),
      );
      if (published && !held) {
        held = true;
        entered.resolve();
        await release.promise;
      }
      return result;
    };
    const operation = h.runtime.runOnce().then(
      (result) => ({ result }),
      (error) => ({ error }),
    );
    try {
      await Promise.race([
        entered.promise,
        operation.then((outcome) => {
          throw outcome.error ?? new Error("Synthetic worker ended before the held boundary");
        }),
      ]);
      assert.equal((await pgRows(h, "snapshots")).length, 1, "actual PostgreSQL publication committed");
      assert.equal(
        h.controlsStore.db.prepare("SELECT count(*) AS n FROM pipeline_aggregate_explanations").get().n,
        0,
        "private confirmation has not run",
      );
      const input = await retire(h);
      assert.equal((await drain(h.eraser, input)).at(-1).status, "owned_scope_erased");
    } finally {
      release.resolve();
    }
    const outcome = await operation;
    h.db.transaction = original;
    assert.match(outcome.error?.message ?? "", /pipeline_repository_retired/);
    for (const table of [
      "policy_preview_inputs",
      "pipeline_aggregate_explanations",
      "policy_preview_approved_versions",
    ])
      assert.equal(h.controlsStore.db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 0, table);
    assert.equal(Object.keys(h.controlsStore.read().pipelinePublications ?? {}).length, 0);
    assert.equal(Object.keys(h.controlsStore.read().pipelineHeads ?? {}).length, 0);
    assert.deepEqual(await pgRows(h, "snapshots"), []);
  },
);

test("actual SQL and private SQLite policy comparisons retire with their exact unlinked source while version registries survive", async (t) => {
  const h = await setup(t, { authorizePolicyPreview: approved });
  await h.runtime.runOnce();
  const board = await getBoard(h.runtime);
  const candidate = { ...h.config.policies[0].policy, version: "synthetic-candidate-v2", rank: false };
  const sqlPreview = await h.runtime.previewPolicy({
    snapshotId: board.snapshotId,
    policy: candidate,
    operatorId: "201",
  });
  assert.equal(sqlPreview.snapshotId, board.snapshotId);
  const comparisons = h.runtime.policyComparisons.comparisons;
  const inputId = h.controlsStore.db.prepare("SELECT id FROM policy_preview_inputs").get().id;
  const record = comparisons.input(inputId);
  const result = await h.runtime.policyComparisons.withAuthorizedInputs(
    [record.authorization],
    async (_removed, authority) =>
      h.controlsStore.transaction(() => comparisons.compare(record, candidate, authority.restoreInput)),
  );
  assert.equal(result.document.snapshot.snapshotId, board.snapshotId);
  const versions = Object.fromEntries(
    ["policy_preview_approved_versions", "policy_preview_candidate_versions"].map((table) => [
      table,
      h.controlsStore.db.prepare(`SELECT * FROM ${table}`).all(),
    ]),
  );
  const input = await retire(h);
  const receipts = await drain(h.eraser, input);
  assert.equal(receipts.at(-1).status, "owned_scope_erased");
  assert.equal(
    receipts.filter((r) => r.stage === "previews").reduce((n, r) => n + r.removed, 0),
    1,
  );
  assert.equal(
    receipts.filter((r) => r.stage === "comparisons").reduce((n, r) => n + r.removed, 0),
    1,
  );
  for (const [table, rows] of Object.entries(versions))
    assert.deepEqual(h.controlsStore.db.prepare(`SELECT * FROM ${table}`).all(), rows, table);
});

async function multipleRepositories(t, includeForeignScope = true) {
  const repositories = [
    { id: 2, slug: "synthetic-org/synthetic-repo", actor: 101 },
    { id: 3, slug: "synthetic-org/synthetic-other", actor: 102 },
  ];
  const payloads = new Map(
    repositories.map((repository) => [
      repository.id,
      {
        id: 1000 + repository.id,
        node_id: `SYNTHETIC_ISSUE_${repository.id}`,
        number: 1,
        title: `Synthetic repository ${repository.id} issue`,
        html_url: `https://github.com/${repository.slug}/issues/1`,
        created_at: ago(2),
        updated_at: ago(1),
        user: {
          id: repository.actor,
          node_id: `U_SYNTHETIC_${repository.actor}`,
          login: `synthetic-actor-${repository.actor}`,
          type: "User",
        },
      },
    ]),
  );
  const githubClient = new components.github.GithubReadClient({
    apiOrigin: "https://api.synthetic.invalid",
    token: async () => "synthetic-test-token",
    checkpoints: syntheticCheckpointStore(),
    maxRetries: 0,
    fetch: async (value) => {
      const url = new URL(value);
      const repository = repositories.find(
        (repo) => url.pathname === `/repos/${repo.slug}` || url.pathname.startsWith(`/repos/${repo.slug}/`),
      );
      assert.ok(repository, "only explicitly approved synthetic repository routes are used");
      let body;
      if (url.pathname === `/repos/${repository.slug}`)
        body = { id: repository.id, private: false, full_name: repository.slug, default_branch: "main" };
      else if (url.pathname === `/repos/${repository.slug}/issues`) body = [payloads.get(repository.id)];
      else if (url.pathname === `/repos/${repository.slug}/issues/1`) body = payloads.get(repository.id);
      else assert.fail(`Unexpected synthetic endpoint ${url.pathname}`);
      return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    },
  });
  return setup(t, {
    githubClient,
    source: undefined,
    probeRepository: undefined,
    configure(config) {
      config.repositories.push({
        id: 3,
        installationId: 1,
        slug: repositories[1].slug,
        families: ["issues"],
        approvalReceipt: "synthetic-other-source-approval",
      });
      if (includeForeignScope) config.scopes.push({ ...publicScope, repository: "3" });
    },
  });
}

async function privatePreview(h, snapshotId) {
  const comparisons = h.runtime.policyComparisons.comparisons;
  const inputId = h.controlsStore.db
    .prepare("SELECT id FROM policy_preview_inputs WHERE json_extract(document,'$.snapshot.snapshotId')=?")
    .get(snapshotId).id;
  const record = comparisons.input(inputId);
  const candidate = { ...h.config.policies[0].policy, version: "synthetic-retirement-candidate-v2", rank: false };
  return h.runtime.policyComparisons.withAuthorizedInputs([record.authorization], async (_removed, authority) =>
    h.controlsStore.transaction(() => comparisons.compare(record, candidate, authority.restoreInput)),
  );
}

for (const direction of ["foreign input", "foreign result"]) {
  test(`private preview retirement rejects a contradictory ${direction} snapshot reference before removing payloads`, async (t) => {
    const h = await multipleRepositories(t);
    await h.runtime.runOnce();
    const snapshots = await pgRows(h, "snapshots");
    const target = snapshots.find((row) => row.repository_ids.includes(2));
    const foreign = snapshots.find((row) => !row.repository_ids.includes(2));
    const original = direction === "foreign input" ? foreign : target;
    const claimed = direction === "foreign input" ? target : foreign;
    const preview = await privatePreview(h, original.snapshot_id);
    const doc = { ...preview.document, snapshot: claimed.document.snapshot };
    h.controlsStore.db
      .prepare("UPDATE policy_previews SET document=?,digest=? WHERE id=?")
      .run(stable(doc), hash(doc), doc.comparisonId);
    const before = Object.fromEntries(
      ["policy_previews", "policy_preview_inputs", "pipeline_aggregate_explanations"].map((table) => [
        table,
        h.controlsStore.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
      ]),
    );
    const input = await retire(h);
    assert.equal((await h.eraser.eraseBatch(input, "synthetic-register", 1, approved)).stage, "register_snapshot");
    await assert.rejects(
      h.eraser.eraseBatch(input, "synthetic-contradictory-preview", 1, approved),
      /derived_(?:source_binding_invalid|retirement_integrity_error)/,
    );
    for (const [table, rows] of Object.entries(before))
      assert.deepEqual(h.controlsStore.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(), rows, table);
    assert.deepEqual(await pgRows(h, "snapshots"), snapshots);
    assert.equal(
      (await pgRows(h, "derived_retirement_receipts")).some((row) => row.document.removed > 0),
      false,
    );
  });
}

for (const timing of ["before selection", "after selection"]) {
  test(`private preview retirement preserves a result when its linked input disappears ${timing}`, async (t) => {
    const h = await setup(t);
    await h.runtime.runOnce();
    const snapshot = (await pgRows(h, "snapshots"))[0];
    const preview = await privatePreview(h, snapshot.snapshot_id);
    const before = h.controlsStore.db.prepare("SELECT * FROM policy_previews").all();
    const input = await retire(h);
    await h.eraser.eraseBatch(input, "synthetic-register", 1, approved);
    const removeInput = () =>
      h.controlsStore.db.prepare("DELETE FROM policy_preview_inputs WHERE id=?").run(preview.document.inputId);
    const original = h.db.transaction;
    let removed = false;
    if (timing === "before selection") {
      removeInput();
      removed = true;
    } else {
      h.db.transaction = async (work) => {
        let selected = false;
        const result = await original((tx) =>
          work({
            query: (sql, params) => {
              if (
                sql.includes("INSERT INTO leaderboard_pipeline.derived_retirement_manifests") &&
                JSON.parse(params[3]).stage === "previews"
              )
                selected = true;
              return tx.query(sql, params);
            },
          }),
        );
        if (selected && !removed) {
          removeInput();
          removed = true;
        }
        return result;
      };
    }
    try {
      await assert.rejects(
        h.eraser.eraseBatch(input, "synthetic-missing-preview-input", 1, approved),
        /derived_preview_input_missing/,
      );
    } finally {
      h.db.transaction = original;
    }
    assert.equal(removed, true);
    assert.deepEqual(h.controlsStore.db.prepare("SELECT * FROM policy_previews").all(), before);
    assert.equal(
      h.controlsStore.db
        .prepare("SELECT 1 FROM pipeline_derived_retirement_batches WHERE batch_id=?")
        .get("synthetic-missing-preview-input"),
      undefined,
    );
    assert.equal(
      (await pgRows(h, "derived_retirement_receipts")).some(
        (row) => row.batch_id === "synthetic-missing-preview-input",
      ),
      false,
    );
  });
}

test("private preview retirement removes only the bound result and preserves the unrelated repository's result", async (t) => {
  const h = await multipleRepositories(t);
  await h.runtime.runOnce();
  const snapshots = await pgRows(h, "snapshots");
  const target = snapshots.find((row) => row.repository_ids.includes(2));
  const foreign = snapshots.find((row) => !row.repository_ids.includes(2));
  await privatePreview(h, target.snapshot_id);
  const other = await privatePreview(h, foreign.snapshot_id);
  const preserved = h.controlsStore.db
    .prepare("SELECT * FROM policy_previews WHERE id=?")
    .get(other.document.comparisonId);
  const input = await retire(h);
  const receipts = await drain(h.eraser, input);
  assert.equal(receipts.at(-1).status, "owned_scope_erased");
  assert.equal(
    receipts.filter((row) => row.stage === "previews").reduce((n, row) => n + row.removed, 0),
    1,
  );
  assert.deepEqual(h.controlsStore.db.prepare("SELECT * FROM policy_previews").all(), [preserved]);
});

test("a mixed-source snapshot retires as one object while the unrelated repository's complete projection remains exact", async (t) => {
  const h = await multipleRepositories(t);
  assert.equal((await h.runtime.runOnce()).state, "published");
  const snapshots = await pgRows(h, "snapshots");
  const mixed = snapshots.find((row) => row.repository_ids.includes(2));
  const foreign = snapshots.find((row) => !row.repository_ids.includes(2));
  assert.deepEqual(mixed.repository_ids, [2, 3]);
  assert.deepEqual(foreign.repository_ids, [3]);
  const retained = {};
  for (const table of ["snapshots", "frozen_inputs", "heads"])
    retained[table] = (await pgRows(h, table)).filter((row) => row.snapshot_id === foreign.snapshot_id);
  for (const table of ["normalizations", "source_modes", "source_artifacts"])
    retained[table] = (
      await h.db.query(`SELECT d.* FROM leaderboard_pipeline.${table} d
      JOIN leaderboard_ingestion.source_facts f USING(fact_key) WHERE f.repository_id=3 ORDER BY f.fact_key`)
    ).rows;
  const sqlite = Object.fromEntries(
    ["policy_preview_inputs", "pipeline_aggregate_explanations"].map((table) => [
      table,
      h.controlsStore.db
        .prepare(`SELECT * FROM ${table} WHERE json_extract(document,'$.snapshot.snapshotId')=?`)
        .all(foreign.snapshot_id),
    ]),
  );
  const confirmation = h.controlsStore.read().pipelinePublications[foreign.snapshot_id];
  const audit = await pgRows(h, "receipts");
  const input = await retire(h);
  assert.equal((await drain(h.eraser, input)).at(-1).status, "owned_scope_erased");
  for (const [table, rows] of Object.entries(retained)) assert.deepEqual(await pgRows(h, table), rows, table);
  for (const [table, rows] of Object.entries(sqlite))
    assert.deepEqual(h.controlsStore.db.prepare(`SELECT * FROM ${table}`).all(), rows, table);
  assert.deepEqual(h.controlsStore.read().pipelinePublications[foreign.snapshot_id], confirmation);
  assert.deepEqual(h.controlsStore.read().pipelineHeads[foreign.scope_key], confirmation);
  assert.equal(h.controlsStore.read().pipelinePublications[mixed.snapshot_id], undefined);
  assert.deepEqual(await pgRows(h, "receipts"), audit);
  assert.equal((await h.runtime.app.inject(`${boardUrl}&repository=3`)).statusCode, 200);
  assert.equal((await h.runtime.app.inject(`${boardUrl}&snapshot=${mixed.snapshot_id}`)).statusCode, 410);
});

for (const selectedStage of ["confirmations", "heads"]) {
  test(
    `a newer foreign publication replaces a pending ${selectedStage} version without being erased`,
    { timeout: 30000 },
    async (t) => {
      const h = await multipleRepositories(t);
      await h.runtime.runOnce();
      const target = (await pgRows(h, "snapshots")).find((row) => row.repository_ids.includes(2));
      const input = await retire(h);
      const entered = deferred(),
        release = deferred();
      const original = h.db.transaction;
      let held = false;
      h.db.transaction = async (work) => {
        let selected = false;
        const result = await original((tx) =>
          work({
            query: (sql, params) => {
              if (
                sql.includes("INSERT INTO leaderboard_pipeline.derived_retirement_manifests") &&
                JSON.parse(params[3]).stage === selectedStage
              )
                selected = true;
              return tx.query(sql, params);
            },
          }),
        );
        if (selected && !held) {
          held = true;
          entered.resolve();
          await release.promise;
        }
        return result;
      };
      const operation = drain(h.eraser, input, { limit: 100 }).then(
        (result) => ({ result }),
        (error) => ({ error }),
      );
      let newer;
      try {
        await Promise.race([
          entered.promise,
          operation.then((outcome) => {
            throw outcome.error ?? new Error("Synthetic eraser ended before the held boundary");
          }),
        ]);
        const config = {
          ...h.config,
          version: "synthetic-foreign-configuration-v2",
          repositories: h.config.repositories.filter((repo) => repo.id === 3),
          scopes: [publicScope],
        };
        newer = await createPipeline({ ...h.options, config, verifyConfiguration: async () => true });
        assert.equal((await newer.runOnce()).state, "published");
        const replacement = (await pgRows(h, "snapshots")).find(
          (row) => row.scope_key === target.scope_key && row.snapshot_id !== target.snapshot_id,
        );
        assert.deepEqual(replacement.repository_ids, [3]);
        const sqlHead = (await pgRows(h, "heads")).find((row) => row.scope_key === target.scope_key);
        const localHead = h.controlsStore.read().pipelineHeads[target.scope_key];
        assert.equal(sqlHead.snapshot_id, replacement.snapshot_id);
        assert.equal(localHead.snapshotId, replacement.snapshot_id);
        release.resolve();
        const outcome = await operation;
        assert.ifError(outcome.error);
        assert.equal(outcome.result.at(-1).status, "owned_scope_erased");
        const receipt = outcome.result.find((row) => row.stage === selectedStage);
        assert.equal(
          receipt.alreadyAbsent,
          1,
          "the selected old head version disappeared, not the replacement payload",
        );
        assert.deepEqual(
          (await pgRows(h, "heads")).find((row) => row.scope_key === target.scope_key),
          sqlHead,
        );
        assert.deepEqual(h.controlsStore.read().pipelineHeads[target.scope_key], localHead);
        assert.equal((await newer.app.inject(boardUrl)).statusCode, 200);
      } finally {
        release.resolve();
        await operation;
        h.db.transaction = original;
        await newer?.stop();
      }
    },
  );
}

test("a valid digest with contradictory private source authority blocks removal instead of assigning payload by display text", async (t) => {
  const h = await setup(t);
  await h.runtime.runOnce();
  const row = h.controlsStore.db.prepare("SELECT * FROM policy_preview_inputs").get();
  const doc = JSON.parse(row.document);
  doc.authorization.sources[0].repositoryId = "3";
  const digest = hash(doc);
  h.controlsStore.db
    .prepare("UPDATE policy_preview_inputs SET id=?,document=?,digest=? WHERE id=?")
    .run(digest, stable(doc), digest, row.id);
  const input = await retire(h);
  await h.eraser.eraseBatch(input, "synthetic-registration", 1, approved);
  const before = h.controlsStore.db.prepare("SELECT * FROM policy_preview_inputs").all();
  await assert.rejects(
    h.eraser.eraseBatch(input, "synthetic-corrupt-binding", 1, approved),
    /derived_source_binding_invalid/,
  );
  assert.deepEqual(h.controlsStore.db.prepare("SELECT * FROM policy_preview_inputs").all(), before);
  assert.equal((await pgRows(h, "snapshots")).length, 1);
  assert.equal(
    (await pgRows(h, "derived_retirement_receipts")).some((r) => r.document.removed > 0),
    false,
  );
});

test("legacy orphan normalizations make optional migration fail atomically without relaxing an existing trigger", async (t) => {
  const h = await harness(t);
  await h.engine.exec(
    await readFile(
      new URL("../../../packages/ingestion/sql/005_collection_retirement.up.sql", import.meta.url),
      "utf8",
    ),
  );
  await h.db.query("INSERT INTO leaderboard_pipeline.normalizations VALUES($1,$2,$3::jsonb,$4)", [
    "synthetic-unbound-fact",
    "synthetic-policy",
    JSON.stringify({ actor: "synthetic-retained-payload" }),
    hash({ actor: "synthetic-retained-payload" }),
  ]);
  const before = await pgRows(h, "normalizations");
  await assert.rejects(migratePipelineDerivedRetirement(h.db), /derived_normalization_source/);
  assert.deepEqual(await pgRows(h, "normalizations"), before);
  assert.equal(
    (await h.db.query("SELECT to_regclass('leaderboard_pipeline.derived_retirements') AS relation")).rows[0].relation,
    null,
  );
  assert.equal(
    (
      await h.db.query(`SELECT count(*)::int AS n FROM pg_trigger WHERE tgname IN
    ('retired_normalization_write','retired_repository_access')`)
    ).rows[0].n,
    1,
    "only ingestion's original fence remains",
  );
});

test("an independently expired selected SQLite input is acknowledged absent, while malformed remaining authority prevents completion", async (t) => {
  const h = await setup(t);
  await h.runtime.runOnce();
  const input = await retire(h);
  await h.eraser.eraseBatch(input, "synthetic-registration", 1, approved);
  const original = h.db.transaction;
  let expired = false;
  h.db.transaction = async (work) => {
    let selected = false;
    const result = await original((tx) =>
      work({
        query: (sql, params) => {
          if (
            sql.includes("INSERT INTO leaderboard_pipeline.derived_retirement_manifests") &&
            JSON.parse(params[3]).stage === "preview_inputs"
          )
            selected = true;
          return tx.query(sql, params);
        },
      }),
    );
    if (selected && !expired) {
      expired = true;
      h.controlsStore.db.prepare("DELETE FROM policy_preview_inputs").run();
    }
    return result;
  };
  try {
    const result = await h.eraser.eraseBatch(input, "synthetic-expired-input", 1, approved);
    assert.equal(expired, true);
    assert.equal(result.removed, 0);
    assert.equal(result.alreadyAbsent, 1);
  } finally {
    h.db.transaction = original;
  }
  // A distinct legacy record has no valid typed source authority. It is never
  // assigned to this repository by substring or treated as proof of emptiness.
  const legacy = {
    snapshot: { snapshotId: "synthetic-legacy", revision: 1 },
    authorization: { sources: [{ repositoryId: "02", generation: "1" }] },
  };
  h.controlsStore.db
    .prepare("INSERT INTO pipeline_aggregate_explanations VALUES(?,?,?)")
    .run("synthetic-legacy", stable(legacy), hash(legacy));
  await assert.rejects(drain(h.eraser, input, { prefix: "synthetic-remaining" }), /derived_unbound_payload/);
  assert.ok(
    h.controlsStore.db
      .prepare("SELECT 1 FROM pipeline_aggregate_explanations WHERE snapshot_id='synthetic-legacy'")
      .get(),
  );
  assert.equal(
    (await pgRows(h, "derived_retirement_receipts")).some((r) => r.document.status === "owned_scope_erased"),
    false,
  );
});

test(
  "two independently authorized retirements sharing a snapshot cannot create conflicting cross-store registrations",
  { timeout: 30000 },
  async (t) => {
    const h = await multipleRepositories(t, false);
    await h.runtime.runOnce();
    const input = await retire(h);
    const other = {
      ...input,
      operationId: "synthetic-other-retirement",
      repositoryId: 3,
      expectedGeneration: String(
        (await h.db.query("SELECT generation FROM leaderboard_ingestion.repository_access WHERE repository_id=3"))
          .rows[0].generation,
      ),
    };
    await h.retirement.retire(other, approved);
    const entered = deferred(),
      release = deferred();
    const original = h.db.transaction;
    let held = false;
    h.db.transaction = async (work) => {
      let selected = false;
      const result = await original((tx) =>
        work({
          query: (sql, params) => {
            if (
              sql.includes("INSERT INTO leaderboard_pipeline.derived_retirement_manifests") &&
              params[0] === input.operationId &&
              JSON.parse(params[3]).stage === "register_snapshot"
            )
              selected = true;
            return tx.query(sql, params);
          },
        }),
      );
      if (selected && !held) {
        held = true;
        entered.resolve();
        await release.promise;
      }
      return result;
    };
    const registering = h.eraser.eraseBatch(input, "synthetic-first-registration", 1, approved).then(
      (result) => ({ result }),
      (error) => ({ error }),
    );
    try {
      await Promise.race([
        entered.promise,
        registering.then((outcome) => {
          throw outcome.error ?? new Error("Synthetic registration ended before its held boundary");
        }),
      ]);
      await assert.rejects(
        h.eraser.eraseBatch(other, "synthetic-second-registration", 1, approved),
        /derived_snapshot_batch_pending/,
      );
      assert.equal(
        (await pgRows(h, "derived_retirement_manifests")).filter((row) => row.operation_id === other.operationId)
          .length,
        0,
      );
      release.resolve();
      const first = await registering;
      assert.ifError(first.error);
      const second = await h.eraser.eraseBatch(other, "synthetic-second-registration", 1, approved);
      assert.equal(
        second.stage,
        "preview_inputs",
        "the second operation consumes the validated shared snapshot binding",
      );
      assert.equal(
        (await drain(h.eraser, other, { prefix: "synthetic-other-tail" })).at(-1).status,
        "owned_scope_erased",
      );
      assert.equal(
        (await drain(h.eraser, input, { prefix: "synthetic-first-tail" })).at(-1).status,
        "owned_scope_erased",
      );
      assert.equal((await pgRows(h, "derived_retirement_snapshots")).length, 1);
      assert.equal((await pgRows(h, "derived_retirement_snapshots"))[0].operation_id, input.operationId);
      assert.equal(
        h.controlsStore.db.prepare("SELECT count(*) AS n FROM pipeline_derived_retirement_snapshots").get().n,
        1,
      );
    } finally {
      release.resolve();
      await registering;
      h.db.transaction = original;
    }
  },
);

for (const causal of [false, true]) {
  test(`legacy string-valued SQL repository scope blocks deletion and preserves ${causal ? "causal" : "unconfirmed"} support`, async (t) => {
    const h = await harness(t);
    await h.engine.exec(
      await readFile(
        new URL("../../../packages/ingestion/sql/005_collection_retirement.up.sql", import.meta.url),
        "utf8",
      ),
    );
    await h.runtime.runOnce();
    const snapshot = (await pgRows(h, "snapshots"))[0];
    // This legacy row predates the optional pipeline guards. Its full frozen
    // input still explicitly binds repository2, despite the malformed SQL ID.
    await h.db.query("UPDATE leaderboard_pipeline.snapshots SET repository_ids='[\"2\"]'::jsonb WHERE snapshot_id=$1", [
      snapshot.snapshot_id,
    ]);
    if (causal)
      await h.db.query("INSERT INTO leaderboard_pipeline.dispatch_publications VALUES($1,$2,$3)", [
        "synthetic-legacy-dispatch",
        snapshot.scope_key,
        snapshot.snapshot_id,
      ]);
    // Model a SQL-only historical publication: private confirmation never
    // survived. It must not rely on a SQLite copy to discover its source scope.
    h.controlsStore.transaction((state) => {
      delete state.pipelinePublications[snapshot.snapshot_id];
      delete state.pipelineHeads[snapshot.scope_key];
      for (const table of ["policy_preview_inputs", "pipeline_aggregate_explanations"])
        h.controlsStore.db
          .prepare(`DELETE FROM ${table} WHERE json_extract(document,'$.snapshot.snapshotId')=?`)
          .run(snapshot.snapshot_id);
    });
    await migratePipelineDerivedRetirement(h.db);
    h.eraser = new PipelineDerivedRetirementStore(h.db, h.controlsStore);
    h.retirement = new components.ingestion.RepositoryRetirementStore(h.db);
    const tables = [
      "snapshots",
      "frozen_inputs",
      "heads",
      "normalizations",
      "source_modes",
      "source_artifacts",
      "dispatch_publications",
      "receipts",
    ];
    const before = {};
    for (const table of tables) before[table] = await pgRows(h, table);
    const input = await retire(h);
    const outcome = await drain(h.eraser, input).then(
      (result) => ({ result }),
      (error) => ({ error }),
    );
    t.diagnostic(
      JSON.stringify({
        legacy: causal ? "causal" : "unconfirmed",
        terminalStatus: outcome.result?.at(-1)?.status ?? null,
        error: outcome.error?.message ?? null,
        normalizationsBefore: before.normalizations.length,
        normalizationsAfter: (await pgRows(h, "normalizations")).length,
      }),
    );
    assert.match(
      outcome.error?.message ?? `Unexpected receipt ${outcome.result?.at(-1)?.status}`,
      /derived_unbound_payload/,
    );
    for (const table of tables) assert.deepEqual(await pgRows(h, table), before[table], table);
    assert.equal((await pgRows(h, "derived_retirement_receipts")).length, 0);
  });
}

test("orphan private publication and head confirmations remain unresolved rather than proving foreign scope", async (t) => {
  const h = await setup(t);
  await h.runtime.runOnce();
  const orphan = { snapshotId: "synthetic-orphan-confirmation", scopeKey: "synthetic-orphan-scope", revision: 1 };
  h.controlsStore.transaction((state) => {
    state.pipelinePublications[orphan.snapshotId] = orphan;
    state.pipelineHeads[orphan.scopeKey] = orphan;
  });
  const before = h.controlsStore.read();
  const snapshots = await pgRows(h, "snapshots");
  const input = await retire(h);
  const outcome = await drain(h.eraser, input).then(
    (result) => ({ result }),
    (error) => ({ error }),
  );
  t.diagnostic(
    JSON.stringify({
      legacy: "orphan-confirmation",
      terminalStatus: outcome.result?.at(-1)?.status ?? null,
      error: outcome.error?.message ?? null,
      snapshotsAfter: (await pgRows(h, "snapshots")).length,
    }),
  );
  assert.match(
    outcome.error?.message ?? `Unexpected receipt ${outcome.result?.at(-1)?.status}`,
    /derived_unbound_payload/,
  );
  assert.deepEqual(h.controlsStore.read(), before);
  assert.deepEqual(await pgRows(h, "snapshots"), snapshots);
  assert.equal((await pgRows(h, "derived_retirement_receipts")).length, 0);
});
