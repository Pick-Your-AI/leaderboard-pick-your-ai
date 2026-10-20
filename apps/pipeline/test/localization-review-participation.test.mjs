import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { createPipeline } from "../src/index.mjs";
import { createGithubCollectionSource } from "../src/github-source.mjs";
import { comparisonHash } from "../../controls/src/policy-comparison.mjs";
import { record as recordControlsDecision } from "../../controls/src/store.mjs";
import { localizationReviewRequest } from "../../controls/src/localization-review.mjs";
import { syntheticRepositoryClient } from "../../../packages/github/test/synthetic-client.mjs";
import { attachSyntheticEvidenceState } from "../../../tests/fixtures/evidence-intake.mjs";
import {
  localizationReviewFixture,
  localizationReviewSlug,
  localizationReviewUrl,
} from "../../../tests/fixtures/localization-review.mjs";
import { components, harness, publicScope } from "./harness.mjs";

const nativeVersion = components.github.localizationReviewNormalizationVersion;
const localeFacts = (document) => document.frozen.facts.filter((fact) => fact.metricId === "localization");
const currentRead = (runtime, snapshotId) => runtime.source.read(publicScope, snapshotId, new AbortController().signal);

async function localeReviewerHarness(
  t,
  { configure = () => {}, change = () => {}, sourceKind = "native", forge } = {},
) {
  const fixture = localizationReviewFixture();
  const state = {
    parent: fixture.parent,
    reviews: [fixture.first, fixture.later],
    integration: fixture.integration,
    private: false,
    calls: [],
  };
  change(state, fixture);
  const repository = {
    id: 2,
    installationId: 1,
    slug: localizationReviewSlug,
    families: ["pull_requests", "reviews"],
  };
  const githubClient = syntheticRepositoryClient(2, {
    async rest(_source, path) {
      state.calls.push(["rest", path]);
      if (path === "/repos/" + localizationReviewSlug) {
        return { id: 2, private: state.private, full_name: localizationReviewSlug, default_branch: "main" };
      }
      if (path === "/repos/" + localizationReviewSlug + "/pulls/10") return structuredClone(state.parent);
      const review = state.reviews.find(
        (entry) => path === "/repos/" + localizationReviewSlug + "/pulls/10/reviews/" + entry.id,
      );
      assert.ok(review, path);
      return structuredClone(review);
    },
    async scanRest({ url }) {
      state.calls.push(["scan", url]);
      if (url.startsWith("/repos/" + localizationReviewSlug + "/pulls?")) return [structuredClone(state.parent)];
      assert.equal(url, "/repos/" + localizationReviewSlug + "/pulls/10/reviews?per_page=100");
      return structuredClone(state.reviews);
    },
  });
  const native = createGithubCollectionSource({
    client: githubClient,
    sourceId: "installation:1",
    repositories: [repository],
    isSynthetic: true,
  });
  const source = {
    async readPage(request) {
      const page = await native.readPage(request);
      if (sourceKind === "unversioned" && request.family === "reviews") {
        page.facts = page.facts.map((fact) => {
          const review = state.reviews.find((entry) => entry.node_id === fact.subjectId);
          assert.ok(review);
          return { ...fact, sourceRevision: components.github.githubReviewRevision(review) };
        });
      }
      return page;
    },
  };
  const githubEnrich = async (input) => {
    if (input.family !== "pull_requests") return null;
    state.calls.push(["enrich", input.factKey]);
    return {
      repository: { id: 2, slug: localizationReviewSlug, visibility: "public", defaultBranch: "main" },
      proof: { verified: true, source: "github_rest", revision: input.fact.sourceRevision, isSynthetic: true },
      family: "pull_request",
      observedAt: input.observedAt,
      payload: { pull_request: structuredClone(state.parent) },
      integration: structuredClone(state.integration),
    };
  };
  const extra = {
    githubClient,
    githubEnrich,
    source,
    reviewSourceNormalizationVersion: components.github.reviewSourceNormalizationVersion,
    async probeRepository(repo) {
      return {
        repositoryId: repo.id,
        installationId: repo.installationId,
        visibility: state.private ? "private" : "public",
        checkedAt: new Date().toISOString(),
      };
    },
    configure(config) {
      config.repositories[0].families = ["pull_requests", "reviews"];
      config.documentationPolicies = [fixture.policy];
      const policy = {
        ...config.policies[0].policy,
        metricId: "localization",
        unit: components.metrics.getMetricDefinition("localization").definition.unit,
        rankedStates: ["qualified"],
        dateBasis: "occurredAt",
        roles: ["author", "reviewer"],
        groupBy: "canonical",
        rank: false,
      };
      config.policies = [
        { policy, signature: components.metrics.stableJSON(policy), approvalReceipt: "synthetic-locale-review-policy" },
      ];
      config.recognitionBindings = [
        {
          category: "other",
          scope: "repository:2:locale:fr:documentation",
          policyVersion: policy.version,
          metricId: "localization",
          sourceMetricId: "localization",
          repositoryId: "2",
          reviewerIds: ["303"],
          localization: { locale: "fr", category: "documentation", policyVersion: fixture.policy.version },
        },
      ];
      configure(config);
    },
  };
  if (forge) {
    extra.localizationReviewNormalizationVersion = nativeVersion;
    extra.defaultDeliveryNormalizationVersion = components.github.defaultDeliveryNormalizationVersion;
    extra.normalizerFactory = (options) => {
      const normalize = components.github.createGithubEvidenceNormalizer({
        client: githubClient,
        source: "installation:1",
        allowedRepositoryIds: [2],
        isSynthetic: true,
        documentationPolicies: options.config.documentationPolicies,
        localizationReviews: true,
        enrich: githubEnrich,
      });
      return async (input) => forge(await normalize(input), input);
    };
  }
  const h = await harness(t, extra);
  return { ...h, state, fixture };
}

async function publish(h, options = {}) {
  const outcome = await h.runtime.runOnce(options);
  assert.equal(outcome.state, "published");
  assert.equal(outcome.publications.length, 1);
  const publication = outcome.publications[0];
  const read = await currentRead(h.runtime, publication.snapshotId);
  assert.ok(read);
  const retained = (
    await h.db.query("SELECT document,document_hash FROM leaderboard_pipeline.frozen_inputs WHERE snapshot_id=$1", [
      publication.snapshotId,
    ])
  ).rows[0];
  assert.equal(comparisonHash(retained.document), retained.document_hash);
  return { publication, read, frozen: retained.document };
}

async function acceptReviewer(h, proof, { id = "synthetic-locale-reviewer-acceptance", actor = "303" } = {}) {
  const binding = h.config.recognitionBindings[0];
  return h.controlsStore.transaction((state) => {
    const request = {
      id,
      version: 0,
      kind: "evidence",
      status: "accepted",
      owner: "202",
      category: binding.category,
      scope: binding.scope,
      policyVersion: binding.policyVersion,
      locator: localizationReviewUrl,
      collaborators: {},
      history: [],
    };
    recordControlsDecision(state, request, actor, "accepted", Date.parse(h.fixture.at(0.5)), {
      policyVersion: binding.policyVersion,
      localization: {
        ...binding.localization,
        targetFactId: proof.contribution.contributionId,
        sourceRevision: proof.sourceRevision,
      },
      evidenceRequest: localizationReviewRequest(request),
    });
    state.requests[id] = request;
    attachSyntheticEvidenceState(state);
    return structuredClone(request.history.at(-1));
  });
}

function frenchReviewer(read) {
  return read.selected.portfolioEvidence.find(
    (entry) =>
      entry.contribution.metricIds.includes("localization") &&
      entry.contribution.actorId === "202" &&
      entry.contribution.roles.includes("reviewer") &&
      entry.contribution.reasonCodes.includes("locale:fr"),
  );
}
async function sourceRows(h) {
  return (
    await h.db.query(
      "SELECT n.*,f.family,f.document AS source_document FROM leaderboard_pipeline.normalizations n " +
        "JOIN leaderboard_ingestion.source_facts f USING(fact_key) ORDER BY n.fact_key,n.policy_signature",
    )
  ).rows;
}
async function frozenRows(h) {
  return (
    await h.db.query(
      "SELECT snapshot_id,document,document_hash FROM leaderboard_pipeline.frozen_inputs ORDER BY snapshot_id",
    )
  ).rows;
}

test("native locale reviewer credit joins first review and merge before independent acceptance", async (t) => {
  const h = await localeReviewerHarness(t);
  for (const review of h.state.reviews) {
    assert.equal(Object.hasOwn(review, "created_at"), false);
    assert.equal(Object.hasOwn(review, "createdAt"), false);
  }
  const first = await publish(h);
  const facts = localeFacts(first.frozen);
  assert.equal(facts.filter((fact) => fact.role === "author").length, 2);
  assert.equal(facts.filter((fact) => fact.role === "reviewer").length, 2);
  assert.ok(facts.every((fact) => fact.state === "observed" && fact.acceptedAt === null && fact.acceptedBy === null));
  const capture = first.frozen.identityAuthorization.localizationReviewEvidence;
  assert.equal(capture.schemaVersion, nativeVersion);
  assert.equal(capture.bindings.length, 2);
  const rows = await sourceRows(h);
  for (const binding of capture.bindings) {
    const merge = rows.find((row) => row.fact_key === binding.merge.factKey);
    const review = rows.find((row) => row.fact_key === binding.review.factKey);
    assert.equal(merge.family, "pull_requests");
    assert.equal(review.family, "reviews");
    assert.equal(merge.document_hash, binding.merge.documentHash);
    assert.equal(review.document_hash, binding.review.documentHash);
    assert.equal(review.document.localizationReviewSource.reviewId, "51");
    assert.equal(review.document.localizationReviewSource.reviewerId, "202");
    assert.equal(merge.document.localizationMergeSource.authorId, "101");
    assert.equal(merge.document.localizationMergeSource.headRevision, h.fixture.head);
    assert.equal(review.document.localizationReviewSource.headRevision, h.fixture.head);
    assert.equal(merge.document.localizationMergeSource.mergeRevision, h.fixture.after);
    const round = review.document.facts.find((fact) => fact.metricId === "review_rounds");
    assert.ok(round);
    assert.equal(round.state, "observed");
    assert.equal(round.occurredAt, h.fixture.first.submitted_at);
    assert.equal(round.observedAt, review.document.localizationReviewSource.observedAt);
    assert.equal(round.rawState, "submitted_head:" + h.fixture.head);
    const feedback = review.document.facts.find((fact) => fact.metricId === "review_feedback");
    assert.ok(feedback);
    assert.equal(feedback.state, "unknown");
    assert.equal(feedback.occurredAt, null);
  }
  const proof = frenchReviewer(first.read);
  assert.ok(proof);
  assert.equal(proof.sourceRevision, h.fixture.after);
  assert.equal(proof.occurredAt, h.fixture.parent.merged_at);
  const authorProof = first.read.selected.portfolioEvidence.find(
    (entry) =>
      entry.contribution.metricIds.includes("localization") &&
      entry.contribution.actorId === "101" &&
      entry.contribution.reasonCodes.includes("locale:fr"),
  );
  assert.ok(authorProof);
  await acceptReviewer(h, authorProof, { id: "synthetic-copied-author-target" });
  const copied = await publish(h);
  assert.equal(localeFacts(copied.frozen).filter((fact) => fact.state === "qualified").length, 0);
  const decision = await acceptReviewer(h, proof);
  const accepted = await publish(h);
  const qualified = localeFacts(accepted.frozen).filter((fact) => fact.state === "qualified");
  assert.equal(qualified.length, 1);
  assert.equal(qualified[0].actorId, "202");
  assert.equal(qualified[0].role, "reviewer");
  assert.equal(qualified[0].acceptedBy, "303");
  assert.equal(qualified[0].occurredAt, h.fixture.parent.merged_at);
  assert.equal(qualified[0].acceptedAt, new Date(decision.at).toISOString());
  assert.equal(
    qualified[0].canonicalKey,
    facts.find((fact) => fact.id === proof.contribution.contributionId).canonicalKey,
  );
  const positiveRows = accepted.read.selected.rows.filter((row) => row.result.value > 0);
  assert.deepEqual(
    positiveRows.map((row) => [row.actorId, row.result.value]),
    [["202", 1]],
  );
  assert.equal(JSON.stringify(accepted.read).includes("localizationReviewEvidence"), false);
  assert.equal(JSON.stringify(accepted.read).includes(h.fixture.first.body), false);
  assert.equal(JSON.stringify(accepted.read).includes(decision.id), false);
});

test("locale reviewer cache survives file-backed reopen without source hydration", async (t) => {
  const h = await localeReviewerHarness(t);
  const first = await publish(h);
  await acceptReviewer(h, frenchReviewer(first.read));
  const cutoff = new Date().toISOString();
  const accepted = await publish(h, { cutoff });
  const originals = await sourceRows(h);
  const frozen = await frozenRows(h);
  const calls = structuredClone(h.state.calls);
  const controls = h.controlsStore.read();
  await h.runtime.stop();
  await h.reopenDatabase();
  // A fresh SQLite handle reads the durable receipt, rather than a copied state.
  const reopenedControls = new components.controls.ControlStore(join(h.directory, "controls.sqlite"));
  h.runtime = await createPipeline({ ...h.options, controlsStore: reopenedControls });
  t.after(async () => {
    await h.runtime.stop();
    reopenedControls.close();
  });
  const restored = await currentRead(h.runtime, accepted.publication.snapshotId);
  assert.ok(restored);
  assert.deepEqual(restored.selected, accepted.read.selected);
  const reused = await publish(h, { collect: false, cutoff });
  assert.equal(reused.publication.snapshotId, accepted.publication.snapshotId);
  assert.deepEqual(await sourceRows(h), originals);
  assert.deepEqual(await frozenRows(h), frozen);
  assert.deepEqual(h.state.calls, calls);
  assert.deepEqual(reopenedControls.read().requests, controls.requests);
  assert.deepEqual(reopenedControls.read().audit, controls.audit);
  assert.deepEqual(reopenedControls.read().profiles, controls.profiles);
});

for (const [name, change] of [
  [
    "stale reviewed head",
    (state) => {
      for (const review of state.reviews) review.commit_id = "d".repeat(40);
    },
  ],
  [
    "changed merged PR head",
    (state) => {
      state.parent.head.sha = "d".repeat(40);
    },
  ],
  [
    "unknown native reviewer",
    (state) => {
      for (const review of state.reviews) review.user = null;
    },
  ],
  [
    "self review copied from the author",
    (state) => {
      for (const review of state.reviews) review.user = structuredClone(state.parent.user);
    },
  ],
  [
    "review only after the merge",
    (state, fixture) => {
      for (const review of state.reviews) {
        review.submitted_at = fixture.at(0.75);
      }
    },
  ],
]) {
  test(`locale reviewer join withholds ${name} while retaining author units`, async (t) => {
    const h = await localeReviewerHarness(t, { change });
    const result = await publish(h);
    assert.equal(localeFacts(result.frozen).filter((fact) => fact.role === "author").length, 2);
    assert.equal(localeFacts(result.frozen).filter((fact) => fact.role === "reviewer").length, 0);
    assert.deepEqual(result.frozen.identityAuthorization.localizationReviewEvidence.bindings, []);
  });
}

test("a stable review revision cannot replace complete-scan locale authority", async (t) => {
  const h = await localeReviewerHarness(t, { sourceKind: "unversioned" });
  const result = await publish(h);
  assert.equal(localeFacts(result.frozen).filter((fact) => fact.role === "author").length, 2);
  assert.equal(localeFacts(result.frozen).filter((fact) => fact.role === "reviewer").length, 0);
  const rows = await sourceRows(h);
  assert.ok(rows.some((row) => row.document.localizationReviewSource?.reviewId === "51"));
  assert.deepEqual(result.frozen.identityAuthorization.localizationReviewEvidence.bindings, []);
});

test("later duplicate reviews do not multiply locale units or replace the first native identity", async (t) => {
  const h = await localeReviewerHarness(t);
  const original = await publish(h);
  const originals = await sourceRows(h);
  h.state.reviews.push(h.fixture.makeReview(53, 202, h.fixture.at(1.25)));
  const next = await publish(h);
  const nextReviewers = localeFacts(next.frozen).filter((fact) => fact.role === "reviewer");
  const priorReviewers = localeFacts(original.frozen).filter((fact) => fact.role === "reviewer");
  assert.deepEqual(
    nextReviewers.map((fact) => fact.id).sort(),
    priorReviewers.map((fact) => fact.id).sort(),
  );
  const rows = await sourceRows(h);
  for (const binding of next.frozen.identityAuthorization.localizationReviewEvidence.bindings) {
    const row = rows.find((entry) => entry.fact_key === binding.review.factKey);
    assert.equal(row.document.localizationReviewSource.reviewId, "51");
  }
  for (const originalRow of originals) {
    assert.deepEqual(
      rows.find(
        (row) => row.fact_key === originalRow.fact_key && row.policy_signature === originalRow.policy_signature,
      ),
      originalRow,
    );
  }
  assert.ok(await currentRead(h.runtime, original.publication.snapshotId));
});

test("a copied author fact cannot enter the reviewer lane through a declared custom normalizer", async (t) => {
  const h = await localeReviewerHarness(t, {
    forge(output, input) {
      if (input.family !== "pull_requests") return output;
      const fact = output.facts.find((entry) => entry.metricId === "localization");
      const evidence = output.evidence.find((entry) => entry.contribution.contributionId === fact.id);
      const id = "gh:" + comparisonHash(["synthetic-copied-author", fact.id]);
      output.facts.push({ ...fact, id, canonicalKey: id, role: "reviewer" });
      output.evidence.push({
        ...structuredClone(evidence),
        contribution: { ...evidence.contribution, contributionId: id, canonicalEventId: id, roles: ["reviewer"] },
      });
      return output;
    },
  });
  await assert.rejects(h.runtime.runOnce(), /localization_review_source_unverified/);
  const snapshots = (await h.db.query("SELECT count(*) AS count FROM leaderboard_pipeline.snapshots")).rows;
  assert.equal(Number(snapshots[0].count), 0);
});

test("both locale dependencies remain required after reopen and exact restoration", async (t) => {
  const h = await localeReviewerHarness(t);
  const first = await publish(h);
  await acceptReviewer(h, frenchReviewer(first.read));
  const accepted = await publish(h);
  const frozen = await frozenRows(h);
  const rows = await sourceRows(h);
  const binding = accepted.frozen.identityAuthorization.localizationReviewEvidence.bindings[0];
  await h.runtime.stop();
  await h.reopenDatabase();
  h.runtime = await createPipeline(h.options);
  t.after(() => h.runtime.stop());
  for (const role of ["merge", "review"]) {
    const original = rows.find((row) => row.fact_key === binding[role].factKey);
    const changed = structuredClone(original.document);
    changed.reasons = [...changed.reasons, "synthetic_changed_locale_dependency"];
    const hash = comparisonHash(changed);
    await h.db.query(
      "UPDATE leaderboard_pipeline.normalizations SET document=$1,document_hash=$2 " +
        "WHERE fact_key=$3 AND policy_signature=$4",
      [JSON.stringify(changed), hash, original.fact_key, original.policy_signature],
    );
    await assert.rejects(
      currentRead(h.runtime, accepted.publication.snapshotId),
      { status: 409, message: "Frozen identity evidence unavailable" },
      role,
    );
    await h.db.query(
      "UPDATE leaderboard_pipeline.normalizations SET document=$1,document_hash=$2 " +
        "WHERE fact_key=$3 AND policy_signature=$4",
      [JSON.stringify(original.document), original.document_hash, original.fact_key, original.policy_signature],
    );
    assert.ok(await currentRead(h.runtime, accepted.publication.snapshotId), role);
    const changedSource = { ...original.source_document, sourceRevision: "synthetic-other-locale-source" };
    await h.db.query("UPDATE leaderboard_ingestion.source_facts SET document=$1 WHERE fact_key=$2", [
      JSON.stringify(changedSource),
      original.fact_key,
    ]);
    await assert.rejects(
      currentRead(h.runtime, accepted.publication.snapshotId),
      { message: "localization_review_source_unverified" },
      role,
    );
    await h.db.query("UPDATE leaderboard_ingestion.source_facts SET document=$1 WHERE fact_key=$2", [
      JSON.stringify(original.source_document),
      original.fact_key,
    ]);
    assert.ok(await currentRead(h.runtime, accepted.publication.snapshotId), role);
  }
  assert.deepEqual(await sourceRows(h), rows);
  assert.deepEqual(await frozenRows(h), frozen);
});

test("changed merge revisions cannot reuse a prior locale reviewer acceptance", async (t) => {
  const h = await localeReviewerHarness(t);
  const first = await publish(h);
  await acceptReviewer(h, frenchReviewer(first.read));
  const accepted = await publish(h);
  const oldFrozen = accepted.frozen;
  h.state.parent.merge_commit_sha = "d".repeat(40);
  h.state.parent.updated_at = new Date().toISOString();
  h.state.integration.after = h.state.parent.merge_commit_sha;
  h.state.integration.diff.after = h.state.parent.merge_commit_sha;
  h.state.integration.commitShas = [h.state.parent.merge_commit_sha];
  const next = await publish(h);
  assert.equal(localeFacts(next.frozen).filter((fact) => fact.state === "qualified").length, 0);
  const nextProof = frenchReviewer(next.read);
  assert.ok(nextProof);
  assert.equal(nextProof.sourceRevision, h.state.parent.merge_commit_sha);
  assert.equal(nextProof.contribution.contributionId, frenchReviewer(first.read).contribution.contributionId);
  const retained = (
    await h.db.query("SELECT document FROM leaderboard_pipeline.frozen_inputs WHERE snapshot_id=$1", [
      accepted.publication.snapshotId,
    ])
  ).rows[0].document;
  assert.deepEqual(retained, oldFrozen);
});

test("withdrawal and current repository privacy fence locale reviewer publications", async (t) => {
  const h = await localeReviewerHarness(t);
  const first = await publish(h);
  await acceptReviewer(h, frenchReviewer(first.read));
  const accepted = await publish(h);
  const originals = await sourceRows(h);
  const frozen = await frozenRows(h);
  h.controlsStore.transaction((state) => {
    state.requests["synthetic-locale-reviewer-acceptance"].status = "withdrawn";
  });
  assert.equal(await currentRead(h.runtime, accepted.publication.snapshotId), null);
  const withdrawn = await publish(h);
  assert.equal(localeFacts(withdrawn.frozen).filter((fact) => fact.state === "qualified").length, 0);
  assert.equal(localeFacts(withdrawn.frozen).filter((fact) => fact.role === "reviewer").length, 2);
  const rows = await sourceRows(h);
  for (const original of originals) {
    assert.deepEqual(
      rows.find((row) => row.fact_key === original.fact_key && row.policy_signature === original.policy_signature),
      original,
    );
  }
  const retained = await frozenRows(h);
  for (const original of frozen) {
    assert.deepEqual(
      retained.find((row) => row.snapshot_id === original.snapshot_id),
      original,
    );
  }
  h.state.private = true;
  await assert.rejects(h.runtime.runOnce(), /public_source_not_verified/);
  assert.equal(await currentRead(h.runtime, withdrawn.publication.snapshotId), null);
});

test("author-only configuration preserves the existing output and does not enroll locale reviewer proof", async (t) => {
  const h = await localeReviewerHarness(t, {
    configure(config) {
      config.policies[0].policy.roles = ["author"];
      config.policies[0].signature = components.metrics.stableJSON(config.policies[0].policy);
    },
  });
  const result = await publish(h);
  assert.equal(localeFacts(result.frozen).length, 2);
  assert.ok(localeFacts(result.frozen).every((fact) => fact.role === "author"));
  assert.equal(result.frozen.identityAuthorization.localizationReviewEvidence, undefined);
  for (const row of await sourceRows(h)) {
    assert.equal(row.document.localizationReviewNormalizationVersion, undefined);
    assert.equal(row.document.localizationMergeSource, undefined);
    assert.equal(row.document.localizationReviewSource, undefined);
  }
});
