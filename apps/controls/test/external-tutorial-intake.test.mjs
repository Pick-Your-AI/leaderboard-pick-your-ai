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
  createEvidenceIntake,
  createSourceUseReview,
  evidenceTerms,
  hasConsentedEvidenceIntake,
  hasCurrentEvidenceConsent,
  hasReviewedEvidenceIntake,
  projectEvidenceInvitation,
} from "../src/evidence-intake.mjs";
import {
  externalTutorialDeclarationVersion,
  externalTutorialIntakeVersion,
  externalTutorialTerms,
  parseExternalTutorialDeclaration,
} from "../src/external-tutorial-intake.mjs";
import {
  syntheticEvidenceIntakeInput,
  syntheticSourceUseReviewInput,
} from "../../../tests/fixtures/evidence-intake.mjs";

// Fictional actors, public-looking locators and OAuth exchanges. Only a
// disposable localhost server and SQLite file are used; no source is fetched.
const origin = "https://intake.example.test";
const policy = "synthetic-intake-policy-1";

async function harness(t, enabled = false) {
  const directory = mkdtempSync(join(tmpdir(), "leaderboard-tutorial-intake-"));
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
      externalTutorialConsent: enabled,
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
    async reopen(nextEnabled = enabled) {
      await stop();
      enabled = nextEnabled;
      await start();
    },
  };
}

const carrier = "https://github.com/synthetic-intake/fixtures/blob/" + "a".repeat(40) + "/tutorial.json";
function tutorialInput(ids = ["3"]) {
  const terms = externalTutorialTerms();
  const roles = {
    submitter: "Declared tutorial author",
    collaborators: Object.fromEntries(ids.map((id) => [id, null])),
  };
  return {
    kind: "evidence",
    locator: carrier,
    category: "other",
    scope: "Synthetic tutorial attribution declaration",
    detail: "PRIVATE_TUTORIAL_REVIEW_DETAIL",
    collaborators: ids,
    consent: true,
    intake: {
      schemaVersion: externalTutorialIntakeVersion,
      termsVersion: terms.version,
      termsDigest: terms.digest,
      sourceUseBasis: { state: "declared", statement: "PRIVATE_TUTORIAL_RIGHTS_STATEMENT" },
      roles,
      period: { kind: "unknown" },
      externalTutorial: {
        schemaVersion: externalTutorialDeclarationVersion,
        canonicalUrl: "https://tutorial.example.invalid/lessons/build",
        revision: { id: "declared-revision-1", contentSha256: "b".repeat(64) },
        manifest: { locator: carrier, contentSha256: "c".repeat(64) },
        publishedAt: null,
        attribution: ["1", ...ids].sort().map((actorId) => ({
          actorId,
          role: actorId === "1" ? roles.submitter : roles.collaborators[actorId],
        })),
      },
    },
  };
}
const stored = (h) => h.store.read().requests[h.receipt.id];
async function scenario(t, ids = ["3"]) {
  const h = await harness(t, true);
  h.owner = await h.login("1");
  h.peer = await h.login("3");
  h.reviewer = await h.login("2");
  const submitted = await h.call("/controls/requests", {
    user: h.owner,
    method: "POST",
    input: tutorialInput(ids),
  });
  assert.equal(submitted.status, 201, submitted.text);
  h.receipt = submitted.data;
  return h;
}
async function invitation(h) {
  const response = await h.call("/controls/invitations", { user: h.peer });
  assert.equal(response.status, 200, response.text);
  const result = response.data.invitations.find((item) => item.id === h.receipt.id);
  assert.ok(result);
  return result;
}
const affirmative = (invite) => ({
  version: invite.version,
  consent: true,
  claimDigest: invite.claimDigest,
  termsVersion: invite.terms.version,
  termsDigest: invite.terms.digest,
});
async function change(h, action, user, input = {}) {
  return h.call("/controls/requests/" + h.receipt.id + "/" + action, {
    user,
    method: "POST",
    input: { version: stored(h).version, ...input },
  });
}
async function denyWithoutMutation(h, operation, status) {
  const before = h.store.read();
  const publication = h.store.publicSnapshot();
  const result = await operation();
  assert.equal(result.status, status, result.text);
  assert.deepEqual(h.store.read(), before);
  assert.deepEqual(h.store.publicSnapshot(), publication);
  return result;
}

test("tutorial capability is absent by default and preserves the legacy terms, claim hash and invitation shape", async (t) => {
  const h = await harness(t);
  const owner = await h.login("1");
  const response = await h.call("/controls/evidence-terms", { user: owner });
  assert.equal(response.status, 200);
  assert.equal(response.text, JSON.stringify({ terms: evidenceTerms() }));
  assert.equal(evidenceTerms().digest, "432cf9d0450f12d2b5967629f79c95adfa14b22e407b7b62e5f7ca7837ccd553");
  const request = {
    id: "legacy-consent-golden",
    owner: "1",
    kind: "evidence",
    locator: "https://github.com/synthetic-intake/fixtures/issues/11",
    category: "governance",
    scope: "One synthetic reviewed decision record",
    detail: "Private legacy detail remains outside participant display",
    collaborators: { 3: "pending" },
  };
  request.intake = createEvidenceIntake(request, syntheticEvidenceIntakeInput(["3"]), h.now);
  assert.equal(request.intake.claimDigest, "f09d2d149426e593d307d84d2545e02d8d39670435f2f97c2ed2b89f32e95b17");
  assert.equal(Object.hasOwn(request.intake, "externalTutorial"), false);
  const legacyInvitation = projectEvidenceInvitation(request, "3");
  assert.deepEqual(Object.keys(legacyInvitation), [
    "id",
    "version",
    "locator",
    "category",
    "scope",
    "consent",
    "claimRevision",
    "claimDigest",
    "participantIds",
    "role",
    "period",
    "sourceUseState",
    "terms",
    "intakeEligibility",
  ]);
  await denyWithoutMutation(
    h,
    () => h.call("/controls/requests", { user: owner, method: "POST", input: tutorialInput() }),
    409,
  );
  await h.reopen(true);
  const available = await h.call("/controls/evidence-terms", { user: owner });
  assert.deepEqual(available.data, { terms: evidenceTerms(), externalTutorialTerms: externalTutorialTerms() });
  const legacy = await h.call("/controls/requests", {
    user: owner,
    method: "POST",
    input: {
      kind: "evidence",
      locator: request.locator,
      category: request.category,
      scope: request.scope,
      detail: request.detail,
      collaborators: ["3"],
      consent: true,
      intake: syntheticEvidenceIntakeInput(["3"]),
    },
  });
  assert.equal(legacy.status, 201, legacy.text);
  const saved = h.store.read().requests[legacy.data.id].intake;
  assert.equal(saved.schemaVersion, "evidence-intake/v1");
  assert.equal(Object.hasOwn(saved, "externalTutorial"), false);
});

test("tutorial invitations share the exact declaration and all attribution without protected rationale or external fetches", async (t) => {
  let fetches = 0;
  t.mock.method(globalThis, "fetch", () => {
    fetches++;
    throw new Error("No external URL may be fetched by consent intake");
  });
  const h = await scenario(t);
  const invite = await invitation(h);
  assert.deepEqual(invite.externalTutorial, tutorialInput().intake.externalTutorial);
  assert.equal(invite.externalTutorialConsentEnabled, true);
  assert.deepEqual(invite.participantIds, ["1", "3"]);
  assert.equal(invite.role, null);
  assert.equal(invite.externalTutorial.publishedAt, null);
  assert.equal(invite.sourceUseState, "declared");
  assert.doesNotMatch(JSON.stringify(invite), /PRIVATE_TUTORIAL|sourceUseReview|reviewedInputDigest|history/);
  const outsider = await h.login("5");
  const hidden = await h.call("/controls/requests/" + h.receipt.id, { user: outsider });
  assert.equal(hidden.status, 404);
  assert.deepEqual((await h.call("/controls/invitations", { user: outsider })).data.invitations, []);
  const consented = await change(h, "consent", h.peer, affirmative(invite));
  assert.equal(consented.status, 200, consented.text);
  const request = stored(h);
  assert.equal(request.intake.participantConsents["3"].claimDigest, invite.claimDigest);
  assert.equal(hasConsentedEvidenceIntake(request), true);
  assert.equal(hasReviewedEvidenceIntake(request), false);
  assert.equal(fetches, 0);
});

test("tutorial consent cannot pass independent acceptance or a forged accepted publication", async (t) => {
  const h = await scenario(t);
  assert.equal((await change(h, "consent", h.peer, affirmative(await invitation(h)))).status, 200);
  const rejected = await denyWithoutMutation(
    h,
    () =>
      change(h, "review", h.reviewer, {
        decision: "accept",
        conflict: false,
        reason: "Synthetic independent declaration review",
        sourceReviewedPublic: true,
        policyVersion: policy,
        sourceUseReview: syntheticSourceUseReviewInput(),
      }),
    409,
  );
  assert.match(rejected.text, /External tutorial qualification is unavailable/);
  const protectedView = await h.call("/controls/requests/" + h.receipt.id, { user: h.owner });
  assert.equal(protectedView.data.intakeEligibility.state, "external_tutorial_qualification_unavailable");
  const forged = structuredClone(stored(h));
  forged.status = "accepted";
  forged.policyVersion = policy;
  forged.version++;
  const decision = {
    id: "synthetic-forged-tutorial-acceptance",
    receipt: forged.id,
    actor: "2",
    action: "accepted",
    at: h.now,
    version: forged.version,
    policyVersion: policy,
    sourceReviewedPublic: true,
    conflict: false,
    reason: "Synthetic stored-record negative, never an actual reviewer grant",
  };
  decision.sourceUseReview = createSourceUseReview(forged, syntheticSourceUseReviewInput(), {
    actorId: "2",
    roleVersion: "reviewer-role-1",
    at: h.now,
    policyVersion: policy,
  });
  forged.history.push(decision);
  assert.equal(hasConsentedEvidenceIntake(forged), true);
  assert.equal(hasReviewedEvidenceIntake(forged), false);
  h.store.transaction(
    (state) => {
      state.requests[forged.id] = forged;
      state.audit.push(decision);
    },
    { publish: true },
  );
  assert.deepEqual(h.store.publicSnapshot().claims, []);
  const stalePublication = h.store.publicSnapshot();
  stalePublication.claims.push({ id: forged.id, actorId: forged.owner });
  h.store.db.prepare("UPDATE controls_publication SET document=? WHERE id=1").run(JSON.stringify(stalePublication));
  await h.reopen();
  const publicView = await h.call("/controls/public");
  assert.equal(publicView.status, 200);
  assert.deepEqual(publicView.data.claims, []);
  assert.doesNotMatch(publicView.text, /tutorial\.example|PRIVATE_TUTORIAL|declared-revision/);
});

test("tutorial amendment binds revision, hash, time and roles while requiring fresh participant consent", async (t) => {
  const h = await scenario(t);
  const original = await invitation(h);
  assert.equal((await change(h, "consent", h.peer, affirmative(original))).status, 200);
  const input = tutorialInput();
  delete input.kind;
  input.intake.externalTutorial.revision = { id: "declared-revision-2", contentSha256: "d".repeat(64) };
  input.intake.externalTutorial.publishedAt = "2026-10-18T12:30:00.000Z";
  input.intake.roles.collaborators["3"] = "Declared translator";
  input.intake.externalTutorial.attribution[1].role = "Declared translator";
  const amended = await change(h, "amend", h.owner, {
    ...input,
    reason: "PRIVATE_AMENDMENT_REASON",
  });
  assert.equal(amended.status, 200, amended.text);
  const next = await invitation(h);
  assert.equal(next.externalTutorial.canonicalUrl, original.externalTutorial.canonicalUrl);
  assert.deepEqual(next.externalTutorial.revision, input.intake.externalTutorial.revision);
  assert.equal(next.externalTutorial.publishedAt, "2026-10-18T12:30:00.000Z");
  assert.equal(next.role, "Declared translator");
  assert.equal(next.claimRevision, original.claimRevision + 1);
  assert.notEqual(next.claimDigest, original.claimDigest);
  assert.equal(next.consent, "pending");
  assert.deepEqual(stored(h).intake.participantConsents, {});
  assert.doesNotMatch(JSON.stringify(next), /PRIVATE_AMENDMENT|PRIVATE_TUTORIAL/);
  await denyWithoutMutation(h, () => change(h, "consent", h.peer, affirmative(original)), 409);
  await denyWithoutMutation(
    h,
    () => change(h, "consent", h.peer, { ...affirmative(original), version: next.version }),
    409,
  );
  assert.equal((await change(h, "consent", h.peer, affirmative(next))).status, 200);
  const legacy = tutorialInput();
  delete legacy.kind;
  legacy.intake = syntheticEvidenceIntakeInput(["3"]);
  const removed = await change(h, "amend", h.owner, { ...legacy, reason: "Remove the optional declaration" });
  assert.equal(removed.status, 200, removed.text);
  assert.equal(stored(h).intake.schemaVersion, "evidence-intake/v1");
  assert.deepEqual(stored(h).intake.participantConsents, {});
  assert.equal(Object.hasOwn(await invitation(h), "externalTutorial"), false);
});

test("disabling tutorial consent after reopen preserves saved display, decline and withdrawal but rejects affirmation", async (t) => {
  const h = await scenario(t);
  await h.reopen(false);
  const terms = await h.call("/controls/evidence-terms", { user: h.owner });
  assert.deepEqual(terms.data, { terms: evidenceTerms() });
  const invite = await invitation(h);
  assert.equal(invite.externalTutorialConsentEnabled, false);
  assert.deepEqual(invite.externalTutorial, tutorialInput().intake.externalTutorial);
  await denyWithoutMutation(h, () => change(h, "consent", h.peer, affirmative(invite)), 409);
  const amendment = tutorialInput();
  delete amendment.kind;
  await denyWithoutMutation(
    h,
    () => change(h, "amend", h.owner, { ...amendment, reason: "Disabled profile cannot be affirmed" }),
    409,
  );
  assert.equal((await change(h, "consent", h.peer, { consent: false })).status, 200);
  assert.equal(stored(h).collaborators["3"], "declined");
  assert.equal((await change(h, "withdraw", h.owner)).status, 200);
  assert.equal(stored(h).status, "withdrawn");
  assert.deepEqual((await h.call("/controls/invitations", { user: h.peer })).data.invitations, []);
  assert.deepEqual(h.store.publicSnapshot().claims, []);
});

test("tutorial malformed declarations cannot enter real private state or confer participant authority", async (t) => {
  const h = await harness(t, true);
  const owner = await h.login("1");
  const mutations = [
    ["hidden rationale", (d) => (d.privateRationale = "PRIVATE")],
    ["credential URL", (d) => (d.canonicalUrl = "https://user:secret@tutorial.example.invalid/lesson")],
    ["fragment identity", (d) => (d.canonicalUrl += "#part")],
    ["mutable manifest", (d) => (d.manifest.locator = carrier.replace("a".repeat(40), "main"))],
    ["different carrier", (d) => (d.manifest.locator = carrier.replace("tutorial.json", "other.json"))],
    ["external manifest", (d) => (d.manifest.locator = "https://tutorial.example.invalid/manifest.json")],
    ["bad revision hash", (d) => (d.revision.contentSha256 = "short")],
    ["bad manifest hash", (d) => (d.manifest.contentSha256 = "F".repeat(64))],
    ["impossible publication", (d) => (d.publishedAt = "2026-02-30T00:00:00Z")],
    ["implicit publication", (d) => delete d.publishedAt],
    ["foreign attribution", (d) => (d.attribution[1].actorId = "5")],
    ["duplicate attribution", (d) => (d.attribution[1] = { ...d.attribution[0] })],
    ["unconsented role", (d) => (d.attribution[1].role = "Author")],
    ["oversized identity", (d) => (d.canonicalUrl += "x".repeat(2048))],
  ];
  for (const [label, mutate] of mutations) {
    const input = tutorialInput();
    mutate(input.intake.externalTutorial);
    const before = h.store.read();
    const result = await h.call("/controls/requests", { user: owner, method: "POST", input });
    assert.equal(result.status, 400, label + ": " + result.text);
    assert.deepEqual(h.store.read(), before, label);
  }
  const input = tutorialInput();
  input.category = "governance";
  await denyWithoutMutation(h, () => h.call("/controls/requests", { user: owner, method: "POST", input }), 400);
});

test("tutorial declaration copying rejects hooks and detaches the complete participant descriptor", () => {
  const input = tutorialInput();
  const context = { owner: "1", locator: carrier, category: "other", roles: input.intake.roles, participantIds: ["3"] };
  let hooks = 0;
  const declaration = structuredClone(input.intake.externalTutorial);
  Object.defineProperty(declaration.revision, "contentSha256", {
    enumerable: true,
    get() {
      hooks++;
      throw new Error("No getter read");
    },
  });
  assert.equal(parseExternalTutorialDeclaration(declaration, context), null);
  const proxy = Proxy.revocable(
    {},
    {
      ownKeys() {
        hooks++;
        throw new Error("No proxy hook");
      },
    },
  );
  assert.equal(parseExternalTutorialDeclaration(proxy.proxy, context), null);
  proxy.revoke();
  assert.equal(parseExternalTutorialDeclaration(proxy.proxy, context), null);
  assert.equal(hooks, 0);
  const parsed = parseExternalTutorialDeclaration(input.intake.externalTutorial, context);
  assert.deepEqual(parsed, input.intake.externalTutorial);
  input.intake.externalTutorial.attribution[0].role = "Changed after admission";
  assert.equal(parsed.attribution[0].role, "Declared tutorial author");
  assert.equal(parsed.publishedAt, null);
});

test("tutorial persisted declaration tampering cannot reuse completed consent", async (t) => {
  const h = await scenario(t);
  assert.equal((await change(h, "consent", h.peer, affirmative(await invitation(h)))).status, 200);
  const baseline = stored(h);
  assert.equal(hasConsentedEvidenceIntake(baseline), true);
  assert.equal(hasCurrentEvidenceConsent(baseline, baseline.owner), true);
  assert.equal(hasCurrentEvidenceConsent(baseline, "3"), true);
  const fixedConsentBytes = (request) =>
    JSON.stringify({
      id: request.id,
      version: request.version,
      claimRevision: request.intake.claimRevision,
      claimDigest: request.intake.claimDigest,
      submitterConsent: request.intake.submitterConsent,
      participantConsents: request.intake.participantConsents,
    });
  const originalConsentBytes = fixedConsentBytes(baseline);
  const mutations = [
    {
      label: "canonical tutorial identity",
      mutate(request) {
        request.intake.externalTutorial.canonicalUrl = "https://tutorial.example.invalid/lessons/other";
      },
    },
    {
      label: "tutorial revision identity",
      mutate(request) {
        request.intake.externalTutorial.revision.id = "declared-revision-2";
      },
    },
    {
      label: "tutorial content hash",
      mutate(request) {
        request.intake.externalTutorial.revision.contentSha256 = "d".repeat(64);
      },
    },
    {
      label: "manifest content hash",
      mutate(request) {
        request.intake.externalTutorial.manifest.contentSha256 = "e".repeat(64);
      },
    },
    {
      label: "declared publication time",
      mutate(request) {
        request.intake.externalTutorial.publishedAt = "2026-10-18T12:30:00.000Z";
      },
    },
    {
      label: "submitter role",
      mutate(request) {
        request.intake.roles.submitter = "Declared tutorial editor";
        request.intake.externalTutorial.attribution[0].role = request.intake.roles.submitter;
      },
    },
    {
      label: "peer role",
      mutate(request) {
        request.intake.roles.collaborators["3"] = "Declared translator";
        request.intake.externalTutorial.attribution[1].role = request.intake.roles.collaborators["3"];
      },
    },
    {
      label: "pinned GitHub carrier",
      mutate(request) {
        request.locator = carrier.replace("a".repeat(40), "f".repeat(40));
        request.intake.externalTutorial.manifest.locator = request.locator;
      },
    },
  ];
  assert.equal(mutations.length, 8);
  for (const { label, mutate } of mutations) {
    const candidate = structuredClone(baseline);
    mutate(candidate);
    assert.deepEqual(
      parseExternalTutorialDeclaration(candidate.intake.externalTutorial, {
        owner: candidate.owner,
        locator: candidate.locator,
        category: candidate.category,
        roles: candidate.intake.roles,
        participantIds: Object.keys(candidate.collaborators),
      }),
      candidate.intake.externalTutorial,
      label,
    );
    assert.equal(fixedConsentBytes(candidate), originalConsentBytes, label);
    assert.equal(hasConsentedEvidenceIntake(candidate), false, label);
    // Each participant consented to the complete attribution, including the other participant's role.
    if (label === "submitter role")
      assert.equal(candidate.intake.roles.collaborators["3"], baseline.intake.roles.collaborators["3"], label);
    if (label === "peer role") assert.equal(candidate.intake.roles.submitter, baseline.intake.roles.submitter, label);
    assert.equal(hasCurrentEvidenceConsent(candidate, baseline.owner), false, label);
    assert.equal(hasCurrentEvidenceConsent(candidate, "3"), false, label);
    assert.equal(fixedConsentBytes(candidate), originalConsentBytes, label);
  }
  assert.equal(fixedConsentBytes(baseline), originalConsentBytes);
  assert.deepEqual(stored(h), baseline);
});
