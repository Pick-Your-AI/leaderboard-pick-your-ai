import assert from "node:assert/strict";
import test from "node:test";
import { canonicalPublicScope, publicScopeKey, publicScopeParameters } from "../../../packages/contracts/dist/index.js";
import { comparisonHash } from "../../controls/src/policy-comparison.mjs";
import { clock, publicScope } from "./harness.mjs";
import { publicScopeHarness, projectIds } from "./public-scope-harness.mjs";

const scoped = (roles, patch = {}) => canonicalPublicScope({ ...publicScope, ...patch, roles });
const url = (scope, extra = {}) =>
  `/api/v1/boards?${new URLSearchParams({ ...publicScopeParameters(scope), metric: "issues_opened", ...extra })}`;
async function board(h, scope, extra) {
  const response = await h.runtime.app.inject(url(scope, extra));
  assert.equal(response.statusCode, 200, response.body);
  return response.json();
}

test("approved role views use actual engine selection and conserve role/Project unions", async (t) => {
  const reporter = scoped(["reporter"]);
  const author = scoped(["author"]);
  const union = scoped(["reporter", "author"]);
  const project = scoped(["reporter", "author"], { context: "current", projects: projectIds });
  const configuredUnion = { ...publicScope, roles: ["reporter", "author", "reporter"] };
  const h = await publicScopeHarness(t, { scopes: [publicScope, reporter, author, configuredUnion, project] });
  const originalConfig = JSON.stringify(h.config);
  const publication = await h.runtime.runOnce({ cutoff: clock() });
  assert.equal(publication.state, "published");
  assert.equal(publication.publications.length, 5);
  assert.equal(new Set(publication.publications.map((entry) => entry.snapshotId)).size, 5);
  const baseline = await board(h, publicScope);
  assert.equal(baseline.schemaVersion, "leaderboard/v1");
  assert.equal(baseline.rows[0].result.value, 2);
  for (const scope of [reporter, union]) {
    const selected = await board(h, scope);
    assert.equal(selected.schemaVersion, "public-read/v3");
    assert.deepEqual(selected.scope, scope);
    assert.equal(selected.rows[0].result.value, 2);
    assert.equal(selected.rows[0].evidenceIds.length, 2);
  }
  const unmatched = await board(h, author);
  assert.deepEqual(unmatched.rows, [], "issue reporters cannot appear in an author-only view");
  assert.ok(unmatched.coverage.every((entry) => entry.state === "partial"));
  const explanation = await h.runtime.aggregateExplanations.read(unmatched.snapshotId);
  assert.ok(explanation.document.metrics[0].audit.every((entry) => entry.reason === "role_filter"));
  const selectedProject = await board(h, project);
  assert.equal(
    selectedProject.rows[0].result.value,
    1,
    "two Projects and repeated selected roles still count one issue action",
  );
  assert.equal(selectedProject.rows[0].evidenceIds.length, 1);
  const records = (await h.db.query("SELECT scope_key,document FROM leaderboard_pipeline.snapshots ORDER BY scope_key"))
    .rows;
  for (const record of records) {
    assert.equal(record.scope_key, publicScopeKey(record.document.scope));
    const frozen = await h.frozen({ snapshotId: record.document.snapshot.snapshotId });
    assert.deepEqual(frozen.document.engineScope.roles, record.document.scope.roles ?? []);
    assert.equal(frozen.document_hash, comparisonHash(frozen.document));
    assert.equal(
      h.controlsStore.read().pipelinePublications[record.document.snapshot.snapshotId].configurationHash,
      comparisonHash(h.config),
    );
  }
  assert.equal(
    JSON.stringify(h.config),
    originalConfig,
    "canonical read scopes do not rewrite the approved configuration",
  );
});

test("retained role pins and comparison pairs never cross into another role or legacy head", async (t) => {
  const reporter = scoped(["reporter"]);
  const author = scoped(["author"]);
  const h = await publicScopeHarness(t, { scopes: [publicScope, reporter, author] });
  await h.runtime.runOnce({ cutoff: clock() });
  const selected = await board(h, reporter);
  const legacy = await board(h, publicScope);
  for (const [scope, snapshot] of [
    [reporter, legacy.snapshotId],
    [author, selected.snapshotId],
    [publicScope, selected.snapshotId],
  ]) {
    const response = await h.runtime.app.inject(url(scope, { snapshot }));
    assert.equal(response.statusCode, 410, response.body);
    assert.equal(response.json().error, "snapshot_expired_refetch");
  }
  assert.equal(
    await h.runtime.source.readComparison(
      reporter,
      selected.snapshotId,
      { scope: author, snapshotId: selected.snapshotId },
      new AbortController().signal,
    ),
    null,
  );
  const retained = (
    await h.db.query("SELECT document,document_hash FROM leaderboard_pipeline.snapshots WHERE snapshot_id=$1", [
      selected.snapshotId,
    ])
  ).rows;
  await h.reopenDatabase();
  assert.equal((await board(h, reporter, { snapshot: selected.snapshotId })).rows[0].result.value, 2);
  assert.deepEqual(
    (
      await h.db.query("SELECT document,document_hash FROM leaderboard_pipeline.snapshots WHERE snapshot_id=$1", [
        selected.snapshotId,
      ])
    ).rows,
    retained,
  );
  h.setPrivate(true);
  await h.runtime.runOnce({ cutoff: clock() }).catch(() => {});
  const revoked = await h.runtime.app.inject(url(reporter, { snapshot: selected.snapshotId }));
  assert.equal(revoked.statusCode, 410, revoked.body);
});

test("unapproved role combinations cannot trigger collection or allocate a materialization", async (t) => {
  const h = await publicScopeHarness(t, { scopes: [publicScope, scoped(["reporter"])] });
  await h.runtime.runOnce({ cutoff: clock() });
  const before = (await h.db.query("SELECT run_id FROM leaderboard_ingestion.collection_runs ORDER BY run_id")).rows;
  const heads = (await h.db.query("SELECT * FROM leaderboard_pipeline.heads ORDER BY scope_key")).rows;
  for (const scope of [
    scoped(["author"]),
    scoped(["author", "reporter"]),
    scoped(["reporter"], { context: "current" }),
  ]) {
    const response = await h.runtime.app.inject(url(scope));
    assert.equal(response.statusCode, 503, response.body);
    assert.equal(response.json().error, "public_snapshot_unavailable");
  }
  assert.deepEqual(
    (await h.db.query("SELECT run_id FROM leaderboard_ingestion.collection_runs ORDER BY run_id")).rows,
    before,
  );
  assert.deepEqual((await h.db.query("SELECT * FROM leaderboard_pipeline.heads ORDER BY scope_key")).rows, heads);
});

test("role configuration rejects duplicate aliases and invalid roles before collection", async (t) => {
  for (const [scopes, error] of [
    [
      [scoped(["author", "reporter"]), { ...publicScope, roles: ["reporter", "author", "reporter"] }],
      /duplicate_public_scope_configuration/,
    ],
    [[{ ...publicScope, roles: ["unknown"] }], /invalid_public_scope/],
    [[{ ...publicScope, roles: ["operator"] }], /invalid_public_scope/],
    [
      [{ ...publicScope, schemaVersion: "public-scope/v2", context: "current", projects: [], roles: ["reporter"] }],
      /invalid_public_scope/,
    ],
  ])
    await t.test(error.source + JSON.stringify(scopes), async (subtest) => {
      const h = await publicScopeHarness(subtest, { scopes });
      await assert.rejects(() => h.runtime.runOnce({ cutoff: clock() }), error);
      assert.equal(
        Number((await h.db.query("SELECT count(*) AS count FROM leaderboard_ingestion.collection_runs")).rows[0].count),
        0,
      );
      assert.equal(
        Number((await h.db.query("SELECT count(*) AS count FROM leaderboard_pipeline.heads")).rows[0].count),
        0,
      );
    });
});
