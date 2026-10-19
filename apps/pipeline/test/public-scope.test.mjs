import assert from "node:assert/strict";
import test from "node:test";
import { canonicalPublicScope, publicScopeKey, publicScopeParameters } from "../../../packages/contracts/dist/index.js";
import { comparisonHash } from "../../controls/src/policy-comparison.mjs";
import { clock, publicScope } from "./harness.mjs";
import { publicScopeHarness, projectIds } from "./public-scope-harness.mjs";

const current = { ...publicScope, context: "current" };
const projectScope = (projects, context = "current") => canonicalPublicScope({ ...publicScope, context, projects });
const url = (scope, extra = {}) =>
  `/api/v1/boards?${new URLSearchParams({ ...publicScopeParameters(scope), metric: "issues_opened", ...extra })}`;
async function board(h, scope, extra) {
  const response = await h.runtime.app.inject(url(scope, extra));
  assert.equal(response.statusCode, 200, response.body);
  return response.json();
}

test("materialized current views conserve Project unions and preserve unknown event membership", async (t) => {
  const alias = { ...publicScope, context: "event", projects: [] };
  const both = projectScope(projectIds);
  const historical = projectScope(projectIds, "event");
  const workstream = { ...current, workstream: "engineering" };
  const scopes = [
    alias,
    current,
    projectScope([projectIds[0]]),
    projectScope([projectIds[1]]),
    both,
    historical,
    workstream,
    { ...publicScope, workstream: "engineering" },
  ];
  const h = await publicScopeHarness(t, { scopes });
  const result = await h.runtime.runOnce({ cutoff: clock() });
  assert.equal(result.state, "published");
  assert.equal(result.publications.length, scopes.length);
  assert.equal(new Set(result.publications.map((entry) => entry.snapshotId)).size, scopes.length);
  const organization = await board(h, publicScope);
  assert.equal(organization.rows[0].result.value, 2, "unboarded work remains in the organization total");
  assert.equal((await board(h, current)).rows[0].result.value, 2);
  for (const scope of [projectScope([projectIds[0]]), projectScope([projectIds[1]]), both, workstream]) {
    const view = await board(h, scope);
    assert.equal(view.schemaVersion, "public-read/v2");
    assert.equal(view.rows[0].result.value, 1, "two Project associations supply one native issue action");
    assert.equal(view.rows[0].evidenceIds.length, 1);
    assert.equal(view.coverage[0].state, "partial");
  }
  for (const scope of [historical, { ...publicScope, workstream: "engineering" }]) {
    const view = await board(h, scope);
    assert.deepEqual(view.rows, [], "an actor roster cannot expose a contributor without scoped evidence");
    assert.ok(view.coverage.every((entry) => entry.state === "partial"));
    const retained = (
      await h.db.query("SELECT document FROM leaderboard_pipeline.snapshots WHERE snapshot_id=$1", [view.snapshotId])
    ).rows[0].document;
    assert.deepEqual(retained.rows, [], "unknown membership does not create a measured actor cohort or zero");
    const explanation = await h.runtime.aggregateExplanations.read(view.snapshotId);
    assert.equal(explanation.document.metrics[0].coverage, "incomplete");
    assert.equal(explanation.document.metrics[0].audit.length, 2);
    assert.ok(explanation.document.metrics[0].audit.every((entry) => entry.reason === "unknown_membership_context"));
  }
  const records = (await h.db.query("SELECT scope_key,document FROM leaderboard_pipeline.snapshots ORDER BY scope_key"))
    .rows;
  const legacy = records.find((entry) => entry.scope_key === '["Pick-Your-AI",null,null,null,null]');
  assert.ok(legacy);
  assert.deepEqual(legacy.document.scope, publicScope);
  const storedScope = (
    await h.db.query(
      "SELECT (document->'scope')::text AS actual,$2::jsonb::text AS legacy FROM leaderboard_pipeline.snapshots WHERE snapshot_id=$1",
      [legacy.document.snapshot.snapshotId, JSON.stringify(publicScope)],
    )
  ).rows[0];
  assert.equal(storedScope.actual, storedScope.legacy, "JSONB's own key order preserves the original scope bytes");
  const implicit = await h.runtime.app.inject(url(publicScope));
  const explicit = await h.runtime.app.inject(url(publicScope, { context: "event" }));
  assert.equal(implicit.body, explicit.body);
  assert.equal(implicit.headers.etag, explicit.headers.etag);
  for (const record of records) {
    assert.equal(record.scope_key, publicScopeKey(record.document.scope));
    assert.equal(JSON.stringify(record.document).includes("currentContext"), false);
    const frozen = await h.frozen({ snapshotId: record.document.snapshot.snapshotId });
    assert.equal(frozen.document_hash, comparisonHash(frozen.document));
    assert.equal(frozen.document.engineScope.context, record.document.scope.context ?? "event");
    assert.deepEqual(frozen.document.engineScope.projects, record.document.scope.projects ?? []);
    assert.equal(
      h.controlsStore.read().pipelinePublications[record.document.snapshot.snapshotId].configurationHash,
      comparisonHash(h.config),
      "approval retains exact configured bytes",
    );
  }
});

test("pins retain frozen current membership and cannot cross into event or another Project view", async (t) => {
  const both = projectScope(projectIds);
  const event = projectScope(projectIds, "event");
  const single = projectScope([projectIds[0]]);
  const h = await publicScopeHarness(t, { scopes: [publicScope, both, event, single] });
  await h.runtime.runOnce({ cutoff: clock() });
  const first = await board(h, both);
  const original = await h.db.query(
    "SELECT document,document_hash FROM leaderboard_pipeline.snapshots WHERE snapshot_id=$1",
    [first.snapshotId],
  );
  const organization = await board(h, publicScope);
  for (const [scope, pin] of [
    [event, first.snapshotId],
    [single, first.snapshotId],
    [both, organization.snapshotId],
  ]) {
    const rejected = await h.runtime.app.inject(url(scope, { snapshot: pin }));
    assert.equal(rejected.statusCode, 410, rejected.body);
    assert.equal(rejected.json().error, "snapshot_expired_refetch");
  }
  const wrongPair = await h.runtime.source.readComparison(
    both,
    first.snapshotId,
    { scope: event, snapshotId: first.snapshotId },
    new AbortController().signal,
  );
  assert.equal(wrongPair, null);
  h.setMemberships([[], []]);
  await h.runtime.runOnce({ cutoff: clock() });
  const latest = await board(h, both);
  assert.notEqual(latest.snapshotId, first.snapshotId);
  assert.deepEqual(latest.rows, [], "incomplete history cannot turn an empty current match into a known zero");
  const latestRetained = (
    await h.db.query("SELECT document FROM leaderboard_pipeline.snapshots WHERE snapshot_id=$1", [latest.snapshotId])
  ).rows[0].document;
  assert.deepEqual(latestRetained.rows, []);
  const latestExplanation = await h.runtime.aggregateExplanations.read(latest.snapshotId);
  assert.equal(latestExplanation.document.metrics[0].coverage, "incomplete");
  assert.ok(latestExplanation.document.metrics[0].audit.every((entry) => entry.reason === "project_filter"));
  const pin = await board(h, both, { snapshot: first.snapshotId });
  assert.equal(pin.rows[0].result.value, 1);
  assert.equal(pin.snapshotId, first.snapshotId);
  assert.equal(pin.head.snapshotId, latest.snapshotId);
  assert.deepEqual(
    (
      await h.db.query("SELECT document,document_hash FROM leaderboard_pipeline.snapshots WHERE snapshot_id=$1", [
        first.snapshotId,
      ])
    ).rows,
    original.rows,
  );
  assert.equal((await board(h, publicScope)).rows[0].result.value, 2);
  h.setPrivate(true);
  await h.runtime.runOnce({ cutoff: clock() }).catch(() => {});
  const withheld = await h.runtime.app.inject(url(both, { snapshot: first.snapshotId }));
  assert.equal(withheld.statusCode, 410, withheld.body);
});

test("unmaterialized current scopes never fall back, collect, or allocate a public head", async (t) => {
  const h = await publicScopeHarness(t, { scopes: [publicScope] });
  await h.runtime.runOnce({ cutoff: clock() });
  const before = (await h.db.query("SELECT run_id FROM leaderboard_ingestion.collection_runs ORDER BY run_id")).rows;
  const head = (await h.db.query("SELECT * FROM leaderboard_pipeline.heads ORDER BY scope_key")).rows;
  for (const scope of [current, projectScope(projectIds), { ...current, workstream: "engineering" }]) {
    const response = await h.runtime.app.inject(url(scope));
    assert.equal(response.statusCode, 503, response.body);
    assert.equal(response.json().error, "public_snapshot_unavailable");
  }
  assert.deepEqual(
    (await h.db.query("SELECT run_id FROM leaderboard_ingestion.collection_runs ORDER BY run_id")).rows,
    before,
  );
  assert.deepEqual((await h.db.query("SELECT * FROM leaderboard_pipeline.heads ORDER BY scope_key")).rows, head);
  assert.equal(head.length, 1);
});

test("scope admission rejects unapproved Projects, duplicate aliases and scope explosion before collection", async (t) => {
  const cases = [
    { scopes: [projectScope(["PVT_unapproved"])], error: /unapproved_scope_project/ },
    {
      scopes: [publicScope, { ...publicScope, context: "event", projects: [] }],
      error: /duplicate_public_scope_configuration/,
    },
    {
      scopes: Array.from({ length: 101 }, (_, i) => ({ ...current, workstream: `scope_${i}` })),
      error: /pipeline_scope_budget_exceeded/,
    },
  ];
  for (const entry of cases) {
    await t.test(entry.error.source, async (subtest) => {
      const h = await publicScopeHarness(subtest, { scopes: entry.scopes });
      await assert.rejects(() => h.runtime.runOnce({ cutoff: clock() }), entry.error);
      assert.equal(
        Number((await h.db.query("SELECT count(*) AS count FROM leaderboard_ingestion.collection_runs")).rows[0].count),
        0,
      );
      assert.equal(
        Number((await h.db.query("SELECT count(*) AS count FROM leaderboard_pipeline.heads")).rows[0].count),
        0,
      );
    });
  }
});

test("public workstream scope: empty and nonempty subjects outside the mapping remain unknown", async (t) => {
  const outside = { ...current, workstream: "outside" };
  const h = await publicScopeHarness(t, { scopes: [outside] });
  assert.equal((await h.runtime.runOnce({ cutoff: clock() })).state, "published");
  const view = await board(h, outside);
  assert.deepEqual(view.rows, []);
  assert.ok(view.coverage.every((entry) => entry.state === "partial"));
  const explanation = await h.runtime.aggregateExplanations.read(view.snapshotId);
  assert.equal(explanation.document.metrics[0].audit.length, 2);
  assert.deepEqual(
    explanation.document.metrics[0].audit.map((entry) => entry.reason),
    ["unknown_membership_context", "unknown_membership_context"],
  );
});

test("public workstream scope: empty subjects preserve proved in-mapping absence", async (t) => {
  const inside = { ...current, workstream: "engineering" };
  const h = await publicScopeHarness(t, { scopes: [inside] });
  h.setMemberships([[], []]);
  assert.equal((await h.runtime.runOnce({ cutoff: clock() })).state, "published");
  const view = await board(h, inside);
  assert.deepEqual(view.rows, []);
  const explanation = await h.runtime.aggregateExplanations.read(view.snapshotId);
  assert.equal(explanation.document.metrics[0].audit.length, 2);
  assert.ok(explanation.document.metrics[0].audit.every((entry) => entry.reason === "workstream_filter"));
});

test("public workstream scope: overlapping Projects still contribute one mapped action", async (t) => {
  const inside = { ...current, projects: projectIds, workstream: "engineering" };
  const h = await publicScopeHarness(t, { scopes: [inside] });
  assert.equal((await h.runtime.runOnce({ cutoff: clock() })).state, "published");
  const view = await board(h, inside);
  assert.equal(view.rows.length, 1);
  assert.equal(view.rows[0].result.value, 1);
  assert.equal(view.rows[0].evidenceIds.length, 1);
});
