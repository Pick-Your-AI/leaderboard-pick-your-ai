import test from "node:test";
import assert from "node:assert/strict";
import {
  applyRecognitionReceipt,
  createGithubEvidenceNormalizer,
  parseOrderingReview,
  parseOrderingSourceAuthority,
  bindOrderingReview,
  validateOrderingSource,
  orderingPlanIdentity,
  registerOrderingPlan,
} from "../dist/index.js";
import {
  orderingSource,
  orderingEnvelope,
  orderingAt,
  orderingDescriptor,
  orderingAuthority,
  orderingState,
} from "../../../tests/fixtures/ordering.mjs";

function scenario() {
  const source = orderingSource(),
    state = orderingState({ source }),
    request = Object.values(state.requests)[0];
  const review = request.history.at(-1).ordering,
    target = source.facts.find((fact) => fact.id === review.source.factId);
  const receipt = {
    verified: true,
    id: "fixture-review",
    metricId: "issue_ordering",
    actorId: "101",
    reviewerId: "202",
    acceptedAt: orderingAt,
    decision: "accepted",
    targetFactId: target.id,
    evidenceIds: [target.id],
    ordering: review,
    orderingAuthority: orderingAuthority(),
  };
  return { source, state, request, review, target, receipt };
}

test("a generic accepted receipt cannot invent a reviewed ordering plan", () => {
  const input = orderingSource(),
    target = input.facts.find((fact) => fact.metricId === "issues_opened");
  const before = structuredClone(input);
  assert.throws(() =>
    applyRecognitionReceipt(
      input,
      {
        verified: true,
        id: "fixture-review",
        metricId: "issue_ordering",
        actorId: "101",
        reviewerId: "202",
        acceptedAt: orderingAt,
        decision: "accepted",
        targetFactId: target.id,
        evidenceIds: [target.id],
        changesetId: "arbitrary-credit",
      },
      ["202"],
    ),
  );
  assert.deepEqual(input, before);
});

test("an explicit rejected ordering receipt preserves raw source and grants no eligible plan", () => {
  const s = scenario(),
    before = structuredClone(s.source);
  s.receipt.decision = "rejected";
  delete s.receipt.ordering;
  delete s.receipt.orderingAuthority;
  const out = applyRecognitionReceipt(s.source, s.receipt, ["202"]);
  assert.deepEqual(out.facts.slice(0, -1), before.facts);
  assert.equal(out.facts.at(-1).state, "excluded");
  assert.equal(out.evidence.at(-1).contribution.qualification, "ineligible");
  assert.deepEqual(s.source, before);
});

test("ten ordered children produce one qualified plan and preserve every original observation", () => {
  const s = scenario(),
    original = structuredClone(s.source);
  const out = applyRecognitionReceipt(s.source, s.receipt, ["202"]);
  assert.equal(out.facts.length, original.facts.length + 1);
  assert.deepEqual(out.facts.slice(0, -1), original.facts);
  assert.equal(out.facts.at(-1).metricId, "issue_ordering");
  assert.equal(out.facts.at(-1).state, "qualified");
  assert.equal(out.facts.at(-1).acceptedAt, orderingAt);
  assert.equal(out.facts.at(-1).occurredAt, s.target.occurredAt);
  assert.equal(out.evidence.at(-1).occurredAt, orderingAt);
  assert.deepEqual(out.evidence.at(-1).contribution.reasonCodes, ["independent_recognition_receipt"]);
  assert.equal(out.evidence.at(-1).artifact.stableId, s.target.artifactId);
  assert.deepEqual(s.source, original);
  assert.doesNotMatch(JSON.stringify(out), /PRIVATE_ORDERING_DETAIL|CHILD_10|ordering-review\/v1/);
});

test("receipt identifiers review time revision aliases and arbitrary changesets cannot mint another plan", () => {
  const s = scenario(),
    first = applyRecognitionReceipt(s.source, s.receipt, ["202"]).facts.at(-1);
  const receipt = structuredClone(s.receipt);
  receipt.id = "different-review";
  receipt.acceptedAt = "2026-10-19T03:01:00.000Z";
  receipt.changesetId = "another-credit";
  receipt.ordering.requestId = "another-request";
  receipt.ordering.before.revision = "c".repeat(40);
  receipt.ordering.before.locator = receipt.ordering.before.locator.replace("a".repeat(40), "c".repeat(40));
  receipt.ordering.aliases.push("PUBLIC_PLAN_ALIAS");
  receipt.ordering.aliases.reverse();
  const second = applyRecognitionReceipt(s.source, receipt, ["202"]).facts.at(-1);
  assert.equal(second.canonicalKey, first.canonicalKey);
  assert.equal(second.id, first.id);
  assert.equal(
    orderingPlanIdentity(parseOrderingReview(receipt.ordering)).identity,
    orderingPlanIdentity(s.review).identity,
  );
});

test("closed ordering input rejects snapshots without a net permutation or with mixed facets", () => {
  const mutations = [
    (r) => {
      r.after.items = [...r.before.items];
    },
    (r) => {
      r.after.items[0] = "NEW_CHILD";
    },
    (r) => {
      r.before.items.pop();
    },
    (r) => {
      r.after.items[0] = r.after.items[1];
    },
    (r) => {
      r.before.items = [];
    },
    (r) => {
      delete r.after.items[1];
    },
    (r) => {
      r.after.items.extra = "not-an-item";
    },
    (r) => {
      r.method = "automatic_sort";
    },
    (r) => {
      r.priority = "high";
    },
    (r) => {
      r.reparentedTo = "ANOTHER_PARENT";
    },
    (r) => {
      r.before.revision = "main";
    },
    (r) => {
      r.before.locator = r.before.locator.replace("a".repeat(40), "c".repeat(40));
    },
    (r) => {
      r.after.locator = r.before.locator;
      r.after.revision = r.before.revision;
    },
    (r) => {
      r.after.locator += "?raw=1";
    },
    (r) => {
      r.after.locator += "#part";
    },
    (r) => {
      r.after.locator = r.after.locator.replace("example-repo", "other-repo");
    },
    (r) => {
      r.scope.url = r.scope.url.replace("example-repo", "other-repo");
    },
    (r) => {
      r.aliases = [];
    },
    (r) => {
      r.aliases.push(r.aliases[0]);
    },
    (r) => {
      r.claimDigest = "not-a-digest";
    },
    (r) => {
      r.contributorRole = "observer";
    },
  ];
  for (const mutate of mutations) {
    const r = structuredClone(scenario().review);
    mutate(r);
    assert.throws(() => parseOrderingReview(r), /ordering_evidence_unverified/);
  }
});

test("ordering parsing detaches exact values without sorting the caller's ordered lists", () => {
  const s = scenario(),
    input = structuredClone(s.review);
  input.aliases.unshift("SECOND_ALIAS");
  const old = structuredClone(input),
    result = parseOrderingReview(input);
  assert.deepEqual(input, old);
  assert.deepEqual(result.before.items, old.before.items);
  assert.deepEqual(result.after.items, old.after.items);
  input.before.items.reverse();
  input.scope.id = "MUTATED";
  input.aliases.push("MUTATED");
  assert.deepEqual(result.before.items, old.before.items);
  assert.equal(result.scope.id, old.scope.id);
  assert.equal(result.aliases.length, 2);
});

test("ordering arrays reject sparse accessor and iterator-bearing data without reading their values", () => {
  let callbacks = 0;
  for (const target of ["items", "scopes"]) {
    for (const mutate of [
      (values) => {
        delete values[0];
      },
      (values) => {
        Object.defineProperty(values, "0", {
          get() {
            callbacks++;
            return "forged";
          },
          configurable: true,
        });
      },
      (values) => {
        Object.setPrototypeOf(values, {
          [Symbol.iterator]() {
            callbacks++;
            return [][Symbol.iterator]();
          },
        });
      },
      (values) => {
        values[Symbol.iterator] = function* () {
          callbacks++;
          yield "forged";
        };
      },
    ]) {
      const value = target === "items" ? structuredClone(scenario().review) : orderingAuthority();
      mutate(target === "items" ? value.before.items : value.scopes);
      assert.throws(
        () => (target === "items" ? parseOrderingReview(value) : parseOrderingSourceAuthority(value)),
        /ordering_evidence_unverified/,
      );
    }
  }
  assert.equal(callbacks, 0);
});

test("current claim role and both exact source-use references independently bind the descriptor", () => {
  const s = scenario(),
    refs = s.request.history.at(-1).sourceUseReview.references;
  assert.deepEqual(bindOrderingReview(s.review, s.request, refs), parseOrderingReview(s.review));
  for (const key of ["id", "owner", "category", "locator"]) {
    const request = structuredClone(s.request);
    request[key] += "different";
    assert.throws(() => bindOrderingReview(s.review, request, refs));
  }
  for (const mutate of [
    (r) => {
      r.intake.claimDigest = "b".repeat(64);
    },
    (r) => {
      r.intake.roles.submitter = "observer";
    },
  ]) {
    const request = structuredClone(s.request);
    mutate(request);
    assert.throws(() => bindOrderingReview(s.review, request, refs));
  }
  assert.throws(() => bindOrderingReview(s.review, s.request, refs.slice(1)));
  assert.throws(() => bindOrderingReview(s.review, s.request, [...refs, refs[0]]));
  const changed = structuredClone(refs);
  changed[0].revision = "e".repeat(40);
  assert.throws(() => bindOrderingReview(s.review, s.request, changed));
});

test("source admission rejects ambiguous foreign synthetic hidden automated or undated plan authority", () => {
  const mutations = [
    (s) => {
      s.source.facts.push(structuredClone(s.target));
    },
    (s) => {
      s.source.evidence.push(structuredClone(s.source.evidence[0]));
    },
    (s) => {
      s.source.actors.push(structuredClone(s.source.actors[0]));
    },
    (s) => {
      s.source.isSynthetic = true;
    },
    (s) => {
      s.source.syntheticFactIds = [s.target.id];
    },
    (s) => {
      s.target.actorId = "303";
    },
    (s) => {
      s.target.repoId = "3";
    },
    (s) => {
      s.target.role = "automation";
    },
    (s) => {
      s.target.occurredAt = null;
    },
    (s) => {
      s.target.occurredAt = "2026-10-19T03:00:00.0001Z";
    },
    (s) => {
      s.target.acceptedAt = orderingAt;
    },
    (s) => {
      s.target.state = "qualified";
    },
    (s) => {
      s.source.actors[0].kind = "service_account";
    },
    (s) => {
      s.source.actors[0].executionMode = "automated";
    },
    (s) => {
      s.source.actors[0].publicState = "suppressed";
    },
    (s) => {
      s.source.evidence[0].artifact.visibility = "private";
    },
    (s) => {
      s.source.evidence[0].sourceRevision = "different";
    },
    (s) => {
      s.source.evidence[0].contribution.roles.push("author");
    },
    (s) => {
      s.source.evidence[0].contribution.artifactId = "another-plan";
    },
    (s) => {
      s.receipt.orderingAuthority.scopes[0].id = "not-enrolled";
    },
  ];
  for (const mutate of mutations) {
    const s = scenario();
    mutate(s);
    assert.throws(
      () => applyRecognitionReceipt(s.source, s.receipt, ["202"]),
      /ordering_evidence_unverified|Independent verified/,
    );
  }
});

test("Project-item ordering requires its own exact host enrollment without granting a Project read", () => {
  const s = scenario();
  s.review.scope = {
    ...s.review.scope,
    kind: "project_items",
    id: "PROJECT_7",
    url: "https://github.com/orgs/example-org/projects/7",
  };
  assert.throws(() => validateOrderingSource(s.source, s.target.id, orderingAt, s.review, orderingAuthority()));
  const authority = orderingAuthority(s.review.scope);
  assert.equal(
    validateOrderingSource(s.source, s.target.id, orderingAt, s.review, authority).review.scope.kind,
    "project_items",
  );
  assert.throws(() =>
    parseOrderingSourceAuthority({ ...authority, scopes: [...authority.scopes, authority.scopes[0]] }),
  );
  assert.throws(() => parseOrderingSourceAuthority({ ...authority, scopes: [] }));
});

test("plan deduplication rejects opposite moves and alias bridges in either arrival order", () => {
  const r = scenario().review,
    alias = structuredClone(r);
  alias.requestId = "second";
  const map = new Map();
  assert.equal(registerOrderingPlan(map, r), false);
  assert.equal(registerOrderingPlan(map, alias), true);
  const reverse = structuredClone(r);
  [reverse.before.items, reverse.after.items] = [reverse.after.items, reverse.before.items];
  for (const pair of [
    [r, reverse],
    [reverse, r],
  ]) {
    const registry = new Map();
    registerOrderingPlan(registry, pair[0]);
    assert.throws(() => registerOrderingPlan(registry, pair[1]));
  }
  const bridge = structuredClone(r);
  bridge.source.artifactId = "OTHER_PLAN";
  bridge.aliases.push("OTHER_PLAN");
  for (const pair of [
    [r, bridge],
    [bridge, r],
  ]) {
    const registry = new Map();
    registerOrderingPlan(registry, pair[0]);
    assert.throws(() => registerOrderingPlan(registry, pair[1]));
  }
  const netZero = structuredClone(r);
  netZero.after.items = [...netZero.before.items];
  assert.throws(() => parseOrderingReview(netZero));
});

test("async receipt and enrichment callbacks cannot replace captured source or reviewer authority", async () => {
  const s = scenario(),
    token = {},
    reviewers = ["202"];
  const collection = {
    issueFieldHistoryBatch: token,
    repository: { id: 2, slug: "example-org/example-repo" },
    family: "issues",
    factKey: "synthetic-collection",
    observedAt: orderingAt,
    policyVersion: "fixture-policy",
    fact: {
      subjectId: "ORDERING_PLAN_1",
      sourceRevision: "plan-revision-1",
      sourceUrl: s.review.source.locator,
      evidence: "current_state",
      actorId: null,
      occurredAt: null,
      state: "open",
    },
  };
  const before = structuredClone({ ...collection, issueFieldHistoryBatch: null });
  const normalizer = createGithubEvidenceNormalizer({
    client: {},
    source: "synthetic-source",
    allowedRepositoryIds: [2],
    authorizedReviewerIds: reviewers,
    async enrich(input) {
      assert.equal(input.issueFieldHistoryBatch, token);
      input.repository.id = 404;
      await Promise.resolve();
      return orderingEnvelope();
    },
    async acceptance(input, normalized) {
      assert.equal(input.repository.id, 2);
      assert.equal(input.issueFieldHistoryBatch, token);
      input.fact.sourceRevision = "forged";
      normalized.facts[0].actorId = "404";
      normalized.evidence[0].artifact.repositoryId = "404";
      reviewers.splice(0, 1, "303");
      await Promise.resolve();
      return [structuredClone(s.receipt)];
    },
  });
  const result = await normalizer(collection);
  assert.equal(result.facts.at(-1).actorId, "101");
  assert.equal(result.facts.at(-1).acceptedBy, "202");
  assert.deepEqual({ ...collection, issueFieldHistoryBatch: null }, before);
  assert.equal(collection.issueFieldHistoryBatch, token);
  await assert.rejects(normalizer(collection), /ordering_evidence_unverified/);
});

test("async normalizer preflights opposite receipts and collapses valid aliases before qualification", async () => {
  const s = scenario(),
    input = {
      repository: { id: 2, slug: "example-org/example-repo" },
      family: "issues",
      factKey: "fixture",
      observedAt: orderingAt,
      policyVersion: "fixture",
      fact: {
        subjectId: "ORDERING_PLAN_1",
        sourceRevision: "plan-revision-1",
        sourceUrl: s.review.source.locator,
        evidence: "current_state",
        actorId: null,
        occurredAt: null,
        state: "open",
      },
    };
  let receipts = [s.receipt, { ...structuredClone(s.receipt), id: "second-review" }];
  const normalize = createGithubEvidenceNormalizer({
    client: {},
    source: "fixture",
    allowedRepositoryIds: [2],
    authorizedReviewerIds: ["202"],
    enrich: async () => orderingEnvelope(),
    acceptance: async () => receipts,
  });
  assert.equal((await normalize(input)).facts.filter((f) => f.metricId === "issue_ordering").length, 1);
  // A same-plan duplicate still requires independent receipt authority. Its
  // position must not let deduplication hide an invalid reviewer or proof set.
  for (const mutate of [
    (r) => {
      r.reviewerId = "UNAUTHORIZED";
    },
    (r) => {
      r.reviewerId = r.actorId;
    },
    (r) => {
      r.evidenceIds = ["different-proof"];
    },
    (r) => {
      r.actorId = "303";
    },
    (r) => {
      r.verified = false;
    },
  ]) {
    const invalid = structuredClone(s.receipt);
    mutate(invalid);
    for (const pair of [
      [s.receipt, invalid],
      [invalid, s.receipt],
    ]) {
      receipts = pair;
      await assert.rejects(normalize(input), /ordering_evidence_unverified|Independent verified/);
    }
  }
  const reverse = structuredClone(s.receipt);
  [reverse.ordering.before.items, reverse.ordering.after.items] = [
    reverse.ordering.after.items,
    reverse.ordering.before.items,
  ];
  for (const pair of [
    [s.receipt, reverse],
    [reverse, s.receipt],
  ]) {
    receipts = pair;
    await assert.rejects(normalize(input), /ordering_evidence_unverified/);
  }
});
