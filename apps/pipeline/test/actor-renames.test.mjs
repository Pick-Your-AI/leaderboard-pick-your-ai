import assert from "node:assert/strict";
import test from "node:test";
import { createPipeline } from "../src/index.mjs";
import { harness, components, ago, boardUrl } from "./harness.mjs";

const renamed = (user = {}) => {
  const at = ago(0);
  return {
    id: 1003,
    node_id: "SYNTHETIC_ISSUE_3",
    number: 3,
    html_url: "https://github.com/synthetic-org/synthetic-repo/issues/3",
    created_at: ago(1),
    updated_at: at,
    user: { id: 101, node_id: "U_SYNTHETIC_A", login: "synthetic-alice-renamed", type: "User", ...user },
  };
};
const alice = (body) => body.rows.find((row) => row.actorId === "101");

for (const reverse of [false, true])
  test(`verified source rename preserves cached credit, automation and frozen replay in ${reverse ? "reverse" : "forward"} observation order`, async (t) => {
    const h = await harness(t, {
      reverseNormalizationRows: reverse,
      authorizePolicyPreview: async () => true,
      transformPayloads(payloads) {
        payloads[0].sender = structuredClone(payloads[0].user);
        payloads[0].execution_mode = "automated";
        return payloads;
      },
    });
    await h.runtime.runOnce();
    const first = (await h.runtime.app.inject(boardUrl)).json();
    assert.equal(alice(first).result.value, 1);
    assert.equal(alice(first).actor.executionMode, "automated");
    const oldEvidence = alice(first).evidenceIds[0];
    h.add(renamed());
    const publication = (await h.runtime.runOnce()).publications[0];
    const board = (await h.runtime.app.inject(boardUrl)).json();
    assert.equal(alice(board).result.value, 2);
    assert.equal(alice(board).actor.login, "synthetic-alice-renamed");
    assert.equal(alice(board).actor.githubNodeId, "U_SYNTHETIC_A");
    assert.equal(alice(board).actor.githubDatabaseId, 101);
    assert.equal(alice(board).actor.kind, "user");
    assert.equal(alice(board).actor.executionMode, "automated");
    assert.ok(alice(board).evidenceIds.includes(oldEvidence));
    assert.equal(
      (await h.runtime.app.inject(`/api/v1/evidence/${oldEvidence}?snapshot=${board.snapshotId}`)).statusCode,
      200,
    );
    const historical = (await h.runtime.app.inject(`${boardUrl}&snapshot=${first.snapshotId}`)).json();
    assert.equal(alice(historical).result.value, 1);
    assert.equal(alice(historical).actor.login, "synthetic-alice");
    const preview = async (runtime, snapshotId, count) => {
      const result = await runtime.previewPolicy({
        snapshotId,
        policy: { ...h.config.policies[0].policy, version: "synthetic-renamed-preview-v2", rank: false },
        operatorId: "201",
      });
      assert.equal(result.comparison.before.rows.find((row) => row.actorId === "101").value, count);
      assert.doesNotMatch(JSON.stringify(result), /githubNodeId|githubDatabaseId|first_run_id|U_SYNTHETIC_A/);
      return result;
    };
    const beforePreview = await preview(h.runtime, first.snapshotId, 1);
    const afterPreview = await preview(h.runtime, board.snapshotId, 2);
    const input = h.runtime.policyComparisons.comparisons.input(publication.comparisonInput.inputId);
    assert.equal(input.input.actors.find((actor) => actor.id === "101").login, "synthetic-alice-renamed");
    assert.doesNotMatch(JSON.stringify(input), /githubNodeId|githubDatabaseId|first_run_id|U_SYNTHETIC_A/);
    await h.runtime.stop();
    await h.reopenDatabase();
    const restarted = await createPipeline(h.options);
    t.after(() => restarted.stop());
    assert.deepEqual(await preview(restarted, first.snapshotId, 1), beforePreview);
    assert.deepEqual(await preview(restarted, board.snapshotId, 2), afterPreview);
    await restarted.runOnce();
    const replay = (await restarted.app.inject(boardUrl)).json();
    assert.equal(alice(replay).result.value, 2);
    assert.equal(alice(replay).actor.login, "synthetic-alice-renamed");
    assert.equal(alice(replay).actor.executionMode, "automated");
  });

for (const reverse of [false, true])
  test(`conflicting source aliases within one scan remain ambiguous in ${reverse ? "reverse" : "forward"} order`, async (t) => {
    const h = await harness(t, {
      reverseNormalizationRows: reverse,
      transformPayloads(payloads) {
        payloads[1].user = { ...payloads[0].user, login: "synthetic-conflicting-login" };
        return payloads;
      },
    });
    await assert.rejects(h.runtime.runOnce(), /conflicting_actor_metadata/);
    // A later coherent observation cannot erase the earlier scan's unresolved
    // contradiction, including when source rows arrive in the opposite order.
    h.add(renamed());
    await assert.rejects(h.runtime.runOnce(), /conflicting_actor_metadata/);
    assert.equal((await h.db.query("SELECT count(*)::int AS n FROM leaderboard_pipeline.snapshots")).rows[0].n, 0);
  });

for (const identity of ["missing_node", "changed_node"])
  test(`a later login cannot reconcile ${identity} provider evidence`, async (t) => {
    const h = await harness(t, {
      transformPayloads(payloads) {
        if (identity === "missing_node") delete payloads[0].user.node_id;
        return payloads;
      },
    });
    await h.runtime.runOnce();
    const first = (await h.runtime.app.inject(boardUrl)).json();
    const later = renamed({ node_id: identity === "missing_node" ? undefined : "U_SYNTHETIC_DIFFERENT" });
    h.add(later);
    await assert.rejects(h.runtime.runOnce(), /conflicting_actor_metadata/);
    const board = (await h.runtime.app.inject(boardUrl)).json();
    assert.equal(board.snapshotId, first.snapshotId);
    assert.equal(alice(board).actor.login, "synthetic-alice");
    assert.equal(alice(board).result.value, 1);
  });

for (const reverse of [false, true])
  test(`tied retained observation times from separate scans remain ambiguous in ${reverse ? "reverse" : "forward"} order`, async (t) => {
    const h = await harness(t, { reverseNormalizationRows: reverse });
    const tied = ago(0);
    const newer = new Date(Date.parse(tied) + 1).toISOString();
    const observedAt = (value) =>
      h.db.query(
        `ALTER TABLE leaderboard_ingestion.source_facts ALTER COLUMN observed_at SET DEFAULT '${value}'::timestamptz`,
      );
    // Set the disposable collector database clock before insertion; retained
    // source rows stay immutable, including their distinct first-run bindings.
    await observedAt(tied);
    await h.runtime.runOnce();
    await observedAt(newer);
    h.add({ ...renamed(), updated_at: tied });
    await h.runtime.runOnce();
    const previous = (await h.runtime.app.inject(boardUrl)).json();
    assert.equal(alice(previous).result.value, 2);
    assert.equal(alice(previous).actor.login, "synthetic-alice-renamed");
    await observedAt(tied);
    h.add({
      ...renamed({ login: "synthetic-same-time-alias" }),
      id: 1004,
      node_id: "SYNTHETIC_ISSUE_4",
      number: 4,
      html_url: "https://github.com/synthetic-org/synthetic-repo/issues/4",
      updated_at: tied,
    });
    await assert.rejects(h.runtime.runOnce(), /conflicting_actor_metadata/);
    const board = (await h.runtime.app.inject(boardUrl)).json();
    assert.equal(board.snapshotId, previous.snapshotId);
    assert.equal(alice(board).result.value, 2);
    assert.equal(alice(board).actor.login, "synthetic-alice-renamed");
  });

for (const reverse of [false, true])
  test(`frozen aliases bind exact source rows when later actor-only bytes repeat in ${reverse ? "reverse" : "forward"} order`, async (t) => {
    const h = await harness(t, {
      reverseNormalizationRows: reverse,
      authorizePolicyPreview: async () => true,
      transformPayloads(payloads) {
        payloads[1].user = structuredClone(payloads[0].user);
        return payloads;
      },
      normalizerFactory(options) {
        const normalize = components.github.createGithubEvidenceNormalizer({
          client: options.githubClient,
          source: options.sourceId,
          allowedRepositoryIds: [2],
          isSynthetic: true,
        });
        return async (input) => {
          const output = await normalize(input);
          // Approved actor context can exist without a credited metric event.
          // Its identical normalized bytes do not identify its source row.
          return ["SYNTHETIC_ISSUE_2", "SYNTHETIC_ISSUE_4"].includes(input.fact.subjectId)
            ? {
                ...output,
                facts: [],
                evidence: [],
                participation: [],
                assistance: [],
                reasons: ["synthetic_actor_context_without_credited_event"],
              }
            : output;
        };
      },
    });
    await h.runtime.runOnce();
    h.add(renamed());
    await h.runtime.runOnce();
    const historical = (await h.runtime.app.inject(boardUrl)).json();
    const request = {
      snapshotId: historical.snapshotId,
      policy: { ...h.config.policies[0].policy, version: "synthetic-source-bound-preview-v2", rank: false },
      operatorId: "201",
    };
    const before = await h.runtime.previewPolicy(request);
    const explanation = await h.runtime.aggregateExplanations.read(historical.snapshotId);
    assert.equal(alice(historical).actor.login, "synthetic-alice-renamed");
    assert.equal(before.comparison.before.rows.find((row) => row.actorId === "101").value, 2);
    assert.doesNotMatch(JSON.stringify(before), /normalizationSources|factKey|documentHash|first_run_id/);
    h.add({
      ...renamed({ login: "synthetic-alice" }),
      id: 1004,
      node_id: "SYNTHETIC_ISSUE_4",
      number: 4,
      html_url: "https://github.com/synthetic-org/synthetic-repo/issues/4",
    });
    await h.runtime.runOnce();
    const current = (await h.runtime.app.inject(boardUrl)).json();
    assert.equal(alice(current).actor.login, "synthetic-alice");
    assert.equal(alice(current).result.value, 2);
    const contexts = (
      await h.db.query(
        "SELECT fact_key,document_hash FROM leaderboard_pipeline.normalizations WHERE document->'facts'='[]'::jsonb",
      )
    ).rows;
    assert.equal(contexts.length, 2);
    assert.notEqual(contexts[0].fact_key, contexts[1].fact_key);
    assert.equal(contexts[0].document_hash, contexts[1].document_hash);
    assert.deepEqual(await h.runtime.previewPolicy(request), before);
    assert.deepEqual(await h.runtime.aggregateExplanations.read(historical.snapshotId), explanation);
    assert.doesNotMatch(JSON.stringify(current), /normalizationSources|factKey|documentHash|first_run_id/);
    await h.runtime.stop();
    await h.reopenDatabase();
    const restarted = await createPipeline(h.options);
    t.after(() => restarted.stop());
    assert.deepEqual(await restarted.previewPolicy(request), before);
    assert.deepEqual(await restarted.aggregateExplanations.read(historical.snapshotId), explanation);
    const pinned = (await restarted.app.inject(`${boardUrl}&snapshot=${historical.snapshotId}`)).json();
    assert.equal(alice(pinned).actor.login, "synthetic-alice-renamed");
    assert.equal(alice(pinned).result.value, 2);

    const { comparisonHash } = await import("../../controls/src/policy-comparison.mjs");
    const frozen = async (snapshotId) =>
      (await h.db.query("SELECT document FROM leaderboard_pipeline.frozen_inputs WHERE snapshot_id=$1", [snapshotId]))
        .rows[0].document;
    const saved = await frozen(historical.snapshotId);
    const replace = (snapshotId, document) =>
      h.db.query(
        "UPDATE leaderboard_pipeline.frozen_inputs SET document=$2::jsonb,document_hash=$3 WHERE snapshot_id=$1",
        [snapshotId, JSON.stringify(document), comparisonHash(document)],
      );
    const legacy = structuredClone(saved);
    delete legacy.identityAuthorization.identityEvidence.normalizationSources;
    await replace(historical.snapshotId, legacy);
    await assert.rejects(restarted.previewPolicy(request), /Frozen identity evidence conflict/);
    await replace(historical.snapshotId, saved);
    assert.deepEqual(await restarted.previewPolicy(request), before);
    const latest = await frozen(current.snapshotId);
    const missing = structuredClone(latest);
    const sources = missing.identityAuthorization.identityEvidence.normalizationSources;
    assert.equal(sources.filter((entry) => entry.documentHash === contexts[0].document_hash).length, 2);
    // Every exact source must remain available even when another source still
    // supplies identical bytes and therefore all normalization hashes are found.
    sources.find((entry) => entry.documentHash === contexts[0].document_hash).factKey = "f".repeat(64);
    await replace(current.snapshotId, missing);
    await assert.rejects(
      restarted.previewPolicy({ ...request, snapshotId: current.snapshotId }),
      /Frozen identity evidence unavailable/,
    );
    await replace(current.snapshotId, latest);
  });
