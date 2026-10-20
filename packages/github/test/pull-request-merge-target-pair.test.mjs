import assert from "node:assert/strict";
import test from "node:test";
import { createGithubEvidenceNormalizer, relationshipPairNormalizationVersion } from "../dist/index.js";
import { mergeTargetFixture, mergedAt, observedAt, slug } from "./pull-request-merge-target-fixture.mjs";

function relationshipFixture(kind, mergeTargetEnabled) {
  const s = mergeTargetFixture();
  if (!mergeTargetEnabled) delete s.options.pullRequestMergeTargetRepositoryIds;
  const state = { valid: true };
  const pair = {
    version: relationshipPairNormalizationVersion,
    kind,
    action: kind === "reference" ? "reference" : "connect",
    eventId: "ME_SYNTHETIC_PAIR",
    from: { repositoryId: "2", artifactId: s.payload.node_id, kind: "pull_request" },
    to: { repositoryId: "2", artifactId: "I_SYNTHETIC_PAIR", kind: "issue" },
  };
  s.options.enrich = async () => ({
    repository: { id: 2, slug, visibility: "public", defaultBranch: "main" },
    proof: {
      verified: true,
      source: "github_graphql",
      revision: observedAt,
      eventId: pair.eventId,
    },
    family: "relationship",
    action: kind === "reference" ? "referenced" : "connected",
    occurredAt: mergedAt,
    observedAt,
    payload: {
      repository: { id: 2, private: false, full_name: slug },
      pull_request: structuredClone(s.payload),
      sender: s.payload.merged_by,
      relationship: {
        kind,
        from: pair.from.artifactId,
        to: pair.to.artifactId,
        intentional: true,
        publicEndpointsVerified: true,
        pair: { ...structuredClone(pair), ...(state.valid ? {} : { eventId: "ME_UNBOUND" }) },
      },
    },
  });
  return { ...s, pair, pairState: state };
}

for (const kind of ["reference", "closing"]) {
  test(`${kind}: merge-target enrollment preserves native pair semantics without projecting a branch`, async () => {
    const legacy = relationshipFixture(kind, false);
    const baseline = await createGithubEvidenceNormalizer(legacy.options)(legacy.input);
    const s = relationshipFixture(kind, true);
    const normalize = createGithubEvidenceNormalizer(s.options);
    const output = await normalize(s.input);
    const { pullRequestMergeTargets, ...ordinary } = output;
    assert.deepEqual(ordinary, baseline);
    assert.deepEqual(pullRequestMergeTargets, []);
    const pairFacts = output.facts.filter((fact) => fact.metricId === `${kind}_links`);
    assert.equal(pairFacts.length, 1);
    assert.deepEqual(pairFacts[0].relationshipPair, s.pair);
    assert.equal(pairFacts[0].state, "observed");
    assert.equal(pairFacts[0].occurredAt, mergedAt);
    assert.equal(pairFacts[0].observedAt, observedAt);
    assert.ok(output.facts.every((fact) => fact.mergeTarget === undefined));
    assert.equal(s.state.requests.length, 0);
    assert.equal(legacy.state.requests.length, 0);

    s.pairState.valid = false;
    const unbound = await normalize(s.input);
    assert.deepEqual(unbound.pullRequestMergeTargets, []);
    assert.ok(unbound.reasons.includes("relationship_pair_source_unverified"));
    assert.ok(unbound.facts.every((fact) => fact.mergeTarget === undefined));
    const unresolved = unbound.facts.filter((fact) => fact.metricId === `${kind}_links`);
    assert.equal(unresolved.length, 1);
    assert.equal(unresolved[0].state, "unknown");
    assert.equal(unresolved[0].relationshipPair, undefined);
    assert.equal(unresolved[0].occurredAt, mergedAt);
    assert.equal(s.state.requests.length, 0);
  });
}
