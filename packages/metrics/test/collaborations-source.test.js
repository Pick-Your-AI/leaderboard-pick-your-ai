import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { applyRecognitionReceipt, normalizeGithubObservation } from "../../github/dist/index.js";
import { aggregateCollaborations, getMetricDefinition, metricRegistryV1 } from "../dist/index.js";

// Actual normalizer and receipt paths over fictional API payloads. These are
// executable source semantics, never observed people, consent or live authority.
const engineering = JSON.parse(
  await readFile(new URL("../../github/test/fixtures/engineering.json", import.meta.url), "utf8"),
);
const start = "2026-10-10T00:00:00Z";
const end = "2026-11-01T00:00:00Z";
const scope = (patch = {}) => ({
  timezone: "UTC",
  period: "custom",
  from: start,
  to: end,
  repos: [],
  projects: [],
  workstreams: [],
  roles: [],
  actors: "user",
  context: "event",
  ...patch,
});
const sourcePolicy = (metricId, roles) => ({
  metricId,
  version: "synthetic-pair-source/v1",
  definitionVersion: metricRegistryV1.policy_version,
  unit: getMetricDefinition(metricId).definition.unit,
  aggregation: "count",
  dateBasis: "acceptedAt",
  rankedStates: ["qualified"],
  roles,
  groupBy: "canonical",
  sources: ["github_rest"],
  minimumSamples: 1,
  rank: false,
});
const policy = () => ({
  version: "accepted-peer-pairs/v1",
  definitionVersion: metricRegistryV1.policy_version,
  sourcePolicies: [
    sourcePolicy("pr_merged", ["author"]),
    sourcePolicy("pr_coauthored", ["coauthor"]),
    sourcePolicy("prs_reviewed", ["reviewer"]),
  ],
});
function fixture() {
  const at = "2026-10-07T10:00:00Z";
  const observedAt = "2026-10-20T10:00:00Z";
  const reviewer = { id: 505, node_id: "U_synthetic_pair_reviewer", login: "synthetic-pair-reviewer", type: "User" };
  const pr = { ...structuredClone(engineering.pull_request), user: engineering.author, merged_by: engineering.merger };
  const envelope = {
    repository: { id: 2, slug: "synthetic-owner/repository", visibility: "public", defaultBranch: "main" },
    proof: { verified: true, source: "github_rest", revision: at, isSynthetic: true },
    family: "pull_request",
    action: "closed",
    occurredAt: at,
    observedAt,
    payload: { repository: engineering.repository, pull_request: pr, sender: engineering.merger },
    verifiedCoauthors: [{ actor: engineering.reviewer, verificationReceipt: "synthetic-coauthor-identity" }],
  };
  const authorOutput = normalizeGithubObservation(envelope);
  const reviewOutput = normalizeGithubObservation({
    ...envelope,
    family: "review",
    action: "submitted",
    verifiedCoauthors: [],
    reviewParticipation: { verified: true, firstSubmittedAt: at, roundFirstSubmittedAt: at },
    payload: {
      pull_request: pr,
      review: {
        id: 501,
        node_id: "R_synthetic_pair_review",
        user: reviewer,
        state: "COMMENTED",
        submitted_at: at,
        created_at: at,
        commit_id: "c".repeat(40),
      },
    },
  });
  const accept = (output, metricId, acceptedAt) => {
    const target = output.facts.find((entry) => entry.metricId === metricId);
    assert.ok(target, "normalizer supplied " + metricId);
    const receiptId = "synthetic-accept-" + metricId;
    const accepted = applyRecognitionReceipt(
      output,
      {
        verified: true,
        id: receiptId,
        metricId,
        actorId: target.actorId,
        reviewerId: "909",
        acceptedAt,
        decision: "accepted",
        targetFactId: target.id,
        evidenceIds: [target.id],
        changesetId: "synthetic-pair-" + metricId,
      },
      ["909"],
    );
    const result = accepted.facts.find((entry) => entry.acceptanceReceipt === receiptId);
    assert.ok(result, "receipt adapter supplied an independently accepted source fact");
    return result;
  };
  const facts = [
    accept(authorOutput, "pr_merged", "2026-10-08T10:00:00Z"),
    accept(authorOutput, "pr_coauthored", "2026-10-12T10:00:00Z"),
    accept(reviewOutput, "prs_reviewed", "2026-10-14T10:00:00Z"),
  ];
  const actors = [
    ...new Map([...authorOutput.actors, ...reviewOutput.actors].map((actor) => [actor.id, actor])).values(),
  ];
  const artifact = authorOutput.evidence.find((entry) => entry.contribution.metricIds.includes("pr_merged")).artifact;
  return {
    input: {
      datasetId: "synthetic-pair-dataset",
      cutoff: end,
      backfillRevision: "synthetic-pair-capture/v1",
      repositoryIds: ["2"],
      actors,
      facts,
      coverage: [],
    },
    artifacts: [artifact],
    policy: policy(),
    scope: scope(),
    subject: "101",
    rawFacts: [...authorOutput.facts, ...reviewOutput.facts],
  };
}
const run = (value) => aggregateCollaborations(value.input, value.policy, value.scope, value.subject, value.artifacts);
const peers = (result) => result.peers.map((entry) => entry.actorId);
function assertUnknown(result) {
  assert.equal(result.value, null);
  assert.equal(result.state, "unknown");
  assert.deepEqual(result.peers, []);
  assert.equal(result.coverage, "incomplete");
  assert.equal(result.publicEnabled, false);
  assert.equal(result.rank, null);
}
function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

test("accepted source authors, verified coauthors and reviewers produce distinct evidenced peers", () => {
  const value = fixture();
  const before = structuredClone(value);
  const result = run(deepFreeze(value));
  assert.equal(result.metricId, "collaborations");
  assert.equal(result.value, 2);
  assert.equal(result.state, "partial");
  assert.equal(result.coverage, "incomplete");
  assert.equal(result.publicEnabled, false);
  assert.equal(result.rank, null);
  assert.deepEqual(peers(result), ["303", "505"]);
  assert.deepEqual(
    result.peers.map((entry) => [entry.pairs[0].relationship, entry.pairs[0].formedAt]),
    [
      ["shared_authorship", "2026-10-12T10:00:00.000Z"],
      ["author_review_pair", "2026-10-14T10:00:00.000Z"],
    ],
  );
  for (const peer of result.peers) {
    const pair = peer.pairs[0];
    assert.equal(pair.subject.actorId, "101");
    assert.equal(pair.peer.actorId, peer.actorId);
    assert.equal(pair.artifactId, value.artifacts[0].stableId);
    assert.equal(pair.repoId, "2");
    assert.equal(pair.sourceUrl, value.artifacts[0].publicUrl);
    const subject = value.input.facts.find((fact) => fact.id === pair.subject.factId);
    const original = value.input.facts.find((fact) => fact.id === pair.peer.factId);
    for (const key of ["canonicalKey", "metricId", "role", "occurredAt", "acceptedAt", "observedAt", "revision"]) {
      assert.equal(pair.subject[key], subject[key]);
      assert.equal(pair.peer[key], original[key]);
    }
  }
  assert.deepEqual(value, before);
});

test("ordinary source observations and actual unreviewed PR/review facts cannot create accepted peers", () => {
  const value = fixture();
  value.input.facts = value.rawFacts;
  assertUnknown(run(value));
});

test("source occurrence policies retain their clocks while peers form at later independent acceptance", () => {
  const value = fixture();
  value.policy.sourcePolicies.forEach((source) => {
    source.dateBasis = "occurredAt";
  });
  value.input.facts.forEach((fact) => {
    fact.observedAt = "2026-10-07T11:00:00Z";
  });
  const before = structuredClone(value);
  const result = run(deepFreeze(value));
  assert.deepEqual(peers(result), ["303", "505"]);
  assert.equal(result.value, 2);
  assert.deepEqual(value, before);
  for (const peer of result.peers) {
    assert.ok(Date.parse(peer.pairs[0].formedAt) >= Date.parse(value.scope.from));
    assert.ok(Date.parse(peer.pairs[0].subject.occurredAt) < Date.parse(value.scope.from));
    assert.ok(Date.parse(peer.pairs[0].peer.observedAt) < Date.parse(peer.pairs[0].peer.acceptedAt));
  }
});

test("old accepted author proof joins new peer acceptance at the exact inclusive start", () => {
  const value = fixture();
  value.scope = scope({ from: "2026-10-12T10:00:00Z", to: "2026-10-14T10:00:00Z" });
  const result = run(value);
  assert.equal(result.value, 1);
  assert.deepEqual(peers(result), ["303"]);
  assert.ok(Date.parse(result.peers[0].pairs[0].subject.acceptedAt) < Date.parse(value.scope.from));
});

test("accepted pair dates retain millisecond precision and exclude the upper endpoint", () => {
  const value = fixture();
  value.input.facts[1].acceptedAt = "2026-10-12T10:00:00.001Z";
  value.scope = scope({ from: "2026-10-12T10:00:00.001Z", to: "2026-10-12T10:00:00.002Z" });
  assert.equal(run(value).value, 1);
  value.scope.from = "2026-10-12T10:00:00.000Z";
  value.scope.to = "2026-10-12T10:00:00.001Z";
  assertUnknown(run(value));
});

test("later repeated acceptance cannot resurrect an existing artifact and peer in a new window", () => {
  const value = fixture();
  const old = value.input.facts[1];
  value.input.facts.push({
    ...old,
    id: "synthetic-later-peer-proof",
    canonicalKey: "synthetic-later-peer-action",
    acceptedAt: "2026-10-18T10:00:00Z",
  });
  value.scope.from = "2026-10-17T00:00:00Z";
  assertUnknown(run(value));
});

test("one peer across repeated artifacts counts once while every selected original pair remains inspectable", () => {
  const value = fixture();
  const artifact = {
    ...value.artifacts[0],
    stableId: "PR_synthetic_second",
    publicUrl: "https://github.com/synthetic-owner/repository/pull/11",
  };
  value.artifacts.push(artifact);
  value.input.facts.push(
    ...value.input.facts
      .slice(0, 2)
      .map((fact) => ({
        ...fact,
        id: fact.id + "-second",
        canonicalKey: fact.canonicalKey + "-second",
        artifactId: artifact.stableId,
      })),
  );
  const result = run(value);
  assert.equal(result.value, 2);
  assert.equal(result.peers.find((peer) => peer.actorId === "303").pairs.length, 2);
});

test("adapter reobservations, input order and display-name collisions preserve stable peer identity", () => {
  const value = fixture();
  value.input.actors.forEach((actor) => {
    actor.login = "synthetic-same-display";
  });
  const original = value.input.facts[1];
  value.input.facts.push({ ...original, id: "synthetic-reobserved-coauthor", observedAt: "2026-10-21T10:00:00Z" });
  const result = run(value);
  value.input.facts.reverse();
  value.input.actors.reverse();
  value.artifacts.push(structuredClone(value.artifacts[0]));
  value.artifacts.reverse();
  value.policy.sourcePolicies.reverse();
  assert.deepEqual(run(value), result);
  assert.deepEqual(peers(result), ["303", "505"]);
});

test("reviewer pairs require an author and never infer peers from co-review, triage, membership or self", () => {
  const value = fixture();
  value.subject = "505";
  assert.deepEqual(peers(run(value)), ["101", "303"]);
  value.input.facts = value.input.facts.filter((fact) => fact.role === "reviewer");
  const peer = {
    ...value.input.facts[0],
    id: "synthetic-co-reviewer",
    canonicalKey: "synthetic-co-reviewer-action",
    actorId: "303",
    subjectActorId: "101",
  };
  value.input.facts.push(peer);
  assertUnknown(run(value));
  value.input.facts[1].role = "triager";
  assertUnknown(run(value));
});

test("either source side must retain its independent acceptance receipt and accepted state", () => {
  const variants = [
    (fact) => {
      fact.state = "observed";
    },
    (fact) => {
      fact.state = "pending";
    },
    (fact) => {
      fact.state = "excluded";
    },
    (fact) => {
      fact.state = "unknown";
    },
    (fact) => {
      fact.acceptanceReceipt = null;
    },
    (fact) => {
      fact.acceptedBy = fact.actorId;
    },
    (fact) => {
      fact.acceptedBy = null;
    },
    (fact) => {
      fact.acceptedAt = null;
    },
  ];
  for (const index of [0, 1])
    for (const alter of variants) {
      const value = fixture();
      value.input.facts = value.input.facts.slice(0, 2);
      alter(value.input.facts[index]);
      assertUnknown(run(value));
    }
});

test("future observations, future acceptance and acceptance before actual source occurrence remain withheld", () => {
  for (const patch of [
    { observedAt: "2026-11-02T00:00:00Z" },
    { observedAt: "2026-10-06T00:00:00Z" },
    { acceptedAt: "2026-11-02T00:00:00Z" },
    { occurredAt: null },
    { occurredAt: "2026-10-22T00:00:00Z" },
  ]) {
    const value = fixture();
    value.input.facts = value.input.facts.slice(0, 2);
    Object.assign(value.input.facts[1], patch);
    assertUnknown(run(value));
  }
});

test("reviewed exclusion retires old accepted peers while a prior frozen cutoff preserves its original evidence", () => {
  const value = fixture();
  value.input.facts = value.input.facts.slice(0, 2);
  const original = value.input.facts[1];
  value.input.facts.push({
    ...original,
    revision: 1,
    state: "excluded",
    correctionReceipt: "synthetic-reviewed-withdrawal",
    observedAt: "2026-10-25T00:00:00Z",
  });
  assertUnknown(run(value));
  value.input.cutoff = "2026-10-23T00:00:00Z";
  value.scope.to = value.input.cutoff;
  assert.equal(run(value).value, 1);
});

test("conflicting canonical and reviewed source revisions cannot pick a convenient accepted peer", () => {
  for (const patch of [{ id: "synthetic-conflicting-adapter", actorId: "505" }, { role: "author" }]) {
    const value = fixture();
    value.input.facts = value.input.facts.slice(0, 2);
    value.input.facts.push({ ...value.input.facts[1], ...patch });
    assertUnknown(run(value));
  }
});

test("unknown, hidden, deleted, bot and positively automated accounts never become human collaborators", () => {
  for (const patch of [
    { kind: "unknown" },
    { publicState: "suppressed" },
    { publicState: "deleted" },
    { kind: "bot" },
    { executionMode: "automated" },
  ]) {
    for (const actorId of ["101", "303"]) {
      const value = fixture();
      value.input.facts = value.input.facts.slice(0, 2);
      Object.assign(
        value.input.actors.find((actor) => actor.id === actorId),
        patch,
      );
      assertUnknown(run(value));
    }
  }
});

test("known actor aliases cannot count the same account as a different peer", () => {
  const value = fixture();
  value.input.actors.find((actor) => actor.id === "303").githubNodeId = value.input.actors.find(
    (actor) => actor.id === "101",
  ).githubNodeId;
  assert.throws(() => run(value), /identity|alias|actor/i);
});

test("missing or nonpublic artifact context cannot be manufactured from a matching label or source fact", () => {
  for (const mode of ["missing", "unknown", "private", "deleted", "unavailable", "unbound-repository"]) {
    const value = fixture();
    if (mode === "missing") value.artifacts = [];
    else if (mode === "unknown") value.artifacts[0].kind = "unknown";
    else if (mode === "unbound-repository") delete value.artifacts[0].repositoryId;
    else {
      value.artifacts[0].visibility = mode;
      delete value.artifacts[0].publicUrl;
    }
    assertUnknown(run(value));
  }
});

test("conflicting artifact kind, repository, public URL or visibility fails closed before selecting a pair", () => {
  for (const patch of [
    { kind: "issue" },
    { repositoryId: "another-repo" },
    { publicUrl: "https://github.com/synthetic-owner/repository/pull/999" },
    { visibility: "private", publicUrl: undefined },
  ]) {
    const value = fixture();
    value.artifacts.push({ ...value.artifacts[0], ...patch });
    assert.throws(() => run(value), /artifact|identity|manifest|conflict/i);
  }
});

test("matching source artifact IDs cannot cross repository bindings", () => {
  const value = fixture();
  value.input.repositoryIds.push("other-repo");
  value.input.facts[1].repoId = "other-repo";
  const result = run(value);
  assert.deepEqual(peers(result), ["505"]);
  assert.equal(result.value, 1);
});

test("event context, roles and selected source policies constrain both original participant proofs", () => {
  const value = fixture();
  for (const fact of value.input.facts) {
    fact.eventContext = { projects: ["synthetic-p1"], workstreams: ["synthetic-w1"], workstreamsKnown: true };
    fact.currentContext = { projects: ["synthetic-p2"], workstreams: ["synthetic-w2"], workstreamsKnown: true };
  }
  value.input.facts[1].eventContext.projects = ["synthetic-p2"];
  value.scope.projects = ["synthetic-p1"];
  assert.deepEqual(peers(run(value)), ["505"]);
  value.scope.projects = [];
  value.scope.roles = ["author", "coauthor"];
  assert.deepEqual(peers(run(value)), ["303"]);
  value.scope.roles = [];
  value.policy.sourcePolicies = value.policy.sourcePolicies.filter((entry) => entry.metricId !== "prs_reviewed");
  assert.deepEqual(peers(run(value)), ["303"]);
  value.scope.context = "current";
  assert.throws(() => run(value), /context|event/i);
});

test("unmapped event context removes a scoped peer without restoring its current association", () => {
  const value = fixture();
  value.scope.workstreams = ["synthetic-workstream"];
  for (const fact of value.input.facts) {
    fact.eventContext = { projects: [], workstreams: ["synthetic-workstream"], workstreamsKnown: true };
    fact.currentContext = fact.eventContext;
  }
  value.input.facts[1].eventContext = null;
  assert.deepEqual(peers(run(value)), ["505"]);
});

test("nominal complete selected-month source coverage never fabricates complete peer history or zero", () => {
  const value = fixture();
  value.input.coverage = [
    {
      schemaVersion: "leaderboard/v1",
      state: "complete",
      source: "github_rest",
      scopeId: "2",
      windowStart: start,
      windowEnd: end,
      knownStart: start,
      lastSuccessfulSync: end,
      sourceWatermark: end,
      missingPages: 0,
      permissionsMissing: [],
      sourceErrors: [],
    },
  ];
  assert.equal(run(value).state, "partial");
  value.input.facts = value.input.facts.slice(0, 1);
  assertUnknown(run(value));
});

test("strict private policy and artifact inputs reject sparse lists, duplicate source policies and unknown versions", () => {
  const mutations = [
    (value) => {
      value.policy.version = "unreviewed-pair-policy/v2";
    },
    (value) => {
      value.policy.sourcePolicies = new Array(1);
    },
    (value) => {
      delete value.policy.sourcePolicies[1];
    },
    (value) => {
      value.policy.sourcePolicies.push(value.policy.sourcePolicies[0]);
    },
    (value) => {
      value.policy.sourcePolicies[0].rankedStates = ["observed"];
    },
    (value) => {
      value.policy.sourcePolicies[0].definitionVersion = "different-definition/v1";
    },
    (value) => {
      value.policy.sourcePolicies[0] = sourcePolicy("pr_lines_added", ["author"]);
      value.policy.sourcePolicies[0].aggregation = "sum";
    },
    (value) => {
      value.artifacts = new Array(1);
    },
    (value) => {
      value.scope.actors = "automation";
    },
    (value) => {
      value.scope.period = "30d";
    },
  ];
  for (const change of mutations) {
    const value = fixture();
    change(value);
    assert.throws(() => run(value));
  }
});

test("equal pair formation clocks prefer actual shared authorship and retain exact original roles", () => {
  const value = fixture();
  const acceptedReviewer = value.input.facts[2];
  value.input.facts[1].acceptedAt = acceptedReviewer.acceptedAt;
  value.input.facts.push({
    ...acceptedReviewer,
    id: "synthetic-coauthor-also-reviewed",
    canonicalKey: "synthetic-coauthor-review-action",
    actorId: "303",
  });
  const result = run(value);
  const pair = result.peers.find((peer) => peer.actorId === "303").pairs[0];
  assert.equal(pair.relationship, "shared_authorship");
  assert.equal(pair.peer.role, "coauthor");
  assert.equal(pair.peer.factId, value.input.facts[1].id);
});

test("a later shared-authorship proof cannot move an earlier author-review relationship into the window", () => {
  const value = fixture();
  value.input.facts[1].acceptedAt = "2026-10-18T00:00:00Z";
  value.input.facts.push({
    ...value.input.facts[2],
    id: "synthetic-earlier-peer-review",
    canonicalKey: "synthetic-earlier-peer-review-action",
    actorId: "303",
    acceptedAt: "2026-10-09T00:00:00Z",
  });
  const result = run(value);
  assert.deepEqual(peers(result), ["505"]);
});
