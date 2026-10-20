import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createGithubEvidenceNormalizer, normalizeGithubObservation } from "../../github/dist/index.js";
import { syntheticRepositoryClient } from "../../github/test/synthetic-client.mjs";
import { aggregateMetric, getMetricDefinition, metricRegistryV1 } from "../dist/index.js";

// Synthetic protected-host witnesses exercise the existing normalizer and engine.
// The host supplies first-integration time and the direct-versus-PR classification.
// These cases do not implement a push/DAG collector or a complete PR-overlap resolver,
// establish independent acceptance, change the registry, or enable a public metric.
const fixture = JSON.parse(await readFile(new URL("../../github/test/fixtures/engineering.json", import.meta.url)));
const before = "b".repeat(40);
const sha = "c".repeat(40);
const integratedAt = "2026-10-07T10:00:00Z";
const observedAt = "2026-10-08T10:00:00Z";
const cutoff = "2026-10-10T00:00:00Z";
const repository = { id: 2, slug: "synthetic-owner/repository", visibility: "public", defaultBranch: "main" };
const scope = {
  timezone: "UTC",
  from: "2026-10-01T00:00:00Z",
  to: "2026-10-09T00:00:00Z",
  repos: [],
  projects: [],
  workstreams: [],
  roles: [],
  actors: "user",
  context: "event",
};

function observation(patch = {}) {
  return {
    repository: { ...repository },
    proof: {
      verified: true,
      source: "github_webhook",
      revision: sha,
      eventId: "synthetic-direct-push-1",
      isSynthetic: true,
    },
    family: "commit",
    action: "direct_default_branch_integration",
    occurredAt: integratedAt,
    observedAt,
    payload: {
      sha,
      html_url: `https://github.com/${repository.slug}/commit/${sha}`,
      author: structuredClone(fixture.author),
      committer: structuredClone(fixture.merger),
      sender: structuredClone(fixture.reviewer),
      parents: [{ sha: before }],
      commit: {
        author: { name: "Synthetic author text", date: "2026-10-01T10:00:00Z" },
        committer: { name: "Synthetic committer text", date: "2026-10-02T10:00:00Z" },
        message: "Synthetic direct change; metadata is not account or integration proof.",
      },
    },
    integration: {
      before,
      after: sha,
      canonicalChangeId: "synthetic-direct-change",
      targetBranch: "main",
      defaultBranch: "main",
      commitShas: [sha],
    },
    ...patch,
  };
}

function policy(metricId = "direct_changes", patch = {}) {
  return {
    metricId,
    version: "synthetic-direct-changes/v1",
    definitionVersion: metricRegistryV1.policy_version,
    unit: getMetricDefinition(metricId).definition.unit,
    aggregation: "count",
    dateBasis: "occurredAt",
    rankedStates: ["observed"],
    roles: ["author"],
    groupBy: "canonical",
    sources: ["github_webhook", "github_rest"],
    minimumSamples: 1,
    rank: false,
    ...patch,
  };
}

function aggregate(outputs, { metricId = "direct_changes", scopePatch = {}, policyPatch = {} } = {}) {
  const result = aggregateMetric(
    {
      datasetId: "synthetic-direct-changes",
      cutoff,
      backfillRevision: "synthetic-direct-changes/v1",
      repositoryIds: ["2"],
      actors: [...new Map(outputs.flatMap((output) => output.actors).map((actor) => [actor.id, actor])).values()],
      facts: outputs.flatMap((output) => output.facts),
      coverage: [],
    },
    policy(metricId, policyPatch),
    { ...scope, ...scopePatch },
  );
  assert.equal(result.publicEnabled, false);
  assert.equal(result.coverage, "incomplete");
  assert.ok(result.rows.every((row) => row.rank === null));
  return result;
}

const facts = (output, metricId = "direct_changes") => output.facts.filter((fact) => fact.metricId === metricId);
const values = (result) => result.rows.filter((row) => row.value !== null).map((row) => [row.actorId, row.value]);

test("direct changes use the witnessed first integration and half-open windows, not Git or collection dates", () => {
  const output = normalizeGithubObservation(observation());
  assert.equal(facts(output).length, 1);
  assert.equal(facts(output)[0].occurredAt, "2026-10-07T10:00:00.000Z");
  assert.equal(facts(output)[0].acceptedAt, null);
  assert.equal(facts(output)[0].state, "observed");
  assert.deepEqual(values(aggregate([output])), [["101", 1]]);
  assert.deepEqual(
    values(aggregate([output], { scopePatch: { from: integratedAt, to: "2026-10-07T10:00:00.001Z" } })),
    [["101", 1]],
  );
  for (const scopePatch of [
    { to: integratedAt },
    { from: "2026-10-07T10:00:00.001Z" },
    { from: "2026-10-01T00:00:00Z", to: "2026-10-03T00:00:00Z" },
    { from: "2026-10-08T00:00:00Z" },
  ]) {
    const excluded = aggregate([output], { scopePatch });
    assert.deepEqual(values(excluded), []);
    assert.ok(excluded.audit.some((entry) => entry.reason === "outside_window"));
  }
  assert.throws(() => aggregate([output], { policyPatch: { rank: true } }), /Descriptive metrics cannot rank/);
});

test("direct changes credit the linked author while retaining distinct committer and pusher evidence", () => {
  const output = normalizeGithubObservation(observation());
  assert.equal(output.isSynthetic, true);
  assert.equal(facts(output)[0].actorId, "101");
  assert.equal(facts(output)[0].role, "author");
  assert.equal(output.observations[0].actorId, "303");
  assert.deepEqual(
    output.participation.map(({ actorId, role }) => [actorId, role]),
    [
      ["101", "author"],
      ["202", "committer"],
    ],
  );
  assert.deepEqual(values(aggregate([output])), [["101", 1]]);
  assert.throws(() => aggregate([output], { scopePatch: { roles: ["committer"] } }), /Unknown role filter/);
  const evidence = output.evidence.find((entry) => entry.contribution.metricIds.includes("direct_changes"));
  assert.equal(evidence.contribution.actorId, "101");
  assert.equal(evidence.sourceRevision, sha);
  assert.equal(evidence.sourceRevisionUrl, `https://github.com/${repository.slug}/commit/${sha}`);
  assert.equal(evidence.evidenceMetadata.sourceAction, "default_branch_integrated");
  assert.ok(evidence.contribution.reasonCodes.includes("raw_observed_only"));
});

test("direct changes conserve one repository/SHA across redelivery and order without collapsing a distinct commit", () => {
  const input = observation();
  const untouched = structuredClone(input);
  const first = normalizeGithubObservation(input);
  const replay = normalizeGithubObservation({
    ...input,
    proof: { ...input.proof, eventId: "synthetic-redelivery-2" },
    observedAt: "2026-10-09T10:00:00Z",
  });
  const next = observation();
  const nextSha = "d".repeat(40);
  next.proof.revision = nextSha;
  next.proof.eventId = "synthetic-direct-push-3";
  next.payload.sha = nextSha;
  next.payload.html_url = `https://github.com/${repository.slug}/commit/${nextSha}`;
  next.integration = {
    ...next.integration,
    before: sha,
    after: nextSha,
    canonicalChangeId: "synthetic-direct-change-2",
    commitShas: [nextSha],
  };
  const distinct = normalizeGithubObservation(next);
  assert.equal(facts(first)[0].id, facts(replay)[0].id);
  assert.notEqual(facts(first)[0].id, facts(distinct)[0].id);
  assert.deepEqual(values(aggregate([replay, first, first])), [["101", 1]]);
  const forward = aggregate([first, replay, distinct]);
  const reordered = aggregate([distinct, replay, first]);
  assert.deepEqual(forward, reordered);
  assert.deepEqual(values(forward), [["101", 2]]);
  assert.equal(forward.rows[0].evidenceIds.length, 2);
  assert.equal(
    forward.rows[0].evidence.find((entry) => entry.id === facts(first)[0].id).observedAt,
    "2026-10-08T10:00:00.000Z",
  );
  assert.deepEqual(input, untouched);
});

test("PR delivery and an ordinarily classified integrated commit do not manufacture an additional direct change", () => {
  const input = observation();
  const pull = normalizeGithubObservation({
    ...input,
    family: "pull_request",
    action: "closed",
    payload: {
      repository: fixture.repository,
      pull_request: {
        ...structuredClone(fixture.pull_request),
        user: fixture.author,
        merged_by: fixture.merger,
        merge_commit_sha: sha,
      },
      sender: fixture.reviewer,
    },
  });
  const commit = normalizeGithubObservation({
    ...input,
    action: "default_branch_integration",
    lineage: [
      {
        relation: "squash_of",
        sourceIds: [fixture.pull_request.node_id],
        targetId: sha,
        evidenceIds: ["synthetic-pr-merge"],
      },
    ],
  });
  assert.deepEqual(values(aggregate([pull, commit, pull, commit], { metricId: "pr_merged" })), [["101", 1]]);
  assert.deepEqual(values(aggregate([pull, commit, commit], { metricId: "commits_integrated" })), [["101", 1]]);
  assert.deepEqual(facts(pull), []);
  assert.deepEqual(facts(commit), []);
  assert.deepEqual(values(aggregate([pull, commit])), []);
  assert.equal(commit.lineage[0].relation, "squash_of");
  // Direct classification is a separate protected-host input, not inferred from
  // seeing a commit or from the presence/absence of a PR in a partial collection.
  const direct = normalizeGithubObservation(input);
  assert.deepEqual(values(aggregate([direct])), [["101", 1]]);
});

test("unlinked commit authors never borrow the pusher, committer or Git author text", () => {
  for (const author of [null, { login: "synthetic-unlinked" }]) {
    const input = observation();
    input.payload.author = author;
    const output = normalizeGithubObservation(input);
    assert.equal(facts(output)[0].actorId, null);
    assert.equal(facts(output)[0].state, "unknown");
    const result = aggregate([output]);
    assert.deepEqual(values(result), []);
    assert.ok(result.audit.some((entry) => entry.reason === "unknown_actor"));
    assert.equal(output.observations[0].actorId, "303");
  }
});

test("an unknown integration clock stays unknown even when authored, committed and observed clocks are present", () => {
  for (const occurredAt of [null, undefined]) {
    const output = normalizeGithubObservation(observation({ occurredAt }));
    assert.equal(facts(output)[0].occurredAt, null);
    assert.equal(facts(output)[0].state, "unknown");
    assert.deepEqual(values(aggregate([output])), []);
    assert.equal(aggregate([output]).coverage, "incomplete");
  }
});

test("missing or mismatched commit/default-branch witnesses cannot supply measured direct delivery", () => {
  for (const change of [
    (input) => delete input.integration,
    (input) => (input.integration.commitShas = []),
    (input) => (input.integration.commitShas = [before]),
    (input) => (input.integration.targetBranch = "feature"),
  ]) {
    const input = observation();
    change(input);
    const output = normalizeGithubObservation(input);
    assert.deepEqual(facts(output), []);
    assert.deepEqual(values(aggregate([output])), []);
    assert.ok(output.reasons.includes("default_branch_integration_unverified"));
    assert.ok(output.participation.some((entry) => entry.actorId === "101" && entry.role === "author"));
  }
  for (const invalidSha of [undefined, "not-a-commit-sha"]) {
    const input = observation();
    input.payload.sha = invalidSha;
    const output = normalizeGithubObservation(input);
    assert.deepEqual(facts(output), []);
    assert.deepEqual(values(aggregate([output])), []);
    assert.ok(output.reasons.includes("missing_public_artifact_identity"));
  }
});

test("current commit hydration cannot invent direct integration; exact protected enrichment supplies the positive control", async () => {
  const envelope = observation();
  const calls = [];
  const client = syntheticRepositoryClient(2, {
    rest: async (_source, endpoint) => {
      calls.push(endpoint);
      if (endpoint === `/repos/${repository.slug}`) return structuredClone(fixture.repository);
      assert.equal(endpoint, `/repos/${repository.slug}/commits/${sha}`);
      return structuredClone(envelope.payload);
    },
  });
  const input = {
    repository: { id: 2, slug: repository.slug },
    family: "commits",
    factKey: "synthetic-current-commit",
    observedAt,
    policyVersion: "synthetic-direct-changes/v1",
    fact: {
      subjectId: sha,
      sourceRevision: sha,
      sourceUrl: envelope.payload.html_url,
      evidence: "current_state",
      actorId: null,
      occurredAt: null,
      state: "present",
    },
  };
  const options = { client, source: "synthetic", allowedRepositoryIds: [2], isSynthetic: true };
  const hydrated = await createGithubEvidenceNormalizer(options)(input);
  assert.deepEqual(calls.sort(), [`/repos/${repository.slug}`, `/repos/${repository.slug}/commits/${sha}`]);
  assert.deepEqual(facts(hydrated), []);
  assert.deepEqual(values(aggregate([hydrated])), []);
  assert.ok(hydrated.reasons.includes("default_branch_integration_unverified"));
  const enriched = await createGithubEvidenceNormalizer({ ...options, enrich: async () => envelope })(input);
  assert.deepEqual(values(aggregate([enriched])), [["101", 1]]);
  const mismatched = await createGithubEvidenceNormalizer({
    ...options,
    enrich: async () => ({ ...envelope, proof: { ...envelope.proof, revision: before } }),
  })(input);
  assert.deepEqual(facts(mismatched), []);
  assert.deepEqual(mismatched.reasons, ["enrichment_scope_or_revision_mismatch"]);
});
