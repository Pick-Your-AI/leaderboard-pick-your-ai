import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlStore } from "../src/store.mjs";
import { createControlsServer } from "../src/server.mjs";
import {
  syntheticEvidenceIntakeInput,
  syntheticSourceUseReviewInput,
} from "../../../tests/fixtures/evidence-intake.mjs";

// Fictional actors, public-looking locators and OAuth exchanges. Only a
// disposable localhost server and SQLite file are used; no source is fetched.
const origin = "https://intake.example.test";
const policy = "synthetic-intake-policy-1";

async function harness(t) {
  const directory = mkdtempSync(join(tmpdir(), "leaderboard-evidence-intake-"));
  const filename = join(directory, "private.sqlite");
  const challenges = new Set();
  const authorities = new Map([
    ["2", { roles: ["reviewer"], version: "reviewer-role-1" }],
    ["4", { roles: ["privacy"], version: "privacy-role-1" }],
  ]);
  let timestamp = Date.parse("2026-10-19T03:00:00.000Z");
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
      approvedPolicyVersions: [policy],
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

function seedPreIntakeAcceptance(h, collaborators) {
  // Literal pre-intake records remain migration negatives. Do not attach the
  // current positive fixture helper or manufacture consent during read/startup.
  const decision = {
    id: "legacy-independent-decision",
    receipt: "legacy-claim",
    actor: "2",
    action: "accepted",
    at: h.now,
    version: 2,
    reason: "Synthetic pre-intake independent review",
    policyVersion: policy,
  };
  const request = {
    id: "legacy-claim",
    owner: "1",
    kind: "evidence",
    status: "accepted",
    version: 2,
    locator: "https://github.com/synthetic-intake/fixtures/issues/1",
    category: "governance",
    scope: "One synthetic legacy decision record",
    detail: "PRIVATE_LEGACY_PROOF",
    collaborators,
    policyVersion: policy,
    history: [decision],
  };
  const state = h.store.read();
  state.requests[request.id] = request;
  state.audit.push(structuredClone(decision));
  state.spotlights = {
    "legacy-spotlight": {
      id: "legacy-spotlight",
      owner: request.owner,
      claimId: request.id,
      claimVersion: request.version,
      status: "accepted",
      version: 2,
      nominatedAt: h.now - 1_000,
      history: [
        {
          id: "legacy-editorial-decision",
          actor: "2",
          action: "accepted",
          at: h.now,
          version: 2,
          publicExplanation: "Synthetic previously selected decision record",
        },
      ],
    },
  };
  const publication = h.store.publicSnapshot();
  publication.revision = ++state.revision;
  publication.claims = [
    {
      id: request.id,
      actorId: request.owner,
      locator: request.locator,
      category: request.category,
      scope: request.scope,
      policyVersion: policy,
      collaborators: Object.keys(collaborators),
    },
  ];
  h.store.db.exec("BEGIN IMMEDIATE");
  try {
    h.store.db.prepare("UPDATE controls_state SET document=? WHERE id=1").run(JSON.stringify(state));
    h.store.db.prepare("UPDATE controls_publication SET document=? WHERE id=1").run(JSON.stringify(publication));
    h.store.db.exec("COMMIT");
  } catch (error) {
    h.store.db.exec("ROLLBACK");
    throw error;
  }
  return structuredClone(request);
}

for (const [label, collaborators] of [
  ["empty participant set", {}],
  ["accepted participant", { 3: "accepted" }],
]) {
  for (const restart of [false, true]) {
    test(`evidence intake: pre-intake ${label} stays withheld on ${restart ? "reopen" : "initial read"}`, async (t) => {
      const h = await harness(t);
      const stored = seedPreIntakeAcceptance(h, collaborators);
      if (restart) await h.reopen();
      const publication = await h.call("/controls/public");
      const editorial = await h.call("/controls/spotlights");
      assert.equal(publication.status, 200);
      assert.equal(editorial.status, 200);
      assert.deepEqual(
        { claims: publication.data.claims, spotlights: editorial.data.spotlights },
        { claims: [], spotlights: [] },
        "A legacy acceptance and persisted public row cannot substitute for current scoped intake",
      );
      assert.deepEqual(h.store.publicSnapshot().claims, []);
      assert.deepEqual(
        h.store.read().requests[stored.id],
        stored,
        "Reading must not manufacture new intake or consent",
      );
    });
  }
}

const evidence = (ids = [], overrides = {}) => ({
  kind: "evidence",
  locator: "https://github.com/synthetic-intake/fixtures/issues/11",
  category: "governance",
  collaborators: ids,
  consent: true,
  scope: "One synthetic reviewed decision record",
  detail: "PRIVATE_INTAKE_EVIDENCE_DETAIL",
  intake: syntheticEvidenceIntakeInput(ids),
  ...overrides,
});
const storedRequest = (h) => h.store.read().requests[h.receipt.id];
async function scenario(t, ids = [], overrides = {}) {
  const h = await harness(t);
  h.owner = await h.login("1");
  h.reviewer = await h.login("2");
  h.peers = new Map();
  for (const id of ids) h.peers.set(id, await h.login(id));
  const submitted = await h.call("/controls/requests", {
    user: h.owner,
    method: "POST",
    input: evidence(ids, overrides),
  });
  assert.equal(submitted.status, 201, submitted.text);
  h.receipt = submitted.data;
  return h;
}
async function change(h, action, user, input = {}) {
  const result = await h.call(`/controls/requests/${h.receipt.id}/${action}`, {
    user,
    method: "POST",
    input: { version: storedRequest(h).version, ...input },
  });
  if (result.status === 200) h.receipt = result.data;
  return result;
}
async function invitation(h, id) {
  const response = await h.call("/controls/invitations", { user: h.peers.get(id) });
  assert.equal(response.status, 200, response.text);
  const found = response.data.invitations.find((value) => value.id === h.receipt.id);
  assert.ok(found, "The authenticated listed participant sees their invitation");
  return found;
}
const affirmative = (invite) => ({
  version: invite.version,
  consent: true,
  claimDigest: invite.claimDigest,
  termsVersion: invite.terms.version,
  termsDigest: invite.terms.digest,
});
async function consent(h, id) {
  const result = await change(h, "consent", h.peers.get(id), affirmative(await invitation(h, id)));
  assert.equal(result.status, 200, result.text);
  return result;
}
function accept(h, overrides = {}) {
  return change(h, "review", h.reviewer, {
    decision: "accept",
    conflict: false,
    reason: "Synthetic independent review of this bounded source and attribution",
    sourceReviewedPublic: true,
    policyVersion: policy,
    sourceUseReview: syntheticSourceUseReviewInput(),
    ...overrides,
  });
}
async function denyWithoutMutation(h, operation, status) {
  const before = { state: h.store.read(), publication: h.store.publicSnapshot() };
  const result = await operation();
  assert.equal(result.status, status, result.text);
  assert.deepEqual(h.store.read(), before.state, "Rejected input must not change private receipts or audit");
  assert.deepEqual(h.store.publicSnapshot(), before.publication, "Rejected input must not change publication");
}
async function protectedReceipt(h) {
  const result = await h.call(`/controls/requests/${h.receipt.id}`, { user: h.owner });
  assert.equal(result.status, 200, result.text);
  return result.data;
}
async function publishedClaims(h) {
  const result = await h.call("/controls/public");
  assert.equal(result.status, 200, result.text);
  assert.deepEqual(result.data.claims, h.store.publicSnapshot().claims);
  return result.data.claims;
}
function replaceStoredRequest(h, request) {
  // Deliberately emulate a stored record from an older or corrupted authority.
  // Leave the old persisted publication intact so its read-time gate is tested.
  const state = h.store.read();
  state.requests[request.id] = request;
  h.store.db.prepare("UPDATE controls_state SET document=? WHERE id=1").run(JSON.stringify(state));
}
function canonicalDigest(value) {
  function ordered(item) {
    if (Array.isArray(item)) return item.map(ordered);
    if (item && typeof item === "object")
      return Object.fromEntries(
        Object.keys(item)
          .sort()
          .map((key) => [key, ordered(item[key])]),
      );
    return item;
  }
  return createHash("sha256")
    .update(JSON.stringify(ordered(value)))
    .digest("hex");
}

test("evidence intake: authenticated display terms have a reproducible versioned content digest", async (t) => {
  const h = await harness(t);
  assert.equal((await h.call("/controls/evidence-terms")).status, 401);
  const owner = await h.login("1");
  const before = h.store.read();
  const response = await h.call("/controls/evidence-terms", { user: owner });
  assert.equal(response.status, 200);
  assert.deepEqual(Object.keys(response.data), ["terms"]);
  const { digest, ...content } = response.data.terms;
  assert.deepEqual(Object.keys(content).sort(), ["paragraphs", "rightsPolicyVersion", "schemaVersion", "version"]);
  assert.equal(content.schemaVersion, "evidence-terms/v1");
  assert.equal(content.version, "evidence-terms/2026-10-19");
  assert.equal(content.rightsPolicyVersion, "2026-10-18");
  assert.ok(
    content.paragraphs.length > 0 &&
      content.paragraphs.every((paragraph) => typeof paragraph === "string" && paragraph.length > 0),
  );
  assert.equal(digest, canonicalDigest(content));
  assert.match(digest, /^[a-f0-9]{64}$/);
  assert.deepEqual(h.store.read(), before);
  const originalParagraphs = structuredClone(content.paragraphs);
  response.data.terms.paragraphs[0] = "Client mutation cannot change the server's displayed terms";
  const fresh = (await h.call("/controls/evidence-terms", { user: owner })).data.terms;
  assert.equal(fresh.digest, digest);
  assert.deepEqual(fresh.paragraphs, originalParagraphs);
});

test("evidence intake: a bare checkbox and malformed terms, roles or dates cannot create a receipt", async (t) => {
  const h = await harness(t);
  const owner = await h.login("1");
  const mutations = [
    ["missing intake", (input) => delete input.intake],
    ["unchecked consent", (input) => (input.consent = false)],
    ["unknown schema", (input) => (input.intake.schemaVersion = "evidence-intake/v999")],
    ["unknown terms", (input) => (input.intake.termsVersion = "evidence-terms/unknown")],
    ["wrong terms digest", (input) => (input.intake.termsDigest = "0".repeat(64))],
    ["unrecorded consent keys", (input) => (input.intake.actorId = "99")],
    ["undeclared source-use state", (input) => (input.intake.sourceUseBasis = { state: "permitted" })],
    ["blank source-use declaration", (input) => (input.intake.sourceUseBasis.statement = " ")],
    ["oversized source-use declaration", (input) => (input.intake.sourceUseBasis.statement = "a".repeat(1001))],
    ["extra basis key", (input) => (input.intake.sourceUseBasis.proof = "undeclared")],
    ["missing required participant role", (input) => delete input.intake.roles.collaborators["3"]],
    ["other actor role", (input) => (input.intake.roles.collaborators["5"] = null)],
    ["oversized role", (input) => (input.intake.roles.submitter = "a".repeat(201))],
    ["invalid leap date", (input) => (input.intake.period = { kind: "date", date: "2026-02-29" })],
    ["impossible month day", (input) => (input.intake.period = { kind: "date", date: "2026-04-31" })],
    ["year zero", (input) => (input.intake.period = { kind: "date", date: "0000-01-01" })],
    [
      "reversed interval",
      (input) => (input.intake.period = { kind: "interval", start: "2026-10-19", end: "2026-10-18" }),
    ],
    ["unknown period with hidden date", (input) => (input.intake.period = { kind: "unknown", date: "2026-10-18" })],
  ];
  for (const [label, mutate] of mutations) {
    const input = evidence(["3"]);
    mutate(input);
    const before = h.store.read();
    const response = await h.call("/controls/requests", { user: owner, method: "POST", input });
    assert.equal(response.status, 400, label + ": " + response.text);
    assert.deepEqual(h.store.read(), before, label + " must not create a receipt or audit event");
    assert.deepEqual(h.store.publicSnapshot().claims, []);
  }
});

test("evidence intake: unknown roles and dates stay unknown while source-use acceptance needs an independent decision", async (t) => {
  const h = await scenario(t, [], {
    intake: syntheticEvidenceIntakeInput([], { sourceUseBasis: { state: "unresolved" } }),
  });
  const submitted = storedRequest(h);
  assert.deepEqual(submitted.intake.roles, { submitter: null, collaborators: {} });
  assert.deepEqual(submitted.intake.period, { kind: "unknown" });
  assert.deepEqual(submitted.intake.sourceUseBasis, { state: "unresolved" });
  assert.equal((await protectedReceipt(h)).intakeEligibility.state, "awaiting_review");
  assert.deepEqual(await publishedClaims(h), []);
  await denyWithoutMutation(h, () => accept(h, { sourceUseReview: undefined }), 400);
  await denyWithoutMutation(h, () => accept(h, { sourceReviewedPublic: false }), 400);
  await denyWithoutMutation(
    h,
    () =>
      change(h, "review", h.owner, {
        decision: "accept",
        conflict: false,
        reason: "Synthetic self-review",
        sourceReviewedPublic: true,
        sourceUseReview: syntheticSourceUseReviewInput(),
        policyVersion: policy,
      }),
    403,
  );
  h.advance();
  const accepted = await accept(h);
  assert.equal(accepted.status, 200, accepted.text);
  assert.equal((await protectedReceipt(h)).intakeEligibility.state, "eligible");
  const request = storedRequest(h);
  assert.deepEqual(
    request.intake.sourceUseBasis,
    { state: "unresolved" },
    "A reviewer decision does not rewrite the submitter's declaration",
  );
  assert.equal(request.history.at(-1).sourceUseReview.disposition, "permitted");
  assert.equal((await publishedClaims(h)).length, 1);
  assert.deepEqual(
    (await h.call("/controls/spotlights")).data.spotlights,
    [],
    "Evidence acceptance is not editorial opt-in or approval",
  );
  const published = await publishedClaims(h);
  await h.reopen();
  assert.deepEqual(await publishedClaims(h), published);
});

test("evidence intake: source-use review rejects undeclared authority and unbounded or unsafe references", async (t) => {
  const h = await scenario(t);
  const variants = [
    { ...syntheticSourceUseReviewInput(), disposition: "unknown" },
    { ...syntheticSourceUseReviewInput(), rationale: " " },
    { ...syntheticSourceUseReviewInput(), rationale: "a".repeat(1001) },
    { ...syntheticSourceUseReviewInput(), reviewerId: "99" },
    { ...syntheticSourceUseReviewInput(), reviewedInputDigest: "0".repeat(64) },
    { ...syntheticSourceUseReviewInput(), references: [] },
    {
      ...syntheticSourceUseReviewInput(),
      references: Array(6).fill({ locator: "https://github.com/synthetic-intake/fixtures/issues/1", revision: "v1" }),
    },
    { ...syntheticSourceUseReviewInput(), references: [{ locator: "https://example.test/private", revision: "v1" }] },
    {
      ...syntheticSourceUseReviewInput(),
      references: [{ locator: "https://user:password@github.com/synthetic-intake/fixtures/issues/1", revision: "v1" }],
    },
    {
      ...syntheticSourceUseReviewInput(),
      references: [{ locator: "https://github.com/synthetic-intake/fixtures/issues/1", revision: "" }],
    },
    {
      ...syntheticSourceUseReviewInput(),
      references: [{ locator: "https://github.com/synthetic-intake/fixtures/issues/1", revision: "a".repeat(129) }],
    },
    {
      ...syntheticSourceUseReviewInput(),
      references: [{ locator: "https://github.com/synthetic-intake/fixtures/issues/1", revision: "v1", actorId: "99" }],
    },
  ];
  for (const sourceUseReview of variants) await denyWithoutMutation(h, () => accept(h, { sourceUseReview }), 400);
});

test("evidence intake: invitations disclose only the participant's own role and claim scope", async (t) => {
  const h = await scenario(t, ["3", "5"], {
    intake: syntheticEvidenceIntakeInput(["3", "5"], {
      sourceUseBasis: { state: "declared", statement: "PRIVATE_SOURCE_USE_STATEMENT" },
      roles: {
        submitter: "PRIVATE_SUBMITTER_ROLE",
        collaborators: { 3: "Participant three's proposed role", 5: "PRIVATE_OTHER_PARTICIPANT_ROLE" },
      },
      period: { kind: "interval", start: "2026-10-01", end: "2026-10-18" },
    }),
  });
  const invite = await invitation(h, "3");
  assert.deepEqual(Object.keys(invite).sort(), [
    "category",
    "claimDigest",
    "claimRevision",
    "consent",
    "id",
    "intakeEligibility",
    "locator",
    "participantIds",
    "period",
    "role",
    "scope",
    "sourceUseState",
    "terms",
    "version",
  ]);
  assert.equal(invite.role, "Participant three's proposed role");
  assert.deepEqual(invite.participantIds, ["1", "3", "5"]);
  assert.deepEqual(invite.period, { kind: "interval", start: "2026-10-01", end: "2026-10-18" });
  assert.equal(invite.sourceUseState, "declared");
  assert.equal(invite.intakeEligibility.state, "participant_consent_required");
  assert.deepEqual(invite.terms, (await h.call("/controls/evidence-terms", { user: h.peers.get("3") })).data.terms);
  assert.equal(invite.claimDigest, storedRequest(h).intake.claimDigest);
  for (const hidden of [
    "PRIVATE_INTAKE_EVIDENCE_DETAIL",
    "PRIVATE_SOURCE_USE_STATEMENT",
    "PRIVATE_SUBMITTER_ROLE",
    "PRIVATE_OTHER_PARTICIPANT_ROLE",
    "submitterConsent",
    "participantConsents",
    "history",
    "sourceUseReview",
  ])
    assert.equal(JSON.stringify(invite).includes(hidden), false, hidden + " must remain protected");
  const unauthorized = await h.call(`/controls/requests/${h.receipt.id}`, { user: h.peers.get("3") });
  assert.equal(unauthorized.status, 404, "An invitation does not grant access to the full private receipt");
  const outsider = await h.login("6");
  assert.deepEqual((await h.call("/controls/invitations", { user: outsider })).data.invitations, []);
});

test("evidence intake: malformed legacy participant containers cannot grant invitation or consent access", async (t) => {
  const h = await scenario(t, ["3"]);
  const original = storedRequest(h);
  for (const collaborators of [[null, null, null, "pending"], "PRIVATE_LEGACY_PROOF"]) {
    const malformed = { ...structuredClone(original), collaborators };
    replaceStoredRequest(h, malformed);
    const invited = await h.call("/controls/invitations", { user: h.peers.get("3") });
    assert.equal(invited.status, 200);
    assert.deepEqual(invited.data.invitations, [], "An array index or string position is not membership authority");
    await denyWithoutMutation(h, () => change(h, "consent", h.peers.get("3"), { consent: false }), 404);
    assert.equal((await h.call(`/controls/requests/${h.receipt.id}`, { user: h.peers.get("3") })).status, 404);
    assert.deepEqual(await publishedClaims(h), []);
    assert.equal(
      storedRequest(h).detail,
      original.detail,
      "Malformed historical input stays protected, not silently deleted",
    );
  }
});

test("evidence intake: sequential participant choices bind authenticated actors to the same claim and exact terms", async (t) => {
  const h = await scenario(t, ["3", "5"], {
    intake: syntheticEvidenceIntakeInput(["3", "5"], {
      roles: { submitter: "Synthetic decision author", collaborators: { 3: "Synthetic facilitator", 5: null } },
      period: { kind: "date", date: "2024-02-29" },
    }),
  });
  const original = storedRequest(h);
  const invite3 = await invitation(h, "3");
  const invite5 = await invitation(h, "5");
  const input = affirmative(invite3);
  for (const invalid of [
    { ...input, claimDigest: "0".repeat(64) },
    { ...input, termsVersion: "evidence-terms/unknown" },
    { ...input, termsDigest: "0".repeat(64) },
    { version: input.version, consent: true },
  ])
    await denyWithoutMutation(h, () => change(h, "consent", h.peers.get("3"), invalid), 409);
  for (const extra of [{ actorId: "5" }, { role: "Unreviewed role" }, { at: 0 }])
    await denyWithoutMutation(h, () => change(h, "consent", h.peers.get("3"), { ...input, ...extra }), 400);
  const outsider = await h.login("6");
  await denyWithoutMutation(h, () => change(h, "consent", outsider, input), 404);
  h.advance();
  await consent(h, "3");
  assert.deepEqual(storedRequest(h).collaborators, { 3: "accepted", 5: "pending" });
  assert.deepEqual(Object.keys(storedRequest(h).intake.participantConsents), ["3"]);
  assert.equal(storedRequest(h).intake.claimRevision, original.intake.claimRevision);
  assert.equal(storedRequest(h).intake.claimDigest, original.intake.claimDigest);
  assert.equal(storedRequest(h).version, original.version + 1);
  await denyWithoutMutation(h, () => change(h, "consent", h.peers.get("5"), affirmative(invite5)), 409);
  await denyWithoutMutation(h, () => accept(h), 409);
  h.advance();
  await consent(h, "5");
  const complete = storedRequest(h);
  assert.equal(complete.version, original.version + 2);
  assert.equal(complete.intake.claimDigest, original.intake.claimDigest);
  assert.equal(complete.intake.claimRevision, 1);
  for (const [actorId, role, at] of [
    ["1", "Synthetic decision author", original.createdAt],
    ["3", "Synthetic facilitator", original.createdAt + 1000],
    ["5", null, original.createdAt + 2000],
  ]) {
    const record = actorId === "1" ? complete.intake.submitterConsent : complete.intake.participantConsents[actorId];
    assert.deepEqual(record, {
      actorId,
      choice: "accepted",
      scope: "public-claim-attribution",
      claimRevision: 1,
      claimDigest: original.intake.claimDigest,
      role,
      termsVersion: invite3.terms.version,
      termsDigest: invite3.terms.digest,
      rightsPolicyVersion: invite3.terms.rightsPolicyVersion,
      at,
    });
  }
  assert.equal((await protectedReceipt(h)).intakeEligibility.state, "awaiting_review");
  assert.deepEqual(await publishedClaims(h), []);
  h.advance();
  const reviewed = await accept(h);
  assert.equal(reviewed.status, 200, reviewed.text);
  assert.deepEqual((await publishedClaims(h))[0].collaborators, ["3", "5"]);
});

test("evidence intake: an invitation for an identical-looking claim cannot authorize a different receipt", async (t) => {
  const h = await scenario(t, ["3"]);
  const original = storedRequest(h);
  const other = await h.call("/controls/requests", {
    user: h.owner,
    method: "POST",
    input: evidence(["3"]),
  });
  assert.equal(other.status, 201, other.text);
  const invitations = (await h.call("/controls/invitations", { user: h.peers.get("3") })).data.invitations;
  const otherInvitation = invitations.find((invite) => invite.id === other.data.id);
  assert.ok(otherInvitation);
  assert.equal(otherInvitation.locator, original.locator);
  assert.equal(otherInvitation.scope, original.scope);
  assert.notEqual(otherInvitation.claimDigest, original.intake.claimDigest);
  await denyWithoutMutation(h, () => change(h, "consent", h.peers.get("3"), affirmative(otherInvitation)), 409);
  await consent(h, "3");
  assert.equal(storedRequest(h).collaborators["3"], "accepted");
  assert.equal(h.store.read().requests[other.data.id].collaborators["3"], "pending");
});

test("evidence intake: accepted review binds actual reviewer authority and the complete private review input", async (t) => {
  const h = await scenario(t, ["3"], {
    intake: syntheticEvidenceIntakeInput(["3"], {
      sourceUseBasis: { state: "declared", statement: "PRIVATE_REVIEWED_SOURCE_BASIS" },
      roles: { submitter: "PRIVATE_REVIEWED_SUBMITTER_ROLE", collaborators: { 3: "PRIVATE_REVIEWED_PEER_ROLE" } },
      period: { kind: "date", date: "2026-10-18" },
    }),
  });
  h.advance();
  await consent(h, "3");
  h.advance();
  const sourceUseReview = syntheticSourceUseReviewInput({ rationale: "PRIVATE_INDEPENDENT_REVIEW_RATIONALE" });
  const accepted = await accept(h, { sourceUseReview });
  assert.equal(accepted.status, 200, accepted.text);
  const request = storedRequest(h);
  const intake = request.intake;
  assert.equal(
    intake.claimDigest,
    canonicalDigest([
      "evidence-claim/v1",
      request.id,
      request.owner,
      request.locator,
      request.category,
      request.scope,
      ["3"],
      intake.period,
      intake.termsVersion,
      intake.termsDigest,
      "2026-10-18",
      1,
    ]),
  );
  const decision = request.history.at(-1);
  assert.equal(decision.actor, "2");
  assert.equal(decision.version, request.version);
  assert.equal(decision.conflict, false);
  assert.equal(decision.sourceReviewedPublic, true);
  assert.deepEqual(decision.sourceUseReview, {
    ...sourceUseReview,
    reviewerId: "2",
    roleVersion: "reviewer-role-1",
    reviewedAt: h.now,
    scope: "public-claim-attribution",
    claimRevision: 1,
    claimDigest: intake.claimDigest,
    reviewedInputDigest: canonicalDigest([
      "evidence-reviewed-input/v1",
      intake.claimDigest,
      request.detail,
      intake.sourceUseBasis,
      intake.roles,
    ]),
    termsVersion: intake.termsVersion,
    termsDigest: intake.termsDigest,
    rightsPolicyVersion: "2026-10-18",
    policyVersion: policy,
    sourceReviewedPublic: true,
    conflict: false,
  });
  assert.deepEqual(
    h.store.read().audit.find((event) => event.id === decision.id),
    decision,
  );
  const published = (await publishedClaims(h))[0];
  assert.deepEqual(Object.keys(published).sort(), [
    "actorId",
    "category",
    "collaborators",
    "id",
    "locator",
    "policyVersion",
    "scope",
  ]);
  for (const privateValue of [
    request.detail,
    intake.sourceUseBasis.statement,
    intake.roles.submitter,
    intake.roles.collaborators["3"],
    sourceUseReview.rationale,
    sourceUseReview.references[0].revision,
  ])
    assert.equal(
      JSON.stringify(published).includes(privateValue),
      false,
      "Protected input must not enter public recognition",
    );
  assert.equal(Object.hasOwn(published, "score"), false);
});

test("evidence intake: an amendment replaces claim consent and review while preserving previous receipts", async (t) => {
  const h = await scenario(t, ["3"]);
  h.advance();
  await consent(h, "3");
  h.advance();
  assert.equal((await accept(h)).status, 200);
  const accepted = storedRequest(h);
  const oldInvitation = await invitation(h, "3");
  h.advance();
  const input = evidence(["3"], {
    scope: "A revised synthetic decision record",
    detail: "PRIVATE_AMENDED_PROOF",
    intake: syntheticEvidenceIntakeInput(["3"], {
      roles: { submitter: null, collaborators: { 3: "A revised synthetic role" } },
      period: { kind: "date", date: "2026-10-18" },
    }),
  });
  const { kind: _kind, ...amendedInput } = input;
  await denyWithoutMutation(
    h,
    () => change(h, "amend", h.owner, { ...amendedInput, consent: false, reason: "Synthetic correction" }),
    400,
  );
  const amendment = await change(h, "amend", h.owner, { ...amendedInput, reason: "Synthetic correction" });
  assert.equal(amendment.status, 200, amendment.text);
  const amended = storedRequest(h);
  assert.equal(amended.status, "pending");
  assert.equal(amended.policyVersion, undefined);
  assert.equal(amended.intake.claimRevision, accepted.intake.claimRevision + 1);
  assert.notEqual(amended.intake.claimDigest, accepted.intake.claimDigest);
  assert.deepEqual(amended.intake.participantConsents, {});
  assert.deepEqual(amended.collaborators, { 3: "pending" });
  assert.deepEqual(amended.history.at(-1).previous.intake, accepted.intake);
  assert.deepEqual(
    amended.history.find((event) => event.id === accepted.history.at(-1).id),
    accepted.history.at(-1),
  );
  assert.deepEqual(await publishedClaims(h), []);
  await denyWithoutMutation(
    h,
    () => change(h, "consent", h.peers.get("3"), { ...affirmative(oldInvitation), version: amended.version }),
    409,
  );
  await denyWithoutMutation(h, () => accept(h), 409);
  h.advance();
  await consent(h, "3");
  assert.deepEqual(await publishedClaims(h), [], "Fresh consent does not reapply the old source-use decision");
  h.advance();
  assert.equal((await accept(h)).status, 200);
  assert.equal(storedRequest(h).history.at(-1).sourceUseReview.claimRevision, 2);
  assert.notEqual(
    storedRequest(h).history.at(-1).sourceUseReview.reviewedInputDigest,
    accepted.history.at(-1).sourceUseReview.reviewedInputDigest,
  );
  assert.equal((await publishedClaims(h))[0].scope, amended.scope);
});

test("evidence intake: carrying a decline through amendment preserves its historical scope and never invents consent", async (t) => {
  const h = await scenario(t, ["3"]);
  h.advance();
  assert.equal((await change(h, "consent", h.peers.get("3"), { consent: false })).status, 200);
  const declined = storedRequest(h).intake.participantConsents["3"];
  h.advance();
  const { kind: _kind, ...input } = evidence(["3"], { scope: "Revised synthetic claim after a decline" });
  assert.equal((await change(h, "amend", h.owner, { ...input, reason: "Synthetic amendment" })).status, 200);
  const request = storedRequest(h);
  assert.equal(request.collaborators["3"], "declined");
  assert.deepEqual(request.intake.participantConsents["3"], declined);
  assert.notEqual(request.intake.claimDigest, declined.claimDigest);
  await denyWithoutMutation(h, () => accept(h), 409);
  h.advance();
  await consent(h, "3");
  assert.equal(storedRequest(h).intake.participantConsents["3"].claimDigest, request.intake.claimDigest);
  assert.equal(storedRequest(h).intake.participantConsents["3"].choice, "accepted");
});

for (const [label, mutate] of [
  ["missing intake", (request) => delete request.intake],
  ["unsupported terms", (request) => (request.intake.termsVersion = "evidence-terms/unknown")],
]) {
  test(`evidence intake: ${label} blocks acceptance but cannot block participant decline or owner withdrawal`, async (t) => {
    const h = await scenario(t, ["3"]);
    await consent(h, "3");
    const request = storedRequest(h);
    mutate(request);
    replaceStoredRequest(h, request);
    assert.equal((await protectedReceipt(h)).intakeEligibility.state, "updated_intake_required");
    const invite = await invitation(h, "3");
    assert.equal(invite.terms, null);
    assert.equal(invite.claimDigest, null);
    await denyWithoutMutation(h, () => accept(h), 409);
    await denyWithoutMutation(h, () => change(h, "consent", h.peers.get("3"), { consent: true }), 409);
    const declined = await change(h, "consent", h.peers.get("3"), { consent: false });
    assert.equal(declined.status, 200, declined.text);
    assert.equal(storedRequest(h).collaborators["3"], "declined");
    const withdrawn = await change(h, "withdraw", h.owner);
    assert.equal(withdrawn.status, 200, withdrawn.text);
    assert.equal(storedRequest(h).status, "withdrawn");
    assert.deepEqual(await publishedClaims(h), []);
    assert.equal(
      storedRequest(h).detail,
      "PRIVATE_INTAKE_EVIDENCE_DETAIL",
      "Removing attribution does not claim retained-data deletion",
    );
    await h.reopen();
    assert.deepEqual(await publishedClaims(h), []);
    assert.equal(storedRequest(h).status, "withdrawn");
  });
}

test("evidence intake: stale or altered consent and review authority cannot survive a stored public projection", async (t) => {
  const h = await scenario(t, ["3"]);
  h.advance();
  await consent(h, "3");
  h.advance();
  assert.equal((await accept(h)).status, 200);
  const valid = storedRequest(h);
  assert.equal((await publishedClaims(h)).length, 1);
  const changes = [
    ["source-use statement", (request) => (request.intake.sourceUseBasis.statement = "Different protected basis")],
    ["private evidence detail", (request) => (request.detail = "Different protected evidence")],
    ["submitter role", (request) => (request.intake.roles.submitter = "Different own role")],
    ["peer role", (request) => (request.intake.roles.collaborators["3"] = "Different participant role")],
    ["period", (request) => (request.intake.period = { kind: "date", date: "2026-10-18" })],
    ["claim scope", (request) => (request.scope = "An unconsented public scope")],
    ["consent actor", (request) => (request.intake.participantConsents["3"].actorId = "5")],
    ["consent claim digest", (request) => (request.intake.participantConsents["3"].claimDigest = "0".repeat(64))],
    ["consent terms digest", (request) => (request.intake.submitterConsent.termsDigest = "0".repeat(64))],
    ["consent after review", (request) => (request.intake.participantConsents["3"].at = h.now + 1)],
    ["forged review actor", (request) => (request.history.at(-1).sourceUseReview.reviewerId = "5")],
    ["participant review actor", (request) => (request.history.at(-1).actor = "3")],
    ["missing reviewer authority", (request) => delete request.history.at(-1).sourceUseReview.roleVersion],
    [
      "reviewed private digest",
      (request) => (request.history.at(-1).sourceUseReview.reviewedInputDigest = "0".repeat(64)),
    ],
    ["reviewed request version", (request) => request.version++],
    ["missing conflict declaration", (request) => delete request.history.at(-1).conflict],
  ];
  for (const [label, mutate] of changes) {
    const changed = structuredClone(valid);
    mutate(changed);
    replaceStoredRequest(h, changed);
    assert.deepEqual(await publishedClaims(h), [], label + " must withhold the old public claim");
    assert.deepEqual(storedRequest(h), changed, label + " read must not manufacture repaired proof");
  }
  replaceStoredRequest(h, valid);
  assert.equal((await publishedClaims(h)).length, 1, "The actual intact authority remains publishable");
  const missingReview = structuredClone(valid);
  delete missingReview.history.at(-1).sourceUseReview;
  replaceStoredRequest(h, missingReview);
  assert.equal((await protectedReceipt(h)).intakeEligibility.state, "source_use_review_required");
  await h.reopen();
  assert.deepEqual(await publishedClaims(h), []);
  assert.deepEqual(storedRequest(h), missingReview);
});
