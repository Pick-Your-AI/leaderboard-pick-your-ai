import test from "node:test";
import assert from "node:assert/strict";
import { orderingControls, orderingReview } from "../../../tests/fixtures/ordering.mjs";
import { hasReviewedEvidenceIntake } from "../src/evidence-intake.mjs";
import { projectPublic } from "../src/store.mjs";

test("protected ordering acceptance requires its typed current review without changing pending state", async (t) => {
  const h = await orderingControls(t),
    owner = await h.login("101"),
    reviewer = await h.login("202");
  const request = await h.submit(owner),
    input = orderingReview(request);
  delete input.ordering;
  const before = h.store.read();
  const result = await h.call(`/controls/requests/${request.id}/review`, { user: reviewer, input });
  assert.equal(result.status, 400);
  assert.deepEqual(h.store.read(), before);
});

test("protected ordering review requires actual collaborator consent and stores one detached audited descriptor", async (t) => {
  const h = await orderingControls(t),
    owner = await h.login("101"),
    collaborator = await h.login("303"),
    reviewer = await h.login("202");
  let request = await h.submit(owner, { collaborators: ["303"] });
  const unconsented = await h.call(`/controls/requests/${request.id}/review`, {
    user: reviewer,
    input: orderingReview(request),
  });
  assert.equal(unconsented.status, 409);
  const invitations = await h.call("/controls/invitations", { user: collaborator }),
    invitation = invitations.data.invitations.find((entry) => entry.id === request.id);
  const consent = await h.call(`/controls/requests/${request.id}/consent`, {
    user: collaborator,
    input: {
      version: request.version,
      consent: true,
      claimDigest: invitation.claimDigest,
      termsVersion: invitation.terms.version,
      termsDigest: invitation.terms.digest,
    },
  });
  assert.equal(consent.status, 200);
  request = h.store.read().requests[request.id];
  const input = orderingReview(request),
    submitted = structuredClone(input);
  const accepted = await h.call(`/controls/requests/${request.id}/review`, { user: reviewer, input });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.data));
  input.ordering.after.items.reverse();
  input.ordering.scope.id = "MUTATED_CALLER";
  const state = h.store.read(),
    stored = state.requests[request.id],
    decision = stored.history.at(-1);
  assert.deepEqual(decision.ordering, submitted.ordering);
  assert.deepEqual(
    state.audit.filter((event) => event.id === decision.id),
    [decision],
  );
  assert.equal(decision.version, stored.version);
  assert.equal(decision.receipt, request.id);
  assert.equal(hasReviewedEvidenceIntake(stored), true);
  state.profiles["101"] = { public: true };
  state.profiles["303"] = { public: true };
  assert.equal(projectPublic(state).claims.length, 1);
  assert.doesNotMatch(
    JSON.stringify(projectPublic(state)),
    /CHILD_1|PRIVATE_ORDERING_DETAIL|ordering-review\/v1|ordering_contributor/,
  );
  const withdrawn = await h.call(`/controls/requests/${request.id}/withdraw`, {
    user: owner,
    input: { version: stored.version },
  });
  assert.equal(withdrawn.status, 200);
  assert.equal(h.store.read().requests[request.id].status, "withdrawn");
  assert.equal(projectPublic(h.store.read()).claims.length, 0);
});

test("protected review rejects malformed mismatched automated and cross-category descriptors without a write", async (t) => {
  const h = await orderingControls(t),
    owner = await h.login("101"),
    reviewer = await h.login("202"),
    request = await h.submit(owner);
  const changes = [
    (r) => {
      r.ordering.actorId = "303";
    },
    (r) => {
      r.ordering.requestId = "another-request";
    },
    (r) => {
      r.ordering.claimDigest = "a".repeat(64);
    },
    (r) => {
      r.ordering.method = "automatic_sort";
    },
    (r) => {
      r.ordering.contributorRole = "observer";
    },
    (r) => {
      r.ordering.after.items = [...r.ordering.before.items];
    },
    (r) => {
      r.ordering.before.items.pop();
    },
    (r) => {
      r.sourceUseReview.references[0].revision = "c".repeat(40);
    },
    (r) => {
      r.sourceUseReview.references.pop();
    },
    (r) => {
      r.decision = "reject";
      delete r.sourceUseReview;
    },
  ];
  for (const change of changes) {
    const input = orderingReview(request);
    change(input);
    const before = h.store.read();
    const result = await h.call(`/controls/requests/${request.id}/review`, { user: reviewer, input });
    assert.equal(result.status, 400, JSON.stringify(result.data));
    assert.deepEqual(h.store.read(), before);
  }
  const other = await h.submit(owner, { category: "governance" });
  const result = await h.call(`/controls/requests/${other.id}/review`, {
    user: reviewer,
    input: orderingReview(other),
  });
  assert.equal(result.status, 400);
  const valid = await h.call(`/controls/requests/${request.id}/review`, {
    user: reviewer,
    input: orderingReview(request),
  });
  assert.equal(valid.status, 200);
});
