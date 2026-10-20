import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { clock, components, fixtureId } from "./harness.mjs";
import { assertMetric, deliveryHarness, paths, version } from "./default-delivery-fixtures.mjs";

// Real PGlite transactions and Controls SQLite use explicitly synthetic source records.
// Every hook awaits the real query/transaction and returns its unmodified result.
async function declaredDeliveryHarness(t, family = "commit", extra = {}, afterOutput) {
  let calls = 0;
  const h = await deliveryHarness(t, family, {
    memoryDatabase: true,
    defaultDeliveryNormalizationVersion: version,
    ...extra,
    normalizerFactory: (options) => {
      const builtin = components.github.createGithubEvidenceNormalizer({
        client: options.githubClient,
        source: options.sourceId,
        allowedRepositoryIds: [2],
        isSynthetic: true,
        enrich: options.githubEnrich,
      });
      return async (input) => {
        const output = await builtin(input);
        calls++;
        if (afterOutput) await afterOutput(output, options);
        return output;
      };
    },
  });
  return { ...h, providerCalls: () => calls };
}

function observeTransaction(h, matches, change, afterCommit = false) {
  const transaction = h.db.transaction.bind(h.db);
  let calls = 0;
  h.db.transaction = async (work) => {
    let matched = false;
    const value = await transaction((tx) =>
      work({
        ...tx,
        async query(sql, params) {
          const result = await tx.query(sql, params);
          if (calls === 0 && matches(String(sql))) {
            matched = true;
            if (!afterCommit) {
              calls++;
              change();
            }
          }
          return result;
        },
      }),
    );
    if (matched && calls === 0 && afterCommit) {
      calls++;
      change();
    }
    return value;
  };
  return { calls: () => calls, restore: () => (h.db.transaction = transaction) };
}

const lockedNormalization = (sql) =>
  sql.includes("SELECT document_hash FROM leaderboard_pipeline.normalizations") && sql.includes("FOR UPDATE");
const finalDependency = (sql) =>
  sql.includes("SELECT 1 FROM leaderboard_pipeline.issue_transfer_index WHERE fact_key=$1 AND policy_signature=$2");
const snapshotInsert = (sql) => /INSERT\s+INTO\s+leaderboard_pipeline\.snapshots/i.test(sql);
const sorted = (rows) => rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

async function deliveryState(h) {
  const controls = h.controlsStore.read();
  return {
    normalizations: (
      await h.db.query("SELECT * FROM leaderboard_pipeline.normalizations ORDER BY fact_key,policy_signature")
    ).rows,
    snapshots: (await h.db.query("SELECT * FROM leaderboard_pipeline.snapshots ORDER BY revision")).rows,
    frozen: (await h.db.query("SELECT * FROM leaderboard_pipeline.frozen_inputs ORDER BY snapshot_id")).rows,
    publications: controls.pipelinePublications ?? {},
    heads: controls.pipelineHeads ?? {},
    previews: sorted(h.controlsStore.db.prepare("SELECT * FROM policy_preview_inputs").all()),
    explanations: sorted(h.controlsStore.db.prepare("SELECT * FROM pipeline_aggregate_explanations").all()),
  };
}

async function publicReplies(h, snapshotId) {
  const path = paths(h.metric)[0];
  return {
    current: await h.runtime.app.inject(path),
    pinned: snapshotId ? await h.runtime.app.inject(path + "&snapshot=" + snapshotId) : null,
  };
}

function unavailable(replies) {
  for (const response of [replies.current, replies.pinned].filter(Boolean))
    assert.ok(response.statusCode >= 400, response.body);
}

function noConfirmation(state) {
  assert.deepEqual(state.publications, {});
  assert.deepEqual(state.heads, {});
  assert.deepEqual(state.previews, []);
  assert.deepEqual(state.explanations, []);
}

// A successful same-public-cutoff run can capture an additional private preview at
// its fresh observation cutoff. All previously retained rows must remain exact.
function assertCommittedDeliveryPreserved(after, before) {
  const priorPreviewIds = new Set(before.previews.map((row) => row.id));
  assert.deepEqual({ ...after, previews: after.previews.filter((row) => priorPreviewIds.has(row.id)) }, before);
  for (const row of after.previews.filter((row) => !priorPreviewIds.has(row.id))) {
    const document = JSON.parse(row.document);
    const { snapshot } = document;
    const confirmation = before.publications[snapshot.snapshotId];
    assert.ok(confirmation, "additional preview must belong to an already confirmed snapshot");
    assert.deepEqual(snapshot, { snapshotId: confirmation.snapshotId, revision: confirmation.revision });
    assert.deepEqual(Object.keys(document).sort(), [
      "authorization",
      "baseline",
      "input",
      "policies",
      "schemaVersion",
      "scope",
      "snapshot",
    ]);
    assert.equal(document.schemaVersion, "private-policy-preview/v1");
    assert.ok(Array.isArray(document.input?.facts) && Array.isArray(document.input?.actors));
    assert.ok(Array.isArray(document.policies) && Array.isArray(document.baseline));
    assert.equal(row.id, row.digest);
    assert.equal(row.digest, createHash("sha256").update(components.metrics.stableJSON(document)).digest("hex"));
    assert.ok(Number.isSafeInteger(row.expires) && row.expires > Date.parse(document.input.cutoff));
  }
}

function actualOutcome(runtime, cutoff) {
  return runtime.runOnce({ cutoff }).then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
}

function versionFailure(outcome, state, replies) {
  assert.equal(
    outcome.error?.message,
    "default_delivery_normalizer_version_unverified",
    "actual public=" +
      replies.current.statusCode +
      ", snapshots=" +
      state.snapshots.length +
      ", confirmations=" +
      Object.keys(state.publications).length,
  );
}

for (const withdrawDeclaration of [true, false])
  test(
    withdrawDeclaration
      ? "retained default-delivery providers cannot borrow builtin compatibility after their options are removed"
      : "removing a retained default-delivery callback option preserves its still-declared compatibility",
    async (t) => {
      const h = await declaredDeliveryHarness(t, "commit", {}, async (output, options) => {
        assert.ok(output.facts.some((fact) => fact.metricId === "commits_integrated"));
        await Promise.resolve();
        delete options.normalizer;
        if (withdrawDeclaration) delete options.defaultDeliveryNormalizationVersion;
      });
      const cutoff = clock();
      const outcome = await actualOutcome(h.runtime, cutoff);
      const state = await deliveryState(h);
      const replies = await publicReplies(h, outcome.value?.publications[0]?.snapshotId);
      assert.equal(h.providerCalls(), 1);
      assert.equal(h.state.hydrations, 1);
      assert.equal(h.options.normalizer, undefined);
      assert.equal(h.options.defaultDeliveryNormalizationVersion, withdrawDeclaration ? undefined : version);
      if (withdrawDeclaration) {
        versionFailure(outcome, state, replies);
        assert.deepEqual(state.normalizations, []);
        assert.deepEqual(state.snapshots, []);
        assert.deepEqual(state.frozen, []);
        noConfirmation(state);
        unavailable(replies);
      } else {
        assert.ifError(outcome.error);
        assert.equal(outcome.value.state, "published");
        assert.equal(state.normalizations.length, 1);
        assert.equal(state.normalizations[0].document.defaultDeliveryNormalizationVersion, version);
        await assertMetric(h.runtime, h.metric, h.expected);
        const first = outcome.value.publications[0];
        assert.equal((await h.runtime.runOnce({ cutoff })).publications[0].snapshotId, first.snapshotId);
        assert.equal(h.providerCalls(), 1, "compatible cache reuse does not invoke the retained provider");
        assertCommittedDeliveryPreserved(await deliveryState(h), state);
      }
    },
  );

test("an unselected later callback cannot revoke the retained builtin default-delivery provider", async (t) => {
  const h = await deliveryHarness(t, "commit", { memoryDatabase: true });
  let unselectedCalls = 0;
  h.options.normalizer = async () => {
    unselectedCalls++;
    throw Error("unselected replacement must never run");
  };
  assert.equal(h.options.defaultDeliveryNormalizationVersion, undefined);
  const result = await h.runtime.runOnce({ cutoff: clock() });
  assert.equal(result.state, "published");
  assert.equal(unselectedCalls, 0);
  assert.equal(h.state.hydrations, 1);
  await assertMetric(h.runtime, h.metric, h.expected);
  const rows = (await deliveryState(h)).normalizations;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].document.defaultDeliveryNormalizationVersion, version);
});

test("an empty default-delivery result cannot certify a withdrawn retained provider", async (t) => {
  const h = await declaredDeliveryHarness(t, "commit", {}, (output, options) => {
    assert.deepEqual(output.facts, [], "the real builtin rejects delivery without a verified default branch");
    delete options.defaultDeliveryNormalizationVersion;
  });
  h.state.defaultBranch = undefined;
  const outcome = await actualOutcome(h.runtime, clock());
  const state = await deliveryState(h);
  const replies = await publicReplies(h);
  assert.equal(h.providerCalls(), 1);
  assert.equal(h.state.hydrations, 1);
  versionFailure(outcome, state, replies);
  assert.deepEqual(state.normalizations, []);
  assert.deepEqual(state.snapshots, []);
  assert.deepEqual(state.frozen, []);
  noConfirmation(state);
  unavailable(replies);
});

const cacheBoundaries = [
  { name: "locked normalization read", matches: lockedNormalization, afterCommit: false },
  { name: "final dependency read", matches: finalDependency, afterCommit: false },
  { name: "actual cache transaction completion", matches: lockedNormalization, afterCommit: true },
];
for (const cached of [false, true])
  for (const boundary of cacheBoundaries)
    test(
      (cached ? "cached" : "new") + " default-delivery withdrawal at " + boundary.name + " prevents fresh admission",
      async (t) => {
        const h = await declaredDeliveryHarness(t);
        const cutoff = clock();
        const first = cached ? (await h.runtime.runOnce({ cutoff })).publications[0] : null;
        if (cached) await assertMetric(h.runtime, h.metric, h.expected, first.snapshotId);
        const before = await deliveryState(h);
        const providerCalls = h.providerCalls();
        const probe = observeTransaction(
          h,
          boundary.matches,
          () => {
            delete h.options.defaultDeliveryNormalizationVersion;
          },
          boundary.afterCommit,
        );
        const outcome = await actualOutcome(h.runtime, cutoff);
        const state = await deliveryState(h);
        const replies = await publicReplies(h, first?.snapshotId);
        probe.restore();
        assert.equal(probe.calls(), 1, "the real targeted SQL boundary must execute");
        versionFailure(outcome, state, replies);
        assert.equal(h.providerCalls(), providerCalls + (cached ? 0 : 1));
        if (cached) {
          assert.deepEqual(state, before, "a failed new admission preserves all confirmed immutable inputs");
          await assertMetric(h.runtime, h.metric, h.expected, first.snapshotId);
        } else {
          assert.equal(state.normalizations.length, boundary.afterCommit ? 1 : 0);
          if (boundary.afterCommit)
            assert.equal(state.normalizations[0].document.defaultDeliveryNormalizationVersion, version);
          assert.deepEqual(state.snapshots, []);
          assert.deepEqual(state.frozen, []);
          noConfirmation(state);
          unavailable(replies);
        }
        h.options.defaultDeliveryNormalizationVersion = version;
        const beforeRecoveryCalls = h.providerCalls();
        const recovered = (await h.runtime.runOnce({ cutoff })).publications[0];
        await assertMetric(h.runtime, h.metric, h.expected, recovered.snapshotId);
        if (cached || boundary.afterCommit) {
          assert.equal(h.providerCalls(), beforeRecoveryCalls, "restored authority reuses the exact committed cache");
          assert.deepEqual((await deliveryState(h)).normalizations, state.normalizations);
        }
        if (cached) {
          assert.equal(recovered.snapshotId, first.snapshotId);
          assertCommittedDeliveryPreserved(await deliveryState(h), before);
        }
      },
    );

for (const boundary of ["publication head read", "publication transaction completion", "owning Controls callback"])
  test("default-delivery withdrawal at " + boundary + " cannot create public confirmation", async (t) => {
    const h = await declaredDeliveryHarness(t);
    const cutoff = clock();
    let controlsCalls = 0;
    let controlsArmed = false;
    const controlsTransaction = h.controlsStore.transaction.bind(h.controlsStore);
    if (boundary === "owning Controls callback")
      h.controlsStore.transaction = (work, options) =>
        controlsTransaction((state) => {
          if (controlsArmed && controlsCalls === 0) {
            controlsCalls++;
            delete h.options.defaultDeliveryNormalizationVersion;
          }
          return work(state);
        }, options);
    const probe = observeTransaction(
      h,
      boundary === "publication head read"
        ? (sql) => sql.includes("SELECT snapshot_id,revision FROM leaderboard_pipeline.heads")
        : snapshotInsert,
      () => {
        if (boundary === "owning Controls callback") controlsArmed = true;
        else delete h.options.defaultDeliveryNormalizationVersion;
      },
      boundary !== "publication head read",
    );
    const outcome = await actualOutcome(h.runtime, cutoff);
    const state = await deliveryState(h);
    const snapshotId = state.snapshots[0]?.snapshot_id;
    const replies = await publicReplies(h, snapshotId);
    probe.restore();
    h.controlsStore.transaction = controlsTransaction;
    assert.equal(probe.calls(), 1);
    assert.equal(controlsCalls, boundary === "owning Controls callback" ? 1 : 0);
    versionFailure(outcome, state, replies);
    assert.equal(h.providerCalls(), 1);
    assert.equal(state.normalizations.length, 1, "normalization was committed with a valid declaration");
    assert.equal(state.snapshots.length, boundary === "publication head read" ? 0 : 1);
    assert.equal(state.frozen.length, state.snapshots.length);
    noConfirmation(state);
    unavailable(replies);
    h.options.defaultDeliveryNormalizationVersion = version;
    const recovered = (await h.runtime.runOnce({ cutoff })).publications[0];
    assert.equal(h.providerCalls(), 1, "recovery must not replace the retained provider output");
    const after = await deliveryState(h);
    assert.deepEqual(after.normalizations, state.normalizations);
    if (snapshotId) {
      assert.equal(recovered.snapshotId, snapshotId);
      assert.deepEqual(after.snapshots, state.snapshots);
      assert.deepEqual(after.frozen, state.frozen);
    }
    await assertMetric(h.runtime, h.metric, h.expected, recovered.snapshotId);
  });

async function insertDelivery(h, n) {
  const deliveryId = fixtureId(n);
  await h.runtime.inbox.insert({
    deliveryId,
    bodyHash: "a".repeat(64),
    envelope: {
      version: "github-delivery/v1",
      deliveryId,
      event: "issues",
      action: "opened",
      installationId: 1,
      repositoryId: 2,
      subjectId: h.subjectId,
      sourceUrl: h.sourceUrl,
      actorId: null,
      occurredAt: h.at,
    },
  });
  assert.equal(await h.runtime.inbox.complete(await h.runtime.inbox.claim()), true);
}

test("a confirmed immutable default-delivery dispatch replay does not require a new provider declaration", async (t) => {
  const h = await declaredDeliveryHarness(t, "issue", { includeIssuePolicy: true, webhookDispatch: true });
  assert.equal(await h.runtime.collection.verifyPublic(2, 1, null), true);
  await insertDelivery(h, 791);
  const complete = h.runtime.outbox.complete.bind(h.runtime.outbox);
  const fail = h.runtime.outbox.fail.bind(h.runtime.outbox);
  h.runtime.outbox.complete = async () => {
    throw Error("synthetic confirmed delivery acknowledgment loss");
  };
  h.runtime.outbox.fail = async () => {
    throw Error("synthetic confirmed delivery acknowledgment loss");
  };
  await assert.rejects(h.runtime.dispatchOnce(), /synthetic confirmed delivery acknowledgment loss/);
  const before = await deliveryState(h);
  assert.equal(before.snapshots.length, 1);
  const snapshotId = before.snapshots[0].snapshot_id;
  assert.equal(before.publications[snapshotId].defaultDeliveryNormalizationVersion, version);
  await assertMetric(h.runtime, h.metric, h.expected, snapshotId);
  const calls = h.providerCalls();
  const hydrations = h.state.hydrations;
  h.runtime.outbox.complete = complete;
  h.runtime.outbox.fail = fail;
  await h.db.query(
    "UPDATE leaderboard_ingestion.outbox SET lease_until=clock_timestamp()-interval '1 second' WHERE state='leased'",
  );
  const query = h.db.query.bind(h.db);
  const controlsTransaction = h.controlsStore.transaction.bind(h.controlsStore);
  let retainedRead = 0;
  let controlsCalls = 0;
  h.db.query = async (sql, params) => {
    const result = await query(sql, params);
    if (String(sql).includes("FROM leaderboard_pipeline.dispatch_publications AS operation") && result.rows.length) {
      retainedRead++;
      assert.equal(result.rows[0].snapshot_id, snapshotId);
    }
    return result;
  };
  h.controlsStore.transaction = (work, options) =>
    controlsTransaction((state) => {
      if (retainedRead && controlsCalls === 0) {
        controlsCalls++;
        delete h.options.defaultDeliveryNormalizationVersion;
      }
      return work(state);
    }, options);
  assert.equal(await h.runtime.dispatchOnce(), "processed");
  h.db.query = query;
  h.controlsStore.transaction = controlsTransaction;
  assert.equal(retainedRead, 1);
  assert.equal(controlsCalls, 1, "withdrawal must occur inside the real final Controls transaction");
  assert.equal(h.options.defaultDeliveryNormalizationVersion, undefined);
  assert.equal(h.providerCalls(), calls);
  assert.equal(h.state.hydrations, hydrations);
  assert.deepEqual(await deliveryState(h), before);
  const outbox = (await h.db.query("SELECT state,completion FROM leaderboard_ingestion.outbox")).rows;
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0].state, "done");
  assert.ok(outbox[0].completion.publications.every((publication) => publication.snapshotId === snapshotId));
  await assertMetric(h.runtime, h.metric, h.expected);
  await assertMetric(h.runtime, h.metric, h.expected, snapshotId);
});
