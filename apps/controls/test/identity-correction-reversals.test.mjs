import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { encodeVerifiedIdentityCorrectionProposal } from "@pick-your-ai/contracts";
import { createVerifiedIdentityCorrectionConsumer } from "../src/identity-corrections.mjs";
import {
  createVerifiedIdentityCorrectionReversalConsumer,
  digestPrivateIdentityCorrectionApplication,
  privateIdentityApplicationBindingVersion,
} from "../src/identity-correction-reversals.mjs";
import { ControlStore } from "../src/store.mjs";

const originalAt = "2026-10-20T00:00:00.000000004Z";
const reversedAt = "2026-10-22T00:00:00.000000004Z";
const expires = "2026-10-24T00:00:00Z";
const id = (n) => ({
  actorId: String(n),
  githubDatabaseId: n,
  githubNodeId: "synthetic-node-" + n,
  providerKind: "user",
});
const proposalSha = (p) => createHash("sha256").update(encodeVerifiedIdentityCorrectionProposal(p)).digest("hex");
// Independent grant-side encoding. These inputs are already retained records,
// not values returned by the reversal consumer or its digest helper.
function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sorted(value[key])]),
    );
  return value;
}
const grantDigest = (target) =>
  createHash("sha256")
    .update("leaderboard-private-identity-application-binding/v1\n" + JSON.stringify(sorted(target)))
    .digest("hex");
function accepted(kind = "merge") {
  const p = {
    schemaVersion: "leaderboard-verified-identity-correction/v1",
    correctionId: "synthetic-correction",
    revision: 1,
    kind,
    authorityBasis: kind === "split" ? "reviewed_source_attribution" : "verified_account_control",
    requester: id(101),
    preparedAt: "2026-10-20T00:00:00.000000001Z",
    policyVersion: "synthetic-policy",
    sourceActors: kind === "split" ? [id(102)] : [id(101), id(102)],
    resultActors: kind === "merge" ? [id(101)] : [id(101), id(102)],
    assignments:
      kind === "link"
        ? []
        : [
            {
              contributionId: "synthetic-contribution",
              sourceEventId: "synthetic-event",
              sourceRevision: "synthetic-source",
              sourceAttributionSha256: "a".repeat(64),
              role: "coauthor",
              sourceActorId: "102",
              resultActorId: "101",
              evidenceIds: ["synthetic-attribution"],
            },
          ],
    proofs: [],
  };
  if (kind !== "split") {
    p.proofs.push(
      {
        evidenceId: "synthetic-control",
        kind: "account_control",
        subjectActorIds: ["101", "102"],
        contributionIds: [],
        recordedAt: "2026-10-19T00:00:00Z",
        expiresAt: "2026-10-21T00:00:00Z",
      },
      {
        evidenceId: "synthetic-consent",
        kind: "consent",
        subjectActorIds: ["101", "102"],
        contributionIds: [],
        recordedAt: "2026-10-19T00:00:00Z",
        expiresAt: null,
      },
    );
  }
  if (kind !== "link")
    p.proofs.push({
      evidenceId: "synthetic-attribution",
      kind: "source_attribution",
      subjectActorIds: ["101", "102"],
      contributionIds: ["synthetic-contribution"],
      recordedAt: "2026-10-19T00:00:00Z",
      expiresAt: null,
    });
  return {
    schemaVersion: p.schemaVersion,
    decisionId: "synthetic-accepted",
    proposal: p,
    proposalSha256: proposalSha(p),
    outcome: "accepted",
    reviewer: id(103),
    authorizationReceiptId: "synthetic-original-grant",
    reasonReceiptId: "synthetic-original-reason",
    reviewedAt: "2026-10-20T00:00:00.000000003Z",
    priorReviews: [],
    reversesDecisionId: null,
  };
}
function acceptedAuthority(d, priorDecisions = [], currentRevision = 0) {
  const p = d.proposal;
  const people = [
    ...new Map(
      [p.requester, ...p.sourceActors, ...p.resultActors, d.reviewer, ...priorDecisions.map((v) => v.reviewer)].map(
        (v) => [v.actorId, v],
      ),
    ).values(),
  ];
  const binding = ({ evidenceIds: _evidenceIds, ...rest }) => rest;
  const source = (a) => {
    const { resultActorId: _resultActorId, ...rest } = binding(a);
    return rest;
  };
  return {
    schemaVersion: "leaderboard-private-identity-authority/v1",
    revision: 1,
    validUntil: expires,
    decision: d,
    currentProposal: structuredClone(p),
    currentDecisionId: d.decisionId,
    priorDecisions,
    identities: people.map((identity) => ({ identity, expiresAt: expires, verified: true, revoked: false })),
    proofs: p.proofs.map((proof) => ({
      proof,
      attributions: p.assignments.filter((a) => proof.contributionIds.includes(a.contributionId)).map(binding),
      verified: true,
      revoked: false,
    })),
    sources: p.assignments.map((a) => ({ binding: source(a), verified: true, revoked: false })),
    authorization: {
      receiptId: d.authorizationReceiptId,
      scope: "private_identity_correction",
      decisionId: d.decisionId,
      proposalSha256: d.proposalSha256,
      reviewer: d.reviewer,
      policyVersion: p.policyVersion,
      kind: p.kind,
      attributionRevision: currentRevision,
      grantedAt: "2026-10-19T00:00:00Z",
      expiresAt: expires,
      revoked: false,
    },
    reason: {
      receiptId: d.reasonReceiptId,
      decisionId: d.decisionId,
      proposalSha256: d.proposalSha256,
      verified: true,
      revoked: false,
    },
  };
}
function retainedTarget(database, decisionId = "synthetic-accepted") {
  const r = database.prepare("SELECT * FROM identity_correction_receipts WHERE decision_id=?").get(decisionId);
  const o = database.prepare("SELECT * FROM identity_correction_overlays WHERE decision_id=?").get(decisionId);
  return {
    decision: JSON.parse(r.decision_document),
    authorization: JSON.parse(r.authorization_document),
    receipt: JSON.parse(r.document),
    overlay: JSON.parse(o.document),
  };
}
function reversalAuthority(
  target,
  prior = [target.decision],
  revision = 1,
  reviewer = 104,
  decisionId = "synthetic-reversal",
) {
  const d = {
    ...structuredClone(target.decision),
    decisionId,
    outcome: "reversed",
    reviewer: id(reviewer),
    authorizationReceiptId: decisionId + "-grant",
    reasonReceiptId: decisionId + "-reason",
    reviewedAt: "2026-10-22T00:00:00.000000003Z",
    priorReviews: prior.map((p) => ({ decisionId: p.decisionId, reviewer: p.reviewer })),
    reversesDecisionId: target.decision.decisionId,
  };
  const actors = [...new Set([...d.proposal.sourceActors, ...d.proposal.resultActors].map((v) => v.actorId))];
  return {
    schemaVersion: "leaderboard-private-identity-reversal-authority/v1",
    revision: 7,
    validUntil: expires,
    decision: d,
    currentDecisionId: decisionId,
    priorDecisions: structuredClone(prior),
    reviewer: { identity: d.reviewer, expiresAt: expires, verified: true, revoked: false },
    authorization: {
      receiptId: d.authorizationReceiptId,
      scope: "private_identity_cancellation",
      decisionId,
      reversesDecisionId: target.decision.decisionId,
      targetApplicationSha256: grantDigest(target),
      proposalSha256: d.proposalSha256,
      reviewer: d.reviewer,
      policyVersion: d.proposal.policyVersion,
      kind: d.proposal.kind,
      attributionRevision: revision,
      grantedAt: "2026-10-22T00:00:00.000000002Z",
      expiresAt: expires,
      revoked: false,
    },
    reason: {
      receiptId: d.reasonReceiptId,
      decisionId,
      proposalSha256: d.proposalSha256,
      verified: true,
      revoked: false,
    },
    observations: {
      actors: actors.map((actorId) => ({
        actorId,
        suppression: "clear",
        deletion: "retained",
        consent: d.proposal.authorityBasis === "reviewed_source_attribution" ? "not_applicable" : "current",
      })),
      sources: d.proposal.assignments.map((a) => ({ contributionId: a.contributionId, validity: "current" })),
    },
  };
}
function fixture(t, kind = "merge", options = {}) {
  const directory = mkdtempSync(join(tmpdir(), "synthetic-identity-reversal-"));
  const filename = join(directory, "private.sqlite");
  let store = new ControlStore(filename);
  let clock = originalAt;
  let calls = 0;
  store.db.exec(
    "CREATE TABLE protected_acceptances (id TEXT PRIMARY KEY, document TEXT NOT NULL); CREATE TABLE protected_reversals (id TEXT PRIMARY KEY, document TEXT NOT NULL); CREATE TABLE retained_original_sources (id TEXT PRIMARY KEY, document TEXT NOT NULL)",
  );
  const original = accepted(kind);
  const put = (table, a) =>
    store.db.prepare("INSERT OR REPLACE INTO " + table + " VALUES(?,?)").run(a.decision.decisionId, JSON.stringify(a));
  put("protected_acceptances", acceptedAuthority(original));
  for (const a of original.proposal.assignments)
    store.db.prepare("INSERT INTO retained_original_sources VALUES(?,?)").run(a.contributionId, JSON.stringify(a));
  store.transaction(
    (state) => {
      state.profiles["102"] = { public: true, suppressed: true, bio: "synthetic withheld profile", highlights: [] };
    },
    { publish: true },
  );
  const acceptedConsumer = () =>
    createVerifiedIdentityCorrectionConsumer({
      store,
      readAuthority({ database, decisionId }) {
        assert.equal(database, store.db);
        assert.equal(database.isTransaction, true);
        return JSON.parse(
          database.prepare("SELECT document FROM protected_acceptances WHERE id=?").get(decisionId)?.document ?? "null",
        );
      },
      now: () => clock,
    });
  let applications = acceptedConsumer();
  applications.apply(original.decisionId);
  const target = retainedTarget(store.db);
  const authority = reversalAuthority(target);
  put("protected_reversals", authority);
  clock = reversedAt;
  function read(context) {
    assert.equal(context.database, store.db);
    assert.equal(context.database.isTransaction, true);
    const value = JSON.parse(
      context.database.prepare("SELECT document FROM protected_reversals WHERE id=?").get(context.decisionId)
        ?.document ?? "null",
    );
    return options.read ? options.read(context, value, calls++) : (calls++, value);
  }
  const make = () =>
    createVerifiedIdentityCorrectionReversalConsumer({
      store,
      readAuthority: read,
      now: () => (options.clock ? options.clock(clock) : clock),
    });
  let consumer = make();
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const snapshot = () => ({
    state: store.read(),
    publication: store.publicSnapshot(),
    revision: store.db.prepare("SELECT * FROM identity_correction_revision").all(),
    overlays: store.db.prepare("SELECT * FROM identity_correction_overlays ORDER BY decision_id").all(),
    receipts: store.db.prepare("SELECT * FROM identity_correction_receipts ORDER BY decision_id").all(),
    cancellations: store.db
      .prepare("SELECT * FROM identity_correction_cancellations ORDER BY target_decision_id")
      .all(),
    sources: store.db.prepare("SELECT * FROM retained_original_sources ORDER BY id").all(),
  });
  return {
    get store() {
      return store;
    },
    get consumer() {
      return consumer;
    },
    get applications() {
      return applications;
    },
    get calls() {
      return calls;
    },
    filename,
    original,
    target,
    authority,
    put(a) {
      put("protected_reversals", a);
    },
    putAccepted(a) {
      put("protected_acceptances", a);
    },
    setClock(value) {
      clock = value;
    },
    snapshot,
    reopen() {
      store.close();
      store = new ControlStore(filename);
      applications = acceptedConsumer();
      consumer = make();
    },
  };
}

for (const kind of ["link", "merge", "split"]) {
  test(
    "private " +
      kind +
      " cancellation retains original history, records restrictive state and changes no public source",
    (t) => {
      const h = fixture(t, kind);
      const before = h.snapshot();
      const receipt = h.consumer.reverse(h.authority.decision.decisionId);
      const after = h.snapshot();
      assert.equal(h.calls, 2);
      assert.equal(receipt.beforeRevision, 1);
      assert.equal(receipt.afterRevision, 2);
      assert.equal(receipt.outcome, "cancelled_private");
      assert.equal(receipt.restoration, "withheld");
      assert.deepEqual(after.overlays, before.overlays);
      assert.deepEqual(after.sources, before.sources);
      assert.deepEqual(after.state, before.state);
      assert.deepEqual(after.publication, before.publication);
      assert.deepEqual(
        after.receipts.find((r) => r.decision_id === h.original.decisionId),
        before.receipts[0],
      );
      assert.equal(after.receipts.length, 2);
      assert.equal(after.cancellations.length, 1);
      const cancellation = JSON.parse(after.cancellations[0].document);
      assert.equal(cancellation.reversesDecisionId, h.original.decisionId);
      assert.equal(cancellation.restoration, "withheld");
      assert.deepEqual(cancellation.observations, h.authority.observations);
      assert.equal(cancellation.observedAt, reversedAt);
    },
  );
}

test("the whole target has a separate deterministic grant digest without changing proposal digest semantics", (t) => {
  const h = fixture(t);
  assert.equal(privateIdentityApplicationBindingVersion, "leaderboard-private-identity-application-binding/v1");
  assert.equal(digestPrivateIdentityCorrectionApplication(h.target), grantDigest(h.target));
  assert.notEqual(grantDigest(h.target), h.original.proposalSha256);
  const reordered = Object.fromEntries(Object.entries(h.target).reverse());
  reordered.decision = Object.fromEntries(Object.entries(reordered.decision).reverse());
  assert.equal(digestPrivateIdentityCorrectionApplication(reordered), grantDigest(h.target));
  const before = h.snapshot();
  const changed = structuredClone(h.authority);
  changed.authorization.targetApplicationSha256 = h.original.proposalSha256;
  h.put(changed);
  assert.throws(() => h.consumer.reverse(changed.decision.decisionId), /authorization mismatch/);
  assert.deepEqual(h.snapshot(), before);
});

for (const [field, values] of [
  ["suppression", ["suppressed", "unavailable"]],
  ["deletion", ["deleted", "unavailable"]],
  ["consent", ["withdrawn", "expired", "unavailable"]],
]) {
  for (const value of values)
    test(
      "current actor " + field + "=" + value + " permits only cancellation despite expired historical control",
      (t) => {
        const h = fixture(t);
        h.authority.observations.actors[0][field] = value;
        h.put(h.authority);
        const old = acceptedAuthority(h.original);
        old.authorization.revoked = true;
        old.proofs[0].revoked = true;
        old.identities[0].revoked = true;
        h.putAccepted(old);
        const before = h.snapshot();
        const receipt = h.consumer.reverse(h.authority.decision.decisionId);
        assert.equal(receipt.restoration, "withheld");
        assert.deepEqual(receipt.observations, h.authority.observations);
        assert.deepEqual(h.snapshot().overlays, before.overlays);
        assert.deepEqual(h.snapshot().publication, before.publication);
      },
    );
}
for (const validity of ["changed", "revoked", "deleted", "unavailable"]) {
  test("current source " + validity + " cannot prevent restrictive cancellation or restore old credit", (t) => {
    const h = fixture(t);
    h.authority.observations.sources[0].validity = validity;
    h.put(h.authority);
    const before = h.snapshot();
    assert.equal(h.consumer.reverse(h.authority.decision.decisionId).restoration, "withheld");
    assert.deepEqual(h.snapshot().sources, before.sources);
    assert.deepEqual(h.snapshot().publication, before.publication);
  });
}

const invalid = {
  "revoked current reviewer": (a) => {
    a.reviewer.revoked = true;
  },
  "unverified current reviewer": (a) => {
    a.reviewer.verified = false;
  },
  "expired current reviewer": (a) => {
    a.reviewer.expiresAt = reversedAt;
  },
  "wrong current reviewer": (a) => {
    a.reviewer.identity = id(999);
  },
  "revoked new grant": (a) => {
    a.authorization.revoked = true;
  },
  "expired new grant": (a) => {
    a.authorization.expiresAt = reversedAt;
  },
  "old application purpose": (a) => {
    a.authorization.scope = "private_identity_correction";
  },
  "wrong target grant": (a) => {
    a.authorization.reversesDecisionId = "another-acceptance";
  },
  "stale private revision": (a) => {
    a.authorization.attributionRevision = 0;
  },
  "post-review grant": (a) => {
    a.authorization.grantedAt = reversedAt;
  },
  "grant before target application": (a) => {
    a.authorization.grantedAt = "2026-10-19T00:00:00Z";
  },
  "review before target materialization": (a) => {
    a.authorization.grantedAt = "2026-10-20T00:00:00.0000000031Z";
    a.decision.reviewedAt = "2026-10-20T00:00:00.0000000032Z";
  },
  "revoked reason": (a) => {
    a.reason.revoked = true;
  },
  "wrong reason": (a) => {
    a.reason.decisionId = "another-reversal";
  },
  "stale current decision": (a) => {
    a.currentDecisionId = "later-decision";
  },
  "future decision": (a) => {
    a.decision.reviewedAt = expires;
  },
  "expired snapshot": (a) => {
    a.validUntil = reversedAt;
  },
  "missing actor observation": (a) => {
    a.observations.actors.pop();
  },
  "duplicate actor observation": (a) => {
    a.observations.actors.push(a.observations.actors[0]);
  },
  "foreign actor observation": (a) => {
    a.observations.actors[0].actorId = "999";
  },
  "missing source observation": (a) => {
    a.observations.sources = [];
  },
  "duplicate source observation": (a) => {
    a.observations.sources.push(a.observations.sources[0]);
  },
  "foreign source observation": (a) => {
    a.observations.sources[0].contributionId = "another-source";
  },
  "hidden scoped consent": (a) => {
    a.observations.actors[0].consent = "not_applicable";
  },
  "missing state is not clear": (a) => {
    delete a.observations.actors[0].suppression;
  },
  "unknown observation field": (a) => {
    a.observations.actors[0].publicSafe = true;
  },
  "omitted accepted target": (a) => {
    a.priorDecisions = [];
  },
  "changed retained target": (a) => {
    a.priorDecisions[0].reasonReceiptId = "changed-reason";
  },
  "changed historical proposal": (a) => {
    a.decision.proposal.policyVersion = "new-policy";
    a.decision.proposalSha256 = proposalSha(a.decision.proposal);
  },
  "same previous reviewer": (a) => {
    a.decision.reviewer = id(103);
    a.reviewer.identity = id(103);
    a.authorization.reviewer = id(103);
  },
};
for (const [name, mutate] of Object.entries(invalid)) {
  test("private cancellation rejects " + name + " atomically", (t) => {
    const h = fixture(t);
    mutate(h.authority);
    h.put(h.authority);
    const before = h.snapshot();
    assert.throws(() => h.consumer.reverse(h.authority.decision.decisionId));
    assert.deepEqual(h.snapshot(), before);
  });
}

test("exact retry survives reopen and later unrelated revision while retaining original observations", (t) => {
  const h = fixture(t);
  const receipt = h.consumer.reverse(h.authority.decision.decisionId);
  const original = structuredClone(receipt);
  receipt.observations.actors[0].suppression = "unavailable";
  receipt.afterRevision = 900;
  h.reopen();
  h.authority.revision++;
  h.authority.observations.actors[0].suppression = "suppressed";
  h.authority.observations.sources[0].validity = "deleted";
  h.put(h.authority);
  const other = accepted("link");
  other.decisionId = "synthetic-other-acceptance";
  other.proposal.correctionId = "synthetic-other-lineage";
  other.proposal.proofs[0].expiresAt = expires;
  other.proposalSha256 = proposalSha(other.proposal);
  other.reviewedAt = reversedAt;
  h.putAccepted(acceptedAuthority(other, [], 2));
  assert.equal(h.applications.apply(other.decisionId).afterRevision, 3);
  const before = h.snapshot();
  assert.deepEqual(h.consumer.reverse(h.authority.decision.decisionId), original);
  assert.deepEqual(h.snapshot(), before);
});

test("a different reversal cannot cancel the same accepted application twice", (t) => {
  const h = fixture(t);
  h.consumer.reverse(h.authority.decision.decisionId);
  const second = reversalAuthority(h.target, [h.original, h.authority.decision], 2, 105, "synthetic-second-reversal");
  second.decision.reviewedAt = reversedAt;
  h.put(second);
  const before = h.snapshot();
  assert.throws(() => h.consumer.reverse(second.decision.decisionId), /already cancelled/);
  assert.deepEqual(h.snapshot(), before);
});

for (const includeReversal of [false, true]) {
  test(
    "a later accepted proposal " +
      (includeReversal ? "cannot reuse a cancelled original attribution" : "cannot omit the local reversal history"),
    (t) => {
      const h = fixture(t);
      h.consumer.reverse(h.authority.decision.decisionId);
      const next = accepted();
      next.decisionId = "synthetic-later-acceptance";
      next.reviewer = id(105);
      next.reviewedAt = reversedAt;
      next.proposal.revision = 2;
      next.proposal.proofs[0].expiresAt = expires;
      next.proposalSha256 = proposalSha(next.proposal);
      const prior = includeReversal ? [h.original, h.authority.decision] : [h.original];
      next.priorReviews = prior.map((p) => ({ decisionId: p.decisionId, reviewer: p.reviewer }));
      h.putAccepted(acceptedAuthority(next, prior, 2));
      const before = h.snapshot();
      assert.throws(
        () => h.applications.apply(next.decisionId),
        includeReversal ? /already been superseded/ : /absent or changed in retained history/,
      );
      assert.deepEqual(h.snapshot(), before);
    },
  );
}

for (const fault of [
  "missing-overlay",
  "shifted-revisions",
  "wrong-overlay",
  "future-application",
  "zero-authority",
  "wrong-original-grant",
  "at-original-grant-expiry",
  "at-retained-proof-expiry",
  "before-original-review",
]) {
  test("corrupt accepted target " + fault + " cannot be cancelled", (t) => {
    const h = fixture(t);
    if (fault === "missing-overlay") h.store.db.exec("DELETE FROM identity_correction_overlays");
    else {
      const target = retainedTarget(h.store.db);
      if (fault === "shifted-revisions") {
        target.receipt.beforeRevision = 1;
        target.receipt.afterRevision = 2;
        target.overlay.attributionRevision = 2;
        h.store.db.exec("UPDATE identity_correction_revision SET revision=2");
      }
      if (fault === "wrong-overlay") target.overlay.assignments[0].resultActorId = "999";
      if (fault === "future-application") target.receipt.appliedAt = expires;
      if (fault === "zero-authority") target.receipt.authorityRevision = 0;
      if (fault === "wrong-original-grant") target.authorization.attributionRevision = 1;
      if (fault === "at-original-grant-expiry") target.authorization.expiresAt = originalAt;
      if (fault === "at-retained-proof-expiry") target.receipt.appliedAt = "2026-10-21T00:00:00Z";
      if (fault === "before-original-review") target.receipt.appliedAt = "2026-10-20T00:00:00.000000002Z";
      h.store.db
        .prepare("UPDATE identity_correction_receipts SET document=?,authorization_document=? WHERE decision_id=?")
        .run(JSON.stringify(target.receipt), JSON.stringify(target.authorization), h.original.decisionId);
      h.store.db
        .prepare("UPDATE identity_correction_overlays SET attribution_revision=?,document=?")
        .run(target.overlay.attributionRevision, JSON.stringify(target.overlay));
      // Even a newly bound cancellation grant cannot make an impossible
      // historical application admissible. This bypasses the stale-digest
      // rejection so the retained target's own invariants must reject it.
      h.authority.authorization.targetApplicationSha256 = grantDigest(target);
      h.put(h.authority);
    }
    const before = h.snapshot();
    assert.throws(() => h.consumer.reverse(h.authority.decision.decisionId));
    assert.deepEqual(h.snapshot(), before);
  });
}

for (const fault of [
  "missing-state",
  "wrong-state",
  "shifted-revisions",
  "before-review",
  "future-application",
  "missing-observation",
  "zero-authority",
  "changed-authorization",
]) {
  test("exact retry rejects retained cancellation " + fault + " without repairing or rewriting history", (t) => {
    const h = fixture(t);
    h.consumer.reverse(h.authority.decision.decisionId);
    if (fault === "missing-state") h.store.db.exec("DELETE FROM identity_correction_cancellations");
    else {
      const row = h.store.db
        .prepare("SELECT * FROM identity_correction_receipts WHERE decision_id=?")
        .get(h.authority.decision.decisionId);
      const receipt = JSON.parse(row.document);
      const authorization = JSON.parse(row.authorization_document);
      const state = JSON.parse(
        h.store.db.prepare("SELECT document FROM identity_correction_cancellations").get().document,
      );
      if (fault === "wrong-state") state.restoration = "restored";
      if (fault === "shifted-revisions") {
        receipt.beforeRevision = 2;
        receipt.afterRevision = 3;
        state.attributionRevision = 3;
        h.store.db.exec("UPDATE identity_correction_revision SET revision=3");
      }
      if (fault === "before-review") receipt.appliedAt = originalAt;
      if (fault === "future-application") receipt.appliedAt = expires;
      if (fault === "missing-observation") receipt.observations.sources = [];
      if (fault === "zero-authority") receipt.authorityRevision = 0;
      if (fault === "changed-authorization") authorization.attributionRevision = 0;
      h.store.db
        .prepare("UPDATE identity_correction_receipts SET document=?,authorization_document=? WHERE decision_id=?")
        .run(JSON.stringify(receipt), JSON.stringify(authorization), h.authority.decision.decisionId);
      h.store.db
        .prepare("UPDATE identity_correction_cancellations SET attribution_revision=?,document=?")
        .run(state.attributionRevision, JSON.stringify(state));
    }
    const before = h.snapshot();
    assert.throws(() => h.consumer.reverse(h.authority.decision.decisionId));
    assert.deepEqual(h.snapshot(), before);
  });
}

test("an exact retry still rejects a newly revoked cancellation grant", (t) => {
  const h = fixture(t);
  h.consumer.reverse(h.authority.decision.decisionId);
  h.authority.authorization.revoked = true;
  h.put(h.authority);
  const before = h.snapshot();
  assert.throws(() => h.consumer.reverse(h.authority.decision.decisionId));
  assert.deepEqual(h.snapshot(), before);
});

test("private revision exhaustion cannot wrap or partly append a cancellation", (t) => {
  const h = fixture(t);
  h.store.db.prepare("UPDATE identity_correction_revision SET revision=?").run(Number.MAX_SAFE_INTEGER);
  h.authority.authorization.attributionRevision = Number.MAX_SAFE_INTEGER;
  h.put(h.authority);
  const before = h.snapshot();
  assert.throws(() => h.consumer.reverse(h.authority.decision.decisionId), /Attribution changed/);
  assert.deepEqual(h.snapshot(), before);
});

for (const stage of ["cancellation", "receipt", "revision", "commit"]) {
  test("SQLite " + stage + " failure rolls back all cancellation writes and permits a clean retry", (t) => {
    const h = fixture(t);
    const before = h.snapshot();
    if (stage === "commit") {
      h.store.db.exec(
        "PRAGMA foreign_keys=ON; CREATE TABLE synthetic_parent(id INTEGER PRIMARY KEY); CREATE TABLE synthetic_child(id INTEGER REFERENCES synthetic_parent DEFERRABLE INITIALLY DEFERRED); CREATE TRIGGER synthetic_failure AFTER INSERT ON identity_correction_cancellations BEGIN INSERT INTO synthetic_child VALUES(1); END",
      );
    } else {
      const table = {
        cancellation: "identity_correction_cancellations",
        receipt: "identity_correction_receipts",
        revision: "identity_correction_revision",
      }[stage];
      h.store.db.exec(
        "CREATE TRIGGER synthetic_failure BEFORE " +
          (stage === "revision" ? "UPDATE" : "INSERT") +
          " ON " +
          table +
          " BEGIN SELECT RAISE(ABORT,'synthetic cancellation failure'); END",
      );
    }
    assert.throws(
      () => h.consumer.reverse(h.authority.decision.decisionId),
      /synthetic cancellation failure|FOREIGN KEY constraint failed/,
    );
    assert.deepEqual(h.snapshot(), before);
    assert.equal(h.store.db.isTransaction, false);
    h.store.db.exec("DROP TRIGGER synthetic_failure");
    assert.equal(h.consumer.reverse(h.authority.decision.decisionId).afterRevision, 2);
  });
}

for (const phase of [0, 1]) {
  test("throwing authority read " + phase + " cannot leave a partial cancellation", (t) => {
    const failure = new Error("synthetic reader failure");
    const h = fixture(t, "merge", {
      read(_context, value, count) {
        if (count === phase) throw failure;
        return value;
      },
    });
    const before = h.snapshot();
    assert.throws(
      () => h.consumer.reverse(h.authority.decision.decisionId),
      (error) => error === failure,
    );
    assert.deepEqual(h.snapshot(), before);
  });
}
test("final same-database authority replacement rolls back cancellation", (t) => {
  const h = fixture(t, "merge", {
    read(_context, value, count) {
      if (count === 1) value.authorization.revoked = true;
      return value;
    },
  });
  const before = h.snapshot();
  assert.throws(() => h.consumer.reverse(h.authority.decision.decisionId));
  assert.deepEqual(h.snapshot(), before);
});
test("authority expiring while the final protected reader runs cannot commit a cancellation", (t) => {
  const h = fixture(t, "merge", {
    read(_context, value, count) {
      if (count === 1) h.setClock(expires);
      return value;
    },
  });
  const before = h.snapshot();
  assert.throws(() => h.consumer.reverse(h.authority.decision.decisionId), /expired/);
  assert.equal(h.calls, 2);
  assert.deepEqual(h.snapshot(), before);
});
for (const retry of [false, true]) {
  for (const field of ["observations", "authorityRevision"]) {
    test(
      "coherent final " + field + " replacement during " + (retry ? "retry" : "first cancellation") + " rolls back",
      (t) => {
        const h = fixture(t, "merge", {
          read({ database, decisionId }, value, count) {
            if (count === (retry ? 3 : 1)) {
              const receipt = JSON.parse(
                database
                  .prepare("SELECT document FROM identity_correction_receipts WHERE decision_id=?")
                  .get(decisionId).document,
              );
              const state = JSON.parse(
                database
                  .prepare("SELECT document FROM identity_correction_cancellations WHERE decision_id=?")
                  .get(decisionId).document,
              );
              if (field === "observations") {
                receipt.observations.actors[0].suppression = "unavailable";
                state.observations = structuredClone(receipt.observations);
              } else {
                receipt.authorityRevision++;
                state.authorityRevision = receipt.authorityRevision;
              }
              database
                .prepare("UPDATE identity_correction_receipts SET document=? WHERE decision_id=?")
                .run(JSON.stringify(receipt), decisionId);
              database
                .prepare("UPDATE identity_correction_cancellations SET document=? WHERE decision_id=?")
                .run(JSON.stringify(state), decisionId);
            }
            return value;
          },
        });
        const original = retry ? h.consumer.reverse(h.authority.decision.decisionId) : null;
        const before = h.snapshot();
        assert.throws(
          () => h.consumer.reverse(h.authority.decision.decisionId),
          /Retained cancellation changed before commit/,
        );
        assert.deepEqual(h.snapshot(), before);
        if (retry)
          assert.deepEqual(
            JSON.parse(before.receipts.find((r) => r.decision_id === h.authority.decision.decisionId).document),
            original,
          );
      },
    );
  }
}
for (const changed of ["target", "revision"]) {
  test("final reader mutation of " + changed + " rolls back the complete private transaction", (t) => {
    const h = fixture(t, "merge", {
      read({ database }, value, count) {
        if (count === 1)
          database.exec(
            changed === "target"
              ? "DELETE FROM identity_correction_overlays"
              : "UPDATE identity_correction_revision SET revision=revision+1",
          );
        return value;
      },
    });
    const before = h.snapshot();
    assert.throws(() => h.consumer.reverse(h.authority.decision.decisionId));
    assert.deepEqual(h.snapshot(), before);
  });
}
for (const value of ["2026-10-24T00:00:00Z", originalAt]) {
  test("final clock " + value + " cannot commit stale or reversed time", (t) => {
    let calls = 0;
    const h = fixture(t, "merge", {
      clock(current) {
        return calls++ === 0 ? current : value;
      },
    });
    const before = h.snapshot();
    assert.throws(() => h.consumer.reverse(h.authority.decision.decisionId), /expired|backwards/);
    assert.deepEqual(h.snapshot(), before);
  });
}
test("an independent SQLite connection cannot replace reversal authority under the write lock", (t) => {
  let other;
  const h = fixture(t, "merge", {
    read(context, value) {
      other ??= new DatabaseSync(h.filename);
      other.exec("PRAGMA busy_timeout=0");
      assert.throws(() => other.prepare("UPDATE protected_reversals SET document='null'").run(), /database is locked/);
      assert.equal(context.database.isTransaction, true);
      return value;
    },
  });
  t.after(() => other?.close());
  assert.equal(h.consumer.reverse(h.authority.decision.decisionId).afterRevision, 2);
});

for (const where of ["reader", "clock"]) {
  for (const phase of [0, 1])
    for (const mode of ["fulfilled", "rejected", "foreign-thenable", "thrown-rejected"]) {
      test(
        where + " phase " + phase + " cannot supply " + mode + " to escape the synchronous private boundary",
        async (t) => {
          let thenCalls = 0;
          const unhandled = [];
          const listener = (error) => unhandled.push(error);
          process.on("unhandledRejection", listener);
          t.after(() => process.removeListener("unhandledRejection", listener));
          const bad = () => {
            if (mode === "thrown-rejected") throw Promise.reject(new Error("synthetic thrown rejection"));
            return mode === "fulfilled"
              ? Promise.resolve(null)
              : mode === "rejected"
                ? Promise.reject(new Error("synthetic rejected callback"))
                : {
                    then() {
                      thenCalls++;
                    },
                  };
          };
          let calls = 0;
          const h = fixture(
            t,
            "merge",
            where === "reader"
              ? {
                  read(_context, value) {
                    return calls++ === phase ? bad() : value;
                  },
                }
              : {
                  clock(value) {
                    return calls++ === phase ? bad() : value;
                  },
                },
          );
          const before = h.snapshot();
          assert.throws(() => h.consumer.reverse(h.authority.decision.decisionId));
          await new Promise(setImmediate);
          assert.deepEqual(unhandled, []);
          assert.equal(thenCalls, 0);
          assert.deepEqual(h.snapshot(), before);
        },
      );
    }
}
test("request inputs cannot replace configured reversal authority", (t) => {
  const h = fixture(t);
  const before = h.snapshot();
  for (const value of [h.authority, "", "../private", 123, undefined])
    assert.throws(() => h.consumer.reverse(value), /exact reversal decision ID/);
  assert.throws(() => h.consumer.reverse(h.authority.decision.decisionId, h.authority), /exact reversal decision ID/);
  assert.deepEqual(h.snapshot(), before);
});
test("cancellation configuration requires initialized private acceptance storage and never installs a public route", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "synthetic-uninitialized-reversal-"));
  const store = new ControlStore(join(directory, "private.sqlite"));
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  assert.throws(
    () => createVerifiedIdentityCorrectionReversalConsumer({ store, readAuthority: () => null }),
    /Initialize the private accepted-decision store/,
  );
  assert.deepEqual(
    store.db.prepare("SELECT name FROM sqlite_schema WHERE name LIKE 'identity_correction_%'").all(),
    [],
  );
});
