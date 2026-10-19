import assert from "node:assert/strict";
import test from "node:test";
import { createService } from "../dist/app.js";
import { validateParticipationHistoryRead } from "../dist/participation-history.js";
import {
  participationHistorySource,
  historyPath,
  historyQuery,
  historyOrigin,
  historyStart,
  historyCutoff,
} from "../../../tests/fixtures/participation-history.mjs";

function harness(t) {
  const fixture = participationHistorySource();
  const app = createService({ source: fixture.source });
  t.after(() => app.close());
  return { ...fixture, app, pair: fixture.state.pair };
}

test("reviewed full history finds earlier work outside the profile repository and category", async (t) => {
  const { app } = harness(t);
  const response = await app.inject(historyPath + "&category=pr_merged");
  assert.equal(response.statusCode, 200, response.body);
  const value = response.json().history;
  assert.equal(value.state, "known");
  assert.equal(value.newcomer, false);
  assert.equal(value.firstProof.proof.contributionId, "synthetic-earlier-review");
  assert.equal(value.firstProof.proof.repositoryId, "3");
  assert.deepEqual(value.firstProof.proof.roles, ["reviewer"]);
  assert.equal(value.ranked, false);
});

test("a first proof resolves only through its fresh history key, not the selected evidence route", async (t) => {
  const { app } = harness(t);
  const response = await app.inject(historyPath);
  assert.equal(response.statusCode, 200, response.body);
  const value = response.json().history;
  const id = value.firstProof.proof.contributionId;
  assert.equal((await app.inject(`/api/v1/evidence/${id}?${historyQuery}`)).statusCode, 404);
  const proof = await app.inject(
    `/api/v1/contributors/101/participation-history/${value.historyKey}/evidence/${id}?${historyQuery}`,
  );
  assert.equal(proof.statusCode, 200, proof.body);
  assert.deepEqual(proof.json().history, value);
});

test("ordinary providers retain explicit unknown history and the existing activity summary", async (t) => {
  const { source } = participationHistorySource();
  const app = createService({ source: { read: source.read } });
  t.after(() => app.close());
  const response = await app.inject(historyPath);
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().history.state, "unknown");
  assert.equal(response.json().history.newcomer, null);
  const profile = await app.inject(`/api/v1/contributors/101?${historyQuery}`);
  assert.equal(profile.statusCode, 200, profile.body);
  assert.equal(profile.json().activitySummary.history.newcomer, null);
});

async function read(app, url = historyPath) {
  const response = await app.inject(url);
  assert.equal(response.statusCode, 200, response.body);
  return response;
}
const proofPath = (value, query = historyQuery) =>
  `/api/v1/contributors/101/participation-history/${value.historyKey}/evidence/${value.firstProof.proof.contributionId}?${query}`;

test("protected admission denial cannot be replaced by a public flag or a receipt string", async (t) => {
  const { app, state, pair } = harness(t);
  state.authorized = false;
  pair.history.admission.decisionId = "synthetic-still-nonempty";
  assert.equal((await read(app)).json().history.reason, "reviewed_history_unavailable");
  assert.equal((await app.inject(historyPath + "&approved=true")).statusCode, 400);
  state.authorized = true;
  assert.equal((await read(app)).json().history.state, "known");
});

test("every required source pair needs complete origin-through-cutoff coverage", async (t) => {
  const { app, pair } = harness(t),
    original = structuredClone(pair.history.publication.selected.snapshot.coverage);
  const changes = [
    (values) => values.pop(),
    (values) => {
      values[1].state = "partial";
    },
    (values) => {
      values[1].knownStart = null;
    },
    (values) => {
      values[1].knownStart = "2026-01-01T00:00:00.000000001Z";
    },
    (values) => {
      values[1].windowStart = "2026-01-01T00:00:00.000000001Z";
    },
    (values) => {
      values[1].windowEnd = "2026-10-17T23:59:59.999999999Z";
    },
    (values) => {
      values[1].sourceWatermark = null;
    },
    (values) => {
      values[1].sourceWatermark = "2026-10-17T23:59:59.999999999Z";
    },
    (values) => {
      values[1].lastSuccessfulSync = null;
    },
    (values) => {
      values[1].state = "partial";
      values[1].missingPages = 1;
    },
    (values) => {
      values[1].state = "partial";
      values[1].permissionsMissing = ["synthetic-denial"];
    },
    (values) => {
      values[1].state = "partial";
      values[1].sourceErrors = ["synthetic-failure"];
    },
  ];
  for (const change of changes) {
    pair.history.publication.selected.snapshot.coverage = structuredClone(original);
    change(pair.history.publication.selected.snapshot.coverage);
    const history = (await read(app)).json().history;
    assert.equal(history.reason, "history_incomplete");
    assert.equal(history.firstProof, null);
    assert.equal(history.newcomer, null);
  }
});

test("shortened, duplicate or invented admitted source inventories fail before a known first event", async (t) => {
  const { app, pair } = harness(t),
    original = structuredClone(pair.history);
  for (const change of [
    (h) => h.dataset.sourceInventory.pop(),
    (h) => h.admission.sourceInventory.pop(),
    (h) => h.admission.sourceInventory.push(structuredClone(h.admission.sourceInventory[0])),
    (h) => {
      h.dataset.sourceInventory[0].source = "unknown";
    },
    (h) => {
      h.admission.sourceInventory = h.admission.sourceInventory.slice(0, 1);
      h.dataset.sourceInventory = structuredClone(h.admission.sourceInventory);
    },
  ]) {
    pair.history = structuredClone(original);
    change(pair.history);
    assert.equal((await app.inject(historyPath)).statusCode, 503);
  }
});

test("selected input identity, organization and exact frozen cutoff remain bound", async (t) => {
  const { app, pair } = harness(t),
    original = structuredClone(pair.history);
  for (const change of [
    (h) => {
      h.selectedInput.snapshotId = "another-snapshot";
    },
    (h) => {
      h.selectedInput.revision++;
    },
    (h) => {
      h.selectedInput.sha256 = "e".repeat(64);
    },
    (h) => {
      h.dataset.cutoff = "2026-10-18T00:00:00.000000001Z";
    },
    (h) => {
      h.admission.organization = "Another-organization";
    },
    (h) => {
      h.admission.reviewedAt = "2026-10-18T00:00:00.000000001Z";
    },
    (h) => {
      h.dataset.sha256 = "not-a-hash";
    },
  ]) {
    pair.history = structuredClone(original);
    change(pair.history);
    assert.equal((await app.inject(historyPath)).statusCode, 503);
  }
  pair.history = structuredClone(original);
  pair.selectedInput.cutoff =
    pair.history.selectedInput.cutoff =
    pair.history.dataset.cutoff =
      "2026-10-18T00:00:00.000000001Z";
  assert.equal((await app.inject(historyPath)).statusCode, 503);
});

test("repository, project, workstream, role and actor lenses never narrow the historical universe", async (t) => {
  const { app, pair } = harness(t),
    original = structuredClone(pair.history.publication);
  const selected = await read(
    app,
    historyPath + "&project=P_synthetic&context=current&role=author&actors=user&category=pr_merged",
  );
  assert.equal(selected.json().history.firstProof.proof.contributionId, "synthetic-earlier-review");
  assert.equal(selected.json().scope.context, "current");
  assert.deepEqual(selected.json().scope.roles, ["author"]);
  for (const change of [
    (p) => {
      p.selected.scope.repository = "2";
    },
    (p) => {
      p.selected.scope.workstream = "T0";
    },
    (p) => {
      p.selected.scope = {
        ...p.selected.scope,
        schemaVersion: "public-scope/v2",
        context: "event",
        projects: ["P_synthetic"],
      };
    },
    (p) => {
      p.selected.scope = {
        ...p.selected.scope,
        schemaVersion: "public-scope/v3",
        context: "event",
        projects: [],
        roles: ["author"],
      };
    },
    (p) => {
      p.actorFilter = "user";
    },
    (p) => {
      p.selected.scope.start = historyStart;
      p.selected.scope.end = historyCutoff;
    },
  ]) {
    pair.history.publication = structuredClone(original);
    change(pair.history.publication);
    assert.equal((await app.inject(historyPath)).statusCode, 503);
  }
});

test("source bindings are complete and cannot alias another repository or an unprovided proof", async (t) => {
  const { app, pair } = harness(t),
    original = structuredClone(pair.history.proofSources);
  for (const change of [
    (s) => s.pop(),
    (s) => s.push(structuredClone(s[0])),
    (s) => {
      s[0].repositoryId = "2";
    },
    (s) => {
      s[0].contributionId = "not-provided";
    },
    (s) => {
      s[0].source = "github_graphql";
    },
  ]) {
    pair.history.proofSources = structuredClone(original);
    change(pair.history.proofSources);
    assert.equal((await app.inject(historyPath)).statusCode, 503);
  }
});

test("global malformed identities cannot hide behind an unrelated actor or an earlier valid proof", async (t) => {
  const { app, pair } = harness(t),
    original = structuredClone(pair.history);
  for (const change of [
    (h) => {
      h.publication.selected.actors[1].actor.githubNodeId = h.publication.selected.actors[0].actor.githubNodeId;
    },
    (h) => {
      h.publication.selected.actors[0].actor.githubNodeId = "synthetic-swapped-identity";
    },
    (h) => {
      h.publication.selected.portfolioEvidence[1].contribution.metricIds = ["not-a-registered-category"];
    },
    (h) => {
      const copy = structuredClone(h.publication.selected.portfolioEvidence[0]);
      copy.contribution.contributionId = "synthetic-contradictory-copy";
      copy.occurredAt = "2026-03-01T00:00:00.000Z";
      h.publication.selected.portfolioEvidence.push(copy);
      h.proofSources.push({ ...h.proofSources[0], contributionId: copy.contribution.contributionId });
    },
  ]) {
    pair.history = structuredClone(original);
    change(pair.history);
    assert.equal((await app.inject(historyPath)).statusCode, 503);
  }
});

test("distinct policy proofs sharing one exact source event remain separate and deterministic", async (t) => {
  const { app, pair } = harness(t);
  const original = (await read(app)).json().history;
  const copy = structuredClone(pair.history.publication.selected.portfolioEvidence[0]);
  copy.contribution.contributionId = "synthetic-z-other-policy";
  copy.contribution.roles = ["author"];
  copy.contribution.metricIds = ["pr_merged"];
  pair.history.publication.selected.portfolioEvidence.push(copy);
  pair.history.proofSources.push({ ...pair.history.proofSources[0], contributionId: copy.contribution.contributionId });
  const next = (await read(app)).json().history;
  assert.deepEqual(next.firstProof, original.firstProof);
  assert.notEqual(next.historyKey, original.historyKey);
  pair.history.publication.selected.portfolioEvidence.reverse();
  assert.deepEqual((await read(app)).json().history.firstProof, original.firstProof);
});

test("missing clocks, attribution, qualification and explicit unresolved records remain unknown", async (t) => {
  const { app, pair } = harness(t),
    original = structuredClone(pair.history);
  for (const change of [
    (h) => {
      h.publication.selected.portfolioEvidence[0].occurredAt = null;
    },
    (h) => {
      h.publication.selected.portfolioEvidence[0].observedAt = null;
    },
    (h) => {
      h.publication.selected.portfolioEvidence[0].contribution.actorId = null;
    },
    (h) => {
      h.publication.selected.portfolioEvidence[0].contribution.qualification = "unknown";
    },
    (h) => {
      h.publication.selected.portfolioEvidence[0].contribution.qualification = "pending";
    },
    (h) => {
      h.publication.selected.portfolioEvidence[0].activityState = "unknown";
    },
    (h) => {
      h.publication.selected.portfolioEvidence[0].activityState = "pending";
    },
    ...["unknown_actor", "unknown_time", "unknown_qualification", "withheld", "conflicting"].map(
      (reason) => (h) => h.unresolved.push({ actorId: reason === "unknown_actor" ? null : "101", reason }),
    ),
  ]) {
    pair.history = structuredClone(original);
    change(pair.history);
    const value = (await read(app)).json().history;
    assert.equal(value.reason, "history_evidence_unavailable");
    assert.equal(value.firstProof, null);
  }
  pair.history = structuredClone(original);
  pair.history.unresolved.push({ actorId: "102", reason: "unknown_time" });
  assert.equal((await read(app)).json().history.state, "known");
});

const unresolvedReasons = ["unknown_actor", "unknown_time", "unknown_qualification", "withheld", "conflicting"];

test("malformed unresolved reasons reject on history and retained proof routes before actor scoping", async (t) => {
  const { app, pair } = harness(t);
  const original = (await read(app)).json().history;
  for (const actorId of ["102", "101", null]) {
    for (const reason of unresolvedReasons.flatMap((value) => [[value], [[value]]])) {
      pair.history.unresolved = [{ actorId, reason }];
      for (const url of [historyPath, proofPath(original)]) {
        const response = await app.inject(url);
        assert.equal(response.statusCode, 503, JSON.stringify({ actorId, reason, body: response.json() }));
        assert.equal(response.json().error, "participation_history_invalid");
        assert.equal(response.body.includes(original.firstProof.proof.contributionId), false);
      }
    }
  }
  pair.history.unresolved = [];
  assert.deepEqual((await read(app)).json().history, original);
  assert.deepEqual((await read(app, proofPath(original))).json().history, original);
});

test("literal unresolved reasons preserve unknown attribution and unrelated actor history", async (t) => {
  const { app, pair } = harness(t);
  const original = (await read(app)).json().history;
  for (const actorId of ["102", "101", null]) {
    for (const reason of unresolvedReasons) {
      pair.history.unresolved = [{ actorId, reason }];
      const response = await app.inject(historyPath);
      if (reason === "unknown_actor" && actorId !== null) {
        assert.equal(response.statusCode, 503, response.body);
        assert.equal(response.json().error, "participation_history_invalid");
        assert.equal((await app.inject(proofPath(original))).statusCode, 503);
        continue;
      }
      assert.equal(response.statusCode, 200, response.body);
      const history = response.json().history;
      if (actorId === "102") {
        assert.equal(history.state, "known");
        assert.deepEqual(history.firstProof, original.firstProof);
        assert.deepEqual((await read(app, proofPath(history))).json().history, history);
      } else {
        assert.equal(history.state, "unknown");
        assert.equal(history.reason, "history_evidence_unavailable");
        assert.equal(history.firstProof, null);
        assert.equal(history.newcomer, null);
        assert.equal((await app.inject(proofPath(original))).statusCode, 409);
      }
    }
  }
});

test("unresolved reason validation rejects JSON aliases without modifying the supplied provider object", () => {
  const pair = participationHistorySource().state.pair;
  const invalidReasons = [
    ...unresolvedReasons.flatMap((value) => [[value], [[value]]]),
    null,
    true,
    false,
    0,
    {},
    [],
    ["unknown_actor", "unknown_time"],
    " unknown_actor",
    "unknown_actor\n",
    "UNKNOWN_ACTOR",
  ];
  for (const actorId of ["102", "101", null]) {
    for (const reason of invalidReasons) {
      pair.history.unresolved = [{ actorId, reason }];
      const original = structuredClone(pair);
      assert.throws(() => validateParticipationHistoryRead(pair), {
        status: 503,
        code: "participation_history_invalid",
      });
      assert.deepEqual(pair, original);
    }
  }
  pair.history.unresolved = [{ actorId: null, reason: "unknown_actor" }];
  const original = structuredClone(pair);
  assert.equal(validateParticipationHistoryRead(pair), pair);
  assert.deepEqual(pair, original);
});

test("current opaque artifact retirement withholds the first proof instead of promoting later work", async (t) => {
  const { app, pair } = harness(t),
    response = await read(app),
    before = response.json().history;
  const artifactId = before.firstProof.proof.artifactId;
  pair.current.controls.suppressedArtifactIds = [artifactId];
  pair.history.publication.controls.suppressedArtifactIds = [artifactId];
  const after = await app.inject({ url: historyPath, headers: { "if-none-match": response.headers.etag } });
  assert.equal(after.statusCode, 200, after.body);
  assert.equal(after.json().history.reason, "history_evidence_unavailable");
  assert.equal(after.body.includes(artifactId), false);
  assert.equal(after.body.includes("synthetic-earlier-review"), false);
  assert.equal((await app.inject(proofPath(before))).statusCode, 409);
  assert.equal(pair.current.controls.version, "synthetic-controls-1");
});

test("current actor and snapshot withdrawal remains authoritative for pinned history and conditional requests", async (t) => {
  const { app, pair } = harness(t),
    before = (await read(app)).json().history;
  pair.current.controls.suppressedActorIds = pair.history.publication.controls.suppressedActorIds = ["101"];
  assert.equal((await app.inject(historyPath)).statusCode, 404);
  pair.current.controls.suppressedActorIds = pair.history.publication.controls.suppressedActorIds = [];
  pair.current.controls.revokedSnapshotIds = pair.history.publication.controls.revokedSnapshotIds = [
    pair.current.head.snapshotId,
  ];
  assert.equal((await app.inject(historyPath)).statusCode, 410);
  pair.current.controls.revokedSnapshotIds = pair.history.publication.controls.revokedSnapshotIds = [
    pair.history.publication.head.snapshotId,
  ];
  assert.equal((await read(app)).json().history.reason, "history_evidence_unavailable");
  assert.equal((await app.inject(proofPath(before))).statusCode, 409);
});

test("the two reads cannot disagree about current controls even with identical version strings", async (t) => {
  const { app, pair } = harness(t),
    original = structuredClone(pair.history.publication.controls);
  for (const change of [
    (c) => c.suppressedArtifactIds.push("another-opaque=="),
    (c) => c.suppressedActorIds.push("102"),
    (c) => c.revokedSnapshotIds.push("another-snapshot"),
    (c) => {
      c.version = "synthetic-other-controls";
    },
  ]) {
    pair.history.publication.controls = structuredClone(original);
    change(pair.history.publication.controls);
    const response = await app.inject(historyPath);
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().error, "participation_history_authority_changed");
  }
});

test("history-only changes invalidate old proof keys and ETags without changing the selected snapshot", async (t) => {
  const { app, pair } = harness(t);
  for (const change of [
    (h) => {
      h.dataset.backfillRevision = "synthetic-backfill-two";
    },
    (h) => {
      h.dataset.sha256 = "e".repeat(64);
    },
    (h) => {
      h.admission.decisionId = "synthetic-reviewed-replacement";
    },
    (h) => {
      h.admission.origin = "2026-01-15T00:00:00.000Z";
    },
  ]) {
    const response = await read(app),
      before = response.json().history;
    change(pair.history);
    const next = await app.inject({ url: historyPath, headers: { "if-none-match": response.headers.etag } });
    assert.equal(next.statusCode, 200, next.body);
    assert.notEqual(next.json().history.historyKey, before.historyKey);
    assert.equal(next.json().snapshotId, response.json().snapshotId);
    assert.equal((await app.inject(proofPath(before))).statusCode, 409);
  }
});

test("precise source occurrences determine completed-period newcomer status without rounding or rewriting", async (t) => {
  const { app, pair } = harness(t),
    first = pair.history.publication.selected.portfolioEvidence[0];
  for (const [occurredAt, expected] of [
    ["2026-09-30T23:59:59.999999999Z", false],
    [historyStart, true],
    ["2026-09-30T20:00:00-04:00", true],
    ["2026-10-01T00:00:00.000000001Z", true],
  ]) {
    first.occurredAt = occurredAt;
    const value = (await read(app)).json().history;
    assert.equal(value.newcomer, expected);
    assert.equal(value.firstProof.proof.occurredAt, occurredAt);
  }
  const allTime = (await read(app, "/api/v1/contributors/101/participation-history")).json().history;
  assert.equal(allTime.state, "known");
  assert.equal(allTime.newcomer, null);
  assert.equal(allTime.periodReason, "unbounded_selection");
  const futureEnd = (await read(app, historyPath.replace(historyCutoff, "2026-10-19T00:00:00.000Z"))).json().history;
  assert.equal(futureEnd.newcomer, null);
  assert.equal(futureEnd.periodReason, "history_cutoff_before_selection_end");
});

test("source and observation clocks cannot pass the shared cutoff at submillisecond precision", async (t) => {
  const { app, pair } = harness(t),
    original = structuredClone(pair.history);
  for (const change of [
    (e) => {
      e.observedAt = "2026-10-18T00:00:00.000000001Z";
    },
    (e) => {
      e.occurredAt = "2026-10-17T00:00:00.000000001Z";
    },
    (e) => {
      e.occurredAt = "2025-12-31T23:59:59.999999999Z";
    },
  ]) {
    pair.history = structuredClone(original);
    change(pair.history.publication.selected.portfolioEvidence[0]);
    assert.equal((await app.inject(historyPath)).statusCode, 503);
  }
  pair.history = structuredClone(original);
  pair.history.publication.selected.portfolioEvidence[0].observedAt = "2026-10-17T20:00:00-04:00";
  assert.equal((await read(app)).json().history.firstProof.observedAt, "2026-10-17T20:00:00-04:00");
});

test("an unavailable qualifying policy does not silently shrink the full history policy set", async (t) => {
  const { app, pair } = harness(t),
    original = structuredClone(pair.history.publication);
  for (const change of [
    (p) => p.selected.methodology.pop(),
    (p) => {
      p.selected.methodology[1].policySignature = "e".repeat(64);
    },
    (p) => {
      p.selected.methodology[1].policyVersion = "another-reviewed-version";
    },
    (p) => {
      p.selected.disabledMetrics = [
        { id: "prs_reviewed", policyVersion: "synthetic-disabled", policyLink: null, reason: "policy_unapproved" },
      ];
    },
  ]) {
    pair.history.publication = structuredClone(original);
    change(pair.history.publication);
    assert.equal((await read(app)).json().history.reason, "qualifying_policy_unavailable");
  }
});

test("no accepted qualifying proof remains unknown rather than a certified zero or newcomer", async (t) => {
  const { app, pair } = harness(t);
  for (const entry of pair.history.publication.selected.portfolioEvidence) entry.activityState = "observed";
  const history = (await read(app)).json().history;
  assert.equal(history.reason, "no_qualifying_evidence");
  assert.equal(history.newcomer, null);
});

test("bounded JSON and closed protocol fields reject oversized, cyclic and accessor inputs before projection", async (t) => {
  const original = participationHistorySource().state.pair;
  let supplied;
  const app = createService({ source: { read: async () => null, readParticipationHistory: async () => supplied } });
  t.after(() => app.close());
  let getterCalls = 0;
  for (const change of [
    (p) => {
      p.privateApproval = "extra-field";
    },
    (p) => {
      p.history.admission.reviewBody = "private-review-body";
    },
    (p) => {
      p.history.unresolved = Array.from({ length: 20_001 }, () => ({ actorId: null, reason: "unknown_actor" }));
    },
    (p) => {
      p.history.dataset.id = "x".repeat(8_000_001);
    },
    (p) => {
      p.history.circular = p;
    },
    (p) => {
      Object.defineProperty(p.history.proofSources, 0, {
        enumerable: true,
        get() {
          getterCalls++;
          return {};
        },
      });
    },
    (p) => {
      Object.defineProperty(p.history.proofSources, "hiddenReceipt", {
        value: "private-review-body",
        enumerable: false,
      });
    },
  ]) {
    supplied = structuredClone(original);
    change(supplied);
    const response = await app.inject(historyPath);
    assert.equal(response.statusCode, 503, response.body);
    assert.equal(response.body.includes("private-review-body"), false);
  }
  assert.equal(getterCalls, 0);
});

test("history and retained proof reads reject inherited array hooks before they can hide an unresolved record", async (t) => {
  let supplied = participationHistorySource().state.pair;
  const app = createService({ source: { read: async () => null, readParticipationHistory: async () => supplied } });
  t.after(() => app.close());
  const original = (await read(app)).json().history;
  let getterCalls = 0;
  let methodCalls = 0;
  const prototype = Object.create(Array.prototype);
  Object.defineProperty(prototype, "some", {
    get() {
      getterCalls++;
      return () => {
        methodCalls++;
        return false;
      };
    },
  });
  supplied.history.unresolved.push({ actorId: "101", reason: "withheld" });
  assert.equal((await read(app)).json().history.reason, "history_evidence_unavailable");
  Object.setPrototypeOf(supplied.history.unresolved, prototype);
  for (const path of [historyPath, proofPath(original)]) {
    const response = await app.inject(path);
    assert.equal(response.statusCode, 503, response.body);
    assert.equal(response.json().error, "participation_history_invalid");
  }
  assert.equal(getterCalls, 0);
  assert.equal(methodCalls, 0);
  assert.equal(Object.getPrototypeOf(supplied.history.unresolved), prototype);
  assert.deepEqual(supplied.history.unresolved[0], { actorId: "101", reason: "withheld" });
});

test("the history JSON boundary rejects custom array prototypes throughout the paired input", () => {
  class ProviderArray extends Array {}
  const arrays = [
    (pair) => pair.current.selected.actors,
    (pair) => pair.history.admission.sourceInventory,
    (pair) => pair.history.admission.policies,
    (pair) => pair.history.dataset.sourceInventory,
    (pair) => pair.history.publication.selected.portfolioEvidence,
    (pair) => pair.history.publication.selected.snapshot.coverage,
    (pair) => pair.history.proofSources,
    (pair) => pair.history.unresolved,
  ];
  for (const select of arrays) {
    for (const prototype of [null, Object.create(Array.prototype), ProviderArray.prototype]) {
      const pair = participationHistorySource().state.pair;
      const value = select(pair);
      Object.setPrototypeOf(value, prototype);
      assert.throws(() => validateParticipationHistoryRead(pair), {
        status: 503,
        code: "participation_history_invalid",
      });
      assert.equal(Object.getPrototypeOf(value), prototype);
    }
  }
});

test("ordinary dense frozen history arrays retain known proofs and unresolved-history withholding", async (t) => {
  let supplied = participationHistorySource().state.pair;
  const freezeArrays = (value) => {
    if (value === null || typeof value !== "object") return;
    for (const entry of Object.values(value)) freezeArrays(entry);
    if (Array.isArray(value)) Object.freeze(value);
  };
  freezeArrays(supplied);
  const before = structuredClone(supplied);
  assert.equal(validateParticipationHistoryRead(supplied), supplied);
  const app = createService({ source: { read: async () => null, readParticipationHistory: async () => supplied } });
  t.after(() => app.close());
  const original = (await read(app)).json().history;
  assert.equal(original.state, "known");
  assert.deepEqual((await read(app, proofPath(original))).json().history, original);
  assert.deepEqual(supplied, before);
  assert.ok(Object.isFrozen(supplied.history.proofSources));

  supplied = participationHistorySource().state.pair;
  supplied.history.unresolved.push({ actorId: "101", reason: "withheld" });
  freezeArrays(supplied);
  const history = (await read(app)).json().history;
  assert.equal(history.state, "unknown");
  assert.equal(history.reason, "history_evidence_unavailable");
  assert.equal(history.firstProof, null);
  assert.equal(history.newcomer, null);
  assert.equal((await app.inject(proofPath(original))).statusCode, 409);
  assert.ok(Object.isFrozen(supplied.history.unresolved));
});

test("public results exclude private admission, frozen input and backfill fields and never mutate the provider", async (t) => {
  const { app, pair } = harness(t),
    original = structuredClone(pair);
  const response = await read(app);
  assert.equal(response.headers["cache-control"], "no-store");
  for (const secret of [
    pair.history.admission.decisionId,
    pair.selectedInput.sha256,
    pair.history.dataset.sha256,
    pair.history.dataset.backfillRevision,
    "selectedInput",
    "proofSources",
    "unresolved",
  ])
    assert.equal(response.body.includes(secret), false, secret);
  assert.deepEqual(pair, original);
  const body = response.json();
  body.history.firstProof.proof.artifactId = "changed-consumer-copy";
  assert.notEqual((await read(app)).json().history.firstProof.proof.artifactId, "changed-consumer-copy");
  const conditional = await app.inject({ url: historyPath, headers: { "if-none-match": response.headers.etag } });
  assert.equal(conditional.statusCode, 304);
});

test("the history capability uses the existing cancellation and concurrency budget without a stale fallback", async (t) => {
  const fixture = participationHistorySource();
  let release,
    receivedSignal,
    ordinary = 0;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const app = createService({
    sourceTimeoutMs: 5,
    maxConcurrentReads: 1,
    source: {
      read: async () => {
        ordinary++;
        return fixture.state.pair.current;
      },
      readParticipationHistory: async (_scope, _pin, _actor, signal) => {
        receivedSignal = signal;
        await held;
        return fixture.state.pair;
      },
    },
  });
  t.after(() => app.close());
  const timedOut = await app.inject(historyPath);
  assert.equal(timedOut.statusCode, 503);
  assert.equal(timedOut.json().error, "snapshot_source_timeout");
  assert.equal(receivedSignal.aborted, true);
  assert.equal((await app.inject(historyPath)).statusCode, 429);
  assert.equal(ordinary, 0);
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await app.inject(historyPath)).statusCode, 200);
});

test("fresh provider authority can deny an admission that was revoked while its historical read awaited", async (t) => {
  const fixture = participationHistorySource();
  let release, started;
  const began = new Promise((resolve) => {
    started = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const app = createService({
    source: {
      read: fixture.source.read,
      readParticipationHistory: async (...args) => {
        const captured = await fixture.source.readParticipationHistory(...args);
        started();
        await gate;
        // This is the trusted fixture's final authority fence, not a public Boolean.
        if (!fixture.state.authorized) captured.history = null;
        return captured;
      },
    },
  });
  t.after(() => app.close());
  const request = app.inject(historyPath);
  await began;
  fixture.state.authorized = false;
  release();
  const response = await request;
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().history.reason, "reviewed_history_unavailable");
});

test("private history identifiers and receipt hashes reject terminal newlines without canonicalizing them", async (t) => {
  const { app, pair } = harness(t),
    original = structuredClone(pair.history);
  for (const change of [
    (h) => {
      h.admission.decisionId += "\n";
    },
    (h) => {
      h.dataset.id += "\n";
    },
    (h) => {
      h.dataset.backfillRevision += "\n";
    },
    (h) => {
      h.dataset.sha256 += "\n";
    },
    (h) => {
      h.admission.sourceInventory[0].repositoryId += "\n";
      h.dataset.sourceInventory[0].repositoryId += "\n";
    },
    (h) => {
      h.admission.policies[0].version += "\n";
      h.publication.selected.methodology[0].policyVersion += "\n";
    },
  ]) {
    pair.history = structuredClone(original);
    change(pair.history);
    assert.equal((await app.inject(historyPath)).statusCode, 503);
  }
  pair.history = structuredClone(original);
  for (const suffix of ["%0A", "%0D", "%2Fchild"]) {
    assert.equal(
      (await app.inject(`/api/v1/contributors/101${suffix}/participation-history?${historyQuery}`)).statusCode,
      400,
    );
  }
});

test("the complete public response budget includes metadata and retains a valid large opaque artifact exactly", async (t) => {
  const { app, pair } = harness(t),
    initial = await read(app);
  const first = pair.history.publication.selected.portfolioEvidence[0];
  const length = 1_500_000 - Buffer.byteLength(initial.body) + first.artifact.stableId.length;
  const atLimit = "s".repeat(length);
  first.artifact.stableId = first.contribution.artifactId = atLimit;
  const response = await read(app);
  assert.equal(Buffer.byteLength(response.body), 1_500_000);
  assert.equal(response.json().history.firstProof.proof.artifactId, atLimit);
  first.artifact.stableId = first.contribution.artifactId = atLimit + "x";
  const oversized = await app.inject(historyPath);
  assert.equal(oversized.statusCode, 503);
  assert.equal(oversized.json().error, "participation_history_response_too_large");
  assert.equal(oversized.body.includes(atLimit), false);
});

test("organization history never certifies a bot, automated account or missing historical actor as a newcomer", async (t) => {
  const { app, pair } = harness(t),
    original = structuredClone(pair);
  for (const kind of ["bot", "service_account", "github_app", "organization", "system", "unknown"]) {
    pair.current = structuredClone(original.current);
    pair.history = structuredClone(original.history);
    pair.current.selected.actors[0].actor.kind = kind;
    pair.history.publication.selected.actors[0].actor.kind = kind;
    const value = (await read(app)).json().history;
    assert.equal(value.reason, "qualifying_actor_unavailable");
    assert.equal(value.newcomer, null);
  }
  pair.current = structuredClone(original.current);
  pair.history = structuredClone(original.history);
  pair.current.selected.actors[0].actor.executionMode = "automated";
  assert.equal((await read(app)).json().history.reason, "qualifying_actor_unavailable");
  pair.current = structuredClone(original.current);
  pair.history = structuredClone(original.history);
  pair.history.publication.selected.actors = pair.history.publication.selected.actors.filter(
    (entry) => entry.actorId !== "101",
  );
  assert.equal((await read(app)).json().history.reason, "qualifying_actor_unavailable");
});

test("reversion contribution authority rejects mismatched history before fresh, pinned or conditional proof reads", async (t) => {
  const { app, pair } = harness(t),
    initial = await read(app),
    before = initial.json().history,
    proofId = before.firstProof.proof.contributionId;
  assert.equal(before.state, "known");
  assert.equal(proofId, "synthetic-earlier-review");
  for (const side of ["current", "history"]) {
    delete pair.current.controls.suppressedContributionIds;
    delete pair.history.publication.controls.suppressedContributionIds;
    const controls = side === "current" ? pair.current.controls : pair.history.publication.controls;
    controls.suppressedContributionIds = [proofId];
    assert.equal(pair.current.controls.version, pair.history.publication.controls.version);
    for (const url of [
      historyPath,
      `${historyPath}&snapshot=${pair.current.selected.snapshot.snapshotId}`,
      proofPath(before),
    ]) {
      for (const headers of [{}, { "if-none-match": initial.headers.etag }]) {
        const response = await app.inject({ url, headers });
        assert.equal(response.statusCode, 503, response.body);
        assert.equal(response.json().error, "participation_history_authority_changed");
        assert.equal(response.body.includes(proofId), false);
        assert.equal(response.body.includes("firstProof"), false);
      }
    }
  }
});

test("reversion contribution authority with matching suppression withholds history without promoting later work", async (t) => {
  const { app, pair } = harness(t),
    initial = await read(app),
    before = initial.json().history,
    proofId = before.firstProof.proof.contributionId;
  pair.current.controls.suppressedContributionIds = [proofId];
  pair.history.publication.controls.suppressedContributionIds = [proofId];
  const unchanged = structuredClone(pair);
  const response = await app.inject({ url: historyPath, headers: { "if-none-match": initial.headers.etag } });
  assert.equal(response.statusCode, 200, response.body);
  const after = response.json().history;
  assert.equal(after.state, "unknown");
  assert.equal(after.reason, "history_evidence_unavailable");
  assert.equal(after.firstProof, null);
  assert.equal(after.newcomer, null);
  assert.equal(response.body.includes(proofId), false);
  assert.equal(response.body.includes("synthetic-recent-author"), false);
  assert.equal((await app.inject(proofPath(before))).statusCode, 409);
  assert.equal(
    (await read(app, `${historyPath}&snapshot=${pair.current.selected.snapshot.snapshotId}`)).json().history.firstProof,
    null,
  );
  assert.deepEqual(pair, unchanged);
});

test("reversion contribution authority preserves legacy absence, explicit emptiness and unordered equal sets", async (t) => {
  const { app, pair } = harness(t),
    before = (await read(app)).json().history;
  for (const [current, historical] of [
    [undefined, undefined],
    [undefined, []],
    [[], undefined],
    [[], []],
    [
      ["synthetic-unrelated-a", "synthetic-unrelated-b"],
      ["synthetic-unrelated-b", "synthetic-unrelated-a"],
    ],
  ]) {
    delete pair.current.controls.suppressedContributionIds;
    delete pair.history.publication.controls.suppressedContributionIds;
    if (current !== undefined) pair.current.controls.suppressedContributionIds = [...current];
    if (historical !== undefined) pair.history.publication.controls.suppressedContributionIds = [...historical];
    const unchanged = structuredClone(pair);
    const after = (await read(app)).json().history;
    assert.equal(after.state, "known");
    assert.deepEqual(after.firstProof, before.firstProof);
    assert.deepEqual(pair, unchanged);
  }
});
