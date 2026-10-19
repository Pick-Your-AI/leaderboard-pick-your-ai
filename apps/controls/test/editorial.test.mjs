import test from "node:test";
import assert from "node:assert/strict";
import { nominateSpotlight, decideSpotlight, projectSpotlights } from "../src/editorial.mjs";
import { attachSyntheticEvidenceState } from "../../../tests/fixtures/evidence-intake.mjs";

const owner = { actorId: "1", roles: [] };
const reviewer = { actorId: "2", roles: ["reviewer"] };
function legacyFixture() {
  return {
    profiles: { 1: { public: true, bio: "Explicit profile text" } },
    audit: [],
    requests: {
      claim: {
        id: "claim",
        owner: "1",
        kind: "evidence",
        status: "accepted",
        version: 2,
        history: [{ action: "accepted", version: 2 }],
        collaborators: { 3: "accepted" },
        locator: "https://github.com/synthetic/example/issues/1",
        category: "governance",
      },
    },
  };
}
function fixture() {
  const state = legacyFixture();
  const claim = state.requests.claim;
  Object.assign(claim, {
    scope: "One synthetic governance decision record",
    detail: "Synthetic private source-use detail",
    policyVersion: "synthetic-editorial-1",
  });
  Object.assign(claim.history[0], {
    id: "synthetic-independent-claim-review",
    receipt: claim.id,
    actor: "2",
    at: 900,
    policyVersion: claim.policyVersion,
  });
  state.audit = [structuredClone(claim.history[0])];
  attachSyntheticEvidenceState(state);
  return state;
}
const accept = {
  version: 1,
  action: "accept",
  reason: "Private selection audit reason",
  publicExplanation: "Reviewed public decision record explains the outcome",
  conflict: false,
};

test("pre-intake accepted evidence cannot be promoted into a new editorial selection", () => {
  const state = legacyFixture();
  const before = structuredClone(state);
  assert.throws(() => nominateSpotlight(state, owner, { claimId: "claim", consent: true }, 1000), {
    status: 409,
    message: "Current claim-scoped intake and source-use review required",
  });
  assert.deepEqual(state, before, "An old acceptance must not be silently migrated during nomination");
  assert.deepEqual(projectSpotlights(state, () => true).spotlights, []);
});

test("legacy incomplete or later participant consent cannot nominate, approve or serve a spotlight", () => {
  for (const disposition of ["pending", "declined", "late-consent", "unknown-version"]) {
    const state = fixture();
    const entry = nominateSpotlight(state, owner, { claimId: "claim", consent: true }, 1000);
    const approved = structuredClone(state);
    decideSpotlight(approved, reviewer, entry.id, accept, 2000);
    for (const candidate of [state, approved]) {
      const claim = candidate.requests.claim;
      if (disposition === "late-consent") claim.history[0].version = 1;
      else if (disposition === "unknown-version") delete claim.history[0].version;
      else claim.collaborators["3"] = disposition;
      assert.throws(
        () => nominateSpotlight(candidate, owner, { claimId: "claim", consent: true }, 3000),
        /participant consent and review/,
      );
      assert.deepEqual(projectSpotlights(candidate, () => true).spotlights, []);
    }
    assert.throws(() => decideSpotlight(state, reviewer, entry.id, accept, 4000), /participant consent and review/);
  }
});

test("spotlights require contributor opt-in and independent selection of current accepted evidence", () => {
  const state = fixture();
  assert.throws(() => nominateSpotlight(state, owner, { claimId: "claim", consent: false }, 1000));
  const entry = nominateSpotlight(state, owner, { claimId: "claim", consent: true }, 1000);
  assert.deepEqual(projectSpotlights(state, () => true).spotlights, []);
  assert.throws(() => decideSpotlight(state, { ...owner, roles: ["reviewer"] }, entry.id, accept, 2000));
  assert.throws(() => decideSpotlight(state, { actorId: "3", roles: ["reviewer"] }, entry.id, accept, 2000));
  assert.throws(() => decideSpotlight(state, reviewer, entry.id, { ...accept, conflict: true }, 2000));
  decideSpotlight(state, reviewer, entry.id, accept, 2000);
  const output = projectSpotlights(state, () => true).spotlights[0];
  assert.equal(output.selectionExplanation, accept.publicExplanation);
  assert.equal(output.bio, "Explicit profile text");
  assert.match(output.label, /not a computed ranking/);
  assert.equal(output.sourceUrl, state.requests.claim.locator);
  assert.equal(JSON.stringify(output).includes('"actor":"2"'), false);
  state.profiles["1"].public = false;
  assert.equal(projectSpotlights(state, () => true).spotlights[0].bio, null);
  state.profiles["1"].suppressed = true;
  assert.deepEqual(projectSpotlights(state, () => true).spotlights, []);
  state.profiles["1"].suppressed = false;
  state.requests.claim.version++;
  assert.deepEqual(projectSpotlights(state, () => true).spotlights, []);
});

test("withdrawal, evidence revocation, stale selection and rejection never retain a public spotlight", () => {
  for (const change of ["withdrawal", "revocation", "rejection"]) {
    const state = fixture();
    const entry = nominateSpotlight(state, owner, { claimId: "claim", consent: true }, 1000);
    decideSpotlight(
      state,
      reviewer,
      entry.id,
      { ...accept, action: change === "rejection" ? "reject" : "accept" },
      2000,
    );
    if (change === "withdrawal")
      decideSpotlight(state, owner, entry.id, { version: 2, action: "withdraw", reason: "Opt out" }, 3000);
    if (change === "revocation") state.requests.claim.status = "withdrawn";
    assert.deepEqual(projectSpotlights(state, () => true).spotlights, []);
    assert.throws(() => decideSpotlight(state, reviewer, entry.id, accept, 4000));
  }
});

test("editorial source eligibility defaults denied and current revocation removes selection", () => {
  const state = fixture();
  const entry = nominateSpotlight(state, owner, { claimId: "claim", consent: true }, 1000);
  decideSpotlight(state, reviewer, entry.id, accept, 2000);
  assert.deepEqual(projectSpotlights(state).spotlights, []);
  assert.deepEqual(projectSpotlights(state, () => false).spotlights, []);
  assert.deepEqual(projectSpotlights(state, async () => true).spotlights, []);
});
