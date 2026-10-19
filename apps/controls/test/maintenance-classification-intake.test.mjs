import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyRecognitionReceipt } from "@pick-your-ai/github";
import { ControlStore } from "../src/store.mjs";
import { createControlsServer } from "../src/server.mjs";
import { materializeRecognition } from "../../pipeline/src/recognition-adapter.mjs";
import {
  syntheticEvidenceIntakeInput,
  syntheticSourceUseReviewInput,
} from "../../../tests/fixtures/evidence-intake.mjs";
import {
  maintenanceClassificationScenario,
  mergeTime,
  reviewTime,
  classificationCutoff,
} from "../../../tests/fixtures/maintenance-classification.mjs";

// Fictional source observations and OAuth identities only. Every acceptance
// below is created by the actual localhost HTTP service and persisted in its
// private SQLite store; the fixture's preaccepted request/state is never used.
const origin = "https://maintenance-intake.example.test";
const publicReasons = () => ["public_accepted_work"];

async function harness(t, fixture) {
  const directory = mkdtempSync(join(tmpdir(), "leaderboard-maintenance-intake-"));
  const filename = join(directory, "private.sqlite");
  const challenges = new Set();
  const authorities = new Map([
    [fixture.binding.reviewerIds[0], { roles: ["reviewer"], version: "reviewer-role-1" }],
    ["4", { roles: ["privacy"], version: "privacy-role-1" }],
  ]);
  let timestamp = Date.parse(reviewTime);
  const provider = {
    authorizationURL({ state, challenge, redirectURI }) {
      assert.equal(redirectURI, origin + "/controls/auth/callback");
      challenges.add(challenge);
      return "https://github.com/login/oauth/authorize?" + new URLSearchParams({ state });
    },
    async exchange({ code, verifier, redirectURI }) {
      assert.equal(redirectURI, origin + "/controls/auth/callback");
      assert.ok(challenges.delete(createHash("sha256").update(verifier).digest("base64url")));
      return { actorId: code };
    },
  };
  let store, server, base;
  async function start() {
    store = new ControlStore(filename);
    server = createControlsServer({
      store,
      provider,
      origin,
      approvedPolicyVersions: [fixture.binding.policyVersion],
      spotlightEligibility: () => true,
      rolesForActor: (id) => authorities.get(id) ?? { roles: [], version: "participant-role-1" },
      now: () => timestamp,
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    base = `http://127.0.0.1:${server.address().port}`;
  }
  async function stop() {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
      server = undefined;
    }
    store?.close();
    store = undefined;
  }
  t.after(async () => {
    await stop();
    rmSync(directory, { recursive: true, force: true });
  });
  await start();
  async function call(path, { user, method = "GET", input, headers = {} } = {}) {
    return new Promise((resolve, reject) => {
      const request = httpRequest(
        base + path,
        {
          method,
          headers: {
            connection: "close",
            ...(user ? { cookie: user.cookie, origin, "x-csrf-token": user.csrf } : {}),
            ...(input === undefined ? {} : { "content-type": "application/json" }),
            ...headers,
          },
        },
        (response) => {
          const chunks = [];
          response.on("data", (chunk) => chunks.push(chunk));
          response.on("error", reject);
          response.on("end", () => {
            try {
              const text = Buffer.concat(chunks).toString();
              resolve({
                status: response.statusCode,
                headers: response.headers,
                text,
                data: response.headers["content-type"]?.includes("application/json") ? JSON.parse(text) : undefined,
              });
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      request.on("error", reject);
      request.setTimeout(5_000, () => request.destroy(new Error("Synthetic intake request timed out")));
      request.end(input === undefined ? undefined : JSON.stringify(input));
    });
  }
  async function login(id) {
    const begin = await call("/controls/auth/login");
    assert.equal(begin.status, 302);
    const state = new URL(begin.headers.location).searchParams.get("state");
    const callback = await call("/controls/auth/callback?" + new URLSearchParams({ state, code: id }), {
      headers: { cookie: begin.headers["set-cookie"][0].split(";")[0] },
    });
    assert.equal(callback.status, 303);
    const cookie = callback.headers["set-cookie"]
      .find((value) => value.startsWith("__Host-controls_session="))
      .split(";")[0];
    const session = await call("/controls/session", { headers: { cookie } });
    assert.equal(session.status, 200);
    assert.equal(session.data.actorId, id);
    return { cookie, csrf: session.data.csrf, actorId: id };
  }
  return {
    call,
    login,
    authorities,
    get now() {
      return timestamp;
    },
    advance(milliseconds = 1_000) {
      timestamp += milliseconds;
    },
    get store() {
      return store;
    },
    async reopen() {
      await stop();
      await start();
    },
  };
}

function requestInput(fixture, collaborators = [], detail = JSON.stringify(fixture.record)) {
  return {
    kind: "evidence",
    locator: fixture.evidence.artifact.publicUrl,
    category: "other",
    scope: "repository:2:maintenance:classification",
    collaborators,
    consent: true,
    detail,
    intake: syntheticEvidenceIntakeInput(collaborators),
  };
}
async function scenario(t, { kinds = ["dependency_maintenance"], collaborators = [], detail, mutate } = {}) {
  const fixture = maintenanceClassificationScenario({ kinds });
  if (mutate) mutate(fixture.record);
  const h = await harness(t, fixture);
  h.fixture = fixture;
  h.owner = await h.login(fixture.target.actorId);
  h.reviewer = await h.login(fixture.binding.reviewerIds[0]);
  h.input = requestInput(fixture, collaborators, detail);
  const submitted = await h.call("/controls/requests", { user: h.owner, method: "POST", input: h.input });
  assert.equal(submitted.status, 201, submitted.text);
  h.receipt = submitted.data;
  return h;
}
const stored = (h) => h.store.read().requests[h.receipt.id];
async function change(h, action, user, input = {}) {
  const response = await h.call("/controls/requests/" + h.receipt.id + "/" + action, {
    user,
    method: "POST",
    input: { version: stored(h).version, ...input },
  });
  if (response.status === 200) h.receipt = response.data;
  return response;
}
function review(h, overrides = {}, user = h.reviewer) {
  return change(h, "review", user, {
    decision: "accept",
    conflict: false,
    reason: "PRIVATE_MAINTENANCE_REVIEW_REASON",
    sourceReviewedPublic: true,
    policyVersion: h.fixture.binding.policyVersion,
    sourceUseReview: syntheticSourceUseReviewInput({
      rationale: "PRIVATE_MAINTENANCE_SOURCE_USE",
      references: [{ locator: h.input.locator, revision: h.fixture.evidence.sourceRevision }],
    }),
    ...overrides,
  });
}
function materialize(h, state = h.store.read()) {
  let calls = 0;
  const original = structuredClone(h.fixture.input);
  const output = materializeRecognition(
    h.fixture.input,
    state,
    [h.fixture.binding],
    h.fixture.policies,
    (...args) => {
      calls++;
      return applyRecognitionReceipt(...args);
    },
    classificationCutoff,
    publicReasons,
  );
  assert.deepEqual(h.fixture.input, original, "Materialization must not change the immutable source");
  return { output, calls };
}
function withheld(h, state) {
  const result = materialize(h, state);
  assert.equal(result.calls, 0, "Ineligible current authority must stop before the host receipt callback");
  assert.deepEqual(result.output, h.fixture.input);
}
function classified(h, kinds) {
  const { output, calls } = materialize(h);
  assert.equal(calls, 1);
  const facts = output.facts.filter((fact) => fact.metricId === "maintenance");
  assert.equal(facts.length, 1, "Classification must preserve one PR/actor contribution");
  const fact = facts[0];
  assert.equal(fact.actorId, h.fixture.target.actorId);
  assert.equal(fact.role, "author");
  assert.equal(fact.occurredAt, mergeTime);
  assert.equal(fact.acceptedAt, new Date(h.now).toISOString());
  const evidence = output.evidence.find((entry) => entry.contribution.contributionId === fact.id);
  assert.equal(evidence.sourceRevision, "collection-scan:maintenance-7");
  assert.deepEqual(evidence.contribution.reasonCodes, [
    "independent_recognition_receipt",
    ...(kinds.length ? ["maintenance_classification_policy:maintenance-classification/v1"] : []),
    ...[...kinds].sort().map((kind) => "maintenance_kind:" + kind),
    "public_accepted_work",
  ]);
  return { fact, evidence };
}
async function denyWithoutMutation(h, operation, status) {
  const state = h.store.read(),
    publication = h.store.publicSnapshot();
  const response = await operation();
  assert.equal(response.status, status, response.text);
  assert.deepEqual(h.store.read(), state);
  assert.deepEqual(h.store.publicSnapshot(), publication);
  withheld(h);
}
async function publicClaims(h) {
  const response = await h.call("/controls/public");
  assert.equal(response.status, 200, response.text);
  for (const privateValue of [
    h.input.detail,
    h.fixture.evidence.sourceRevision,
    "PRIVATE_MAINTENANCE_SOURCE_USE",
    "PRIVATE_MAINTENANCE_REVIEW_REASON",
    "reviewedInputDigest",
    "sourceUseReview",
    "classifications",
  ])
    assert.ok(
      !response.text.includes(privateValue),
      "Private classification input must not enter the claim projection",
    );
  return response.data.claims;
}

for (const kind of ["dependency_maintenance", "build_fix", "accepted_bug_fix"]) {
  test(
    "maintenance intake HTTP: independently reviewed " + kind + " adds only fixed public classification codes",
    async (t) => {
      const h = await scenario(t, { kinds: [kind] });
      withheld(h);
      assert.equal((await review(h)).status, 200);
      const protectedView = await h.call("/controls/requests/" + h.receipt.id, { user: h.owner });
      assert.equal(protectedView.status, 200);
      assert.equal(protectedView.data.detail, h.input.detail);
      assert.equal((await publicClaims(h)).length, 1);
      classified(h, [kind]);
    },
  );
}
test("maintenance intake HTTP: all reviewed facets survive a SQLite reopen without multiplying the merged contribution", async (t) => {
  const kinds = ["dependency_maintenance", "build_fix", "accepted_bug_fix"];
  const h = await scenario(t, { kinds });
  assert.equal((await review(h)).status, 200);
  const accepted = stored(h),
    before = h.store.read();
  await h.reopen();
  assert.deepEqual(h.store.read(), before);
  assert.deepEqual(stored(h), accepted);
  assert.equal((await publicClaims(h)).length, 1);
  classified(h, ["accepted_bug_fix", "build_fix", "dependency_maintenance"]);
});
test("maintenance intake HTTP: ordinary reviewed narrative and suggestive source labels remain unclassified", async (t) => {
  const h = await scenario(t, { detail: "Reviewed maintenance with no structured classification." });
  assert.equal((await review(h)).status, 200);
  classified(h, []);
});
test("maintenance intake HTTP: a pending request cannot grant classification or call the receipt adapter", async (t) => {
  const h = await scenario(t);
  assert.equal(stored(h).status, "pending");
  withheld(h);
  assert.deepEqual(await publicClaims(h), []);
});
test("maintenance intake HTTP: a participant decline prevents acceptance and leaves source maintenance unqualified", async (t) => {
  const h = await scenario(t, { collaborators: ["303"] });
  const peer = await h.login("303");
  const decline = await change(h, "consent", peer, { consent: false });
  assert.equal(decline.status, 200, decline.text);
  assert.equal(stored(h).collaborators["303"], "declined");
  await denyWithoutMutation(h, () => review(h), 409);
});
test("maintenance intake HTTP: a rejected request cannot become classified maintenance", async (t) => {
  const h = await scenario(t);
  const rejected = await change(h, "review", h.reviewer, {
    decision: "reject",
    conflict: false,
    reason: "Synthetic evidence not accepted",
  });
  assert.equal(rejected.status, 200, rejected.text);
  assert.equal(stored(h).status, "rejected");
  withheld(h);
});
test("maintenance intake HTTP: unapproved policy cannot create current reviewed classification authority", async (t) => {
  const h = await scenario(t);
  await denyWithoutMutation(h, () => review(h, { policyVersion: "unapproved-classification-policy" }), 409);
});
test("maintenance intake HTTP: the submitter cannot serve as their independent reviewer", async (t) => {
  const h = await scenario(t);
  await denyWithoutMutation(h, () => review(h, {}, h.owner), 403);
});
test("maintenance intake HTTP: missing source-use references cannot create accepted classification authority", async (t) => {
  const h = await scenario(t);
  await denyWithoutMutation(h, () => review(h, { sourceUseReview: undefined }), 400);
});
test("maintenance intake HTTP: an amended facet needs a fresh detail-bound review before it can replace the prior classification", async (t) => {
  const h = await scenario(t);
  assert.equal((await review(h)).status, 200);
  const accepted = stored(h),
    priorDecision = structuredClone(accepted.history.at(-1));
  h.advance();
  const nextRecord = structuredClone(h.fixture.record);
  nextRecord.classifications[0].kind = "build_fix";
  const { kind: _kind, ...input } = requestInput(h.fixture, [], JSON.stringify(nextRecord));
  const amended = await change(h, "amend", h.owner, { ...input, reason: "Synthetic revised classification" });
  assert.equal(amended.status, 200, amended.text);
  assert.equal(stored(h).status, "pending");
  assert.notEqual(stored(h).intake.claimDigest, accepted.intake.claimDigest);
  assert.deepEqual(
    stored(h).history.find((entry) => entry.id === priorDecision.id),
    priorDecision,
  );
  withheld(h);
  assert.deepEqual(await publicClaims(h), []);
  h.input.detail = input.detail;
  assert.equal((await review(h)).status, 200);
  assert.notEqual(
    stored(h).history.at(-1).sourceUseReview.reviewedInputDigest,
    priorDecision.sourceUseReview.reviewedInputDigest,
  );
  classified(h, ["build_fix"]);
});
test("maintenance intake HTTP: retained accepted detail changed without review is withheld through SQLite reopen", async (t) => {
  const h = await scenario(t);
  assert.equal((await review(h)).status, 200);
  const state = h.store.read(),
    request = state.requests[h.receipt.id];
  const decision = structuredClone(request.history.at(-1));
  const changed = JSON.parse(request.detail);
  changed.classifications[0].kind = "accepted_bug_fix";
  request.detail = JSON.stringify(changed);
  // Emulate a corrupted/older private store without forging a new acceptance.
  // The existing public projection is deliberately left present for its read fence.
  h.store.db.prepare("UPDATE controls_state SET document=? WHERE id=1").run(JSON.stringify(state));
  withheld(h);
  assert.deepEqual(await publicClaims(h), []);
  await h.reopen();
  assert.equal(stored(h).detail, request.detail);
  assert.deepEqual(stored(h).history.at(-1), decision);
  withheld(h);
  assert.deepEqual(await publicClaims(h), []);
});
for (const [label, configure] of [
  [
    "unsupported supplied JSON schema",
    () => ({
      mutate: (record) => {
        record.schemaVersion = "maintenance-classification/v2";
      },
    }),
  ],
  ["reviewed reference mismatch", () => ({})],
]) {
  test("maintenance intake HTTP: " + label + " fails classification before the host receipt callback", async (t) => {
    const h = await scenario(t, configure());
    const overrides =
      label === "reviewed reference mismatch"
        ? {
            sourceUseReview: syntheticSourceUseReviewInput({
              references: [{ locator: h.input.locator, revision: "different-reviewed-revision" }],
            }),
          }
        : {};
    const accepted = await review(h, overrides);
    assert.equal(accepted.status, 200, accepted.text);
    const state = h.store.read(),
      original = structuredClone(h.fixture.input);
    let calls = 0;
    assert.throws(
      () =>
        materializeRecognition(
          h.fixture.input,
          state,
          [h.fixture.binding],
          h.fixture.policies,
          (input) => {
            calls++;
            return input;
          },
          classificationCutoff,
          publicReasons,
        ),
      /maintenance.classification/i,
    );
    assert.equal(calls, 0);
    assert.deepEqual(h.fixture.input, original);
    assert.deepEqual(h.store.read(), state);
  });
}
