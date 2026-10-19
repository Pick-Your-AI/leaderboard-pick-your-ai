import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlStore } from "../src/store.mjs";
import { createControlsServer } from "../src/server.mjs";
import { applyRecognitionReceipt } from "@pick-your-ai/github";
import { materializeRecognition } from "../../pipeline/src/recognition-adapter.mjs";
import { publicDocumentationReasons } from "@pick-your-ai/contracts";
import {
  syntheticEvidenceIntakeInput,
  syntheticSourceUseReviewInput,
} from "../../../tests/fixtures/evidence-intake.mjs";
import {
  authoredNotesScenario,
  authoredNotesProof,
  notesAcceptedReasons,
  notesMergeTime,
  notesReviewTime,
  notesCutoff,
} from "../../../tests/fixtures/authored-release-notes.mjs";

// Fictional source and OAuth only. Every current request/acceptance below is
// created through actual localhost HTTP and retained in the private SQLite store.
const origin = "https://authored-notes-intake.example.test";
const reviewTime = notesReviewTime;
async function harness(t, fixture) {
  const directory = mkdtempSync(join(tmpdir(), "leaderboard-authored-notes-intake-"));
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

function requestInput(fixture, collaborators = [], detail = JSON.stringify(fixture.purpose)) {
  return {
    kind: "evidence",
    locator: fixture.evidence.artifact.publicUrl,
    category: "other",
    scope: fixture.binding.scope,
    collaborators,
    consent: true,
    detail,
    intake: syntheticEvidenceIntakeInput(collaborators),
  };
}
async function scenario(t, { collaborators = [] } = {}) {
  const fixture = authoredNotesScenario(),
    h = await harness(t, fixture);
  h.fixture = fixture;
  h.owner = await h.login(fixture.target.actorId);
  h.reviewer = await h.login(fixture.binding.reviewerIds[0]);
  h.input = requestInput(fixture, collaborators);
  const response = await h.call("/controls/requests", { user: h.owner, method: "POST", input: h.input });
  assert.equal(response.status, 201, response.text);
  h.receipt = response.data;
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
    reason: "PRIVATE_AUTHORED_NOTES_REVIEW",
    sourceReviewedPublic: true,
    policyVersion: h.fixture.binding.policyVersion,
    sourceUseReview: syntheticSourceUseReviewInput({
      rationale: "PRIVATE_NOTES_SOURCE_USE",
      references: [{ locator: h.fixture.evidence.sourceRevisionUrl, revision: h.fixture.evidence.sourceRevision }],
    }),
    ...overrides,
  });
}
function materialize(h) {
  const state = h.store.read(),
    request = state.requests[h.receipt.id],
    decision = request.history.findLast((x) => x.action === "accepted");
  const binding = structuredClone(h.fixture.binding);
  // Read actual current HTTP-created authority; this record cannot create an acceptance.
  binding.domainEvidence.records = [
    {
      ...structuredClone(h.fixture.record),
      requestId: request.id,
      requestVersion: request.version,
      decisionId: decision?.id ?? h.fixture.record.decisionId,
    },
  ];
  let calls = 0;
  const original = structuredClone(h.fixture.input);
  const output = materializeRecognition(
    h.fixture.input,
    state,
    [binding],
    h.fixture.policies,
    (...args) => {
      calls++;
      return applyRecognitionReceipt(...args);
    },
    notesCutoff,
    publicDocumentationReasons,
  );
  assert.deepEqual(h.fixture.input, original);
  return { output, calls };
}
function withheld(h) {
  const result = materialize(h);
  assert.equal(result.calls, 0);
  assert.deepEqual(result.output, h.fixture.input);
}
function accepted(h) {
  const result = materialize(h);
  assert.equal(result.calls, 1);
  const value = authoredNotesProof(result.output);
  assert.deepEqual(value.evidence.contribution.reasonCodes, notesAcceptedReasons);
  assert.equal(value.fact.actorId, h.fixture.target.actorId);
  assert.equal(value.fact.role, "author");
  assert.equal(value.fact.occurredAt, notesMergeTime);
  assert.equal(value.evidence.occurredAt, notesMergeTime);
  assert.equal(value.fact.acceptedAt, new Date(h.now).toISOString());
  assert.equal(value.evidence.sourceRevision, h.fixture.evidence.sourceRevision);
  return value;
}
async function checkPrivateProjection(h) {
  const response = await h.call("/controls/public");
  assert.equal(response.status, 200, response.text);
  for (const value of [
    h.input.detail,
    "PRIVATE_AUTHORED_NOTES_REVIEW",
    "PRIVATE_NOTES_SOURCE_USE",
    "reviewedInputDigest",
    "sourceUseReview",
    "targetFactId",
    "pathPolicyVersion",
  ])
    assert.ok(!response.text.includes(value), value);
  return response.data.claims;
}

test("authored notes intake HTTP: current independent approval and SQLite reopen retain only fixed public purpose", async (t) => {
  const h = await scenario(t);
  withheld(h);
  assert.equal((await review(h)).status, 200);
  const first = accepted(h);
  assert.equal((await checkPrivateProjection(h)).length, 1);
  const state = h.store.read();
  await h.reopen();
  assert.deepEqual(h.store.read(), state);
  assert.equal(accepted(h).fact.id, first.fact.id);
});
test("authored notes intake HTTP: pending and participant-declined requests make no recognition callback", async (t) => {
  const h = await scenario(t, { collaborators: ["303"] });
  withheld(h);
  const participant = await h.login("303");
  assert.equal((await change(h, "consent", participant, { consent: false })).status, 200);
  const before = h.store.read();
  assert.equal((await review(h)).status, 409);
  assert.deepEqual(h.store.read(), before);
  withheld(h);
  assert.deepEqual(await checkPrivateProjection(h), []);
});
test("authored notes intake HTTP: submitter and unapproved policy cannot authorize the purpose", async (t) => {
  const h = await scenario(t),
    before = h.store.read();
  assert.equal((await review(h, {}, h.owner)).status, 403);
  assert.equal((await review(h, { policyVersion: "unapproved-notes-policy" })).status, 409);
  assert.deepEqual(h.store.read(), before);
  withheld(h);
});
test("authored notes intake HTTP: a permitted unrelated source reference stops before the host receipt", async (t) => {
  const h = await scenario(t);
  assert.equal(
    (
      await review(h, {
        sourceUseReview: syntheticSourceUseReviewInput({
          references: [{ locator: h.input.locator, revision: "unrelated-revision" }],
        }),
      })
    ).status,
    200,
  );
  const state = h.store.read();
  assert.throws(() => materialize(h), /documentation.purpose/i);
  assert.deepEqual(h.store.read(), state);
});
test("authored notes intake HTTP: an amended claim requires fresh review and withdrawal retires its accepted purpose", async (t) => {
  const h = await scenario(t);
  assert.equal((await review(h)).status, 200);
  const first = accepted(h),
    prior = structuredClone(stored(h).history.findLast((x) => x.action === "accepted"));
  h.advance();
  const { kind: _kind, ...input } = requestInput(h.fixture, [], JSON.stringify(h.fixture.purpose, null, 2));
  assert.equal((await change(h, "amend", h.owner, { ...input, reason: "Fixture current detail wording" })).status, 200);
  h.input.detail = input.detail;
  assert.equal(stored(h).status, "pending");
  withheld(h);
  assert.deepEqual(
    stored(h).history.find((x) => x.id === prior.id),
    prior,
  );
  assert.equal((await review(h)).status, 200);
  assert.equal(accepted(h).fact.id, first.fact.id);
  assert.notEqual(
    stored(h).history.at(-1).sourceUseReview.reviewedInputDigest,
    prior.sourceUseReview.reviewedInputDigest,
  );
  h.advance();
  assert.equal((await change(h, "withdraw", h.owner, { reason: "Fixture claim withdrawn" })).status, 400);
  assert.equal((await change(h, "withdraw", h.owner)).status, 200);
  withheld(h);
  assert.deepEqual(await checkPrivateProjection(h), []);
});
test("authored notes intake HTTP: stale protected detail remains withheld after SQLite reopen", async (t) => {
  const h = await scenario(t);
  assert.equal((await review(h)).status, 200);
  const state = h.store.read(),
    request = state.requests[h.receipt.id],
    prior = structuredClone(request.history.at(-1));
  const changed = JSON.parse(request.detail);
  changed.pathPolicyVersion = "unreviewed-later-policy";
  request.detail = JSON.stringify(changed);
  h.store.db.prepare("UPDATE controls_state SET document=? WHERE id=1").run(JSON.stringify(state));
  withheld(h);
  assert.deepEqual(await checkPrivateProjection(h), []);
  await h.reopen();
  assert.deepEqual(stored(h).history.at(-1), prior);
  withheld(h);
  assert.deepEqual(await checkPrivateProjection(h), []);
});
