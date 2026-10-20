import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createOperatorPublicationVerifier } from "../src/operator-publication.mjs";
import { webhookDispatchVersion } from "../src/webhook-dispatch.mjs";
import { components, publicScope } from "./harness.mjs";
import { physicalSource } from "./fixtures/physical-context.mjs";
import { operatorAllow, publishedOperatorReplay } from "./operator-harness.mjs";
import { helpScenario, publicHelpFixture } from "../../../tests/fixtures/workstream-help.mjs";

const digest = (value) => createHash("sha256").update(components.metrics.stableJSON(value)).digest("hex");

test("operator replay verifies captured physical and presentation fields and rejects their rehashed removal", async (t) => {
  const physical = (observedAt) => {
    const value = physicalSource(observedAt === undefined ? {} : { observedAt });
    value.pull.number = 2;
    value.pull.html_url = "https://github.com/synthetic-org/synthetic-repo/pull/2";
    return value;
  };
  const issue = {
    id: 1002,
    node_id: "SYNTHETIC_ISSUE_1",
    number: 1,
    html_url: "https://github.com/synthetic-org/synthetic-repo/issues/1",
    created_at: "2026-10-06T10:00:00.000Z",
    updated_at: "2026-10-07T10:00:00.000Z",
    user: { id: 103, node_id: "U_SYNTHETIC_REPORTER", login: "synthetic-reporter", type: "User" },
  };
  const { h, receipt } = await publishedOperatorReplay(t, {
    payloads: [issue, physical().pull],
    // Preserve the existing issues-only dispatch prerequisite and collect the
    // additional PR through a finite synthetic source, with stock normalization.
    source: {
      async readPage({ family }) {
        assert.ok(["issues", "pull_requests"].includes(family));
        const item = family === "issues" ? issue : physical().pull;
        return {
          repositoryId: 2,
          visibility: "public",
          isSynthetic: true,
          nextCursor: null,
          expectedCount: 1,
          facts: [
            {
              subjectId: item.node_id,
              sourceRevision: item.updated_at,
              sourceUrl: item.html_url,
              evidence: "current_state",
              actorId: null,
              occurredAt: null,
              state: family === "issues" ? "open" : "merged",
            },
          ],
        };
      },
    },
    configure(config) {
      config.scopes = [publicScope];
      config.repositories[0].families = ["issues", "pull_requests"];
      const policy = {
        ...config.policies[0].policy,
        metricId: "pr_lines_added",
        unit: components.metrics.getMetricDefinition("pr_lines_added").definition.unit,
        aggregation: "sum",
        roles: ["author"],
        groupBy: "canonical",
      };
      config.policies.push({
        policy,
        signature: components.metrics.stableJSON(policy),
        approvalReceipt: "synthetic-physical-policy",
      });
      const help = helpScenario();
      help.binding.workstreamHelp.records = [];
      config.recognitionBindings = [help.binding];
      const helpPolicy = help.policies[0].policy;
      config.policies.push({
        policy: helpPolicy,
        signature: components.metrics.stableJSON(helpPolicy),
        approvalReceipt: "synthetic-empty-help-policy",
      });
    },
    enrichmentFactory(client, slug) {
      return async (input) => {
        if (input.family !== "pull_requests") return null;
        const value = physical(input.observedAt);
        value.envelope.payload.pull_request = await client.rest("installation:1", `/repos/${slug}/pulls/2`);
        value.envelope.proof.revision = input.fact.sourceRevision;
        return value.envelope;
      };
    },
  });
  const snapshots = (await h.db.query("SELECT snapshot_id,document,document_hash FROM leaderboard_pipeline.snapshots"))
    .rows;
  assert.equal(snapshots.length, 1);
  const saved = snapshots[0];
  assert.deepEqual(saved.document.rankingPresentationPolicy, components.contracts.currentRankingPresentationPolicy);
  assert.equal(saved.document.physicalContexts.length, 1);
  assert.equal(saved.document.physicalContexts[0].state, "available");
  assert.equal(saved.document.physicalEvidence.length, 1);
  assert.deepEqual(saved.document.reviewedWorkstreamHelp, []);
  assert.equal(
    saved.document.physicalContexts[0].samples[0].mergedEvidenceId,
    saved.document.physicalEvidence[0].contribution.contributionId,
  );
  assert.equal(digest(saved.document), saved.document_hash);
  const reads = structuredClone(h.githubReads);
  const read = () => h.runtime.operations.readReplayResult(2, receipt.id, operatorAllow);
  const initial = await read();
  assert.equal(initial.status, "published", initial.reason);
  assert.equal(initial.publications.length, 1);
  assert.equal(initial.publications[0].snapshotId, saved.snapshot_id);
  const health = await h.runtime.operations.readHealth(2, operatorAllow);
  assert.equal(health.publication.state, "verified");
  assert.deepEqual(health.publication.publications, initial.publications);
  const board = await h.runtime.app.inject("/api/v1/boards?metric=pr_lines_added");
  assert.equal(board.statusCode, 200, board.body);
  assert.equal(board.json().rows[0].result.value, 17);
  assert.equal(board.json().rows[0].physicalContext.state, "available");

  const save = (document) =>
    h.db.query("UPDATE leaderboard_pipeline.snapshots SET document=$1::jsonb,document_hash=$2 WHERE snapshot_id=$3", [
      JSON.stringify(document),
      digest(document),
      saved.snapshot_id,
    ]);
  try {
    for (const field of [
      "rankingPresentationPolicy",
      "physicalContexts",
      "physicalEvidence",
      "reviewedWorkstreamHelp",
    ]) {
      const changed = structuredClone(saved.document);
      delete changed[field];
      assert.notEqual(digest(changed), saved.document_hash);
      await save(changed);
      const unavailable = await read();
      assert.equal(unavailable.status, "unavailable", field);
      assert.equal(unavailable.reason, "publication_verification_unavailable", field);
      assert.deepEqual(unavailable.publications, [], field);
      assert.equal(unavailable.publicationDelaySeconds, null, field);
      await save(saved.document);
      assert.deepEqual(await read(), initial, `${field}: exact captured bytes restore the verified result`);
    }
  } finally {
    await save(saved.document);
  }
  h.controlsStore.transaction((state) => {
    state.profiles["101"] = { ...state.profiles["101"], suppressed: true };
  });
  const hidden = await read();
  assert.equal(hidden.status, "unavailable");
  assert.deepEqual(hidden.publications, []);
  assert.equal(hidden.publicationDelaySeconds, null);
  assert.deepEqual(h.githubReads, reads, "hash verification does not collect or replace retained source evidence");
});

async function verifyOperatorContent(capturedHelp) {
  // A fixed synthetic legacy content contract supplies the old ID independently
  // of the verifier. Ledger/authorization collaborators are bounded stubs here;
  // the preceding case exercises the actual persisted source and replay path.
  const config = { version: "synthetic-legacy-config", repositories: [{ id: 2, installationId: 1 }] };
  const cutoff = "2026-10-08T12:00:00.000Z";
  const legacy = {
    approvedPublic: true,
    scope: publicScope,
    actors: [],
    rows: [],
    evidence: [],
    portfolioEvidence: [],
    pendingEvidence: [],
    ...(capturedHelp === null ? {} : { reviewedWorkstreamHelp: capturedHelp }),
    ranking: [],
    diagnostics: [],
    methodology: [],
    definitionVersion: "synthetic-legacy-policy",
    dataMode: "synthetic",
    cutoff,
    coverage: {},
    configVersion: config.version,
    repositoryIds: [2],
  };
  const snapshotId = digest(legacy);
  const original = {
    approvedPublic: true,
    scope: publicScope,
    actors: [],
    rows: [],
    evidence: [],
    portfolioEvidence: [],
    pendingEvidence: [],
    ...(capturedHelp === null ? {} : { reviewedWorkstreamHelp: capturedHelp }),
    ranking: [],
    diagnostics: [],
    methodology: [],
    dataMode: "synthetic",
    snapshot: {
      snapshotId,
      revision: 1,
      computationVersion: "synthetic-legacy-computation",
      metricDefinitionVersion: legacy.definitionVersion,
      coverage: {},
    },
  };
  let document = structuredClone(original);
  const scopeKey = components.contracts.publicScopeKey;
  const publication = { scopeKey: scopeKey(publicScope), snapshotId, revision: 1 };
  const proof = {
    digest: "a".repeat(64),
    document: { cutoff, authorization: { controlsConfigurationRevision: 0 }, references: [], metrics: [] },
  };
  const binding = {
    repositoryId: 2,
    installationId: "1",
    sourceGeneration: "1",
    sourceGenerations: [{ repositoryId: 2, generation: "1" }],
    observationCutoff: cutoff,
    publications: [publication],
    operation: {
      configurationHash: createHash("sha256").update(JSON.stringify(config)).digest("hex"),
      configurationVersion: config.version,
      configurationRevision: 0,
      normalizationVersion: webhookDispatchVersion,
      policyVersion: legacy.definitionVersion,
      dataMode: "synthetic",
      operationKey: "synthetic-legacy-operation",
      cutoff,
    },
  };
  const verify = createOperatorPublicationVerifier({
    config,
    dataMode: "synthetic",
    policyVersion: legacy.definitionVersion,
    computationVersion: original.snapshot.computationVersion,
    scopeKey,
    publicationScopesAt: () => [publicScope],
    digest,
    approved: async () => true,
    controlsStore: {
      read: () => ({
        profiles: {},
        pipelinePublications: {
          [snapshotId]: { controlsConfigurationRevision: 0, aggregateExplanationHash: proof.digest },
        },
      }),
    },
    restrictConfiguration: () => ({ revision: 0, disabledMetricIds: [] }),
    confirmationMatches: () => true,
    aggregateExplanations: { read: () => proof, verify: () => proof },
    recognitionCurrent: () => true,
    configurationCurrent: () => true,
    withAuthorizedInputs: async (_authorizations, work) => work([], { refreshApproval: async () => true }),
  });
  // Even a legacy publication with no transfer edges takes the graph gate
  // before discovering its dependencies and locking any source or snapshot.
  const expectedQueries = [
    [/^SELECT pg_advisory_xact_lock_shared\(hashtextextended\('pipeline-issue-transfer-graph\/v1',0\)\)$/, undefined],
    [/^SELECT DISTINCT a\.artifact_id FROM leaderboard_pipeline\.source_artifacts a\b/, [["2"]]],
    [/^WITH RECURSIVE reachable\(fact_key,policy_signature\) AS \(/, [["2"], [], null]],
    [/^SELECT endpoint\.\* FROM leaderboard_pipeline\.issue_transfer_endpoints endpoint\b/, [[], []]],
    [
      /^SELECT DISTINCT source\.repository_id,artifact\.artifact_id FROM leaderboard_pipeline\.source_artifacts artifact\b/,
      [[]],
    ],
    [
      /^SELECT repository_id,installation_id,state,generation FROM leaderboard_ingestion\.repository_access[\s\S]*ORDER BY repository_id FOR SHARE$/,
      [["2"]],
    ],
    [
      /^SELECT publication\.scope_key,publication\.snapshot_id,snapshot\.revision,[\s\S]*LIMIT 101 FOR SHARE OF publication,snapshot$/,
      [binding.operation.operationKey],
    ],
    [
      /^SELECT document,document_hash FROM leaderboard_pipeline\.snapshots WHERE snapshot_id=\$1 AND scope_key=\$2$/,
      [snapshotId, publication.scopeKey],
    ],
  ];
  let queryStep = 0;
  const tx = {
    async query(sql, values) {
      const expected = expectedQueries[queryStep++];
      assert.ok(expected, `unexpected SQL at step ${queryStep}: ${sql}`);
      assert.match(sql, expected[0], `SQL order at step ${queryStep}`);
      assert.deepEqual(values, expected[1], `SQL parameters at step ${queryStep}`);
      if (queryStep <= 5) return { rows: [] };
      if (queryStep === 6) return { rows: [{ repository_id: 2, installation_id: 1, state: "public", generation: 1 }] };
      if (queryStep === 7)
        return {
          rows: [{ scope_key: publication.scopeKey, snapshot_id: snapshotId, revision: 1, document_bytes: 1024 }],
        };
      return { rows: [{ document, document_hash: digest(document) }] };
    },
  };
  const verifyLegacy = async () => {
    queryStep = 0;
    const result = await verify(tx, binding);
    assert.equal(queryStep, expectedQueries.length, "each content check completes the locked read sequence");
    return result;
  };
  const confirmed = await verifyLegacy();
  assert.equal(typeof confirmed, "function");
  assert.equal(confirmed(), true);
  assert.deepEqual(document, original);
  for (const [field, value] of [
    ["rankingPresentationPolicy", components.contracts.currentRankingPresentationPolicy],
    ["physicalContexts", []],
    ["physicalEvidence", []],
    ["reviewedWorkstreamHelp", []],
  ]) {
    document = structuredClone(original);
    if (Object.hasOwn(document, field)) delete document[field];
    else document[field] = structuredClone(value);
    assert.notEqual(digest(document), digest(original));
    assert.equal(await verifyLegacy(), null, `${field}: adding bytes cannot preserve a legacy content ID`);
  }
  if (capturedHelp !== null) {
    document = {
      ...structuredClone(original),
      reviewedWorkstreamHelp: capturedHelp.length ? [] : publicHelpFixture(1).selected.reviewedWorkstreamHelp,
    };
    assert.notEqual(digest(document), digest(original));
    assert.equal(await verifyLegacy(), null, "changing captured help cannot preserve its content ID");
  }
  document = structuredClone(original);
  assert.equal((await verifyLegacy())(), true);
}

test("legacy operator content keeps absent optional fields absent and does not accept injected captured bytes", async () => {
  await verifyOperatorContent(null);
});

test("operator content verifies captured empty help and rejects its removal or replacement", async () => {
  await verifyOperatorContent([]);
});

test("operator content verifies captured reviewed help and rejects its removal or replacement", async () => {
  await verifyOperatorContent(publicHelpFixture(1).selected.reviewedWorkstreamHelp);
});
