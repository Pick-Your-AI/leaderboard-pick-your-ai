import assert from "node:assert/strict";
import test from "node:test";
import { createPipeline } from "../src/index.mjs";
import { ago } from "./harness.mjs";
import { comparisonHash } from "../../controls/src/policy-comparison.mjs";
import { previewAuthorityLimitsV1 } from "../../controls/src/policy-preview-authority.mjs";
import { operatorAllow, operatorHarness, operatorScopes, queueOperatorReplay } from "./operator-harness.mjs";

async function fixture(t) {
  const payload = {
    id: 1001,
    node_id: "SYNTHETIC_ISSUE_1",
    number: 1,
    html_url: "https://github.com/synthetic-org/synthetic-repo/issues/1",
    title: "Synthetic mixed-mode content A",
    body: "Synthetic mixed-mode body A",
    state: "open",
    created_at: ago(2),
    updated_at: ago(1),
    user: { id: 101, node_id: "U_SYNTHETIC_A", login: "synthetic-alice", type: "User" },
  };
  const h = await operatorHarness(t, {
    payloads: [payload],
    webhookDispatch: true,
    configure(config) {
      config.scopes = operatorScopes;
      config.reconciliation = { lookbackMs: 7 * 86400000, overlapMs: 86400000, fullAuditsPerCycle: 1 };
    },
  });
  return { h, payload, original: structuredClone(payload), publications: new Map(), facts: new Map() };
}

async function capture(context, publications) {
  const { h, payload, original } = context;
  assert.equal(publications.length, 2);
  const scopes = new Set();
  let result;
  for (const publication of publications) {
    const row = (
      await h.db.query(
        `SELECT snapshot.scope_key,snapshot.document AS published,input.document AS input
         FROM leaderboard_pipeline.snapshots AS snapshot
         JOIN leaderboard_pipeline.frozen_inputs AS input USING(snapshot_id)
         WHERE snapshot.snapshot_id=$1`,
        [publication.snapshotId],
      )
    ).rows[0];
    assert.ok(row);
    scopes.add(row.scope_key);
    const facts = row.input.frozen.facts.filter((fact) => fact.metricId === "issues_opened");
    assert.equal(facts.length, 1, "repeated source observations must credit the subject only once");
    assert.equal(facts[0].artifactId, original.node_id);
    assert.equal(facts[0].actorId, "101");
    assert.equal(facts[0].occurredAt, original.created_at, "an edit cannot invent a new opening event");
    assert.equal(row.input.frozen.actors.find((actor) => actor.id === "101").login, payload.user.login);
    assert.ok(row.input.frozen.coverage.every((entry) => entry.state === "partial" && entry.knownStart === null));
    const rows = row.published.rows.filter((entry) => entry.result.metricId === "issues_opened");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].result.value, 1);
    assert.equal(rows[0].evidenceIds.length, 1);
    const evidence = row.published.evidence.filter((entry) => entry.artifact.stableId === original.node_id);
    assert.equal(evidence.length, 1);
    assert.equal(evidence[0].evidenceMetadata.artifactTitle.value, payload.title);
    assert.equal(evidence[0].evidenceMetadata.sourceOccurredAt, original.created_at);
    if (context.publications.has(publication.snapshotId))
      assert.deepEqual(row, context.publications.get(publication.snapshotId));
    else context.publications.set(publication.snapshotId, structuredClone(row));
    result ??= { frozen: row.input.frozen, revision: evidence[0].sourceRevision };
  }
  assert.equal(scopes.size, 2);
  for (const row of (
    await h.db.query(
      `SELECT fact_key,first_run_id,source_revision,observed_at::text AS observed_at,document
       FROM leaderboard_ingestion.source_facts ORDER BY fact_key`,
    )
  ).rows) {
    assert.equal(row.document.actorId, null, "current-state observations do not name an editor");
    assert.equal(row.document.occurredAt, null, "current-state observations do not invent an edit time");
    if (context.facts.has(row.fact_key)) assert.deepEqual(row, context.facts.get(row.fact_key));
    else context.facts.set(row.fact_key, structuredClone(row));
  }
  return result;
}

async function dispatch(context, delivery) {
  const { h } = context;
  const receipt = await queueOperatorReplay(h, delivery);
  assert.equal(await h.runtime.inbox.complete(await h.runtime.inbox.claim()), true);
  assert.equal(await h.runtime.dispatchOnce(), "processed", "the actual dispatcher must finish publication");
  const result = await h.runtime.operations.readReplayResult(2, receipt.id, operatorAllow);
  assert.equal(result.status, "published", "intake processing alone is not a publication receipt");
  return capture(context, result.publications);
}

async function scheduled(context) {
  const result = await context.h.runtime.runOnce();
  assert.equal(result.state, "published");
  assert.equal(result.progress.length, 1);
  assert.ok(result.progress.every((entry) => entry.runId.startsWith("rc1:")));
  return capture(context, result.publications);
}

async function reopen(t, context, removePolicy = false) {
  const { h } = context;
  await h.runtime.stop();
  await h.reopenDatabase();
  if (removePolicy) {
    delete h.config.reconciliation;
    h.config.version = "synthetic-without-reconciliation-v2";
    h.authority.replace({
      schemaVersion: previewAuthorityLimitsV1.schemaVersion,
      revision: 2,
      validUntil: Date.now() + 60_000,
      configurationHashes: [comparisonHash(h.config)],
      reviewers: [{ actorId: "201", roleVersion: "1" }],
    });
  }
  const runtime = await createPipeline(h.options);
  h.runtime = runtime;
  t.after(() => runtime.stop());
}

async function unchangedArchives(context) {
  for (const [snapshotId, prior] of context.publications) {
    const row = (
      await context.h.db.query(
        `SELECT snapshot.scope_key,snapshot.document AS published,input.document AS input
         FROM leaderboard_pipeline.snapshots AS snapshot
         JOIN leaderboard_pipeline.frozen_inputs AS input USING(snapshot_id)
         WHERE snapshot.snapshot_id=$1`,
        [snapshotId],
      )
    ).rows[0];
    assert.deepEqual(row, prior, "later collection must not rewrite an earlier publication");
  }
}

test("policy-enabled default dispatch, scheduled reconciliation and another dispatch publish one credited subject", async (t) => {
  const context = await fixture(t);
  const first = await dispatch(context, 1);
  const audit = await scheduled(context);
  const later = await dispatch(context, 2);
  assert.equal(audit.frozen.backfillRevision, first.frozen.backfillRevision);
  assert.equal(later.frozen.backfillRevision, audit.frozen.backfillRevision);
  assert.equal(context.facts.size, 3, "each opted-in read retains an immutable source observation");
  await unchangedArchives(context);
});

test("default mixed modes publish same-clock A to B to A and retain unchanged lineage after reopen", async (t) => {
  const context = await fixture(t);
  const first = await dispatch(context, 1);
  Object.assign(context.payload, {
    title: "Synthetic mixed-mode content B",
    body: "Synthetic mixed-mode body B",
    user: { ...context.payload.user, login: "synthetic-renamed" },
  });
  assert.equal(context.payload.updated_at, context.original.updated_at);
  const edited = await scheduled(context);
  assert.notEqual(edited.revision, first.revision);
  assert.notEqual(edited.frozen.backfillRevision, first.frozen.backfillRevision);
  Object.assign(context.payload, structuredClone(context.original));
  const restored = await dispatch(context, 2);
  assert.notEqual(restored.revision, edited.revision);
  assert.notEqual(restored.revision, first.revision, "restoration must not select the original stale observation");
  await reopen(t, context);
  const unchanged = await scheduled(context);
  assert.equal(unchanged.frozen.backfillRevision, restored.frozen.backfillRevision);
  assert.equal(context.facts.size, 4);
  await unchangedArchives(context);
});

for (const initialDispatch of [false, true])
  test(`removing reconciliation on reopen preserves dispatch after retained rc1 facts (${initialDispatch ? "with" : "without"} an earlier dispatch)`, async (t) => {
    const context = await fixture(t);
    if (initialDispatch) await dispatch(context, 1);
    await scheduled(context);
    await reopen(t, context, true);
    const first = await dispatch(context, 2);
    Object.assign(context.payload, {
      title: "Synthetic policy-removed content B",
      body: "Synthetic policy-removed body B",
      user: { ...context.payload.user, login: "synthetic-after-policy-removal" },
    });
    assert.equal(context.payload.updated_at, context.original.updated_at);
    const edited = await dispatch(context, 3);
    assert.notEqual(edited.revision, first.revision);
    Object.assign(context.payload, structuredClone(context.original));
    const restored = await dispatch(context, 4);
    assert.notEqual(restored.revision, edited.revision);
    assert.notEqual(restored.revision, first.revision);
    assert.equal(context.facts.size, initialDispatch ? 5 : 4);
    await unchangedArchives(context);
  });
