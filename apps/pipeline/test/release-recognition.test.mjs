// Fictional GitHub source records and disposable databases. No real release,
// contributor consent, host permission or public rollout is asserted here.
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  normalizeGithubObservation,
  applyRecognitionReceipt,
  githubReleaseInclusionHash,
  validateReleaseChangesSource,
} from "@pick-your-ai/github";
import {
  aggregateMetric,
  participationView,
  selectPortfolioFacts,
  validateMetricPolicy,
  getMetricDefinition,
  getMetricUi,
  selectMetricView,
  metricRegistryV1,
} from "@pick-your-ai/metrics";
import { materializeRecognition, recognitionFingerprint } from "../src/recognition-adapter.mjs";
import { releaseReviewRequest } from "../../controls/src/release-review.mjs";
import { attachSyntheticEvidenceIntake } from "../../../tests/fixtures/evidence-intake.mjs";

const fixture = JSON.parse(
  readFileSync(new URL("../../../packages/github/test/fixtures/engineering.json", import.meta.url), "utf8"),
);
const mergedAt = "2026-10-07T10:00:00.000Z";
const publishedAt = "2026-10-08T10:00:00.000Z";
const acceptedAt = "2026-10-09T10:00:00.000Z";
const observedAt = "2026-10-10T10:00:00.000Z";
const cutoff = "2026-10-11T10:00:00.000Z";
const mergeSha = "b".repeat(40),
  releaseSha = "c".repeat(40);
const qualified = (output) => output.facts.filter((fact) => fact.metricId === "release_changes");

function scenario({ bot = false, number = 10, releaseId = 700, publication = publishedAt, markerFree = false } = {}) {
  const data = markerFree ? JSON.parse(JSON.stringify(fixture).replace(/synthetic/gi, "fixture")) : fixture;
  const slug = markerFree ? "example-org/example-repo" : "synthetic-owner/repository";
  const author = bot ? data.bot : data.author;
  const payload = {
    ...structuredClone(data.pull_request),
    id: number,
    node_id: `PR_${markerFree ? "fixture" : "synthetic"}_${number}`,
    number,
    user: author,
    merged_by: data.merger,
    merged_at: mergedAt,
    merge_commit_sha: mergeSha,
    html_url: `https://github.com/${slug}/pull/${number}`,
    updated_at: observedAt,
  };
  const input = normalizeGithubObservation({
    repository: { id: 2, slug, visibility: "public", defaultBranch: "main" },
    proof: { verified: true, source: "github_rest", revision: mergeSha, isSynthetic: false },
    family: "pull_request",
    action: "closed",
    occurredAt: mergedAt,
    observedAt,
    payload: { repository: { ...data.repository, full_name: slug }, pull_request: payload, sender: data.bot },
  });
  const target = input.facts.find((fact) => fact.metricId === "pr_merged");
  assert.ok(target);
  const evidence = input.evidence.find((entry) => entry.contribution.contributionId === target.id);
  const record = {
    schemaVersion: "github-release-inclusion/v1",
    source: "github_rest",
    observedAt,
    request: { repositoryId: 2, repositorySlug: slug, releaseId, pullRequestNumber: number },
    repository: { id: 2, nodeId: "R_fixture", slug, visibility: "public" },
    release: {
      id: releaseId,
      nodeId: `RE_fixture_${releaseId}`,
      tagName: `v1-${releaseId}`,
      publishedAt: publication,
      immutable: true,
      draft: false,
      currentPrerelease: false,
    },
    pullRequest: {
      id: number,
      nodeId: payload.node_id,
      number,
      repositoryId: 2,
      repositoryNodeId: "R_fixture",
      repositorySlug: slug,
      mergedAt,
      mergeCommitSha: mergeSha,
      author: { id: author.id, nodeId: author.node_id, type: author.type },
    },
    tag: {
      ref: `refs/tags/v1-${releaseId}`,
      nodeId: `REF_fixture_${releaseId}`,
      object: { type: "commit", sha: releaseSha },
      annotatedTags: [],
      commitSha: releaseSha,
    },
    comparison: {
      requestedBaseSha: mergeSha,
      requestedHeadSha: releaseSha,
      baseCommitSha: mergeSha,
      mergeBaseCommitSha: mergeSha,
      status: "ahead",
      aheadBy: 2,
      behindBy: 0,
    },
  };
  input.releaseInclusions = [record];
  const review = {
    targetFactId: target.id,
    releaseId,
    pullRequestNumber: number,
    proofHash: githubReleaseInclusionHash(record),
    policyVersion: "release-policy-v1",
  };
  const decision = {
    id: `private-release-decision-${releaseId}-${number}`,
    receipt: `private-release-request-${releaseId}-${number}`,
    action: "accepted",
    actor: "303",
    at: Date.parse(acceptedAt),
    version: 2,
    policyVersion: review.policyVersion,
    releaseInclusion: structuredClone(review),
  };
  const request = {
    id: decision.receipt,
    kind: "evidence",
    status: "accepted",
    version: 2,
    owner: target.actorId,
    category: "release_changes",
    scope: `repository:2:release:${releaseId}:pull:${number}`,
    locator: evidence.artifact.publicUrl,
    policyVersion: review.policyVersion,
    collaborators: {},
    history: [decision],
  };
  attachSyntheticEvidenceIntake(request);
  decision.evidenceRequest = releaseReviewRequest(request);
  const state = { requests: { [request.id]: request }, profiles: {}, audit: [structuredClone(decision)] };
  const binding = {
    category: request.category,
    scope: request.scope,
    policyVersion: review.policyVersion,
    metricId: "release_changes",
    sourceMetricId: "pr_merged",
    repositoryId: "2",
    reviewerIds: ["303"],
    releaseInclusion: structuredClone(review),
  };
  const policy = {
    metricId: "release_changes",
    version: review.policyVersion,
    definitionVersion: metricRegistryV1.policy_version,
    unit: getMetricDefinition("release_changes").definition.unit,
    aggregation: "count",
    dateBasis: "occurredAt",
    rankedStates: ["qualified"],
    roles: ["author"],
    groupBy: "canonical",
    groupingPolicyVersion: "release-inclusion-units/v1",
    sources: ["github_rest"],
    minimumSamples: 1,
    rank: false,
  };
  const receipt = {
    id: decision.id,
    verified: true,
    targetFactId: target.id,
    metricId: "release_changes",
    actorId: target.actorId,
    reviewerId: "303",
    acceptedAt,
    decision: "accepted",
    evidenceIds: [target.id],
    releaseInclusion: structuredClone(review),
  };
  const run = (apply = applyRecognitionReceipt, bound = cutoff) =>
    materializeRecognition(input, state, [binding], [{ policy }], apply, bound);
  return { input, target, evidence, record, review, decision, request, state, binding, policy, receipt, payload, run };
}
function frozen(output) {
  return {
    datasetId: "fixture-release-dataset",
    cutoff,
    backfillRevision: "fixture-backfill-v1",
    repositoryIds: ["2"],
    actors: output.actors,
    facts: output.facts,
    coverage: [
      {
        schemaVersion: "leaderboard/v1",
        state: "complete",
        source: "github_rest",
        scopeId: "2",
        windowStart: "2026-10-01T00:00:00.000Z",
        windowEnd: cutoff,
        knownStart: "2026-10-01T00:00:00.000Z",
        lastSuccessfulSync: cutoff,
        sourceWatermark: cutoff,
        missingPages: 0,
        permissionsMissing: [],
        sourceErrors: [],
      },
    ],
  };
}
const scope = (patch = {}) => ({
  timezone: "UTC",
  from: "2026-10-01T00:00:00.000Z",
  to: cutoff,
  repos: [],
  projects: [],
  workstreams: [],
  roles: [],
  actors: "all",
  context: "event",
  ...patch,
});
const board = (output, policy, patch) => aggregateMetric(frozen(output), policy, scope(patch));
const value = (output, policy, patch) =>
  board(output, policy, patch).rows.reduce((sum, row) => sum + (row.value ?? 0), 0);
const auditDecision = (s) => {
  s.state.audit = [structuredClone(s.decision)];
};

test("release inclusion: accepted author, publication clock and immutable commit link preserve the original merge", () => {
  const s = scenario(),
    original = structuredClone(s.input),
    out = s.run(),
    [fact] = qualified(out);
  assert.equal(qualified(out).length, 1);
  assert.equal(fact.actorId, "101");
  assert.equal(fact.role, "author");
  assert.equal(fact.occurredAt, publishedAt);
  assert.equal(fact.acceptedAt, acceptedAt);
  assert.equal(fact.observedAt, observedAt);
  assert.equal(fact.releaseInclusion.releaseId, 700);
  assert.equal(fact.releaseInclusion.pullRequestNodeId, s.target.artifactId);
  const proof = out.evidence.find((entry) => entry.contribution.contributionId === fact.id);
  assert.equal(proof.occurredAt, publishedAt);
  assert.equal(proof.evidenceMetadata.sourceOccurredAt, publishedAt);
  assert.equal(proof.evidenceMetadata.acceptedAt, acceptedAt);
  assert.equal(proof.sourceRevision, releaseSha);
  assert.equal(proof.sourceRevisionUrl, `https://github.com/synthetic-owner/repository/commit/${releaseSha}`);
  assert.equal(proof.artifact.publicUrl, s.evidence.artifact.publicUrl);
  assert.deepEqual(s.input, original);
  assert.equal(s.target.occurredAt, mergedAt);
  assert.doesNotMatch(JSON.stringify(proof), /private-release|proofHash|currentPrerelease|annotatedTags/);
  assert.equal(value(out, s.policy, { from: publishedAt, to: acceptedAt }), 1);
  assert.equal(value(out, s.policy, { from: acceptedAt }), 0);
  assert.equal(value(out, s.policy, { to: publishedAt }), 0);
});

for (const [name, mutate] of [
  [
    "missing collection",
    (s) => {
      delete s.input.releaseInclusions;
    },
  ],
  [
    "mutable release",
    (s) => {
      s.record.release.immutable = false;
    },
  ],
  [
    "draft release",
    (s) => {
      s.record.release.draft = true;
    },
  ],
  [
    "ancestry diverged",
    (s) => {
      s.record.comparison.status = "diverged";
    },
  ],
  [
    "different ancestry base",
    (s) => {
      s.record.comparison.mergeBaseCommitSha = "d".repeat(40);
    },
  ],
  [
    "different requested tag commit",
    (s) => {
      s.record.comparison.requestedHeadSha = "d".repeat(40);
    },
  ],
  [
    "synthetic result",
    (s) => {
      s.input.isSynthetic = true;
    },
  ],
  [
    "synthetic combined fact",
    (s) => {
      s.input.syntheticFactIds = [s.target.id];
    },
  ],
  [
    "qualified source reuse",
    (s) => {
      s.target.state = "qualified";
    },
  ],
  [
    "hidden source acceptance",
    (s) => {
      s.target.acceptanceReceipt = "private-old";
    },
  ],
  [
    "wrong author node",
    (s) => {
      s.input.actors.find((actor) => actor.id === s.target.actorId).githubNodeId = "U_unrelated";
    },
  ],
  [
    "wrong actor database identity",
    (s) => {
      s.input.actors.find((actor) => actor.id === s.target.actorId).githubDatabaseId = 909;
    },
  ],
  [
    "missing original source actor",
    (s) => {
      s.input.actors = s.input.actors.filter((actor) => actor.id !== s.target.actorId);
    },
  ],
  [
    "duplicated source actor",
    (s) => {
      s.input.actors.push(structuredClone(s.input.actors.find((actor) => actor.id === s.target.actorId)));
    },
  ],
  [
    "duplicate PR proof",
    (s) => {
      s.input.evidence.push(structuredClone(s.evidence));
    },
  ],
  [
    "wrong source artifact",
    (s) => {
      s.evidence.artifact.stableId = "PR_wrong";
    },
  ],
  [
    "wrong source canonical event",
    (s) => {
      s.evidence.contribution.canonicalEventId = "gh:wrong";
    },
  ],
  [
    "hidden source metadata acceptance",
    (s) => {
      s.evidence.evidenceMetadata.acceptedAt = acceptedAt;
    },
  ],
  [
    "source merge revision mismatch",
    (s) => {
      s.evidence.sourceRevision = "d".repeat(40);
    },
  ],
  [
    "source merge clock mismatch",
    (s) => {
      s.target.occurredAt = publishedAt;
      s.evidence.occurredAt = publishedAt;
      s.evidence.evidenceMetadata.sourceOccurredAt = publishedAt;
    },
  ],
  [
    "private extra proof field",
    (s) => {
      s.record.privateNotes = "must never be retained";
    },
  ],
  [
    "future proof observation",
    (s) => {
      s.record.observedAt = "2026-10-12T10:00:00.000Z";
    },
  ],
]) {
  test(`release inclusion source guard rejects ${name} before a custom receipt callback`, () => {
    const s = scenario();
    mutate(s);
    let calls = 0;
    assert.throws(
      () =>
        s.run((input) => {
          calls += 1;
          return input;
        }),
      /release_inclusion_source_unverified/,
    );
    assert.equal(calls, 0);
  });
  if (name !== "future proof observation")
    test(`release inclusion direct receipt rejects ${name}`, () => {
      const s = scenario();
      mutate(s);
      assert.throws(() => applyRecognitionReceipt(s.input, s.receipt, ["303"]));
    });
}

for (const [name, mutate, earlierIntakeBoundary] of [
  [
    "generic old acceptance",
    (s) => {
      delete s.decision.releaseInclusion;
      auditDecision(s);
    },
  ],
  [
    "different accepted release",
    (s) => {
      s.decision.releaseInclusion.releaseId += 1;
      auditDecision(s);
    },
  ],
  [
    "unbound current proof hash",
    (s) => {
      s.binding.releaseInclusion.proofHash = "f".repeat(64);
    },
  ],
  [
    "different decision target",
    (s) => {
      s.decision.releaseInclusion.targetFactId = "gh:other";
      auditDecision(s);
    },
  ],
  [
    "different current request version",
    (s) => {
      s.request.version += 1;
    },
    "withheld_by_current_intake",
  ],
  [
    "different accepted request snapshot",
    (s) => {
      s.decision.evidenceRequest.scope = "unrelated";
      auditDecision(s);
    },
  ],
  [
    "different receipt request",
    (s) => {
      s.decision.receipt = "private-other";
      auditDecision(s);
    },
    "withheld_by_current_intake",
  ],
  [
    "extra private target property",
    (s) => {
      s.binding.releaseInclusion.extra = "unbound";
    },
  ],
])
  test(`release inclusion review rejects ${name} before a custom receipt callback`, () => {
    const s = scenario();
    mutate(s);
    let calls = 0;
    const callback = (input) => {
      calls += 1;
      return input;
    };
    if (earlierIntakeBoundary) {
      // Accepted current-intake authority withholds these stale request IDs or
      // versions before destination-specific review validation is reached.
      const original = structuredClone(s.input);
      const output = s.run(callback);
      assert.equal(qualified(output).length, 0);
      assert.deepEqual(output, original);
      assert.deepEqual(s.input, original);
    } else assert.throws(() => s.run(callback), /release_inclusion_review_unverified/);
    assert.equal(calls, 0);
  });

for (const [name, mutate] of [
  [
    "review after cutoff",
    (s) => {
      s.decision.at = Date.parse("2026-10-12T00:00:00.000Z");
      auditDecision(s);
    },
  ],
  [
    "withdrawal",
    (s) => {
      s.request.status = "withdrawn";
    },
  ],
  [
    "suppression",
    (s) => {
      s.state.profiles[s.request.owner] = { suppressed: true };
    },
  ],
])
  test(`release inclusion ${name} creates no accepted membership`, () => {
    const s = scenario();
    mutate(s);
    assert.equal(qualified(s.run()).length, 0);
  });

test("release inclusion: a review before publication fails in both adapter and direct paths", () => {
  const s = scenario();
  s.decision.at = Date.parse(mergedAt);
  // Keep the independent synthetic intake review current at this earlier clock
  // so both source APIs still reject publication after the review itself.
  attachSyntheticEvidenceIntake(s.request);
  auditDecision(s);
  s.receipt.acceptedAt = mergedAt;
  assert.throws(() => s.run(), /release_inclusion_source_unverified/);
  assert.throws(() => applyRecognitionReceipt(s.input, s.receipt, ["303"]), /release_inclusion_source_unverified/);
});

test("release inclusion: source bot kind remains separate from unknown execution mode and sender/operator never receives author credit", () => {
  const s = scenario({ bot: true }),
    out = s.run();
  assert.equal(qualified(out)[0].actorId, "404");
  assert.equal(s.input.actors.find((actor) => actor.id === "404").kind, "bot");
  assert.equal(s.input.actors.find((actor) => actor.id === "404").executionMode, "unknown");
  assert.equal(value(out, s.policy, { actors: "user" }), 0);
  assert.equal(value(out, s.policy, { actors: "automation" }), 1);
  assert.equal(qualified(scenario().run())[0].actorId, "101");
});

test("release inclusion: hash is order independent and recollection alone does not change reviewed semantics", () => {
  const s = scenario(),
    reversed = Object.fromEntries(Object.entries(s.record).reverse());
  reversed.observedAt = cutoff;
  assert.equal(githubReleaseInclusionHash(reversed), s.review.proofHash);
  reversed.release = { ...reversed.release, currentPrerelease: true };
  assert.notEqual(githubReleaseInclusionHash(reversed), s.review.proofHash);
  s.input.releaseInclusions.push({ ...structuredClone(s.record), observedAt: cutoff });
  assert.equal(qualified(s.run())[0].observedAt, observedAt);
  s.input.releaseInclusions.push(reversed);
  assert.throws(() => s.run(), /release_inclusion_source_unverified/);
});

test("release inclusion: receipt aliases and bulk changesets cannot multiply one release membership", () => {
  const s = scenario();
  s.receipt.changesetId = "private-bulk-a";
  const first = applyRecognitionReceipt(s.input, s.receipt, ["303"]);
  const later = applyRecognitionReceipt(s.input, { ...s.receipt, id: "private-alias", changesetId: "private-bulk-b" }, [
    "303",
  ]);
  assert.equal(qualified(first)[0].id, qualified(later)[0].id);
  assert.equal(qualified(first)[0].canonicalKey, qualified(later)[0].canonicalKey);
  const duplicate = structuredClone(s.request);
  duplicate.id = "private-alias-request";
  duplicate.history[0].id = "private-alias-review";
  duplicate.history[0].receipt = duplicate.id;
  attachSyntheticEvidenceIntake(duplicate);
  s.state.requests[duplicate.id] = duplicate;
  s.state.audit.push(structuredClone(duplicate.history[0]));
  assert.equal(qualified(s.run()).length, 1);
  duplicate.history[0].releaseInclusion.proofHash = "e".repeat(64);
  s.state.audit[1] = structuredClone(duplicate.history[0]);
  assert.throws(() => s.run(), /release_inclusion_review_unverified/);
});

test("release inclusion: distinct release memberships retain publication evidence but conserve lifetime PR work after filters", () => {
  const a = scenario(),
    b = scenario({ releaseId: 701, publication: "2026-10-09T09:00:00.000Z" });
  const ao = a.run(),
    bo = b.run();
  const output = { ...ao, facts: [...qualified(ao), ...qualified(bo)] };
  assert.notEqual(output.facts[0].canonicalKey, output.facts[1].canonicalKey);
  assert.equal(value(output, a.policy), 2);
  assert.equal(value(output, a.policy, { period: "all", from: null }), 1);
  assert.equal(selectPortfolioFacts(frozen(output), a.policy, scope({ period: "all", from: null })).length, 2);
  assert.equal(value(output, a.policy, { from: "2026-10-09T00:00:00.000Z" }), 1);
  output.facts[0].eventContext = { projects: ["old"], workstreams: [] };
  output.facts[1].eventContext = { projects: ["new"], workstreams: [] };
  assert.equal(value(output, a.policy, { from: null, projects: ["new"] }), 1);
  assert.deepEqual(board(output, a.policy, { from: null, projects: ["new"] }).rows[0].evidenceIds, [
    output.facts[1].id,
  ]);
  const correction = { ...output.facts[0], revision: 1, state: "excluded", correctionReceipt: "private-correction" };
  output.facts.push(correction);
  assert.equal(value(output, a.policy, { from: null }), 1);
  assert.deepEqual(board(output, a.policy, { from: null }).rows[0].evidenceIds, [output.facts[1].id]);
});

test("release inclusion: distinct accepted PRs remain separate and unknown cross-PR lineage is not invented", () => {
  const a = scenario(),
    b = scenario({ number: 11 });
  const output = { ...a.run(), facts: [...qualified(a.run()), ...qualified(b.run())] };
  assert.equal(value(output, a.policy, { from: null }), 2);
});

for (const patch of [
  { dateBasis: "acceptedAt" },
  { rankedStates: ["observed"] },
  { groupBy: "actor_artifact" },
  { groupingPolicyVersion: "old" },
  { roles: ["coauthor"] },
])
  test(`release inclusion policy refuses ${JSON.stringify(patch)}`, () => {
    const s = scenario();
    assert.throws(() => validateMetricPolicy({ ...s.policy, ...patch }), /Release inclusion requires/);
  });

test("release inclusion: a saved generic release fact without collected membership cannot rank or enter a portfolio", () => {
  const s = scenario(),
    output = s.run();
  delete qualified(output)[0].releaseInclusion;
  assert.equal(value(output, s.policy), 0);
  assert.equal(selectPortfolioFacts(frozen(output), s.policy, scope()).length, 0);
  assert.ok(board(output, s.policy).audit.some((entry) => entry.reason === "release_inclusion_unverified"));
});

test("release inclusion: unverified saved membership keeps aggregate and participant history incomplete", () => {
  const valid = scenario(),
    other = scenario({ number: 11 }),
    output = valid.run();
  const history = { originAt: "2026-10-01T00:00:00.000Z", reviewReceipt: "fixture-history-review" };
  assert.equal(board(output, valid.policy).coverage, "complete");
  assert.equal(
    participationView(frozen(output), valid.policy, scope(), history)[0].historyCoverage,
    "complete_known_history",
  );
  const unverified = qualified(other.run())[0];
  delete unverified.releaseInclusion;
  output.facts.push(unverified);
  const result = board(output, valid.policy);
  assert.equal(value(output, valid.policy), 1);
  assert.equal(result.coverage, "incomplete");
  assert.ok(
    result.audit.some(
      (entry) => entry.factIds.includes(unverified.id) && entry.reason === "release_inclusion_unverified",
    ),
  );
  const participation = participationView(frozen(output), valid.policy, scope(), history);
  assert.equal(participation.length, 1);
  assert.equal(participation[0].historyCoverage, "incomplete");
  assert.equal(participation[0].newcomer, null);
});

test("release inclusion revision: an unverified higher reviewed correction cannot restore lower release credit", () => {
  const s = scenario(),
    output = s.run(),
    original = qualified(output)[0];
  assert.equal(value(output, s.policy), 1);
  const corrected = {
    ...structuredClone(original),
    revision: 1,
    correctionReceipt: "private-revision-correction",
    state: "excluded",
  };
  output.facts.push(corrected);
  assert.equal(value(output, s.policy), 0, "a complete reviewed exclusion supersedes its original");
  assert.equal(selectPortfolioFacts(frozen(output), s.policy, scope()).length, 0);
  delete corrected.releaseInclusion;
  const result = board(output, s.policy);
  assert.equal(value(output, s.policy), 0, "missing current proof cannot restore lower revision credit");
  assert.equal(selectPortfolioFacts(frozen(output), s.policy, scope()).length, 0);
  assert.equal(result.coverage, "incomplete");
  assert.ok(
    result.audit.some(
      (entry) => entry.factIds.includes(original.id) && entry.reason === "release_inclusion_unverified",
    ),
  );
});

test("release inclusion revision: conflicting copies at the highest revision cannot select only the proved copy", () => {
  const s = scenario(),
    output = s.run(),
    original = qualified(output)[0];
  const proved = {
    ...structuredClone(original),
    revision: 1,
    correctionReceipt: "private-revision-correction",
  };
  output.facts.push(proved);
  assert.equal(value(output, s.policy), 1, "one complete reviewed current copy is eligible");
  const conflicting = structuredClone(proved);
  delete conflicting.releaseInclusion;
  output.facts.push(conflicting);
  const result = board(output, s.policy);
  assert.equal(value(output, s.policy), 0, "both highest-revision copies must participate in conflict selection");
  assert.equal(selectPortfolioFacts(frozen(output), s.policy, scope()).length, 0);
  assert.equal(result.coverage, "incomplete");
  assert.ok(
    result.audit.some((entry) => entry.factIds.includes(original.id) && entry.reason === "conflicting_revision"),
  );
});

// Literal published4645 authority; all earlier category markers remain unchanged.
function previousAuthority(state, bindings = []) {
  const requests = Object.values(state.requests ?? {})
    .filter((r) => r.kind === "evidence")
    .sort((a, b) => a.id.localeCompare(b.id));
  const suppressed = Object.entries(state.profiles ?? {})
    .filter(([, p]) => p.suppressed)
    .map(([id]) => id)
    .sort();
  const decisionIds = new Set(
    requests.flatMap((r) => (r.history ?? []).filter((event) => event.action === "accepted").map((event) => event.id)),
  );
  // A receipt's current audit entry is part of the authority used below. Fence
  // publication and pinned reads when it disappears, changes or is duplicated.
  const audit = (state.audit ?? [])
    .filter((event) => decisionIds.has(event.id))
    .map((event) => JSON.stringify(event))
    .sort();
  // Version the target/clock authority and include exact current bindings. An old
  // unbound locale publication cannot remain authorized after this correction.
  const authority = ["localization-review-target/v1", requests, suppressed, audit, bindings];
  // Earlier generic data-quality receipts did not qualify correction provenance.
  // Retire their publication authority without changing unaffected bindings.
  if (bindings.some((binding) => binding.metricId === "data_quality")) authority.push("data-quality-recognition/v1");
  // Generic reproduction receipts had no scenario/environment/result boundary.
  if (bindings.some((binding) => binding.metricId === "reproductions")) authority.push("reproduction-recognition/v1");
  // Earlier generic bug receipts admitted non-issue and explicitly synthetic sources.
  if (bindings.some((binding) => binding.metricId === "confirmed_bugs"))
    authority.push("confirmed-bug-source-admission/v1");
  // Earlier answer receipts could precede their known source occurrence. Retire
  // only configurations whose destination is affected by that missing bound.
  if (bindings.some((binding) => binding.metricId === "issue_answers")) authority.push("issue-answer-source-time/v1");
  // Prior maintenance receipts lacked merged-participant, clock and unit admission.
  if (bindings.some((binding) => binding.metricId === "maintenance"))
    authority.push("maintenance-merged-participant/v1");
  // Tooling receipts independently require verified merged participation as well.
  if (bindings.some((binding) => binding.metricId === "automation")) authority.push("automation-merged-participant/v1");
  // Older generic operations receipts lack the current source, public artifact
  // and affected-owner evidence boundary. Unrelated configurations stay exact.
  if (bindings.some((binding) => ["governance", "deployment_work", "incidents"].includes(binding.metricId)))
    authority.push("operations-contribution-evidence/v1");
  return createHash("sha256").update(JSON.stringify(authority)).digest("hex");
}

test("release inclusion: affected release destinations retire preceding authority while manual intake retires across all98 definitions", () => {
  const s = scenario();
  const empty = { requests: {}, profiles: {}, audit: [] };
  for (const metric of metricRegistryV1.metrics) {
    const bindings = [{ ...s.binding, metricId: metric.id }];
    // Legacy generic feedback selections lack the required native-thread contract.
    if (metric.id === "helpful_feedback") {
      for (const state of [s.state, empty])
        assert.throws(() => recognitionFingerprint(state, bindings), /invalid_discussion_feedback_contract/);
      continue;
    }
    // The literal historical function above remains unchanged. Current manual
    // claims also require the independently accepted intake authority marker.
    assert.notEqual(recognitionFingerprint(s.state, bindings), previousAuthority(s.state, bindings));
    const previous = previousAuthority(empty, bindings),
      current = recognitionFingerprint(empty, bindings);
    if (
      ["release_changes", "issue_ordering", "release_stewardship", "performance", "regressions_prevented"].includes(
        metric.id,
      )
    )
      assert.notEqual(current, previous);
    else assert.equal(current, previous, metric.id);
  }
  assert.notEqual(recognitionFingerprint(s.state, []), previousAuthority(s.state, []));
  assert.equal(recognitionFingerprint(empty, []), previousAuthority(empty, []));
  assert.equal(getMetricUi("release_changes").maturity, "definition_only");
  assert.throws(() => selectMetricView("release_changes"), /No supported selectable view/);
});

test("release inclusion: conflicting shared release or PR identities cannot hide behind different membership selectors", () => {
  for (const kind of ["release", "pull"]) {
    const s = scenario(),
      another = scenario(kind === "release" ? { number: 11 } : { releaseId: 701 });
    if (kind === "release") another.record.release.nodeId = "RE_wrong";
    else another.record.pullRequest.author.id = 909;
    s.input.releaseInclusions.push(another.record);
    assert.throws(() => s.run(), /release_inclusion_source_unverified/);
  }
});

test("release inclusion: private normalization survives publication and obsolete authority is withheld after reopen", async (t) => {
  const { harness, components, publicScope } = await import("./harness.mjs");
  const { createPipeline } = await import("../src/runtime.mjs");
  const s = scenario({ markerFree: true });
  const h = await harness(t, {
    markerFreeConfig: true,
    dataMode: "public",
    payloads: [s.payload],
    normalizerFactory: () => async () => structuredClone(s.input),
    defaultDeliveryNormalizationVersion: components.github.defaultDeliveryNormalizationVersion,
    authorizePolicyPreview: async () => true,
    configure(config) {
      config.repositories[0].families = ["pull_requests"];
      config.recognitionBindings = [s.binding];
      const policy = { ...config.policies[0].policy, ...s.policy };
      config.policies = [
        { policy, signature: components.metrics.stableJSON(policy), approvalReceipt: "fixture-policy-approval" },
      ];
    },
  });
  h.controlsStore.transaction((state) => {
    state.requests = s.state.requests;
    state.audit = s.state.audit;
  });
  const publication = await h.runtime.runOnce({ cutoff });
  assert.equal(publication.state, "published");
  const snapshot = publication.publications[0].snapshotId;
  const read = await h.runtime.source.read(publicScope, snapshot, new AbortController().signal);
  assert.equal(read.selected.rows[0].result.value, 1);
  const proof = read.selected.evidence.find((entry) => entry.contribution.metricIds.includes("release_changes"));
  assert.ok(proof);
  assert.equal(proof.occurredAt, publishedAt);
  const proofId = proof.contribution.contributionId;
  const paths = [
    `/api/v1/boards?metric=release_changes&snapshot=${snapshot}`,
    `/api/v1/contributors/101?metric=release_changes&snapshot=${snapshot}`,
    `/api/v1/evidence/${proofId}?snapshot=${snapshot}`,
    `/api/v1/exports?metric=release_changes&format=json&snapshot=${snapshot}`,
    `/api/v1/exports?metric=release_changes&format=csv&snapshot=${snapshot}`,
  ];
  for (const path of paths) {
    const response = await h.runtime.app.inject(path);
    assert.equal(response.statusCode, 200, response.body);
    assert.doesNotMatch(response.body, /private-release|proofHash|releaseInclusions|currentPrerelease|annotatedTags/);
  }
  const preview = (runtime) =>
    runtime.previewPolicy({
      snapshotId: snapshot,
      policy: { ...s.policy, version: "release-policy-v2" },
      operatorId: "201",
    });
  assert.ok(await preview(h.runtime));
  assert.ok(await h.runtime.aggregateExplanations.read(snapshot));
  const old = previousAuthority(h.controlsStore.read(), [s.binding]);
  assert.notEqual(old, recognitionFingerprint(h.controlsStore.read(), [s.binding]));
  h.controlsStore.transaction((state) => {
    state.pipelinePublications[snapshot].recognitionFingerprint = old;
  });
  const denied = async (runtime) => {
    for (const pin of [null, snapshot])
      assert.equal(await runtime.source.read(publicScope, pin, new AbortController().signal), null);
    for (const path of paths) {
      const response = await runtime.app.inject(path);
      assert.equal(response.statusCode, 410, response.body);
      assert.match(response.headers["cache-control"], /no-store/);
    }
    await assert.rejects(preview(runtime), /policy_input_revoked/);
    await assert.rejects(runtime.aggregateExplanations.read(snapshot), /authorization_changed/);
  };
  await denied(h.runtime);
  await h.runtime.stop();
  await h.reopenDatabase();
  const reopened = await createPipeline(h.options);
  t.after(() => reopened.stop());
  await denied(reopened);
  const repaired = await reopened.runOnce({ cutoff });
  assert.equal(repaired.state, "published");
  const repairedId = repaired.publications[0].snapshotId;
  const restored = await reopened.source.read(publicScope, repairedId, new AbortController().signal);
  assert.equal(restored.selected.rows[0].result.value, 1);
  h.controlsStore.transaction((state) => {
    state.requests[s.request.id].status = "withdrawn";
  });
  assert.equal(await reopened.source.read(publicScope, repairedId, new AbortController().signal), null);
});
