import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
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

// Fictional actors, OAuth exchanges and evidence; only a disposable local server is contacted.
const origin = "https://consent.example.test";
const policy = "synthetic-consent-1";
const evidence = (collaborators) => ({
  kind: "evidence",
  locator: "https://github.com/synthetic-consent/fixtures/issues/1",
  category: "governance",
  collaborators,
  consent: true,
  detail: "Synthetic private supporting detail",
  scope: "One synthetic voluntary contribution",
  intake: syntheticEvidenceIntakeInput(collaborators),
});

async function harness(t) {
  const directory = mkdtempSync(join(tmpdir(), "leaderboard-evidence-consent-"));
  const filename = join(directory, "private.sqlite");
  const challenges = new Set();
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
  let store;
  let server;
  let base;
  async function start() {
    store = new ControlStore(filename);
    server = createControlsServer({
      store,
      provider,
      origin,
      approvedPolicyVersions: [policy],
      rolesForActor: (id) => ({ roles: ["2", "9"].includes(id) ? ["reviewer"] : [], version: "1" }),
      now: () => 1_000_000,
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
                data: response.headers["content-type"]?.includes("application/json") ? JSON.parse(text) : undefined,
              });
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      request.on("error", reject);
      request.setTimeout(5_000, () => request.destroy(new Error("Synthetic consent request timed out")));
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
    return { cookie, csrf: session.data.csrf };
  }
  return {
    call,
    login,
    get store() {
      return store;
    },
    async reopen() {
      await stop();
      await start();
    },
  };
}

async function submission(t, ids = ["2"]) {
  const h = await harness(t);
  h.owner = await h.login("1");
  h.reviewer = await h.login("9");
  h.peers = new Map();
  for (const id of ids) h.peers.set(id, await h.login(id));
  const submitted = await h.call("/controls/requests", { user: h.owner, method: "POST", input: evidence(ids) });
  assert.equal(submitted.status, 201);
  h.receipt = submitted.data;
  return h;
}

async function change(h, user, action, input, expectedStatus = 200) {
  const response = await h.call(`/controls/requests/${h.receipt.id}/${action}`, {
    user,
    method: "POST",
    input: { version: h.receipt.version, ...input },
  });
  assert.equal(response.status, expectedStatus, `${action}: ${JSON.stringify(response.data)}`);
  if (response.status === 200) h.receipt = response.data;
  return response;
}
async function consent(h, id, value) {
  const input = { consent: value };
  if (value) {
    const response = await h.call("/controls/invitations", { user: h.peers.get(id) });
    assert.equal(response.status, 200);
    const invitation = response.data.invitations.find((entry) => entry.id === h.receipt.id);
    assert.ok(invitation);
    Object.assign(input, {
      claimDigest: invitation.claimDigest,
      termsVersion: invitation.terms.version,
      termsDigest: invitation.terms.digest,
    });
  }
  return change(h, h.peers.get(id), "consent", input);
}
const accept = (h, user = h.reviewer, status = 200) =>
  change(
    h,
    user,
    "review",
    {
      decision: "accept",
      reason: "Synthetic independently reviewed public source",
      conflict: false,
      sourceReviewedPublic: true,
      sourceUseReview: syntheticSourceUseReviewInput(),
      policyVersion: policy,
    },
    status,
  );
const persisted = (h) => h.store.read().requests[h.receipt.id];
async function publicClaims(h) {
  const response = await h.call("/controls/public");
  assert.equal(response.status, 200);
  assert.deepEqual(response.data.claims, h.store.publicSnapshot().claims);
  return response.data.claims;
}
async function blockedAcceptance(h) {
  const before = { state: h.store.read(), publication: h.store.publicSnapshot() };
  await accept(h, h.reviewer, 409);
  assert.deepEqual(h.store.read(), before.state, "Denied acceptance must not alter receipts, audit or revision");
  assert.deepEqual(h.store.publicSnapshot(), before.publication, "Denied acceptance must not publish");
  assert.deepEqual(await publicClaims(h), []);
}
async function acceptedSubmission(t, ids = ["2"]) {
  const h = await submission(t, ids);
  for (const id of ids) await consent(h, id, true);
  await accept(h);
  assert.equal(h.receipt.status, "accepted");
  return h;
}

for (const decision of ["pending", "declined"]) {
  test(`${decision} collaborator consent prevents independent acceptance without mutation`, async (t) => {
    const h = await submission(t);
    if (decision === "declined") await consent(h, "2", false);
    assert.equal(persisted(h).collaborators["2"], decision);
    await blockedAcceptance(h);
    const before = persisted(h);
    await h.reopen();
    assert.deepEqual(persisted(h), before);
    assert.deepEqual(await publicClaims(h), []);
  });
}

test("one collaborator cannot consent for another listed participant", async (t) => {
  const h = await submission(t, ["2", "3"]);
  await consent(h, "2", true);
  assert.deepEqual(persisted(h).collaborators, { 2: "accepted", 3: "pending" });
  await blockedAcceptance(h);
});

test("every participant consents individually before an independent reviewer can publish", async (t) => {
  const h = await submission(t, ["2", "3"]);
  for (const id of ["2", "3"]) {
    await consent(h, id, true);
    assert.equal(h.receipt.status, "pending");
    assert.equal(persisted(h).policyVersion, undefined);
    assert.deepEqual(await publicClaims(h), []);
  }
  const before = h.store.read();
  await accept(h, h.peers.get("2"), 403);
  assert.deepEqual(h.store.read(), before, "A listed reviewer cannot accept their own attribution");
  await accept(h);
  const published = await publicClaims(h);
  assert.equal(published.length, 1);
  assert.equal(published[0].actorId, "1");
  assert.deepEqual(published[0].collaborators, ["2", "3"]);
  assert.equal(published[0].policyVersion, policy);
  await h.reopen();
  assert.deepEqual(await publicClaims(h), published);
  assert.equal(persisted(h).status, "accepted");
});

test("declining an accepted claim removes publication and reconsent still needs independent review", async (t) => {
  const h = await acceptedSubmission(t);
  const acceptedHistory = persisted(h).history.filter((entry) => entry.action === "accepted");
  await consent(h, "2", false);
  assert.equal(h.receipt.status, "pending");
  assert.equal(persisted(h).policyVersion, undefined);
  assert.equal(persisted(h).collaborators["2"], "declined");
  assert.deepEqual(await publicClaims(h), []);
  await h.reopen();
  assert.equal(persisted(h).status, "pending");
  assert.deepEqual(await publicClaims(h), []);
  await consent(h, "2", true);
  assert.equal(h.receipt.status, "pending");
  assert.equal(persisted(h).policyVersion, undefined);
  assert.deepEqual(await publicClaims(h), []);
  assert.deepEqual(
    persisted(h).history.filter((entry) => entry.action === "accepted"),
    acceptedHistory,
  );
  await accept(h);
  assert.equal(persisted(h).history.filter((entry) => entry.action === "accepted").length, 2);
  assert.deepEqual((await publicClaims(h))[0].collaborators, ["2"]);
});

test("amending accepted evidence resets retained participants' consent and requires a fresh decision", async (t) => {
  const h = await acceptedSubmission(t);
  await change(h, h.owner, "amend", {
    reason: "Synthetic changed claim",
    locator: "https://github.com/synthetic-consent/fixtures/issues/2",
    category: "governance",
    scope: "A revised synthetic voluntary contribution",
    detail: "Synthetic amended private supporting detail",
    collaborators: ["2"],
    consent: true,
    intake: syntheticEvidenceIntakeInput(["2"]),
  });
  assert.equal(h.receipt.status, "pending");
  assert.equal(persisted(h).policyVersion, undefined);
  assert.equal(persisted(h).collaborators["2"], "pending");
  assert.equal(persisted(h).history.at(-1).previous.collaborators["2"], "accepted");
  assert.deepEqual(await publicClaims(h), []);
  await blockedAcceptance(h);
  await consent(h, "2", true);
  assert.equal(h.receipt.status, "pending");
  assert.deepEqual(await publicClaims(h), []);
  await accept(h);
  assert.equal((await publicClaims(h))[0].locator, "https://github.com/synthetic-consent/fixtures/issues/2");
});

test("repeating current consent on a sound accepted claim leaves the receipt and audit unchanged", async (t) => {
  const h = await acceptedSubmission(t);
  const before = { request: persisted(h), audit: h.store.read().audit, claims: await publicClaims(h) };
  await consent(h, "2", true);
  assert.equal(h.receipt.version, before.request.version);
  assert.equal(h.receipt.status, "accepted");
  assert.deepEqual(persisted(h), before.request);
  assert.deepEqual(h.store.read().audit, before.audit);
  assert.deepEqual(await publicClaims(h), before.claims);
  // The existing transaction may advance its publication revision without a new consent decision.
  await h.reopen();
  assert.deepEqual(persisted(h), before.request);
  assert.deepEqual(await publicClaims(h), before.claims);
});

test("independently accepted evidence with no collaborators remains published after reopening", async (t) => {
  const h = await acceptedSubmission(t, []);
  const published = await publicClaims(h);
  assert.equal(published.length, 1);
  assert.equal(published[0].id, h.receipt.id);
  assert.deepEqual(published[0].collaborators, []);
  await h.reopen();
  assert.equal(persisted(h).policyVersion, policy);
  assert.deepEqual(await publicClaims(h), published);
});

function seedLegacyAcceptedPublication(h, { lateConsent = false } = {}) {
  // Preserve a pre-fix accepted row and its old materialized public claim. The new API must not create this state.
  const state = h.store.read();
  const request = state.requests[h.receipt.id];
  // This is the original pre-intake stored shape, even though its surrounding
  // authenticated session was created by the current test harness.
  delete request.intake;
  request.status = "accepted";
  request.policyVersion = policy;
  const entry = {
    id: randomUUID(),
    receipt: request.id,
    actor: "9",
    action: "accepted",
    at: 1_000_000,
    version: ++request.version,
    reason: "Synthetic historical acceptance",
    policyVersion: policy,
  };
  request.history.push(entry);
  state.audit.push(entry);
  if (lateConsent) {
    // The old API left this accepted even though consent postdated the reviewed revision.
    request.collaborators["2"] = "accepted";
    const consentEntry = {
      id: randomUUID(),
      receipt: request.id,
      actor: "2",
      action: "attribution-accepted",
      at: 1_000_001,
      version: ++request.version,
    };
    request.history.push(consentEntry);
    state.audit.push(consentEntry);
  }
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
      collaborators: request.collaborators["2"] === "accepted" ? ["2"] : [],
    },
  ];
  h.store.db.exec("BEGIN IMMEDIATE");
  try {
    h.store.db.prepare("UPDATE controls_state SET document=? WHERE id=1").run(JSON.stringify(state));
    h.store.db.prepare("UPDATE controls_publication SET document=? WHERE id=1").run(JSON.stringify(publication));
    h.store.db.exec("COMMIT");
    h.receipt = { id: request.id, version: request.version, status: request.status };
  } catch (error) {
    h.store.db.exec("ROLLBACK");
    throw error;
  }
}

for (const consentState of ["pending", "declined"]) {
  for (const restart of [false, true]) {
    test(`legacy accepted claim with ${consentState} consent is hidden on ${restart ? "startup" : "read"}`, async (t) => {
      const h = await submission(t);
      if (consentState === "declined") await consent(h, "2", false);
      seedLegacyAcceptedPublication(h);
      if (restart) await h.reopen();
      assert.equal(persisted(h).collaborators["2"], consentState, "Reading cannot manufacture participant consent");
      assert.deepEqual(await publicClaims(h), [], "A legacy public row cannot bypass current participant consent");
    });
  }
}

test("legacy consent granted after acceptance cannot publish an unreviewed request version", async (t) => {
  const h = await submission(t);
  seedLegacyAcceptedPublication(h, { lateConsent: true });
  const stored = persisted(h);
  assert.deepEqual(stored.collaborators, { 2: "accepted" });
  assert.ok(stored.history.findLast((entry) => entry.action === "accepted").version < stored.version);
  assert.deepEqual(await publicClaims(h), []);
  await h.reopen();
  assert.deepEqual(await publicClaims(h), []);
});

test("legacy acceptance of a fully consented revision still requires current scoped intake", async (t) => {
  const h = await submission(t);
  await consent(h, "2", true);
  seedLegacyAcceptedPublication(h);
  const stored = persisted(h);
  assert.equal(stored.history.findLast((entry) => entry.action === "accepted").version, stored.version);
  assert.equal(stored.intake, undefined);
  assert.deepEqual(await publicClaims(h), []);
  await h.reopen();
  assert.deepEqual(await publicClaims(h), []);
  assert.deepEqual(persisted(h), stored, "Startup cannot manufacture current intake for a historical acceptance");
});

test("legacy consent needs owner amendment, current intake and fresh independent review before publication", async (t) => {
  const h = await submission(t);
  seedLegacyAcceptedPublication(h, { lateConsent: true });
  await blockedAcceptance(h);
  await change(h, h.owner, "amend", {
    reason: "Synthetic owner presents this legacy contribution under current terms",
    locator: evidence(["2"]).locator,
    category: "governance",
    scope: "One synthetic voluntary contribution",
    detail: "Synthetic reviewed legacy supporting detail",
    collaborators: ["2"],
    consent: true,
    intake: syntheticEvidenceIntakeInput(["2"]),
  });
  await consent(h, "2", true);
  assert.equal(h.receipt.status, "pending");
  assert.equal(persisted(h).policyVersion, undefined);
  assert.deepEqual(await publicClaims(h), []);
  await accept(h);
  const stored = persisted(h);
  assert.equal(stored.history.findLast((entry) => entry.action === "accepted").version, stored.version);
  assert.deepEqual((await publicClaims(h))[0].collaborators, ["2"]);
});
