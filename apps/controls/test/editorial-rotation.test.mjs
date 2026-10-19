import test from "node:test";
import assert from "node:assert/strict";
import { nominateSpotlight, decideSpotlight, projectSpotlights } from "../src/editorial.mjs";
import {
  proposeRotation,
  decideRotation,
  projectRotation,
  rotationQueue,
  ROTATION_LIMITS,
} from "../src/editorial-rotation.mjs";
import { attachSyntheticEvidenceState } from "../../../tests/fixtures/evidence-intake.mjs";

const owner = { actorId: "1", roles: [] };
const reviewer = { actorId: "2", roles: ["reviewer"] };
const at = Date.parse("2026-10-19T12:00:00.000Z");
const period = { start: "2026-10-01T00:00:00.000Z", end: "2026-10-18T00:00:00.000Z" };
function fixture(count = 1) {
  const state = { profiles: { 1: { public: true, bio: "Consented synthetic bio" } }, audit: [], requests: {} };
  for (let i = 0; i < count; i++) {
    state.requests[`claim-${i}`] = {
      id: `claim-${i}`,
      owner: "1",
      kind: "evidence",
      status: "accepted",
      version: 1,
      scope: "Synthetic reviewed contribution",
      detail: "Private fixture detail",
      policyVersion: "synthetic-policy",
      locator: `https://github.com/synthetic/editorial/issues/${i + 1}`,
      category: "governance",
      collaborators: { 3: "accepted" },
      history: [
        {
          id: `accept-${i}`,
          actor: "2",
          action: "accepted",
          version: 1,
          at: at - 10000,
          policyVersion: "synthetic-policy",
        },
      ],
    };
    state.audit.push(structuredClone(state.requests[`claim-${i}`].history[0]));
  }
  attachSyntheticEvidenceState(state);
  const nominations = Object.keys(state.requests).map((claimId) => {
    const n = nominateSpotlight(state, owner, { claimId, consent: true }, at - 5000);
    decideSpotlight(
      state,
      reviewer,
      n.id,
      {
        version: 1,
        action: "accept",
        reason: "Private original reason",
        publicExplanation: "Original reviewed selection",
        conflict: false,
      },
      at - 4000,
    );
    return n.id;
  });
  return { state, nominations };
}
const proposal = (nominationId, extra = {}) => ({
  nominationId,
  version: null,
  consent: true,
  workstreams: ["Editorial infrastructure"],
  behindScenes: true,
  newcomerPeriod: null,
  ...extra,
});
const decision = (version, extra = {}) => ({
  version,
  action: "accept",
  reason: "Private classification reason",
  publicExplanation: "Explicitly reviewed contribution description",
  conflict: false,
  ...extra,
});
const yes = () => true;
function accept(state, id, extra) {
  const p = proposeRotation(state, owner, proposal(id, extra), at, yes);
  return decideRotation(state, reviewer, id, decision(p.version), at + 1, yes);
}

test("separate consent and independent exact proposal review preserve the original v1 decision", () => {
  const {
    state,
    nominations: [id],
  } = fixture();
  const v1 = projectSpotlights(state, yes);
  const original = structuredClone(state.spotlights);
  for (const bad of [{ consent: false }, { version: 1 }, { historyKey: "a".repeat(64) }, { newcomer: true }]) {
    const before = structuredClone(state);
    assert.throws(() => proposeRotation(state, owner, proposal(id, bad), at, yes));
    assert.deepEqual(state, before);
  }
  const p = proposeRotation(state, owner, proposal(id), at, yes);
  assert.deepEqual(projectRotation(state, yes).candidates, []);
  for (const actor of [
    { ...owner, roles: ["reviewer"] },
    { actorId: "3", roles: ["reviewer"] },
    { actorId: "4", roles: [] },
  ])
    assert.throws(() => decideRotation(state, actor, id, decision(p.version), at + 1, yes), { status: 403 });
  assert.throws(() => decideRotation(state, reviewer, id, decision(p.version, { conflict: true }), at, yes));
  decideRotation(state, reviewer, id, decision(p.version), at + 1, yes);
  const publicItem = projectRotation(state, yes).candidates[0];
  assert.deepEqual(publicItem.workstreams, ["Editorial infrastructure"]);
  assert.equal(publicItem.classificationExplanation, "Explicitly reviewed contribution description");
  assert.equal(JSON.stringify(publicItem).includes("Private"), false);
  assert.equal(Object.hasOwn(publicItem, "historyKey"), false);
  assert.deepEqual(projectSpotlights(state, yes), v1);
  assert.deepEqual(state.spotlights, original);
});

test("declarations retain exact Unicode labels and reject duplicate, empty, oversized and invalid periods", () => {
  for (const fields of [
    { workstreams: [], behindScenes: false },
    { workstreams: ["same", "same"] },
    { workstreams: ["a\nb"] },
    { workstreams: ["\uD800"] },
    { workstreams: ["\uDFFF"] },
    { workstreams: ["a".repeat(101)] },
    { workstreams: Array(5).fill("x") },
    { newcomerPeriod: { ...period, start: period.end } },
    { newcomerPeriod: { ...period, end: "2027-01-01T00:00:00.000Z" } },
    { newcomerPeriod: { ...period, end: "2026-02-30T00:00:00.000Z" } },
    { newcomerPeriod: { ...period, extra: true } },
  ]) {
    const {
      state,
      nominations: [id],
    } = fixture();
    const before = structuredClone(state);
    assert.throws(() => proposeRotation(state, owner, proposal(id, fields), at, yes));
    assert.deepEqual(state, before);
  }
  const {
    state,
    nominations: [id],
  } = fixture();
  accept(state, id, { workstreams: ["é", "e\u0301", "\uD83C\uDF1F", "\uFFFD"], newcomerPeriod: period });
  const record = projectRotation(state, yes).candidates[0];
  assert.notDeepEqual(Buffer.from(record.workstreams[0]), Buffer.from(record.workstreams[1]));
  assert.equal(record.workstreams[2], "🌟");
  assert.equal(record.workstreams[3], "\uFFFD");
  assert.deepEqual(record.newcomerPeriod, period);
});

test("amendment retires approval and preserves immutable prior proposal events", () => {
  const {
    state,
    nominations: [id],
  } = fixture();
  const first = accept(state, id);
  const history = structuredClone(first.history);
  assert.deepEqual(history[0].workstreams, ["Editorial infrastructure"]);
  assert.equal(history[0].behindScenes, true);
  assert.equal(history[0].newcomerPeriod, null);
  assert.equal(history[0].nominationVersion, state.spotlights[id].version);
  const second = proposeRotation(
    state,
    owner,
    proposal(id, { version: first.version, workstreams: ["New explicit label"] }),
    at + 2,
    yes,
  );
  assert.notEqual(second.digest, first.digest);
  assert.equal(second.revision, first.revision + 1);
  assert.deepEqual(second.history.slice(0, history.length), history);
  assert.deepEqual(second.history.at(-1).workstreams, ["New explicit label"]);
  assert.deepEqual(second.history[0].workstreams, ["Editorial infrastructure"]);
  assert.deepEqual(projectRotation(state, yes).candidates, []);
  assert.throws(() => decideRotation(state, reviewer, id, decision(first.version), at + 3, yes), { status: 409 });
  decideRotation(state, reviewer, id, decision(second.version), at + 3, yes);
  assert.deepEqual(projectRotation(state, yes).candidates[0].workstreams, ["New explicit label"]);
});

test("source, consent, intake, nomination and claim changes suppress admitted dimensions on every read", () => {
  for (const change of ["source", "async-source", "claim", "nomination", "suppression", "consent", "intake"]) {
    const {
      state,
      nominations: [id],
    } = fixture();
    accept(state, id);
    let gate = yes;
    if (change === "source") gate = () => false;
    if (change === "async-source") gate = async () => true;
    if (change === "claim") state.requests["claim-0"].version++;
    if (change === "nomination") state.spotlights[id].version++;
    if (change === "suppression") state.profiles[1].suppressed = true;
    if (change === "consent") state.requests["claim-0"].collaborators[3] = "declined";
    if (change === "intake") delete state.requests["claim-0"].intake;
    assert.deepEqual(projectRotation(state, gate).candidates, [], change);
  }
});

test("withdrawal remains available after lost eligibility and amendment capacity without changing v1 consent", () => {
  const {
    state,
    nominations: [id],
  } = fixture();
  const accepted = accept(state, id);
  const record = state.spotlightRotations[id];
  while (record.history.length < ROTATION_LIMITS.events) record.history.unshift(structuredClone(record.history[0]));
  state.requests["claim-0"].version++;
  state.spotlights[id].version++;
  state.profiles[1].suppressed = true;
  const originalNomination = structuredClone(state.spotlights[id]);
  assert.throws(() => proposeRotation(state, owner, proposal(id, { version: accepted.version }), at, yes));
  const withdrawn = decideRotation(
    state,
    owner,
    id,
    { version: accepted.version, action: "withdraw", reason: "Stop this separate consent" },
    at + 4,
    () => {
      throw Error("Must not call source for withdrawal");
    },
  );
  assert.equal(withdrawn.status, "withdrawn");
  assert.equal(withdrawn.history.length, ROTATION_LIMITS.events + 1);
  assert.deepEqual(state.spotlights[id], originalNomination);
  assert.deepEqual(projectRotation(state, yes).candidates, []);
});

test("accepted and history capacity refuse admission rather than serving a prefix and recover after withdrawal", () => {
  const { state, nominations } = fixture(ROTATION_LIMITS.accepted + 1);
  for (const [index, id] of nominations.slice(0, ROTATION_LIMITS.accepted).entries())
    accept(state, id, { newcomerPeriod: index < ROTATION_LIMITS.history ? period : null });
  const last = nominations.at(-1);
  const pending = proposeRotation(state, owner, proposal(last), at, yes);
  assert.throws(() => decideRotation(state, reviewer, last, decision(pending.version), at, yes), /capacity/);
  assert.equal(projectRotation(state, yes).candidates.length, ROTATION_LIMITS.accepted);
  const removed = state.spotlightRotations[nominations[8]];
  decideRotation(
    state,
    owner,
    removed.id,
    { version: removed.version, action: "withdraw", reason: "Free admitted space" },
    at,
  );
  const amended = proposeRotation(
    state,
    owner,
    proposal(last, { version: pending.version, newcomerPeriod: period }),
    at,
    yes,
  );
  assert.throws(
    () => decideRotation(state, reviewer, last, decision(amended.version), at, yes),
    /History assessment capacity/,
  );
  const history = state.spotlightRotations[nominations[0]];
  decideRotation(
    state,
    owner,
    history.id,
    { version: history.version, action: "withdraw", reason: "Withdraw assessment" },
    at,
  );
  decideRotation(state, reviewer, last, decision(amended.version), at, yes);
  assert.equal(projectRotation(state, yes).candidates.filter((r) => r.newcomerPeriod).length, ROTATION_LIMITS.history);
});

test("tampered retained declarations fail closed and private queue access is owner or reviewer only", () => {
  const {
    state,
    nominations: [id],
  } = fixture();
  accept(state, id);
  assert.equal(rotationQueue(state, owner).records.length, 1);
  assert.equal(rotationQueue(state, reviewer).records.length, 1);
  assert.deepEqual(rotationQueue(state, { actorId: "8", roles: ["operator"] }).records, []);
  state.spotlightRotations[id].workstreams = ["Unreviewed replacement"];
  assert.throws(() => projectRotation(state, yes), { status: 503 });
});

test("review context exposes exact bound versions and digest while unavailable source never traps withdrawal", () => {
  const {
    state,
    nominations: [id],
  } = fixture();
  const proposalRecord = proposeRotation(state, owner, proposal(id), at, yes);
  const view = rotationQueue(state, reviewer, yes).records[0];
  assert.equal(view.claimId, proposalRecord.claimId);
  assert.equal(view.claimVersion, proposalRecord.claimVersion);
  assert.equal(view.nominationVersion, proposalRecord.nominationVersion);
  assert.equal(view.digest, proposalRecord.digest);
  assert.deepEqual(view.currentContext, {
    state: "current",
    sourceUrl: state.requests[view.claimId].locator,
    category: "governance",
    selectionExplanation: "Original reviewed selection",
    selectedAt: new Date(at - 4000).toISOString(),
  });
  for (const gate of [
    () => false,
    () => {
      throw new Error("Current source unavailable");
    },
  ]) {
    const pending = rotationQueue(state, owner, gate).records[0];
    assert.deepEqual(pending.currentContext, { state: "unavailable" });
    assert.equal(pending.digest, proposalRecord.digest);
  }
  state.spotlights[id].version++;
  assert.deepEqual(rotationQueue(state, reviewer, yes).records[0].currentContext, { state: "unavailable" });
  assert.throws(() => decideRotation(state, reviewer, id, decision(proposalRecord.version), at, yes), { status: 409 });
  assert.equal(
    decideRotation(
      state,
      owner,
      id,
      { version: proposalRecord.version, action: "withdraw", reason: "Retire unavailable consent" },
      at,
    ).status,
    "withdrawn",
  );
});

test("the 256 retained-record limit refuses a new record without deleting history or trapping final withdrawal", () => {
  const { state, nominations } = fixture(ROTATION_LIMITS.retained + 1);
  for (const id of nominations.slice(0, ROTATION_LIMITS.retained)) proposeRotation(state, owner, proposal(id), at, yes);
  const before = structuredClone(state);
  assert.throws(() => proposeRotation(state, owner, proposal(nominations.at(-1)), at, yes), { status: 503 });
  assert.deepEqual(state, before);
  assert.equal(rotationQueue(state, owner, () => false).records.length, 256);
  const record = state.spotlightRotations[nominations[0]];
  decideRotation(
    state,
    owner,
    record.id,
    { version: record.version, action: "withdraw", reason: "Withdraw at retained capacity" },
    at,
  );
  assert.equal(Object.keys(state.spotlightRotations).length, 256);
  assert.equal(state.spotlightRotations[record.id].status, "withdrawn");
  assert.deepEqual(
    state.spotlightRotations[record.id].history.slice(0, 1),
    before.spotlightRotations[record.id].history,
  );
});
