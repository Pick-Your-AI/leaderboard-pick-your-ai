import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  digestVerifiedIdentityCorrectionProposal,
  encodeVerifiedIdentityCorrectionProposal,
  verifiedIdentityCorrectionVersion,
} from "@pick-your-ai/contracts";
import { createVerifiedIdentityCorrectionConsumer } from "../src/identity-corrections.mjs";
import { ControlStore, projectPublic } from "../src/store.mjs";

const at = "2026-10-20T00:00:00.000000004Z";
const until = "2026-10-21T00:00:00Z";
const identity = (id) => ({
  actorId: String(id),
  githubDatabaseId: id,
  githubNodeId: `synthetic-node-${id}`,
  providerKind: "user",
});
const sha = (proposal) => createHash("sha256").update(encodeVerifiedIdentityCorrectionProposal(proposal)).digest("hex");
const proof = (evidenceId, kind, subjectActorIds, contributionIds = []) => ({
  evidenceId,
  kind,
  subjectActorIds,
  contributionIds,
  recordedAt: "2026-10-19T00:00:00Z",
  expiresAt: kind === "account_control" ? until : null,
});
function proposal(kind = "merge") {
  const value = {
    schemaVersion: verifiedIdentityCorrectionVersion,
    correctionId: "synthetic-correction-1",
    revision: 1,
    kind,
    authorityBasis: "verified_account_control",
    requester: identity(101),
    preparedAt: "2026-10-20T00:00:00.000000001Z",
    policyVersion: "synthetic-policy-v1",
    sourceActors: [identity(101), identity(102)],
    resultActors: kind === "link" ? [identity(101), identity(102)] : [identity(101)],
    assignments:
      kind === "link"
        ? []
        : [
            {
              contributionId: "synthetic-contribution-1",
              sourceEventId: "synthetic-event-1",
              sourceRevision: "synthetic-source-revision-1",
              sourceAttributionSha256: "a".repeat(64),
              role: "coauthor",
              sourceActorId: "102",
              resultActorId: "101",
              evidenceIds: ["synthetic-attribution-1"],
            },
          ],
    proofs: [
      proof("synthetic-control", "account_control", ["101", "102"]),
      proof("synthetic-consent", "consent", ["101", "102"]),
    ],
  };
  if (kind !== "link")
    value.proofs.push(
      proof("synthetic-attribution-1", "source_attribution", ["101", "102"], ["synthetic-contribution-1"]),
    );
  if (kind === "split") {
    value.authorityBasis = "reviewed_source_attribution";
    value.sourceActors = [identity(102)];
    value.resultActors = [identity(102), identity(101)];
    value.proofs = value.proofs.filter((item) => item.kind === "source_attribution");
  }
  return value;
}
function decision(value = proposal()) {
  return {
    schemaVersion: verifiedIdentityCorrectionVersion,
    decisionId: "synthetic-decision-1",
    proposal: value,
    proposalSha256: sha(value),
    outcome: "accepted",
    reviewer: identity(103),
    authorizationReceiptId: "synthetic-authorization-1",
    reasonReceiptId: "synthetic-reason-1",
    reviewedAt: "2026-10-20T00:00:00.000000003Z",
    priorReviews: [],
    reversesDecisionId: null,
  };
}
const assignmentBinding = ({ evidenceIds: _ids, ...rest }) => rest;
const sourceBinding = (value) => {
  const { resultActorId: _id, ...rest } = assignmentBinding(value);
  return rest;
};
function authority(record = decision(), priorDecisions = []) {
  const p = record.proposal;
  const identities = new Map(
    [
      p.requester,
      ...p.sourceActors,
      ...p.resultActors,
      record.reviewer,
      ...priorDecisions.map((item) => item.reviewer),
    ].map((item) => [item.actorId, item]),
  );
  return {
    schemaVersion: "leaderboard-private-identity-authority/v1",
    revision: 1,
    validUntil: until,
    decision: record,
    currentProposal: structuredClone(p),
    currentDecisionId: record.decisionId,
    priorDecisions,
    identities: [...identities.values()].map((value) => ({
      identity: value,
      expiresAt: until,
      verified: true,
      revoked: false,
    })),
    proofs: p.proofs.map((item) => ({
      proof: item,
      attributions: p.assignments.filter((a) => item.contributionIds.includes(a.contributionId)).map(assignmentBinding),
      verified: true,
      revoked: false,
    })),
    sources: p.assignments.map((item) => ({ binding: sourceBinding(item), verified: true, revoked: false })),
    authorization: {
      receiptId: record.authorizationReceiptId,
      scope: "private_identity_correction",
      decisionId: record.decisionId,
      proposalSha256: record.proposalSha256,
      reviewer: record.reviewer,
      policyVersion: p.policyVersion,
      kind: p.kind,
      attributionRevision: 0,
      grantedAt: "2026-10-19T00:00:00Z",
      expiresAt: until,
      revoked: false,
    },
    reason: {
      receiptId: record.reasonReceiptId,
      decisionId: record.decisionId,
      proposalSha256: record.proposalSha256,
      verified: true,
      revoked: false,
    },
  };
}
function fixture(t, value = authority(), options = {}) {
  const directory = mkdtempSync(join(tmpdir(), "synthetic-identity-correction-"));
  const filename = join(directory, "private.sqlite");
  let store = new ControlStore(filename);
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  store.db.exec(
    "CREATE TABLE protected_identity_authority (decision_id TEXT PRIMARY KEY, document TEXT NOT NULL); CREATE TABLE original_identity_sources (id TEXT PRIMARY KEY, document TEXT NOT NULL);",
  );
  function put(next) {
    store.db
      .prepare("INSERT OR REPLACE INTO protected_identity_authority VALUES(?,?)")
      .run(next.decision.decisionId, JSON.stringify(next));
  }
  put(value);
  for (const source of value.sources)
    store.db
      .prepare("INSERT INTO original_identity_sources VALUES(?,?)")
      .run(source.binding.contributionId, JSON.stringify(source));
  let reads = 0;
  function read({ database, decisionId }) {
    assert.equal(database, store.db);
    assert.equal(database.isTransaction, true, "The authority read belongs to BEGIN IMMEDIATE");
    reads++;
    return JSON.parse(
      database.prepare("SELECT document FROM protected_identity_authority WHERE decision_id=?").get(decisionId)
        ?.document ?? "null",
    );
  }
  let clock = at;
  const make = () =>
    createVerifiedIdentityCorrectionConsumer({
      store,
      readAuthority: options.readAuthority ? (context) => options.readAuthority(context, read, reads) : read,
      now: () => clock,
    });
  let consumer = make();
  return {
    get store() {
      return store;
    },
    get consumer() {
      return consumer;
    },
    get reads() {
      return reads;
    },
    filename,
    put,
    setClock(value) {
      clock = value;
    },
    snapshot() {
      return {
        state: store.read(),
        publication: store.publicSnapshot(),
        revision: store.db.prepare("SELECT * FROM identity_correction_revision").all(),
        overlays: store.db.prepare("SELECT * FROM identity_correction_overlays ORDER BY decision_id").all(),
        receipts: store.db.prepare("SELECT * FROM identity_correction_receipts ORDER BY decision_id").all(),
        sources: store.db.prepare("SELECT * FROM original_identity_sources ORDER BY id").all(),
      };
    },
    reopen() {
      store.close();
      store = new ControlStore(filename);
      consumer = make();
    },
  };
}

for (const kind of ["link", "merge", "split"]) {
  test(`private ${kind} appends the exact bounded overlay and receipt without changing original/public state`, async (t) => {
    const a = authority(decision(proposal(kind)));
    assert.equal(a.decision.proposalSha256, await digestVerifiedIdentityCorrectionProposal(a.decision.proposal));
    const h = fixture(t, a);
    h.store.transaction(
      (state) => {
        state.profiles["102"] = { public: true, suppressed: true, bio: "synthetic private choice", highlights: [] };
      },
      { publish: true },
    );
    const before = h.snapshot();
    const receipt = h.consumer.apply(a.decision.decisionId);
    const after = h.snapshot();
    assert.equal(h.reads, 2);
    assert.equal(receipt.beforeRevision, 0);
    assert.equal(receipt.afterRevision, 1);
    assert.equal(receipt.outcome, "applied_private");
    assert.equal(receipt.proposalSha256, a.decision.proposalSha256);
    assert.equal(receipt.appliedAt, at);
    assert.deepEqual(after.sources, before.sources);
    assert.deepEqual(after.state, before.state);
    assert.deepEqual(after.publication, before.publication);
    assert.deepEqual(projectPublic(after.state), before.publication);
    assert.equal(after.overlays.length, 1);
    assert.equal(after.receipts.length, 1);
    const overlay = JSON.parse(after.overlays[0].document);
    assert.equal(overlay.kind, kind);
    assert.equal(overlay.attributionRevision, 1);
    assert.deepEqual(overlay.sourceActors, a.decision.proposal.sourceActors);
    assert.deepEqual(overlay.resultActors, a.decision.proposal.resultActors);
    assert.deepEqual(overlay.assignments, a.decision.proposal.assignments);
    assert.deepEqual(JSON.parse(after.receipts[0].decision_document), a.decision);
    assert.deepEqual(JSON.parse(after.receipts[0].authorization_document), a.authorization);
    assert.deepEqual(JSON.parse(after.receipts[0].document), receipt);
  });
}

test("exact retries survive reopen, caller mutation, later unrelated attribution and reordered input keys", (t) => {
  const a = authority();
  const h = fixture(t, a);
  const returned = h.consumer.apply(a.decision.decisionId);
  const first = structuredClone(returned);
  returned.afterRevision = 400;
  returned.decisionId = "mutated-response";
  const reordered = Object.fromEntries(Object.entries(a.decision).reverse());
  h.put({ ...a, decision: reordered });
  assert.deepEqual(h.consumer.apply(a.decision.decisionId), first);
  h.reopen();
  assert.deepEqual(h.consumer.apply(a.decision.decisionId), first);
  const unrelated = proposal("link");
  unrelated.correctionId = "synthetic-independent-correction";
  const other = authority(decision(unrelated));
  other.decision.decisionId = "synthetic-decision-2";
  other.currentDecisionId = other.decision.decisionId;
  other.authorization.decisionId = other.decision.decisionId;
  other.reason.decisionId = other.decision.decisionId;
  other.authorization.attributionRevision = 1;
  h.put(other);
  assert.equal(h.consumer.apply(other.decision.decisionId).afterRevision, 2);
  const beforeRetry = h.snapshot();
  assert.deepEqual(h.consumer.apply(a.decision.decisionId), first);
  assert.deepEqual(h.snapshot(), beforeRetry);
});

test("same decision ID with changed valid content cannot replace a durable receipt", (t) => {
  const original = authority();
  const h = fixture(t, original);
  h.consumer.apply(original.decision.decisionId);
  const changed = decision();
  changed.reasonReceiptId = "synthetic-reason-replacement";
  const a = authority(changed);
  h.put(a);
  const before = h.snapshot();
  assert.throws(() => h.consumer.apply(changed.decisionId), /already used for different content/);
  assert.deepEqual(h.snapshot(), before);
});

test("a current complete prior-review lineage can authorize a later proposal", (t) => {
  const current = decision();
  const earlier = decision();
  earlier.decisionId = "synthetic-earlier-review";
  earlier.outcome = "needs_information";
  earlier.reviewer = identity(104);
  earlier.reviewedAt = "2026-10-20T00:00:00.000000002Z";
  current.priorReviews = [{ decisionId: earlier.decisionId, reviewer: earlier.reviewer }];
  const h = fixture(t, authority(current, [earlier]));
  assert.equal(h.consumer.apply(current.decisionId).afterRevision, 1);
});

const invalid = {
  "unknown snapshot field": (a) => {
    a.unreviewedAuthority = true;
  },
  "unknown decision field": (a) => {
    a.decision.login = "synthetic-login";
  },
  "digest for different proposal": (a) => {
    a.decision.proposalSha256 = "b".repeat(64);
  },
  "stale current proposal revision": (a) => {
    a.currentProposal.revision++;
  },
  "same revision with changed proposal": (a) => {
    a.currentProposal.policyVersion = "different-policy";
  },
  "superseding decision": (a) => {
    a.currentDecisionId = "synthetic-later-decision";
  },
  "expired authority snapshot": (a) => {
    a.validUntil = at;
  },
  "future review": (a) => {
    a.decision.reviewedAt = until;
  },
  "revoked authorization": (a) => {
    a.authorization.revoked = true;
  },
  "expired authorization": (a) => {
    a.authorization.expiresAt = at;
  },
  "authorization granted after review": (a) => {
    a.authorization.grantedAt = at;
  },
  "unrelated authorization decision": (a) => {
    a.authorization.decisionId = "another-decision";
  },
  "unrelated authorization digest": (a) => {
    a.authorization.proposalSha256 = "b".repeat(64);
  },
  "wrong authorization reviewer": (a) => {
    a.authorization.reviewer = identity(109);
  },
  "wrong authorization policy": (a) => {
    a.authorization.policyVersion = "other-policy";
  },
  "wrong authorization operation": (a) => {
    a.authorization.kind = "split";
  },
  "public authorization substituted for private scope": (a) => {
    a.authorization.scope = "public_identity_correction";
  },
  "stale reviewed attribution revision": (a) => {
    a.authorization.attributionRevision = 1;
  },
  "unverified provider identity": (a) => {
    a.identities[0].verified = false;
  },
  "truthy verification is not verification": (a) => {
    a.identities[0].verified = "true";
  },
  "revoked provider identity": (a) => {
    a.identities[0].revoked = true;
  },
  "expired provider identity": (a) => {
    a.identities[0].expiresAt = at;
  },
  "changed provider identity": (a) => {
    a.identities[0].identity.githubNodeId = "unrelated-node";
  },
  "conflicting provider node": (a) => {
    a.identities[1].identity.githubNodeId = a.identities[0].identity.githubNodeId;
  },
  "reviewer is an affected account": (a) => {
    a.decision.reviewer = identity(101);
    a.authorization.reviewer = identity(101);
  },
  "duplicate provider record": (a) => {
    a.identities.push(a.identities[0]);
  },
  "missing provider record": (a) => {
    a.identities.pop();
  },
  "extra provider record": (a) => {
    a.identities.push({ identity: identity(999), verified: true, revoked: false, expiresAt: until });
  },
  "revoked proof": (a) => {
    a.proofs[0].revoked = true;
  },
  "unverified proof": (a) => {
    a.proofs[0].verified = false;
  },
  "missing proof": (a) => {
    a.proofs.shift();
  },
  "duplicate proof": (a) => {
    a.proofs.push(a.proofs[0]);
  },
  "changed proof descriptor": (a) => {
    a.proofs[0].proof.recordedAt = "2026-10-18T00:00:00Z";
  },
  "proof for another event": (a) => {
    a.proofs[2].attributions[0].sourceEventId = "other-event";
  },
  "proof for another result actor": (a) => {
    a.proofs[2].attributions[0].resultActorId = "109";
  },
  "missing exact proof attribution": (a) => {
    a.proofs[2].attributions = [];
  },
  "duplicate exact proof attribution": (a) => {
    a.proofs[2].attributions.push(a.proofs[2].attributions[0]);
  },
  "missing retained source": (a) => {
    a.sources = [];
  },
  "revoked retained source": (a) => {
    a.sources[0].revoked = true;
  },
  "changed retained source event": (a) => {
    a.sources[0].binding.sourceEventId = "other-event";
  },
  "changed retained source revision": (a) => {
    a.sources[0].binding.sourceRevision = "other-revision";
  },
  "changed retained attribution": (a) => {
    a.sources[0].binding.sourceAttributionSha256 = "b".repeat(64);
  },
  "invented source role": (a) => {
    a.sources[0].binding.role = "author";
  },
  "wrong original actor": (a) => {
    a.sources[0].binding.sourceActorId = "101";
  },
  "duplicate retained source": (a) => {
    a.sources.push(a.sources[0]);
  },
  "missing retained reason": (a) => {
    delete a.reason;
  },
  "revoked reason": (a) => {
    a.reason.revoked = true;
  },
  "reason for another decision": (a) => {
    a.reason.decisionId = "other-decision";
  },
};
for (const [name, mutate] of Object.entries(invalid)) {
  test(`private correction rejects ${name} without an overlay, receipt or revision`, (t) => {
    const a = authority();
    const h = fixture(t, a);
    mutate(a);
    h.put(a);
    const before = h.snapshot();
    assert.throws(() => h.consumer.apply(a.decision.decisionId));
    assert.deepEqual(h.snapshot(), before);
  });
}

for (const outcome of ["rejected", "needs_information", "reversed"]) {
  test(`${outcome} cannot acquire accepted application authority`, (t) => {
    const a = authority();
    a.decision.outcome = outcome;
    if (outcome === "reversed") {
      const earlier = decision();
      earlier.decisionId = "synthetic-prior-accepted";
      earlier.reviewer = identity(104);
      earlier.reviewedAt = "2026-10-20T00:00:00.000000002Z";
      a.priorDecisions = [earlier];
      a.decision.priorReviews = [{ decisionId: earlier.decisionId, reviewer: earlier.reviewer }];
      a.decision.reversesDecisionId = earlier.decisionId;
      a.identities.push({ identity: identity(104), verified: true, revoked: false, expiresAt: until });
    }
    const h = fixture(t, a);
    const before = h.snapshot();
    assert.throws(() => h.consumer.apply(a.decision.decisionId), /Only accepted/);
    assert.deepEqual(h.snapshot(), before);
  });
}

for (const mode of [
  "omitted",
  "substituted",
  "duplicate-id",
  "duplicate-reviewer",
  "conflicting-node",
  "incomplete-prefix",
  "different-lineage",
  "unbound-digest",
]) {
  test(`protected prior history rejects ${mode}`, (t) => {
    const current = decision();
    const prior = decision();
    prior.decisionId = "synthetic-prior";
    prior.reviewer = identity(104);
    prior.outcome = "needs_information";
    prior.reviewedAt = "2026-10-20T00:00:00.000000002Z";
    current.priorReviews = [{ decisionId: prior.decisionId, reviewer: prior.reviewer }];
    const a = authority(current, [prior]);
    if (mode === "omitted") a.priorDecisions = [];
    if (mode === "substituted") a.priorDecisions[0].reviewer = identity(105);
    if (mode === "duplicate-id") a.priorDecisions.push(structuredClone(prior));
    if (mode === "duplicate-reviewer")
      a.priorDecisions.push({ ...structuredClone(prior), decisionId: "synthetic-prior-2" });
    if (mode === "conflicting-node") a.priorDecisions[0].reviewer.githubNodeId = current.reviewer.githubNodeId;
    if (mode === "incomplete-prefix")
      a.priorDecisions[0].priorReviews.push({ decisionId: "missing-prior", reviewer: identity(105) });
    if (mode === "different-lineage") {
      a.priorDecisions[0].proposal.correctionId = "other-correction";
      a.priorDecisions[0].proposalSha256 = sha(a.priorDecisions[0].proposal);
    }
    if (mode === "unbound-digest") a.priorDecisions[0].proposalSha256 = "b".repeat(64);
    const h = fixture(t, a);
    const before = h.snapshot();
    assert.throws(() => h.consumer.apply(current.decisionId));
    assert.deepEqual(h.snapshot(), before);
  });
}

test("current proof expiry retains submillisecond precision", (t) => {
  const p = proposal("link");
  p.proofs[0].expiresAt = at;
  const a = authority(decision(p));
  const h = fixture(t, a);
  const before = h.snapshot();
  assert.throws(() => h.consumer.apply(a.decision.decisionId), /expired/);
  assert.deepEqual(h.snapshot(), before);
});

test("a separately reviewed decision cannot reuse an already overlaid original contribution", (t) => {
  const a = authority();
  const h = fixture(t, a);
  h.consumer.apply(a.decision.decisionId);
  const next = decision();
  next.decisionId = "synthetic-next-decision";
  next.proposal.revision = 2;
  next.proposalSha256 = sha(next.proposal);
  next.reviewer = identity(104);
  next.reviewedAt = "2026-10-20T00:00:00.000000004Z";
  next.priorReviews = [{ decisionId: a.decision.decisionId, reviewer: a.decision.reviewer }];
  const nextAuthority = authority(next, [a.decision]);
  nextAuthority.authorization.attributionRevision = 1;
  h.put(nextAuthority);
  const before = h.snapshot();
  assert.throws(() => h.consumer.apply(next.decisionId), /already been superseded/);
  assert.deepEqual(h.snapshot(), before);
});

for (const stage of ["overlay", "receipt", "revision", "commit"]) {
  test(`SQLite ${stage} failure rolls back the complete application and permits one clean retry`, (t) => {
    const a = authority();
    const h = fixture(t, a);
    const before = h.snapshot();
    if (stage === "commit") {
      h.store.db.exec(
        "PRAGMA foreign_keys=ON; CREATE TABLE synthetic_commit_parent (id INTEGER PRIMARY KEY); CREATE TABLE synthetic_commit_child (id INTEGER REFERENCES synthetic_commit_parent DEFERRABLE INITIALLY DEFERRED); CREATE TRIGGER synthetic_identity_failure AFTER INSERT ON identity_correction_receipts BEGIN INSERT INTO synthetic_commit_child VALUES(1); END;",
      );
    } else {
      const table = {
        overlay: "identity_correction_overlays",
        receipt: "identity_correction_receipts",
        revision: "identity_correction_revision",
      }[stage];
      h.store.db.exec(
        `CREATE TRIGGER synthetic_identity_failure BEFORE ${stage === "revision" ? "UPDATE" : "INSERT"} ON ${table} BEGIN SELECT RAISE(ABORT, 'synthetic append failure'); END;`,
      );
    }
    assert.throws(
      () => h.consumer.apply(a.decision.decisionId),
      /synthetic append failure|FOREIGN KEY constraint failed/,
    );
    assert.deepEqual(h.snapshot(), before);
    assert.equal(h.store.db.isTransaction, false);
    h.store.db.exec("DROP TRIGGER synthetic_identity_failure");
    assert.equal(h.consumer.apply(a.decision.decisionId).afterRevision, 1);
    assert.equal(h.snapshot().receipts.length, 1);
  });
}

for (const phase of ["first", "final"]) {
  test(`throwing ${phase} authority read leaves no application and rolls back same-transaction side effects`, (t) => {
    const error = new Error("synthetic protected reader failure");
    let fail = true;
    const h = fixture(t, authority(), {
      readAuthority(context, read, count) {
        const result = read(context);
        if (fail && count === (phase === "first" ? 0 : 1)) {
          context.database
            .prepare("UPDATE protected_identity_authority SET document=?")
            .run(JSON.stringify({ synthetic: "uncommitted" }));
          throw error;
        }
        return result;
      },
    });
    const before = h.snapshot();
    assert.throws(
      () => h.consumer.apply("synthetic-decision-1"),
      (actual) => actual === error,
    );
    assert.deepEqual(h.snapshot(), before);
    fail = false;
    assert.equal(h.consumer.apply("synthetic-decision-1").afterRevision, 1);
  });
}

test("the final current-authority reread detects replacement after the private append", (t) => {
  const h = fixture(t, authority(), {
    readAuthority(context, read, count) {
      const result = read(context);
      if (count === 1) result.revision++;
      return result;
    },
  });
  const before = h.snapshot();
  assert.throws(() => h.consumer.apply("synthetic-decision-1"), /authority changed during application/);
  assert.deepEqual(h.snapshot(), before);
});

for (const mode of ["expires", "backwards"]) {
  test(`the final ${mode} clock cannot commit a partial application`, (t) => {
    let h;
    h = fixture(t, authority(), {
      readAuthority(context, read, count) {
        const result = read(context);
        if (count === 1) h.setClock(mode === "expires" ? until : "2026-10-19T00:00:00Z");
        return result;
      },
    });
    const before = h.snapshot();
    assert.throws(() => h.consumer.apply("synthetic-decision-1"), /expired|backwards/);
    assert.deepEqual(h.snapshot(), before);
  });
}

for (const stage of ["first", "final"]) {
  for (const value of ["fulfilled", "rejected", "foreign-thenable"]) {
    test(`the ${stage} clock rejects ${value} without an escaped rejection or partial application`, async (t) => {
      const unhandled = [];
      const onUnhandled = (error) => unhandled.push(error);
      process.on("unhandledRejection", onUnhandled);
      t.after(() => process.removeListener("unhandledRejection", onUnhandled));
      let thenCalls = 0;
      const clockValue = () => {
        if (value === "fulfilled") return Promise.resolve(at);
        if (value === "rejected") return Promise.reject(new Error("synthetic rejected clock"));
        return {
          then() {
            thenCalls++;
          },
        };
      };
      let h;
      let tentative;
      h = fixture(t, authority(), {
        readAuthority(context, read, count) {
          const current = read(context);
          if (stage === "final" && count === 1) {
            tentative = h.snapshot();
            h.setClock(clockValue());
          }
          return current;
        },
      });
      if (stage === "first") h.setClock(clockValue());
      const before = h.snapshot();
      assert.throws(() => h.consumer.apply("synthetic-decision-1"), {
        status: 409,
        message: "Invalid identity application clock",
      });
      await new Promise(setImmediate);
      assert.equal(h.reads, stage === "first" ? 0 : 2);
      if (stage === "final") {
        assert.equal(tentative.revision[0].revision, 1);
        assert.equal(tentative.overlays.length, 1);
        assert.equal(tentative.receipts.length, 1);
      }
      assert.equal(thenCalls, 0);
      assert.deepEqual(unhandled, []);
      assert.deepEqual(h.snapshot(), before);
      assert.equal(h.store.db.isTransaction, false);
    });
  }
}

test("same-database authority writes cannot race the locked reader", (t) => {
  let other;
  const h = fixture(t, authority(), {
    readAuthority(context, read) {
      if (!other) {
        other = new DatabaseSync(h.filename);
        other.exec("PRAGMA busy_timeout=0");
      }
      assert.throws(
        () => other.prepare("UPDATE protected_identity_authority SET document='null'").run(),
        /database is locked/,
      );
      return read(context);
    },
  });
  t.after(() => other?.close());
  assert.equal(h.consumer.apply("synthetic-decision-1").afterRevision, 1);
});

test("asynchronous authority is rejected before an async function can run", (t) => {
  const h = fixture(t);
  let called = false;
  assert.throws(
    () =>
      createVerifiedIdentityCorrectionConsumer({
        store: h.store,
        async readAuthority() {
          called = true;
          return authority();
        },
      }),
    /synchronous/,
  );
  assert.equal(called, false);
});

for (const value of ["fulfilled", "rejected", "foreign-thenable"]) {
  test(`a synchronous reader returning ${value} cannot supply authority`, async (t) => {
    let thenCalls = 0;
    const h = fixture(t, authority(), {
      readAuthority() {
        if (value === "fulfilled") return Promise.resolve(authority());
        if (value === "rejected") return Promise.reject(new Error("synthetic async failure"));
        return {
          ...authority(),
          then() {
            thenCalls++;
          },
        };
      },
    });
    const before = h.snapshot();
    assert.throws(() => h.consumer.apply("synthetic-decision-1"));
    await Promise.resolve();
    assert.equal(thenCalls, 0);
    assert.deepEqual(h.snapshot(), before);
  });
}

test("a requester cannot substitute a decision object, extra authority argument or malformed lookup", (t) => {
  const h = fixture(t);
  const before = h.snapshot();
  for (const input of [authority(), "", "../private", 123, undefined])
    assert.throws(() => h.consumer.apply(input), /exact decision ID/);
  assert.throws(() => h.consumer.apply("synthetic-decision-1", authority()), /exact decision ID/);
  assert.throws(() => h.consumer.apply("missing-decision"), /Invalid protected/);
  assert.deepEqual(h.snapshot(), before);
});

test("an exact retry still requires current nonrevoked protected authority", (t) => {
  const a = authority();
  const h = fixture(t, a);
  h.consumer.apply(a.decision.decisionId);
  a.authorization.revoked = true;
  h.put(a);
  const before = h.snapshot();
  assert.throws(() => h.consumer.apply(a.decision.decisionId));
  assert.deepEqual(h.snapshot(), before);
});

test("an incomplete durable receipt cannot be treated as an exact retry", (t) => {
  const h = fixture(t);
  h.consumer.apply("synthetic-decision-1");
  h.store.db.exec("DELETE FROM identity_correction_overlays");
  const before = h.snapshot();
  assert.throws(() => h.consumer.apply("synthetic-decision-1"), /Incomplete retained/);
  assert.deepEqual(h.snapshot(), before);
});

test("an exact decision retry cannot silently replace its reviewed authorization revision or lifetime", (t) => {
  const a = authority();
  const h = fixture(t, a);
  h.consumer.apply(a.decision.decisionId);
  for (const change of [
    (current) => {
      current.authorization.attributionRevision = 1;
    },
    (current) => {
      current.authorization.expiresAt = "2026-10-22T00:00:00Z";
    },
  ]) {
    const changed = structuredClone(a);
    change(changed);
    h.put(changed);
    const before = h.snapshot();
    assert.throws(() => h.consumer.apply(a.decision.decisionId), /Retained authorization receipt changed/);
    assert.deepEqual(h.snapshot(), before);
  }
});

test("a reader of live source rows rejects a retained source update made before its transaction", (t) => {
  const h = fixture(t, authority(), {
    readAuthority(context, read) {
      const current = read(context);
      current.sources = context.database
        .prepare("SELECT document FROM original_identity_sources ORDER BY id")
        .all()
        .map((row) => JSON.parse(row.document));
      return current;
    },
  });
  const source = JSON.parse(h.store.db.prepare("SELECT document FROM original_identity_sources").get().document);
  source.binding.sourceRevision = "synthetic-new-source-revision";
  h.store.db.prepare("UPDATE original_identity_sources SET document=?").run(JSON.stringify(source));
  const before = h.snapshot();
  assert.throws(() => h.consumer.apply("synthetic-decision-1"), /Retained source attribution changed/);
  assert.deepEqual(h.snapshot(), before);
});

test("reuse of a mutable authority response cannot hide a change from the final comparison", (t) => {
  const held = authority();
  let reads = 0;
  const h = fixture(t, authority(), {
    readAuthority() {
      if (reads++ === 1) held.authorization.attributionRevision = 1;
      return held;
    },
  });
  const before = h.snapshot();
  assert.throws(() => h.consumer.apply("synthetic-decision-1"), /authority changed during application/);
  assert.deepEqual(h.snapshot(), before);
});

for (const expired of ["proof", "identity", "authorization"]) {
  test(`a ${expired} expiring exactly at the final submillisecond guard rolls back`, (t) => {
    const a = authority();
    const boundary = "2026-10-20T00:00:00.000000005Z";
    if (expired === "proof") {
      a.decision.proposal.proofs[0].expiresAt = boundary;
      a.decision.proposalSha256 = sha(a.decision.proposal);
      a.currentProposal = structuredClone(a.decision.proposal);
      a.proofs[0].proof.expiresAt = boundary;
      a.authorization.proposalSha256 = a.decision.proposalSha256;
      a.reason.proposalSha256 = a.decision.proposalSha256;
    } else if (expired === "identity") a.identities[0].expiresAt = boundary;
    else a.authorization.expiresAt = boundary;
    let h;
    h = fixture(t, a, {
      readAuthority(context, read, count) {
        const current = read(context);
        if (count === 1) h.setClock(boundary);
        return current;
      },
    });
    const before = h.snapshot();
    assert.throws(() => h.consumer.apply(a.decision.decisionId), /expired/);
    assert.deepEqual(h.snapshot(), before);
  });
}

test("the private attribution revision cannot overflow a safe integer", (t) => {
  const a = authority();
  a.authorization.attributionRevision = Number.MAX_SAFE_INTEGER;
  const h = fixture(t, a);
  h.store.db.prepare("UPDATE identity_correction_revision SET revision=?").run(Number.MAX_SAFE_INTEGER);
  const before = h.snapshot();
  assert.throws(() => h.consumer.apply(a.decision.decisionId), /Attribution changed/);
  assert.deepEqual(h.snapshot(), before);
});

for (const historyFault of ["omitted-known-application", "changed-known-decision"]) {
  test(`a protected lineage cannot contain ${historyFault}`, (t) => {
    const original = authority();
    const h = fixture(t, original);
    h.consumer.apply(original.decision.decisionId);
    const p = proposal();
    p.revision = 2;
    p.assignments[0].contributionId = "synthetic-contribution-2";
    p.proofs[2].contributionIds = ["synthetic-contribution-2"];
    const next = decision(p);
    next.decisionId = "synthetic-next-independent-assignment";
    next.reviewer = identity(104);
    next.reviewedAt = at;
    const prior = structuredClone(original.decision);
    if (historyFault === "changed-known-decision") {
      prior.reasonReceiptId = "rewritten-old-reason";
      next.priorReviews = [{ decisionId: prior.decisionId, reviewer: prior.reviewer }];
    }
    const a = authority(next, historyFault === "omitted-known-application" ? [] : [prior]);
    a.authorization.attributionRevision = 1;
    h.put(a);
    const before = h.snapshot();
    assert.throws(() => h.consumer.apply(next.decisionId), /Applied decision is absent or changed in retained history/);
    assert.deepEqual(h.snapshot(), before);
  });
}

test("a new reviewed revision can append a disjoint assignment while preserving the complete applied history", (t) => {
  const original = authority();
  const h = fixture(t, original);
  const receipt = h.consumer.apply(original.decision.decisionId);
  const oldOverlay = h.snapshot().overlays[0];
  const p = proposal();
  p.revision = 2;
  p.assignments[0].contributionId = "synthetic-contribution-2";
  p.proofs[2].contributionIds = ["synthetic-contribution-2"];
  const next = decision(p);
  next.decisionId = "synthetic-next-independent-assignment";
  next.reviewer = identity(104);
  next.reviewedAt = at;
  next.priorReviews = [{ decisionId: original.decision.decisionId, reviewer: original.decision.reviewer }];
  const a = authority(next, [original.decision]);
  a.authorization.attributionRevision = 1;
  h.put(a);
  h.store.db
    .prepare("INSERT INTO original_identity_sources VALUES(?,?)")
    .run(a.sources[0].binding.contributionId, JSON.stringify(a.sources[0]));
  const before = h.snapshot();
  const result = h.consumer.apply(next.decisionId);
  const after = h.snapshot();
  assert.equal(result.beforeRevision, receipt.afterRevision);
  assert.equal(result.afterRevision, 2);
  assert.equal(after.overlays.length, 2);
  assert.equal(after.receipts.length, 2);
  assert.deepEqual(
    after.overlays.find((row) => row.decision_id === receipt.decisionId),
    oldOverlay,
  );
  assert.deepEqual(after.sources, before.sources);
  assert.deepEqual(after.publication, before.publication);
});

test("receipt corruption: coherently shifted revision pairs cannot replace the reviewed authorization revision", (t) => {
  const original = authority();
  const h = fixture(t, original);
  const receipt = h.consumer.apply(original.decision.decisionId);
  const p = proposal("link");
  p.correctionId = "synthetic-unrelated-correction";
  const otherDecision = decision(p);
  otherDecision.decisionId = "synthetic-unrelated-decision";
  const other = authority(otherDecision);
  other.authorization.attributionRevision = 1;
  h.put(other);
  assert.equal(h.consumer.apply(otherDecision.decisionId).afterRevision, 2);
  const authorizations = h.snapshot().receipts.map((row) => row.authorization_document);
  h.store.transaction(() => {
    // Swap both coherent receipt/overlay pairs without violating UNIQUE revision.
    // The immutable reviewed authorization revisions deliberately remain 0 and 1.
    h.store.db
      .prepare("UPDATE identity_correction_overlays SET attribution_revision=3 WHERE decision_id=?")
      .run(receipt.decisionId);
    for (const [id, afterRevision] of [
      [otherDecision.decisionId, 1],
      [receipt.decisionId, 2],
    ]) {
      const retained = h.store.db
        .prepare("SELECT document FROM identity_correction_receipts WHERE decision_id=?")
        .get(id);
      const changedReceipt = JSON.parse(retained.document);
      changedReceipt.beforeRevision = afterRevision - 1;
      changedReceipt.afterRevision = afterRevision;
      h.store.db
        .prepare("UPDATE identity_correction_receipts SET document=? WHERE decision_id=?")
        .run(JSON.stringify(changedReceipt), id);
      const row = h.store.db.prepare("SELECT document FROM identity_correction_overlays WHERE decision_id=?").get(id);
      const changedOverlay = JSON.parse(row.document);
      changedOverlay.attributionRevision = afterRevision;
      h.store.db
        .prepare("UPDATE identity_correction_overlays SET attribution_revision=?,document=? WHERE decision_id=?")
        .run(afterRevision, JSON.stringify(changedOverlay), id);
    }
  });
  const before = h.snapshot();
  assert.deepEqual(
    before.receipts.map((row) => row.authorization_document),
    authorizations,
  );
  assert.equal(before.revision[0].revision, 2);
  assert.throws(() => h.consumer.apply(receipt.decisionId), /Retained identity receipt revision mismatch/);
  assert.deepEqual(h.snapshot(), before);
});

for (const field of ["zero-authority-revision", "before-review", "after-current-time"]) {
  test(`receipt corruption: ${field} cannot be acknowledged as an original application`, (t) => {
    const h = fixture(t);
    const receipt = h.consumer.apply("synthetic-decision-1");
    const changed = structuredClone(receipt);
    if (field === "zero-authority-revision") changed.authorityRevision = 0;
    if (field === "before-review") changed.appliedAt = "2026-10-20T00:00:00.000000002Z";
    if (field === "after-current-time") changed.appliedAt = "2026-10-20T00:00:00.000000005Z";
    h.store.db
      .prepare("UPDATE identity_correction_receipts SET document=? WHERE decision_id=?")
      .run(JSON.stringify(changed), receipt.decisionId);
    const before = h.snapshot();
    assert.throws(
      () => h.consumer.apply(receipt.decisionId),
      /Invalid retained application receipt|Retained identity receipt application time mismatch/,
    );
    assert.deepEqual(h.snapshot(), before);
  });
}
