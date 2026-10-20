import assert from "node:assert/strict";
import test from "node:test";
import { ago, clock, components, fixtureId, harness, publicScope } from "./harness.mjs";
import { currentSignature, pairPolicy, restart, version } from "./relationship-pair-fixtures.mjs";
import { comparisonHash } from "../../controls/src/policy-comparison.mjs";
import { validateRelationshipPairCapture } from "../src/relationship-pair-authority.mjs";

const sourceSlug = "synthetic-org/synthetic-pair-issues";
const peerSlug = "synthetic-org/synthetic-pair-pulls";
const issueId = "I_SYNTHETIC_CROSS_PAIR_20";
const pullId = "PR_SYNTHETIC_CROSS_PAIR_10";
const author = { id: 101, node_id: "U_SYNTHETIC_CROSS_PAIR_101", login: "synthetic-author", type: "User" };
const actor = { id: 202, node_id: "U_SYNTHETIC_CROSS_PAIR_202", login: "synthetic-linker", type: "User" };
const earlierActor = {
  id: 303,
  node_id: "U_SYNTHETIC_CROSS_PAIR_303",
  login: "synthetic-earlier-linker",
  type: "User",
};

// The source is one native issue-side observation. The other endpoint is an
// approved public repository, not an issue-transfer alias or a display scope.
// Collection and the builtin normalizer produce every retained fact and proof.
async function crossRepositoryHarness(
  t,
  metric,
  {
    approvedPeer = true,
    peerAvailable = true,
    earlierPeerHistory = false,
    peerHistoryDays = 3,
    repositoryOnly = false,
    conflictingPeerAuthor = false,
    memoryDatabase = true,
    reviewedPeerHistory = false,
    independentPair = false,
  } = {},
) {
  const at = ago(2);
  const peerAt = ago(peerHistoryDays);
  const kind = metric === "reference_links" ? "reference" : "closing";
  const eventId = `synthetic-cross-pair-${kind}`;
  const sourceUrl = `https://github.com/${sourceSlug}/issues/20`;
  const peerUrl = `https://github.com/${peerSlug}/pull/10`;
  const calls = { probes: [], pages: [], hydrations: 0 };
  const history = { revision: "v1", pair: "bound", reviewedRevision: 0, target: issueId };
  let originalPeerFact;
  const h = await harness(t, {
    memoryDatabase,
    authorizePolicyPreview: async () => true,
    ...(reviewedPeerHistory
      ? {
          relationshipPairNormalizationVersion: version,
          normalizerFactory(options) {
            const builtin = components.github.createGithubEvidenceNormalizer({
              client: options.githubClient,
              source: options.sourceId,
              allowedRepositoryIds: [2, 3],
              isSynthetic: true,
              enrich: options.githubEnrich,
            });
            return async (input) => {
              const output = await builtin(input);
              if (input.repository.id !== 3) return output;
              for (const fact of output.facts.filter((fact) => fact.metricId === metric)) {
                originalPeerFact ??= structuredClone(fact);
                const previousId = fact.id;
                fact.id = originalPeerFact.id;
                fact.canonicalKey = originalPeerFact.canonicalKey;
                fact.revision = history.reviewedRevision;
                fact.correctionReceipt = history.reviewedRevision ? "synthetic-reviewed-pair-revision" : null;
                for (const entry of output.evidence.filter(
                  (entry) => entry.contribution.contributionId === previousId,
                )) {
                  entry.contribution.contributionId = fact.id;
                  entry.contribution.canonicalEventId = fact.canonicalKey;
                }
              }
              return output;
            };
          },
        }
      : {}),
    configure(config) {
      config.repositories = [
        {
          id: 2,
          installationId: 1,
          slug: sourceSlug,
          families: ["issues"],
          approvalReceipt: "synthetic-issue-source-approved",
        },
        ...(approvedPeer
          ? [
              {
                id: 3,
                installationId: 1,
                slug: peerSlug,
                families: ["issues"],
                approvalReceipt: "synthetic-peer-source-approved",
              },
            ]
          : []),
      ];
      const policy = pairPolicy(metric);
      config.policies = [
        { policy, signature: components.metrics.stableJSON(policy), approvalReceipt: "synthetic-cross-pair-policy" },
      ];
      config.scopes = (repositoryOnly ? ["2"] : [null, "2"]).map((repository) => ({ ...publicScope, repository }));
    },
    async probeRepository(repository) {
      calls.probes.push(repository.id);
      assert.ok(repository.id === 2 || (approvedPeer && repository.id === 3));
      if (repository.id === 3 && !peerAvailable) throw new Error("synthetic peer probe unavailable");
      return {
        repositoryId: repository.id,
        installationId: repository.installationId,
        visibility: "public",
        checkedAt: clock(),
      };
    },
    source: {
      async readPage(request) {
        calls.pages.push(request.repositoryId);
        assert.equal(request.family, "issues");
        assert.ok(request.repositoryId === 2 || (approvedPeer && request.repositoryId === 3));
        const facts =
          request.repositoryId === 2
            ? [
                {
                  subjectId: issueId,
                  sourceRevision: "synthetic-cross-pair-source-v1",
                  sourceUrl,
                  evidence: "current_state",
                  actorId: null,
                  occurredAt: null,
                  state: "present",
                },
                ...(independentPair
                  ? [
                      {
                        subjectId: "I_SYNTHETIC_CROSS_PAIR_21",
                        sourceRevision: "synthetic-independent-pair-source-v1",
                        sourceUrl: `https://github.com/${sourceSlug}/issues/21`,
                        evidence: "current_state",
                        actorId: null,
                        occurredAt: null,
                        state: "present",
                      },
                    ]
                  : []),
              ]
            : earlierPeerHistory
              ? [
                  {
                    subjectId: pullId,
                    sourceRevision: `synthetic-cross-pair-earlier-source-${history.revision}`,
                    sourceUrl: peerUrl,
                    evidence: "current_state",
                    actorId: null,
                    occurredAt: null,
                    state: "present",
                  },
                ]
              : [];
        return {
          repositoryId: request.repositoryId,
          visibility: "public",
          isSynthetic: true,
          nextCursor: null,
          expectedCount: facts.length,
          facts,
        };
      },
    },
    async githubEnrich(input) {
      calls.hydrations++;
      const peer = input.repository.id === 3;
      const independent = independentPair && input.fact.subjectId === "I_SYNTHETIC_CROSS_PAIR_21";
      const currentIssueId = independent ? "I_SYNTHETIC_CROSS_PAIR_21" : issueId;
      const currentIssueUrl = independent ? `https://github.com/${sourceSlug}/issues/21` : sourceUrl;
      assert.ok(!peer || earlierPeerHistory);
      assert.equal(input.fact.subjectId, peer ? pullId : currentIssueId);
      assert.equal(input.fact.sourceUrl, peer ? peerUrl : currentIssueUrl);
      const repositoryId = peer ? 3 : 2;
      const slug = peer ? peerSlug : sourceSlug;
      const occurredAt = peer ? peerAt : at;
      const nativeEventId = peer ? `${eventId}-earlier` : independent ? `${eventId}-independent` : eventId;
      return {
        repository: { id: repositoryId, slug, visibility: "public", defaultBranch: "main" },
        proof: {
          verified: true,
          source: "github_graphql",
          revision: input.fact.sourceRevision,
          eventId: nativeEventId,
          isSynthetic: true,
        },
        family: "relationship",
        action: kind === "reference" ? "referenced" : "connected",
        occurredAt,
        observedAt: input.observedAt,
        payload: {
          repository: { id: repositoryId, private: false, full_name: slug },
          [peer ? "pull_request" : "issue"]: {
            id: peer ? 10 : independent ? 21 : 20,
            node_id: peer ? pullId : currentIssueId,
            number: peer ? 10 : independent ? 21 : 20,
            html_url: peer ? peerUrl : currentIssueUrl,
            created_at: occurredAt,
            updated_at: occurredAt,
            state: "open",
            user: peer && conflictingPeerAuthor ? { ...actor, login: "synthetic-unrelated-peer-alias" } : author,
          },
          sender: peer ? earlierActor : actor,
          relationship: {
            kind,
            from: pullId,
            to: peer ? history.target : currentIssueId,
            intentional: true,
            publicEndpointsVerified: !(peer && history.pair === "empty"),
            pair:
              peer && history.pair === "unbound"
                ? undefined
                : {
                    version,
                    kind,
                    action: kind === "reference" ? "reference" : "connect",
                    eventId: nativeEventId,
                    from: { repositoryId: "3", artifactId: pullId, kind: "pull_request" },
                    to: { repositoryId: "2", artifactId: peer ? history.target : currentIssueId, kind: "issue" },
                  },
          },
        },
      };
    },
  });
  return { ...h, calls, metric, history };
}

const query = (metric, repository = null, snapshot = null) =>
  new URLSearchParams({
    metric,
    ...(repository === null ? {} : { repository: String(repository) }),
    ...(snapshot ? { snapshot } : {}),
  });
const values = (board) =>
  board.rows.filter((row) => row.result.value > 0).map((row) => [row.actorId, row.result.value]);
async function board(runtime, metric, repository = null, snapshot = null) {
  const response = await runtime.app.inject(`/api/v1/boards?${query(metric, repository, snapshot)}`);
  assert.equal(response.statusCode, 200, response.body);
  assert.doesNotMatch(response.body, /relationshipPair|normalizationHashes|normalizationSources/);
  return response.json();
}
async function published(h) {
  const result = await h.runtime.runOnce({ cutoff: clock() });
  assert.equal(result.state, "published", JSON.stringify(result));
  return result;
}
async function frozenInput(h, snapshotId) {
  return (
    await h.db.query("SELECT document FROM leaderboard_pipeline.frozen_inputs WHERE snapshot_id=$1", [snapshotId])
  ).rows[0].document;
}
function authoritySummary(input) {
  return {
    display: input.engineScope.repos,
    authorizedRepositories: input.frozen.repositoryIds,
    sources: input.identityAuthorization.sources,
    facts: input.frozen.facts.map((fact) => ({ repo: fact.repoId, actor: fact.actorId, metric: fact.metricId })),
  };
}
async function assertWithdrawn(h, entries) {
  for (const [repository, saved] of entries) {
    for (const snapshot of [null, saved.snapshotId]) {
      for (const suffix of ["/boards", "/exports"]) {
        const response = await h.runtime.app.inject(`/api/v1${suffix}?${query(h.metric, repository, snapshot)}`);
        if (response.statusCode === 200) {
          if (suffix === "/boards")
            assert.deepEqual(values(response.json()), [], "a safe projected response must withdraw the revoked pair");
          else assert.doesNotMatch(response.body, /synthetic-linker|synthetic-earlier-linker/);
          assert.equal(response.body.includes(pullId), false);
          assert.equal(response.body.includes(issueId), false);
        } else assert.equal(response.statusCode, snapshot ? 410 : 503, response.body);
        assert.doesNotMatch(response.body, /relationshipPair|normalizationHashes|normalizationSources/);
      }
    }
  }
}

for (const metric of ["reference_links", "closing_links"]) {
  for (const scenario of ["native-unbound", "native-empty", "reviewed-unbound"]) {
    test(`${metric}: displaced ${scenario} pair history cannot promote a later event`, async (t) => {
      const h = await crossRepositoryHarness(t, metric, {
        earlierPeerHistory: true,
        reviewedPeerHistory: scenario === "reviewed-unbound",
        memoryDatabase: scenario !== "native-empty",
      });
      await published(h);
      const prior = await board(h.runtime, metric);
      assert.deepEqual(values(prior), [["303", 1]], "the original earlier event owns the known pair");
      const originalRows = (
        await h.db.query(
          "SELECT fact_key,policy_signature,document_hash,document FROM leaderboard_pipeline.normalizations ORDER BY fact_key,policy_signature",
        )
      ).rows;
      h.history.revision = "v2";
      h.history.pair = scenario === "native-empty" ? "empty" : "unbound";
      h.history.reviewedRevision = scenario === "reviewed-unbound" ? 1 : 0;
      await published(h);
      const current = await board(h.runtime, metric);
      t.diagnostic(
        JSON.stringify({ scenario, rows: current.rows.map((row) => ({ actorId: row.actorId, result: row.result })) }),
      );
      assert.deepEqual(values(current), [], "losing the earlier supported descriptor must not elect the later actor");
      assert.deepEqual(
        values(await board(h.runtime, metric, 2)),
        [],
        "repository filtering cannot bypass the same uncertainty",
      );
      const frozen = await frozenInput(h, current.snapshotId);
      const later = frozen.frozen.facts.find((fact) => fact.metricId === metric && fact.actorId === "202");
      assert.equal(later.state, "unknown", "retain qualification uncertainty instead of a measured later contribution");
      const aggregate = components.metrics.aggregateMetric(
        frozen.frozen,
        h.config.policies[0].policy,
        frozen.engineScope,
      );
      assert.deepEqual(aggregate.rows, [], "unknown facts create neither positive credit nor a measured zero row");
      assert.ok(
        aggregate.audit.some((entry) => entry.reason === "unknown_qualification" && entry.factIds.includes(later.id)),
      );
      assert.equal(
        frozen.identityAuthorization.relationshipPairEvidence.schemaVersion,
        "pipeline-relationship-pair-authority/v2",
      );
      const obsolete = structuredClone(frozen.identityAuthorization.relationshipPairEvidence);
      obsolete.schemaVersion = "pipeline-relationship-pair-authority/v1";
      assert.throws(() => validateRelationshipPairCapture(obsolete), /relationship_pair_frozen_binding_invalid/);
      const obsoleteAuthorization = { ...frozen.identityAuthorization, relationshipPairEvidence: obsolete };
      await assert.rejects(
        h.runtime.policyComparisons.withAuthorizedInputs([obsoleteAuthorization], () =>
          assert.fail("old capture must not reach private restoration"),
        ),
        /relationship_pair_frozen_binding_invalid/,
      );
      const rowsAfter = (
        await h.db.query(
          "SELECT fact_key,policy_signature,document_hash,document FROM leaderboard_pipeline.normalizations ORDER BY fact_key,policy_signature",
        )
      ).rows;
      for (const row of originalRows) {
        assert.deepEqual(
          rowsAfter.find(
            (candidate) => candidate.fact_key === row.fact_key && candidate.policy_signature === row.policy_signature,
          ),
          row,
          "original current-generation normalizations remain immutable",
        );
      }
      const request = {
        snapshotId: current.snapshotId,
        policy: { ...h.config.policies[0].policy, version: "synthetic-unresolved-history-preview" },
        operatorId: "201",
      };
      const preview = await h.runtime.previewPolicy(request);
      assert.equal(
        preview.comparison.before.rows.some((row) => row.value > 0),
        false,
      );
      assert.deepEqual(await h.runtime.previewPolicy(request), preview, "private replay keeps the frozen uncertainty");
      if (scenario === "native-empty") {
        await restart(h, async (runtime) => {
          assert.deepEqual(
            await runtime.previewPolicy(request),
            preview,
            "actual database reopen preserves v2 uncertainty",
          );
          assert.deepEqual(values(await board(runtime, metric, null, current.snapshotId)), []);
        });
      }
    });
  }

  test(`${metric}: equivalent current history can recover after an unbound observation`, async (t) => {
    const h = await crossRepositoryHarness(t, metric, { earlierPeerHistory: true });
    await published(h);
    h.history.revision = "v2";
    h.history.pair = "unbound";
    await published(h);
    assert.deepEqual(values(await board(h.runtime, metric)), []);
    h.history.revision = "v3";
    h.history.pair = "bound";
    await published(h);
    assert.deepEqual(
      values(await board(h.runtime, metric)),
      [["303", 1]],
      "a later equivalent verified binding restores its original unit",
    );
    assert.deepEqual(
      values(await board(h.runtime, metric, 2)),
      [],
      "the later repository view does not become the first contribution",
    );
  });

  test(`${metric}: a higher reviewed bound revision can correct the earlier pair`, async (t) => {
    const h = await crossRepositoryHarness(t, metric, { earlierPeerHistory: true, reviewedPeerHistory: true });
    await published(h);
    h.history.revision = "v2";
    h.history.reviewedRevision = 1;
    h.history.target = "I_SYNTHETIC_CROSS_PAIR_21";
    await published(h);
    assert.deepEqual(
      values(await board(h.runtime, metric)).sort(),
      [
        ["202", 1],
        ["303", 1],
      ],
      "the admitted correction establishes its new pair without resurrecting its old binding",
    );
    assert.deepEqual(values(await board(h.runtime, metric, 2)), [["202", 1]]);
  });

  test(`${metric}: an unreviewed same-event endpoint change cannot discharge known history`, async (t) => {
    const h = await crossRepositoryHarness(t, metric, { earlierPeerHistory: true });
    await published(h);
    h.history.revision = "v2";
    h.history.target = "I_SYNTHETIC_CROSS_PAIR_21";
    await published(h);
    assert.deepEqual(
      values(await board(h.runtime, metric)),
      [],
      "changing a native event's meaning does not resolve either connected pair",
    );
    const current = await board(h.runtime, metric, 2);
    assert.deepEqual(values(current), []);
    const input = await frozenInput(h, current.snapshotId);
    assert.ok(input.frozen.facts.filter((fact) => fact.metricId === metric).every((fact) => fact.state === "unknown"));
  });

  test(`${metric}: history uncertainty preserves an independent pair sharing its peer endpoint`, async (t) => {
    const h = await crossRepositoryHarness(t, metric, { earlierPeerHistory: true, independentPair: true });
    await published(h);
    assert.deepEqual(values(await board(h.runtime, metric)).sort(), [
      ["202", 1],
      ["303", 1],
    ]);
    h.history.revision = "v2";
    h.history.pair = "empty";
    await published(h);
    const current = await board(h.runtime, metric);
    assert.deepEqual(values(current), [["202", 1]], "only the independent pair remains eligible");
    const input = await frozenInput(h, current.snapshotId);
    const facts = input.frozen.facts.filter((fact) => fact.actorId === "202" && fact.metricId === metric);
    assert.equal(facts.find((fact) => fact.relationshipPair.to.artifactId === issueId).state, "unknown");
    assert.equal(
      facts.find((fact) => fact.relationshipPair.to.artifactId === "I_SYNTHETIC_CROSS_PAIR_21").state,
      "observed",
    );
    assert.ok(facts.every((fact) => fact.relationshipPair.from.artifactId === pullId));
  });

  test(`${metric}: repository display retains an approved public peer's pair authority`, async (t) => {
    const h = await crossRepositoryHarness(t, metric);
    await published(h);
    const org = await board(h.runtime, metric);
    const selected = await board(h.runtime, metric, 2);
    const frozen = await frozenInput(h, selected.snapshotId);
    t.diagnostic(
      JSON.stringify({
        org: authoritySummary(await frozenInput(h, org.snapshotId)),
        repository: authoritySummary(frozen),
      }),
    );
    assert.deepEqual(values(org), [["202", 1]], "the exact same collected pair is valid in organization scope");
    assert.deepEqual(values(selected), values(org), "repository display must not remove approved endpoint authority");
    for (const [repository, snapshot] of [
      [null, org.snapshotId],
      [2, selected.snapshotId],
    ]) {
      assert.deepEqual(values(await board(h.runtime, metric, repository, snapshot)), [["202", 1]]);
      for (const format of ["json", "csv"]) {
        const response = await h.runtime.app.inject(
          `/api/v1/exports?${query(metric, repository, snapshot)}&format=${format}`,
        );
        assert.equal(response.statusCode, 200, response.body);
        assert.doesNotMatch(response.body, /relationshipPair|normalizationHashes|normalizationSources/);
      }
    }
    assert.deepEqual(frozen.engineScope.repos, ["2"], "display selection remains narrow");
    assert.ok(
      frozen.frozen.repositoryIds.includes("2") && frozen.frozen.repositoryIds.includes("3"),
      "both endpoint authorities are captured privately",
    );
    assert.deepEqual(
      frozen.identityAuthorization.sources.map((source) => source.repositoryId).sort(),
      ["2", "3"],
      "the nonselected peer has an independently bound current source gate",
    );
    assert.equal(
      (await h.db.query("SELECT count(*)::int AS n FROM leaderboard_ingestion.source_facts WHERE repository_id=3"))
        .rows[0].n,
      0,
      "independent peer access authority does not require a peer source observation",
    );
    assert.equal(
      (await h.db.query("SELECT count(*)::int AS n FROM leaderboard_pipeline.issue_transfer_index")).rows[0].n,
      0,
      "pair authority must not depend on an invented transfer",
    );
  });

  test(`${metric}: a peer outside the approved configuration cannot supply pair authority`, async (t) => {
    const h = await crossRepositoryHarness(t, metric, { approvedPeer: false });
    await published(h);
    for (const repository of [null, 2]) {
      const response = await h.runtime.app.inject(`/api/v1/boards?${query(metric, repository)}`);
      if (response.statusCode === 200) assert.deepEqual(values(response.json()), []);
      else assert.equal(response.statusCode, 503, response.body);
      assert.doesNotMatch(response.body, /relationshipPair|normalizationHashes|normalizationSources/);
    }
    const retained = (await h.db.query("SELECT document FROM leaderboard_pipeline.frozen_inputs ORDER BY snapshot_id"))
      .rows;
    assert.equal(retained.length, 2);
    for (const { document: input } of retained) {
      assert.equal(input.frozen.repositoryIds.includes("3"), false);
      assert.equal(
        input.identityAuthorization.sources.some((source) => source.repositoryId === "3"),
        false,
      );
      assert.deepEqual(
        components.metrics.aggregateMetric(input.frozen, h.config.policies[0].policy, input.engineScope).rows,
        [],
      );
    }
    assert.ok(h.calls.probes.length > 0 && h.calls.probes.every((id) => id === 2));
    assert.ok(h.calls.pages.length > 0 && h.calls.pages.every((id) => id === 2));
  });

  test(`${metric}: an unavailable configured peer cannot be replaced by the descriptor's public claim`, async (t) => {
    const h = await crossRepositoryHarness(t, metric, { peerAvailable: false });
    await assert.rejects(h.runtime.runOnce({ cutoff: clock() }), /public_source_not_verified/);
    assert.equal((await h.db.query("SELECT count(*)::int AS n FROM leaderboard_pipeline.snapshots")).rows[0].n, 0);
    for (const repository of [null, 2]) {
      const response = await h.runtime.app.inject(`/api/v1/boards?${query(metric, repository)}`);
      assert.equal(response.statusCode, 503, response.body);
    }
  });

  test(`${metric}: peer revocation withdraws current and pinned pair views and private replay authority`, async (t) => {
    const h = await crossRepositoryHarness(t, metric);
    await published(h);
    const org = await board(h.runtime, metric);
    const selected = await board(h.runtime, metric, 2);
    assert.deepEqual(values(org), [["202", 1]]);
    assert.deepEqual(values(selected), [["202", 1]]);
    await h.runtime.previewPolicy({
      snapshotId: selected.snapshotId,
      policy: { ...h.config.policies[0].policy, version: "synthetic-cross-pair-preview" },
      operatorId: "201",
    });
    const before = (
      await h.db.query(
        "SELECT fact_key,policy_signature,document,document_hash FROM leaderboard_pipeline.normalizations ORDER BY fact_key,policy_signature",
      )
    ).rows;
    assert.equal(
      await h.runtime.collection.suppress(
        fixtureId(metric === "reference_links" ? 971 : 972),
        "a".repeat(64),
        1,
        [3],
        "private",
      ),
      "accepted",
    );
    await assertWithdrawn(h, [
      [null, org],
      [2, selected],
    ]);
    await assert.rejects(
      h.runtime.previewPolicy({
        snapshotId: selected.snapshotId,
        policy: { ...h.config.policies[0].policy, version: "synthetic-cross-pair-preview-after-revocation" },
        operatorId: "201",
      }),
      /policy_input_revoked|Frozen|unavailable/,
    );
    await assert.rejects(h.runtime.aggregateExplanations.read(selected.snapshotId), /Frozen|unavailable|changed/);
    assert.deepEqual(
      (
        await h.db.query(
          "SELECT fact_key,policy_signature,document,document_hash FROM leaderboard_pipeline.normalizations ORDER BY fact_key,policy_signature",
        )
      ).rows,
      before,
      "revocation changes authority without rewriting retained source evidence",
    );
  });

  test(`${metric}: deleting a typed peer endpoint with no peer source row withdraws dependent pair views`, async (t) => {
    const h = await crossRepositoryHarness(t, metric);
    await published(h);
    const org = await board(h.runtime, metric);
    const selected = await board(h.runtime, metric, 2);
    assert.deepEqual(values(org), [["202", 1]]);
    assert.deepEqual(values(selected), [["202", 1]]);
    assert.equal(
      (await h.db.query("SELECT count(*)::int AS n FROM leaderboard_ingestion.source_facts WHERE repository_id=3"))
        .rows[0].n,
      0,
    );
    const runId = fixtureId(metric === "reference_links" ? 973 : 974);
    await h.runtime.collection.start({
      runId,
      repositoryId: 3,
      family: "issues",
      mode: "audit",
      since: null,
      until: clock(),
    });
    assert.equal(
      await h.runtime.collection.step(runId, {
        async readPage(request) {
          assert.equal(request.repositoryId, 3);
          return {
            repositoryId: 3,
            visibility: "public",
            isSynthetic: true,
            expectedCount: 1,
            nextCursor: null,
            facts: [
              {
                subjectId: pullId,
                sourceRevision: "synthetic-peer-deleted-v1",
                sourceUrl: `https://github.com/${peerSlug}/pull/10`,
                evidence: "current_state",
                actorId: null,
                occurredAt: null,
                state: "deleted",
              },
            ],
          };
        },
      }),
      "complete",
    );
    assert.deepEqual(
      (
        await h.db.query(
          "SELECT subject_id,reason FROM leaderboard_ingestion.object_suppressions WHERE repository_id=3",
        )
      ).rows,
      [{ subject_id: pullId, reason: "deleted" }],
      "the actual collector records the typed endpoint's deletion",
    );
    assert.equal(
      (await h.db.query("SELECT state FROM leaderboard_ingestion.repository_access WHERE repository_id=3")).rows[0]
        .state,
      "public",
      "object deletion is distinct from repository revocation",
    );
    await assertWithdrawn(h, [
      [null, org],
      [2, selected],
    ]);
    await assert.rejects(
      h.runtime.previewPolicy({
        snapshotId: selected.snapshotId,
        policy: { ...h.config.policies[0].policy, version: "synthetic-cross-pair-preview-after-deletion" },
        operatorId: "201",
      }),
      /policy_input_revoked|Frozen|unavailable/,
    );
    await assert.rejects(h.runtime.aggregateExplanations.read(selected.snapshotId), /Frozen|unavailable|changed/);
  });

  test(`${metric}: authorized peer history is conserved before repository display can select a later actor`, async (t) => {
    const h = await crossRepositoryHarness(t, metric, { earlierPeerHistory: true });
    await published(h);
    const org = await board(h.runtime, metric);
    const selected = await board(h.runtime, metric, 2);
    const input = await frozenInput(h, selected.snapshotId);
    t.diagnostic(
      JSON.stringify({
        org: authoritySummary(await frozenInput(h, org.snapshotId)),
        repository: authoritySummary(input),
      }),
    );
    assert.deepEqual(values(org), [["303", 1]], "the earlier native peer-side event owns the conserved pair");
    assert.deepEqual(values(selected), [], "display filtering cannot promote the later actor in repo2");
    assert.deepEqual(input.engineScope.repos, ["2"]);
    assert.ok(
      input.frozen.facts.some((fact) => fact.repoId === "3" && fact.actorId === "303" && fact.metricId === metric),
      "the selected view retains authorized earlier history for conservation",
    );
    assert.deepEqual(input.identityAuthorization.sources.map((source) => source.repositoryId).sort(), ["2", "3"]);
    assert.ok(
      input.frozen.actors.some((actor) => actor.id === "303"),
      "the private frozen actor remains available for conservation",
    );
    for (const [repository, includesPeer] of [
      [null, true],
      [2, false],
    ]) {
      const directory = await h.runtime.app.inject(
        `/api/v1/contributors${repository === null ? "" : `?repository=${repository}`}`,
      );
      assert.equal(directory.statusCode, 200, directory.body);
      assert.equal(
        directory.json().contributors.some((actor) => actor.actorId === "303"),
        includesPeer,
        "dependency-only actors must not become public members of the selected repository",
      );
      const publicRead = await h.runtime.source.read(
        { ...publicScope, repository: repository === null ? null : String(repository) },
        repository === null ? org.snapshotId : selected.snapshotId,
        new AbortController().signal,
      );
      assert.ok(publicRead);
      assert.equal(
        publicRead.selected.actors.some((actor) => actor.actorId === "303"),
        includesPeer,
      );
      if (!includesPeer) {
        assert.ok(
          publicRead.selected.actors.some((actor) => actor.actorId === "202"),
          "the original selected-source actor remains in the public snapshot roster",
        );
        assert.doesNotMatch(directory.body, /synthetic-earlier-linker|U_SYNTHETIC_CROSS_PAIR_303/);
      }
    }
  });

  test(`${metric}: dependency-only source identity projection survives private replay and reopen`, async (t) => {
    const h = await crossRepositoryHarness(t, metric, {
      earlierPeerHistory: true,
      repositoryOnly: true,
      conflictingPeerAuthor: true,
      memoryDatabase: false,
    });
    const result = await published(h);
    assert.equal(result.publications.length, 1, "only the approved repository display is published");
    const publication = result.publications[0];
    const input = await frozenInput(h, publication.snapshotId);
    const peer = (
      await h.db.query(
        "SELECT n.*,f.repository_id FROM leaderboard_pipeline.normalizations n JOIN leaderboard_ingestion.source_facts f USING(fact_key) WHERE f.repository_id=3",
      )
    ).rows[0];
    assert.ok(peer, "the actual builtin normalizer persisted the peer observation");
    assert.equal(peer.document.actors.find((value) => value.id === "202").login, "synthetic-unrelated-peer-alias");
    assert.equal(peer.document.actors.find((value) => value.id === "202").githubDatabaseId, actor.id);
    assert.equal(peer.document.actors.find((value) => value.id === "202").githubNodeId, actor.node_id);
    assert.ok(peer.document.actors.some((value) => value.id === "303"));
    const peerBinding = input.identityAuthorization.identityEvidence.normalizationSources.find(
      (source) => source.factKey === peer.fact_key,
    );
    assert.ok(peerBinding);
    assert.deepEqual(
      peerBinding.relationshipPairFactHashes,
      peer.document.facts
        .filter((fact) => fact.metricId === metric && fact.actorId === "303")
        .map(comparisonHash)
        .sort(),
    );
    assert.equal(peerBinding.relationshipPairFactHashes.length, 1);
    assert.equal(input.frozen.actors.find((value) => value.id === "202").login, actor.login);
    assert.ok(input.frozen.actors.some((value) => value.id === "303"));
    assert.deepEqual(
      input.identityAuthorization.relationshipPairEvidence.bindings.find((binding) => binding.factKey === peer.fact_key)
        .factHashes,
      peerBinding.relationshipPairFactHashes,
    );
    const captured = h.runtime.policyComparisons.comparisons.input(publication.comparisonInput.inputId);
    assert.deepEqual(
      captured.authorization.identityEvidence.normalizationSources,
      input.identityAuthorization.identityEvidence.normalizationSources,
      "policy capture preserves the exact bound projection",
    );
    const request = {
      snapshotId: publication.snapshotId,
      policy: { ...h.config.policies[0].policy, version: "synthetic-projected-identity-preview" },
      operatorId: "201",
    };
    const verifyPrivate = async (runtime) => {
      const explanation = await runtime.aggregateExplanations.read(publication.snapshotId);
      assert.deepEqual(
        explanation.document.authorization.identityEvidence.normalizationSources,
        input.identityAuthorization.identityEvidence.normalizationSources,
        "explanation preserves the same projection as frozen input and policy capture",
      );
      const preview = await runtime.previewPolicy(request);
      assert.deepEqual(preview.comparison.before.rows, []);
      assert.deepEqual(
        await runtime.previewPolicy(request),
        preview,
        "a retained comparison replay restores the same projected actor identities",
      );
      assert.doesNotMatch(JSON.stringify(preview), /synthetic-unrelated-peer-alias/);
      const restored = await runtime.policyComparisons.withAuthorizedInputs(
        [captured.authorization],
        (removed, authority) => {
          assert.deepEqual(removed, []);
          return authority.restoreInput(captured.input, captured.authorization);
        },
      );
      const selectedActor = restored.actors.find((value) => value.id === "202");
      assert.equal(selectedActor.login, actor.login);
      assert.equal(selectedActor.githubDatabaseId, actor.id);
      assert.equal(selectedActor.githubNodeId, actor.node_id);
      assert.deepEqual(values(await board(runtime, metric, 2, publication.snapshotId)), []);
      return { explanation, preview };
    };
    const before = await verifyPrivate(h.runtime);
    await restart(h, async (runtime) => {
      assert.deepEqual(
        await verifyPrivate(runtime),
        before,
        "actual SQLite/PGlite reopen retains private projection authority",
      );
      const reopened = runtime.policyComparisons.comparisons.input(publication.comparisonInput.inputId);
      assert.deepEqual(
        reopened.authorization.identityEvidence.normalizationSources,
        input.identityAuthorization.identityEvidence.normalizationSources,
      );
    });
  });

  test(`${metric}: an identical historical wrapper cannot block or replace the exact captured peer normalization`, async (t) => {
    const h = await crossRepositoryHarness(t, metric, {
      earlierPeerHistory: true,
      repositoryOnly: true,
      conflictingPeerAuthor: true,
      memoryDatabase: false,
    });
    const publication = (await published(h)).publications[0];
    const frozen = await frozenInput(h, publication.snapshotId);
    const current = (
      await h.db.query(
        "SELECT n.*,f.repository_id FROM leaderboard_pipeline.normalizations n JOIN leaderboard_ingestion.source_facts f USING(fact_key) WHERE f.repository_id=3",
      )
    ).rows[0];
    assert.ok(current);
    const capture = frozen.identityAuthorization.relationshipPairEvidence.bindings.find(
      (binding) => binding.factKey === current.fact_key,
    );
    assert.equal(capture.policySignature, current.policy_signature);
    assert.equal(capture.documentHash, current.document_hash);
    const source = frozen.identityAuthorization.identityEvidence.normalizationSources.find(
      (entry) => entry.factKey === current.fact_key,
    );
    assert.equal(source.relationshipPairFactHashes.length, 1);
    const request = {
      snapshotId: publication.snapshotId,
      policy: { ...h.config.policies[0].policy, version: "synthetic-duplicate-wrapper-preview" },
      operatorId: "201",
    };
    const explanation = await h.runtime.aggregateExplanations.read(publication.snapshotId);
    const preview = await h.runtime.previewPolicy(request);
    const historicalSignature = currentSignature(h.config);
    assert.notEqual(historicalSignature, current.policy_signature);
    await h.db.query(
      "INSERT INTO leaderboard_pipeline.normalizations(fact_key,policy_signature,document,document_hash) SELECT fact_key,$2,document,document_hash FROM leaderboard_pipeline.normalizations WHERE fact_key=$1 AND policy_signature=$3",
      [current.fact_key, historicalSignature, current.policy_signature],
    );
    const duplicates = (
      await h.db.query(
        "SELECT policy_signature,document::text AS document_text,document_hash FROM leaderboard_pipeline.normalizations WHERE fact_key=$1 ORDER BY policy_signature",
        [current.fact_key],
      )
    ).rows;
    assert.equal(duplicates.length, 2);
    assert.equal(
      duplicates[0].document_text,
      duplicates[1].document_text,
      "the historical wrapper has identical stored document bytes",
    );
    assert.equal(duplicates[0].document_hash, duplicates[1].document_hash);
    assert.deepEqual(
      await frozenInput(h, publication.snapshotId),
      frozen,
      "adding a duplicate does not rewrite the exact frozen capture",
    );
    const verifyPrivate = async (runtime) => {
      assert.deepEqual(await runtime.aggregateExplanations.read(publication.snapshotId), explanation);
      assert.deepEqual(await runtime.previewPolicy(request), preview);
      assert.deepEqual(await runtime.previewPolicy(request), preview);
      const input = runtime.policyComparisons.comparisons.input(publication.comparisonInput.inputId);
      assert.deepEqual(
        input.authorization.identityEvidence.normalizationSources,
        frozen.identityAuthorization.identityEvidence.normalizationSources,
      );
      assert.equal(
        input.authorization.relationshipPairEvidence.bindings.find((binding) => binding.factKey === current.fact_key)
          .policySignature,
        current.policy_signature,
      );
    };
    await verifyPrivate(h.runtime);
    await restart(h, async (runtime) => {
      await verifyPrivate(runtime);
      await h.db.query("DELETE FROM leaderboard_pipeline.normalizations WHERE fact_key=$1 AND policy_signature=$2", [
        current.fact_key,
        current.policy_signature,
      ]);
      const retained = (
        await h.db.query(
          "SELECT policy_signature,document,document_hash FROM leaderboard_pipeline.normalizations WHERE fact_key=$1",
          [current.fact_key],
        )
      ).rows;
      assert.equal(retained.length, 1);
      assert.equal(retained[0].policy_signature, historicalSignature);
      assert.deepEqual(retained[0].document, current.document);
      assert.equal(retained[0].document_hash, current.document_hash);
      await assert.rejects(runtime.aggregateExplanations.read(publication.snapshotId), /Frozen|unavailable|revoked/);
      await assert.rejects(runtime.previewPolicy(request), /policy_input_revoked|Frozen|unavailable/);
    });
  });

  test(`${metric}: an ordinary peer correction withdraws dependent current and pinned pair views`, async (t) => {
    const h = await crossRepositoryHarness(t, metric, {
      earlierPeerHistory: true,
      peerHistoryDays: 1,
      memoryDatabase: true,
    });
    await published(h);
    const org = await board(h.runtime, metric);
    const selected = await board(h.runtime, metric, 2);
    assert.deepEqual(values(org), [["202", 1]]);
    assert.deepEqual(values(selected), [["202", 1]]);
    const retainedNormalizations = async () =>
      (
        await h.db.query(
          "SELECT fact_key,policy_signature,document::text AS document_text,document_hash FROM leaderboard_pipeline.normalizations ORDER BY fact_key,policy_signature",
        )
      ).rows;
    const retainedFrozen = async () =>
      (
        await h.db.query(
          "SELECT snapshot_id,document::text AS document_text FROM leaderboard_pipeline.frozen_inputs ORDER BY snapshot_id",
        )
      ).rows;
    const originals = await retainedNormalizations();
    const frozen = await retainedFrozen();
    const facts = originals.flatMap((row) => JSON.parse(row.document_text).facts);
    const peerFact = facts.find((fact) => fact.repoId === "3" && fact.metricId === metric && fact.actorId === "303");
    const sourceFact = facts.find((fact) => fact.repoId === "2" && fact.metricId === metric && fact.actorId === "202");
    assert.ok(peerFact && sourceFact, "the builtin normalizer retains both native pair observations");
    assert.equal(peerFact.artifactId, pullId);
    assert.equal(sourceFact.artifactId, issueId);
    assert.ok(sourceFact.occurredAt < peerFact.occurredAt, "the selected source owns the earlier conserved pair");
    const previewRequest = {
      snapshotId: selected.snapshotId,
      policy: { ...h.config.policies[0].policy, version: "synthetic-peer-correction-preview" },
      operatorId: "201",
    };
    await h.runtime.previewPolicy(previewRequest);
    await h.runtime.aggregateExplanations.read(selected.snapshotId);
    const requestId = fixtureId(metric === "reference_links" ? 975 : 976);
    h.controlsStore.transaction((state) => {
      state.requests[requestId] = {
        id: requestId,
        kind: "correction",
        owner: "303",
        locator: `https://github.com/${peerSlug}/pull/10`,
        status: "pending",
        version: 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        history: [],
      };
    });
    const receipt = await h.runtime.applyCorrection({
      requestId,
      expectedVersion: 1,
      factId: peerFact.id,
      operatorId: "201",
      approvalReceipt: "synthetic-correction-approval",
    });
    assert.equal(receipt.status, "applied");
    const correction = (
      await h.db.query(
        "SELECT artifact_id,repository_id,document FROM leaderboard_pipeline.corrections WHERE request_id=$1",
        [requestId],
      )
    ).rows[0];
    assert.equal(correction.artifact_id, pullId);
    assert.equal(String(correction.repository_id), "3");
    assert.equal(correction.document.fact.state, "excluded");
    assert.equal(Object.hasOwn(correction.document, "kind"), false, "this is an ordinary whole-artifact correction");
    assert.equal(
      (await h.db.query("SELECT state FROM leaderboard_ingestion.repository_access WHERE repository_id=3")).rows[0]
        .state,
      "public",
    );
    assert.equal(
      (
        await h.db.query(
          "SELECT count(*)::int AS n FROM leaderboard_ingestion.object_suppressions WHERE repository_id=3",
        )
      ).rows[0].n,
      0,
      "the correction is an overlay, not a collector deletion or repository revocation",
    );
    assert.deepEqual(
      await retainedNormalizations(),
      originals,
      "the stored source document bytes and hashes remain unchanged",
    );
    assert.deepEqual(await retainedFrozen(), frozen, "the stored frozen document bytes remain unchanged");
    await assert.rejects(h.runtime.previewPolicy(previewRequest), /policy_input_revoked|Frozen|unavailable/);
    await assert.rejects(
      h.runtime.aggregateExplanations.read(selected.snapshotId),
      /Frozen|unavailable|changed|revoked/,
    );
    const scopes = [
      [2, selected],
      [null, org],
    ];
    const observations = [];
    for (const [repository, saved] of scopes) {
      for (const snapshot of [null, saved.snapshotId]) {
        const response = await h.runtime.app.inject(`/api/v1/boards?${query(metric, repository, snapshot)}`);
        observations.push({
          repository,
          pinned: snapshot !== null,
          status: response.statusCode,
          values: response.statusCode === 200 ? values(response.json()) : [],
        });
      }
    }
    t.diagnostic(JSON.stringify({ metric, correctedArtifact: pullId, afterCorrection: observations }));
    await assertWithdrawn(h, scopes);
    for (const [repository, saved] of scopes) {
      for (const snapshot of [null, saved.snapshotId]) {
        const response = await h.runtime.app.inject(
          `/api/v1/exports?${query(metric, repository, snapshot)}&format=csv`,
        );
        if (response.statusCode === 200)
          assert.doesNotMatch(response.body, /synthetic-linker|synthetic-earlier-linker/);
        else assert.equal(response.statusCode, snapshot ? 410 : 503, response.body);
        assert.doesNotMatch(response.body, /relationshipPair|normalizationHashes|normalizationSources/);
      }
    }
  });
}
