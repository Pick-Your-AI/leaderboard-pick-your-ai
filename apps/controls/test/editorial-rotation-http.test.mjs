import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { ControlStore } from "../src/store.mjs";
import { createControlsServer } from "../src/server.mjs";
import { nominateSpotlight, decideSpotlight } from "../src/editorial.mjs";
import { attachSyntheticEvidenceState } from "../../../tests/fixtures/evidence-intake.mjs";

const at = Date.parse("2026-10-19T12:00:00.000Z"),
  origin = "https://editorial.example.test";
const hash = (v) => createHash("sha256").update(v).digest("base64url");
async function harness(t, { onEligibility, clock = () => at } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "editorial-rotation-http-"));
  const filename = join(directory, "private.sqlite");
  let store = new ControlStore(filename),
    server,
    base;
  let eligible = true;
  const authorities = {
    1: { roles: [], version: "1" },
    2: { roles: ["reviewer"], version: "1" },
    3: { roles: ["reviewer"], version: "1" },
  };
  // Fictional accepted evidence and sessions are deliberately seeded. These
  // cases qualify the real HTTP/SQLite route, not OAuth or actual source rights.
  const nomination = store.transaction((state) => {
    state.requests.claim = {
      id: "claim",
      owner: "1",
      kind: "evidence",
      status: "accepted",
      version: 1,
      scope: "Synthetic reviewed infrastructure",
      detail: "Private input",
      policyVersion: "synthetic-editorial",
      locator: "https://github.com/synthetic/editorial/issues/1",
      category: "governance",
      collaborators: { 3: "accepted" },
      history: [
        {
          id: "synthetic-accept",
          actor: "2",
          action: "accepted",
          version: 1,
          at: at - 10000,
          policyVersion: "synthetic-editorial",
        },
      ],
    };
    state.audit.push(structuredClone(state.requests.claim.history[0]));
    attachSyntheticEvidenceState(state);
    const n = nominateSpotlight(state, { actorId: "1" }, { claimId: "claim", consent: true }, at - 5000);
    decideSpotlight(
      state,
      { actorId: "2", roles: ["reviewer"] },
      n.id,
      {
        version: 1,
        action: "accept",
        reason: "Private original review",
        publicExplanation: "Public original selection",
        conflict: false,
      },
      at - 4000,
    );
    return n.id;
  });
  function user(id) {
    const token = randomBytes(32).toString("base64url"),
      csrf = randomBytes(32).toString("base64url");
    store.transaction((s) => {
      s.sessions[hash(token)] = {
        actorId: id,
        csrf,
        roles: authorities[id].roles,
        roleVersion: authorities[id].version,
        expires: at + 100000,
      };
    });
    return { cookie: `__Host-controls_session=${token}`, csrf, token };
  }
  async function start() {
    server = createControlsServer({
      store,
      origin,
      now: clock,
      provider: {
        authorizationURL() {
          throw Error("Unused synthetic OAuth");
        },
        async exchange() {
          throw Error("Unused synthetic OAuth");
        },
      },
      rolesForActor: async (id) => structuredClone(authorities[id] ?? { roles: [], version: "0" }),
      spotlightEligibility: () => {
        onEligibility?.({ store });
        return eligible;
      },
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  }
  await start();
  async function close() {
    await new Promise((resolve) => server.close(resolve));
    store.close();
  }
  t.after(async () => {
    await close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    nomination,
    user,
    authorities,
    get store() {
      return store;
    },
    setEligible(value) {
      eligible = value;
    },
    async reopen() {
      await close();
      store = new ControlStore(filename);
      await start();
    },
    async call(path, user, input, extraHeaders = {}) {
      const response = await fetch(base + path, {
        method: input === undefined ? "GET" : "POST",
        redirect: "manual",
        headers: {
          ...(user ? { cookie: user.cookie, origin, "x-csrf-token": user.csrf } : {}),
          ...(input === undefined ? {} : { "content-type": "application/json" }),
          ...extraHeaders,
        },
        ...(input === undefined ? {} : { body: JSON.stringify(input) }),
      });
      return { status: response.status, headers: response.headers, data: await response.json() };
    },
  };
}
const proposal = (id, version = null) => ({
  nominationId: id,
  version,
  consent: true,
  workstreams: ["Editorial maintenance"],
  behindScenes: true,
  newcomerPeriod: null,
});
const accept = (version) => ({
  version,
  action: "accept",
  reason: "Private independent decision",
  conflict: false,
  publicExplanation: "Reviewed maintenance contribution\nwith its original evidence",
});

test("real HTTP classification review survives SQLite reopen and withdrawal after lost eligibility", async (t) => {
  const h = await harness(t),
    owner = h.user("1"),
    reviewer = h.user("2"),
    collaborator = h.user("3");
  const ranking = h.store.publicSnapshot(),
    original = h.store.read().spotlights;
  assert.equal((await h.call("/controls/spotlight-rotation/queue")).status, 401);
  assert.deepEqual((await h.call("/controls/spotlight-rotation")).data.candidates, []);
  const proposed = await h.call("/controls/spotlight-rotation", owner, proposal(h.nomination));
  assert.equal(proposed.status, 201);
  const route = `/controls/spotlight-rotation/${h.nomination}`;
  assert.equal((await h.call(route, owner, accept(1))).status, 403);
  assert.equal((await h.call(route, collaborator, accept(1))).status, 403);
  assert.equal((await h.call(route, reviewer, accept(1))).status, 200);
  const published = await h.call("/controls/spotlight-rotation");
  assert.equal(published.status, 200);
  assert.equal(published.headers.get("cache-control"), "no-store");
  assert.equal(published.data.candidates.length, 1);
  assert.equal(published.data.candidates[0].classificationExplanation, accept(1).publicExplanation);
  assert.equal(JSON.stringify(published.data).includes("Private"), false);
  const persisted = h.store.read().spotlightRotations;
  await h.reopen();
  assert.deepEqual(h.store.read().spotlightRotations, persisted);
  assert.deepEqual((await h.call("/controls/spotlight-rotation")).data, published.data);
  assert.deepEqual(h.store.publicSnapshot(), ranking);
  h.setEligible(false);
  h.store.transaction((s) => {
    s.requests.claim.status = "withdrawn";
    s.spotlights[h.nomination].version++;
  });
  assert.deepEqual((await h.call("/controls/spotlight-rotation")).data.candidates, []);
  const withheld = await h.call(route, owner, {
    version: 2,
    action: "withdraw",
    reason: "Withdraw separate dimensions",
  });
  assert.equal(withheld.status, 200);
  assert.equal(withheld.data.record.status, "withdrawn");
  assert.equal(h.store.read().spotlights[h.nomination].status, original[h.nomination].status);
  await h.reopen();
  assert.equal(h.store.read().spotlightRotations[h.nomination].status, "withdrawn");
});

test("real route rejects CSRF, stale versions, role revocation and caller-supplied history without state promotion", async (t) => {
  const h = await harness(t),
    owner = h.user("1"),
    reviewer = h.user("2");
  const before = h.store.read();
  assert.equal(
    (await h.call("/controls/spotlight-rotation", owner, proposal(h.nomination), { "x-csrf-token": "wrong" })).status,
    403,
  );
  assert.deepEqual(h.store.read(), before);
  assert.equal(
    (await h.call("/controls/spotlight-rotation", owner, { ...proposal(h.nomination), historyKey: "a".repeat(64) }))
      .status,
    400,
  );
  assert.deepEqual(h.store.read(), before);
  assert.equal((await h.call("/controls/spotlight-rotation", owner, proposal(h.nomination))).status, 201);
  assert.equal((await h.call("/controls/spotlight-rotation", owner, proposal(h.nomination))).status, 409);
  h.authorities[2] = { roles: [], version: "2" };
  assert.equal((await h.call(`/controls/spotlight-rotation/${h.nomination}`, reviewer, accept(1))).status, 401);
  assert.equal(h.store.read().spotlightRotations[h.nomination].status, "pending");
  assert.deepEqual((await h.call("/controls/spotlight-rotation")).data.candidates, []);
  assert.equal((await h.call("/controls/spotlight-rotation?historyKey=forged")).status, 400);
});

function revokePersistedSession(store, sid) {
  const state = store.read();
  assert.equal(Object.hasOwn(state.sessions, sid), true);
  delete state.sessions[sid];
  // Use the existing SQLite connection: a nested transaction would be rejected
  // before exercising the supported synchronous source callback boundary.
  store.db.prepare("UPDATE controls_state SET document=? WHERE id=1").run(JSON.stringify(state));
  assert.equal(Object.hasOwn(store.read().sessions, sid), false);
}

test("current sessions retain proposal, independent review and private queue access across read-only eligibility callbacks", async (t) => {
  let calls = 0;
  const h = await harness(t, {
    onEligibility: ({ store }) => {
      calls++;
      assert.equal(store.read().requests.claim.status, "accepted");
    },
  });
  const owner = h.user("1"),
    reviewer = h.user("2"),
    ranking = h.store.publicSnapshot();
  assert.equal((await h.call("/controls/spotlight-rotation", owner, proposal(h.nomination))).status, 201);
  assert.equal((await h.call(`/controls/spotlight-rotation/${h.nomination}`, reviewer, accept(1))).status, 200);
  const queue = await h.call("/controls/spotlight-rotation/queue", owner);
  assert.equal(queue.status, 200);
  assert.equal(queue.data.records.length, 1);
  assert.equal(queue.data.records[0].status, "accepted");
  assert.equal(queue.data.records[0].lastEvent.reason, accept(1).reason);
  assert.equal(queue.data.records[0].currentContext.state, "current");
  assert.ok(calls >= 3);
  assert.equal(Object.hasOwn(h.store.read().sessions, hash(owner.token)), true);
  assert.equal(Object.hasOwn(h.store.read().sessions, hash(reviewer.token)), true);
  assert.deepEqual(h.store.publicSnapshot(), ranking);
});

test("eligibility callback session revocation rejects the owner proposal before the cloned state is persisted", async (t) => {
  let sid,
    revocations = 0;
  const h = await harness(t, {
    onEligibility: ({ store }) => {
      if (!sid) return;
      const current = sid;
      sid = undefined;
      revokePersistedSession(store, current);
      revocations++;
    },
  });
  const owner = h.user("1"),
    before = h.store.read(),
    ranking = h.store.publicSnapshot();
  sid = hash(owner.token);
  const response = await h.call("/controls/spotlight-rotation", owner, proposal(h.nomination));
  t.diagnostic(
    JSON.stringify({
      status: response.status,
      revocations,
      proposalCreated: Object.hasOwn(h.store.read().spotlightRotations ?? {}, h.nomination),
    }),
  );
  assert.equal(revocations, 1);
  assert.equal(response.status, 401);
  assert.deepEqual(response.data, { error: "Session revoked" });
  // The failed transaction rolls back both its declaration/audit changes and
  // the callback's same-transaction session deletion. No durable logout is claimed.
  assert.deepEqual(h.store.read(), before);
  assert.deepEqual(h.store.publicSnapshot(), ranking);
});

test("eligibility callback session revocation cannot promote a pending declaration through independent review", async (t) => {
  let sid,
    revocations = 0;
  const h = await harness(t, {
    onEligibility: ({ store }) => {
      if (!sid) return;
      const current = sid;
      sid = undefined;
      revokePersistedSession(store, current);
      revocations++;
    },
  });
  const owner = h.user("1"),
    reviewer = h.user("2");
  assert.equal((await h.call("/controls/spotlight-rotation", owner, proposal(h.nomination))).status, 201);
  const before = h.store.read(),
    ranking = h.store.publicSnapshot();
  sid = hash(reviewer.token);
  const response = await h.call(`/controls/spotlight-rotation/${h.nomination}`, reviewer, accept(1));
  t.diagnostic(
    JSON.stringify({
      status: response.status,
      revocations,
      declarationStatus: h.store.read().spotlightRotations[h.nomination].status,
    }),
  );
  assert.equal(revocations, 1);
  assert.equal(response.status, 401);
  assert.deepEqual(response.data, { error: "Session revoked" });
  assert.deepEqual(h.store.read(), before);
  assert.deepEqual(h.store.publicSnapshot(), ranking);
  assert.deepEqual((await h.call("/controls/spotlight-rotation")).data.candidates, []);
});

test("eligibility callback session revocation withholds the private queue before response bytes are sent", async (t) => {
  let sid,
    revocations = 0;
  const h = await harness(t, {
    onEligibility: ({ store }) => {
      if (!sid) return;
      const current = sid;
      sid = undefined;
      revokePersistedSession(store, current);
      revocations++;
    },
  });
  const owner = h.user("1"),
    reviewer = h.user("2");
  assert.equal((await h.call("/controls/spotlight-rotation", owner, proposal(h.nomination))).status, 201);
  assert.equal((await h.call(`/controls/spotlight-rotation/${h.nomination}`, reviewer, accept(1))).status, 200);
  const before = h.store.read(),
    ranking = h.store.publicSnapshot();
  const revoked = hash(owner.token);
  sid = revoked;
  const response = await h.call("/controls/spotlight-rotation/queue", owner);
  t.diagnostic(
    JSON.stringify({
      status: response.status,
      revocations,
      privateReasonDisclosed: JSON.stringify(response.data).includes(accept(1).reason),
      sessionPresent: Object.hasOwn(h.store.read().sessions, revoked),
    }),
  );
  assert.equal(revocations, 1);
  assert.equal(response.status, 401);
  assert.deepEqual(response.data, { error: "Session revoked" });
  // Queue projection is outside the mutation transaction, so this deletion
  // persists. Every other private field and the public metric state stay exact.
  delete before.sessions[revoked];
  assert.deepEqual(h.store.read(), before);
  assert.deepEqual(h.store.publicSnapshot(), ranking);
});

for (const actorId of ["1", "2"]) {
  for (const eligible of [true, false]) {
    const actor = actorId === "1" ? "owner" : "reviewer";
    const context = eligible ? "eligible" : "unavailable";
    test(`queue denies ${actor} when its session expires during ${context} source context`, async (t) => {
      let current = at,
        expires,
        armed = false,
        expiryTransitions = 0;
      const h = await harness(t, {
        clock: () => current,
        onEligibility: () => {
          if (!armed) return;
          armed = false;
          current = expires;
          expiryTransitions++;
        },
      });
      const owner = h.user("1"),
        reviewer = h.user("2");
      assert.equal((await h.call("/controls/spotlight-rotation", owner, proposal(h.nomination))).status, 201);
      assert.equal((await h.call(`/controls/spotlight-rotation/${h.nomination}`, reviewer, accept(1))).status, 200);
      const reader = actorId === "1" ? owner : reviewer;
      expires = h.store.read().sessions[hash(reader.token)].expires;
      const before = h.store.db.prepare("SELECT document FROM controls_state WHERE id=1").get().document;
      const ranking = h.store.publicSnapshot();
      h.setEligible(eligible);
      armed = true;
      const response = await h.call("/controls/spotlight-rotation/queue", reader);
      t.diagnostic(
        JSON.stringify({
          status: response.status,
          expiryTransitions,
          reachedExactExpiry: current === expires,
          privateReasonDisclosed: JSON.stringify(response.data).includes(accept(1).reason),
        }),
      );
      assert.equal(expiryTransitions, 1);
      assert.equal(current, expires);
      assert.equal(response.status, 401);
      assert.deepEqual(response.data, { error: "Session revoked" });
      // Only the supported clock advances. No callback SQL write or transaction
      // rollback can explain the denial, and the complete private document stays exact.
      assert.equal(h.store.db.prepare("SELECT document FROM controls_state WHERE id=1").get().document, before);
      assert.deepEqual(h.store.publicSnapshot(), ranking);
    });
  }
}
