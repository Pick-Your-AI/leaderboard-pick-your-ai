import assert from "node:assert/strict";
import test from "node:test";
import {
  identityCorrectionSchema,
  verifiedGithubIdentitySchema,
  verifiedIdentityCorrectionVersion,
  verifiedIdentityCorrectionProposalSchema as proposalSchema,
  verifiedIdentityCorrectionDecisionSchema as decisionSchema,
} from "../dist/index.js";

const identity = (id) => ({
  actorId: String(id),
  githubDatabaseId: id,
  githubNodeId: `opaque_synthetic_${id}`,
  providerKind: "user",
});
const preparedAt = "2026-10-01T01:00:00.000000002Z";
const proof = (evidenceId, kind, subjectActorIds, contributionIds = []) => ({
  evidenceId,
  kind,
  subjectActorIds,
  contributionIds,
  recordedAt: "2026-10-01T00:00:00Z",
  expiresAt: kind === "account_control" ? "2026-10-02T00:00:00Z" : null,
});
function link() {
  return {
    schemaVersion: verifiedIdentityCorrectionVersion,
    correctionId: "synthetic-correction-1",
    revision: 1,
    kind: "link",
    authorityBasis: "verified_account_control",
    requester: identity(101),
    preparedAt,
    policyVersion: "synthetic-policy-v1",
    sourceActors: [identity(101), identity(102)],
    resultActors: [identity(101), identity(102)],
    assignments: [],
    proofs: [proof("control", "account_control", ["101", "102"]), proof("consent", "consent", ["101", "102"])],
  };
}
function merge() {
  const proposal = link();
  proposal.kind = "merge";
  proposal.resultActors = [identity(101)];
  proposal.assignments = [
    {
      contributionId: "contribution-1",
      sourceEventId: "event-1",
      sourceRevision: "revision-1",
      sourceAttributionSha256: "a".repeat(64),
      role: "coauthor",
      sourceActorId: "102",
      resultActorId: "101",
      evidenceIds: ["attribution-1"],
    },
  ];
  proposal.proofs.push(proof("attribution-1", "source_attribution", ["101", "102"], ["contribution-1"]));
  return proposal;
}
function split() {
  const proposal = merge();
  proposal.kind = "split";
  proposal.authorityBasis = "reviewed_source_attribution";
  proposal.sourceActors = [identity(102)];
  proposal.resultActors = [identity(102), identity(101)];
  proposal.proofs = proposal.proofs.filter((item) => item.kind === "source_attribution");
  return proposal;
}
function decision(proposal = link()) {
  return {
    schemaVersion: verifiedIdentityCorrectionVersion,
    decisionId: "decision-1",
    proposal,
    proposalSha256: "b".repeat(64),
    outcome: "accepted",
    reviewer: identity(103),
    authorizationReceiptId: "authority-1",
    reasonReceiptId: "reason-1",
    reviewedAt: "2026-10-01T01:00:00.000000003Z",
    priorReviews: [],
    reversesDecisionId: null,
  };
}
function rejects(schema, valid, mutations) {
  for (const [name, mutate] of Object.entries(mutations)) {
    const value = structuredClone(valid);
    mutate(value);
    assert.equal(schema.safeParse(value).success, false, name);
  }
}

test("the private version preserves verified provider identities without inferring names or emails", () => {
  assert.deepEqual(verifiedGithubIdentitySchema.parse(identity(101)), identity(101));
  rejects(verifiedGithubIdentitySchema, identity(101), {
    "serving alias mismatch": (value) => {
      value.actorId = "102";
    },
    "unsafe database integer": (value) => {
      value.githubDatabaseId = Number.MAX_SAFE_INTEGER + 1;
    },
    "absent node ID": (value) => {
      delete value.githubNodeId;
    },
    "missing provider type": (value) => {
      delete value.providerKind;
    },
    "unverified login": (value) => {
      value.login = "synthetic-alias";
    },
    "private email": (value) => {
      value.email = "synthetic@example.invalid";
    },
    "inferred service account": (value) => {
      value.providerKind = "service_account";
    },
  });
  assert.equal(
    verifiedGithubIdentitySchema.safeParse({ ...identity(101), githubNodeId: "MDQ6VXNlcjEwMQ==" }).success,
    true,
  );
});

test("a voluntary link preserves both accounts and grants no contribution assignment", () => {
  assert.deepEqual(proposalSchema.parse(link()), link());
  rejects(proposalSchema, link(), {
    "one account": (value) => {
      value.sourceActors.pop();
    },
    "removed account": (value) => {
      value.resultActors.pop();
    },
    "new target account": (value) => {
      value.resultActors[1] = identity(104);
    },
    "moves credit": (value) => {
      value.assignments = merge().assignments;
    },
    "name matching basis": (value) => {
      value.authorityBasis = "matching_login";
    },
    "source-only basis": (value) => {
      value.authorityBasis = "reviewed_source_attribution";
    },
    "missing control": (value) => {
      value.proofs.shift();
    },
    "missing consent": (value) => {
      value.proofs.pop();
    },
    "consent excludes second account": (value) => {
      value.proofs[1].subjectActorIds = ["101"];
    },
    "unbounded control": (value) => {
      value.proofs[0].expiresAt = null;
    },
    "caller-supplied permission": (value) => {
      value.authorized = true;
    },
  });
});

test("the whole proposal rejects inverse provider conflicts and changed provider kind", () => {
  rejects(proposalSchema, link(), {
    "node maps to two database IDs": (value) => {
      value.sourceActors[1].githubNodeId = value.sourceActors[0].githubNodeId;
    },
    "database maps to two node IDs": (value) => {
      value.resultActors[0].githubNodeId = "different-opaque-node";
    },
    "kind changes across role": (value) => {
      value.resultActors[0].providerKind = "bot";
    },
    "requester conflicts with affected actor": (value) => {
      value.requester.githubNodeId = "different-opaque-node";
    },
    "duplicate source": (value) => {
      value.sourceActors.push(identity(101));
    },
    "duplicate result": (value) => {
      value.resultActors.push(identity(102));
    },
  });
});

test("a merge moves only exact evidenced contributions to an existing target", () => {
  assert.deepEqual(proposalSchema.parse(merge()), merge());
  rejects(proposalSchema, merge(), {
    "empty scope": (value) => {
      value.assignments = [];
    },
    "duplicate assignment": (value) => {
      value.assignments.push(structuredClone(value.assignments[0]));
    },
    "multiple targets": (value) => {
      value.resultActors.push(identity(102));
    },
    "unused source": (value) => {
      value.sourceActors.push(identity(104));
    },
    "new merge target": (value) => {
      value.resultActors = [identity(104)];
    },
    "unknown source": (value) => {
      value.assignments[0].sourceActorId = "104";
    },
    "unknown target": (value) => {
      value.assignments[0].resultActorId = "104";
    },
    "unchanged assignment": (value) => {
      value.assignments[0].sourceActorId = "101";
    },
    "unbound source revision": (value) => {
      delete value.assignments[0].sourceRevision;
    },
    "unbound attribution": (value) => {
      delete value.assignments[0].sourceAttributionSha256;
    },
    "unknown original role": (value) => {
      value.assignments[0].role = "owner";
    },
    "missing contribution evidence": (value) => {
      value.assignments[0].evidenceIds = [];
    },
    "unknown evidence ID": (value) => {
      value.assignments[0].evidenceIds = ["missing"];
    },
    "account proof substituted": (value) => {
      value.assignments[0].evidenceIds = ["control"];
    },
    "evidence for different contribution": (value) => {
      value.proofs[2].contributionIds = ["other"];
    },
    "evidence omits original actor": (value) => {
      value.proofs[2].subjectActorIds = ["101"];
    },
    "evidence omits target actor": (value) => {
      value.proofs[2].subjectActorIds = ["102"];
    },
  });
});

test("a factual split can correct attribution without compelling the wrongly credited account's consent", () => {
  assert.deepEqual(proposalSchema.parse(split()), split());
  rejects(proposalSchema, split(), {
    "single result": (value) => {
      value.resultActors = [identity(101)];
    },
    "multiple original accounts": (value) => {
      value.sourceActors.push(identity(101));
    },
    "unused new result": (value) => {
      value.resultActors.push(identity(104));
    },
    "unverified voluntary split": (value) => {
      value.authorityBasis = "verified_account_control";
    },
  });
});

test("all evidence is bounded, scoped, unique and valid when the proposal is prepared", () => {
  rejects(proposalSchema, link(), {
    "duplicate receipt": (value) => {
      value.proofs[1].evidenceId = "control";
    },
    "unknown evidence subject": (value) => {
      value.proofs[0].subjectActorIds.push("104");
    },
    "duplicate evidence subject": (value) => {
      value.proofs[0].subjectActorIds.push("101");
    },
    "raw evidence payload": (value) => {
      value.proofs[0].email = "synthetic@example.invalid";
    },
    "wrong evidence kind": (value) => {
      value.proofs[0].kind = "email_match";
    },
    "account evidence claims attribution": (value) => {
      value.proofs[0].contributionIds.push("contribution-1");
    },
    "future evidence within same millisecond": (value) => {
      value.proofs[0].recordedAt = "2026-10-01T01:00:00.000000003Z";
    },
    "expired within same millisecond": (value) => {
      value.proofs[0].expiresAt = "2026-10-01T01:00:00.000000001Z";
    },
    "expiry equals preparation": (value) => {
      value.proofs[0].expiresAt = preparedAt;
    },
    "unknown policy": (value) => {
      value.policyVersion = "";
    },
    "unversioned revision": (value) => {
      value.revision = 0;
    },
  });
});

test("acceptance requires a separate reviewer, authority reference and current proof", () => {
  assert.deepEqual(decisionSchema.parse(decision()), decision());
  rejects(decisionSchema, decision(), {
    "requester reviews own proposal": (value) => {
      value.reviewer = identity(101);
    },
    "affected account reviews": (value) => {
      value.reviewer = identity(102);
    },
    "node-only self identity": (value) => {
      value.reviewer.githubNodeId = identity(101).githubNodeId;
    },
    "same actor different node": (value) => {
      value.reviewer = { ...identity(101), githubNodeId: "alternative-node" };
    },
    "missing authority": (value) => {
      delete value.authorizationReceiptId;
    },
    "missing rationale": (value) => {
      delete value.reasonReceiptId;
    },
    "missing exact proposal binding": (value) => {
      delete value.proposalSha256;
    },
    "review predates proposal fraction": (value) => {
      value.reviewedAt = "2026-10-01T01:00:00.000000001Z";
    },
    "expired at acceptance": (value) => {
      value.reviewedAt = "2026-10-02T00:00:00Z";
    },
    "duplicate earlier decision": (value) => {
      value.priorReviews = [
        { decisionId: "earlier", reviewer: identity(104) },
        { decisionId: "earlier", reviewer: identity(105) },
      ];
    },
    "self-referential history": (value) => {
      value.priorReviews = [{ decisionId: value.decisionId, reviewer: identity(104) }];
    },
  });
});

test("a reversal is a new independently reviewed decision and can withdraw expired evidence", () => {
  const value = decision();
  value.outcome = "reversed";
  value.reviewedAt = "2026-10-03T00:00:00Z";
  value.priorReviews = [{ decisionId: "original-acceptance", reviewer: identity(104) }];
  value.reversesDecisionId = "original-acceptance";
  assert.deepEqual(decisionSchema.parse(value), value);
  rejects(decisionSchema, value, {
    "missing target": (item) => {
      item.reversesDecisionId = null;
    },
    "unknown target": (item) => {
      item.reversesDecisionId = "not-in-history";
    },
    "previous reviewer": (item) => {
      item.reviewer = identity(104);
    },
    "older appeal reviewer": (item) => {
      item.priorReviews.push({ decisionId: "appeal", reviewer: identity(103) });
    },
    "non-reversal restores": (item) => {
      item.outcome = "rejected";
    },
  });
});

test("non-acceptance decisions are explicit and proposals and original source records remain unchanged", () => {
  const value = decision(split());
  const before = structuredClone(value);
  for (const outcome of ["accepted", "rejected", "needs_information"]) {
    assert.equal(decisionSchema.parse({ ...value, outcome }).outcome, outcome);
  }
  assert.deepEqual(value, before);
  assert.equal(decisionSchema.safeParse({ ...value, outcome: "pending" }).success, false);
  assert.equal(identityCorrectionSchema.safeParse(value).success, false);
  // The frozen v1 wire contract remains available; this proposal is never an implicit v1 migration.
  const legacy = {
    schemaVersion: "leaderboard/v1",
    correctionId: "legacy",
    kind: "merge",
    state: "pending",
    subjectActorIds: ["101", "102"],
    resultActorIds: ["101"],
    evidenceEventIds: [],
    reviewerActorId: null,
    reviewedAt: null,
    supersedesCorrectionId: null,
  };
  assert.deepEqual(identityCorrectionSchema.parse(legacy), legacy);
});
