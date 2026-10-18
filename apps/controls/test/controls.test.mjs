import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import { ControlStore } from "../src/store.mjs";
import { createControlsServer } from "../src/server.mjs";
import { githubOAuthProvider } from "../src/github.mjs";
import { configurationOverlay } from "../src/configuration.mjs";

// All identities and evidence in this file are fictional test examples.
const origin = "https://controls.example.test";
const fixture = (extra = {}) => ({
  kind: "evidence",
  locator: "https://github.com/synthetic-example/demo/issues/1",
  category: "governance",
  collaborators: [],
  consent: true,
  detail: "Synthetic private verification detail",
  scope: "One synthetic reviewed change",
  ...extra,
});

async function harness(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), "leaderboard-controls-test-"));
  const filename = join(directory, "private.sqlite");
  const store = new ControlStore(filename, options);
  let timestamp = 100_000;
  let broken = false;
  const authorities = new Map([
    ["2", { roles: ["reviewer"], version: "1" }],
    ["3", { roles: ["reviewer"], version: "1" }],
    ["4", { roles: ["privacy"], version: "1" }],
    ["7", { roles: ["operator"], version: "1" }],
    ["8", { roles: ["operator"], version: "1" }],
  ]);
  const challenges = new Map();
  const provider = {
    authorizationURL({ state, challenge, redirectURI }) {
      assert.equal(redirectURI, origin + "/controls/auth/callback");
      challenges.set(state, challenge);
      return (
        "https://github.com/login/oauth/authorize?" +
        new URLSearchParams({
          state,
          redirect_uri: redirectURI,
          code_challenge: challenge,
          code_challenge_method: "S256",
          scope: "",
        })
      );
    },
    async exchange({ code, verifier, redirectURI }) {
      assert.equal(redirectURI, origin + "/controls/auth/callback");
      assert.ok([...challenges.values()].includes(createHash("sha256").update(verifier).digest("base64url")));
      if (broken) throw Error("Synthetic identity outage");
      return { actorId: code };
    },
  };
  const server = createControlsServer({
    store,
    provider,
    origin,
    loginSuccessPath: options.loginSuccessPath,
    spotlightEligibility: options.spotlightEligibility,
    approvedPolicyVersions: options.approvedPolicyVersions || ["test-1"],
    knownMetricIds: ["pr_merged", "prs_reviewed"],
    sourceVerifier: options.sourceVerifier ? (input) => options.sourceVerifier(input, timestamp) : undefined,
    rolesForActor: (id) => authorities.get(id) || { roles: [], version: "0" },
    now: () => timestamp,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function call(path, { user, method = "GET", input, headers = {} } = {}) {
    const response = await fetch(base + path, {
      method,
      redirect: "manual",
      headers: {
        ...(user ? { cookie: user.cookie, origin, "x-csrf-token": user.csrf } : {}),
        ...(input !== undefined ? { "content-type": "application/json" } : {}),
        ...headers,
      },
      ...(input !== undefined ? { body: JSON.stringify(input) } : {}),
    });
    let data;
    if (response.headers.get("content-type")?.includes("application/json")) data = await response.json();
    return { response, status: response.status, data };
  }
  async function begin() {
    const start = await call("/controls/auth/login");
    assert.equal(start.status, 302);
    const target = new URL(start.response.headers.get("location"));
    return {
      state: target.searchParams.get("state"),
      cookie: start.response.headers.getSetCookie()[0].split(";")[0],
      target,
    };
  }
  async function login(id, oldCookie) {
    const started = await begin();
    const callback = await call("/controls/auth/callback?" + new URLSearchParams({ state: started.state, code: id }), {
      headers: { cookie: started.cookie + (oldCookie ? "; " + oldCookie : "") },
    });
    assert.equal(callback.status, 303);
    const header = callback.response.headers.getSetCookie().find((c) => c.startsWith("__Host-controls_session="));
    assert.match(header, /HttpOnly; Secure; SameSite=Lax; Max-Age=900/);
    const cookie = header.split(";")[0];
    const session = await call("/controls/session", { headers: { cookie } });
    assert.equal(session.status, 200);
    return { cookie, csrf: session.data.csrf, actorId: id };
  }
  const close = async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
  };
  t.after(async () => {
    await close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    store,
    filename,
    authorities,
    call,
    login,
    begin,
    base,
    advance: (n) => {
      timestamp += n;
    },
    breakProvider: () => {
      broken = true;
    },
  };
}

test("anonymous snapshot is available without login and no private state is exposed", async (t) => {
  const h = await harness(t);
  assert.equal((await h.call("/controls/public")).status, 200);
  for (const path of ["/controls/session", "/controls/requests", "/controls/invitations"])
    assert.equal((await h.call(path)).status, 401);
  const user = await h.login("1");
  const receipt = await h.call("/controls/requests", { user, method: "POST", input: fixture() });
  assert.equal(receipt.status, 201);
  const snapshot = await h.call("/controls/public");
  assert.deepEqual(snapshot.data.claims, []);
  assert.ok(!JSON.stringify(snapshot.data).includes("private"));
  assert.equal(snapshot.response.headers.get("cache-control"), "no-store");
});

test("OAuth requires browser-bound one-use state, exact callback shape and PKCE", async (t) => {
  const h = await harness(t);
  const started = await h.begin();
  assert.equal(started.target.searchParams.get("scope"), "");
  assert.equal(started.target.searchParams.get("code_challenge_method"), "S256");
  const path = `/controls/auth/callback?state=${started.state}&code=1`;
  assert.equal((await h.call(path)).status, 400);
  assert.equal((await h.call(path, { headers: { cookie: "__Host-controls_login=wrong" } })).status, 400);
  assert.equal((await h.call(path + "&state=other", { headers: { cookie: started.cookie } })).status, 400);
  assert.equal(
    (await h.call(path + "&redirect_uri=https://evil.test", { headers: { cookie: started.cookie } })).status,
    400,
  );
  assert.equal((await h.call(path, { headers: { cookie: started.cookie } })).status, 303);
  assert.equal((await h.call(path, { headers: { cookie: started.cookie } })).status, 400);
  const expired = await h.begin();
  h.advance(600_001);
  assert.equal(
    (await h.call(`/controls/auth/callback?state=${expired.state}&code=1`, { headers: { cookie: expired.cookie } }))
      .status,
    400,
  );
});

test("provider error consumes callback state and never creates a session", async (t) => {
  const h = await harness(t);
  const started = await h.begin();
  h.breakProvider();
  const path = `/controls/auth/callback?state=${started.state}&code=1`;
  assert.equal((await h.call(path, { headers: { cookie: started.cookie } })).status, 500);
  assert.equal((await h.call(path, { headers: { cookie: started.cookie } })).status, 400);
  assert.equal(Object.keys(h.store.read().sessions).length, 0);
});

test("sessions rotate on reauthentication, expire, revoke and contain no provider token", async (t) => {
  const h = await harness(t);
  const original = await h.login("1");
  const rotated = await h.login("1", original.cookie);
  assert.notEqual(original.cookie, rotated.cookie);
  assert.equal((await h.call("/controls/session", { user: original })).status, 401);
  assert.ok(!JSON.stringify(h.store.read()).includes(rotated.cookie.split("=")[1]));
  const other = await h.login("1");
  assert.equal((await h.call("/controls/sessions/revoke", { user: rotated, method: "POST", input: {} })).status, 200);
  assert.equal((await h.call("/controls/session", { user: other })).status, 401);
  const expiring = await h.login("1");
  h.advance(900_001);
  assert.equal((await h.call("/controls/session", { user: expiring })).status, 401);
});

test("mutations enforce CSRF, origin, JSON, duplicate-cookie and ownership boundaries", async (t) => {
  const h = await harness(t);
  const user = await h.login("1");
  for (const headers of [{ "x-csrf-token": "" }, { origin: "https://evil.test" }]) {
    assert.equal(
      (
        await h.call("/controls/profile", {
          user,
          method: "POST",
          input: { bio: "ok", highlights: [], public: true },
          headers,
        })
      ).status,
      403,
    );
  }
  assert.equal(
    (
      await h.call("/controls/profile", {
        user,
        method: "POST",
        input: { actorId: "2", bio: "ok", highlights: [], public: true },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await h.call("/controls/profile", {
        user,
        method: "POST",
        input: { bio: "<script>alert(1)</script>", highlights: [], public: true },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await h.call("/controls/profile", {
        user,
        method: "POST",
        input: { bio: "ok", highlights: [], public: true },
        headers: { "content-type": "text/plain" },
      })
    ).status,
    415,
  );
  assert.equal(
    (await h.call("/controls/session", { user, headers: { cookie: user.cookie + "; " + user.cookie } })).status,
    400,
  );
});

test("role changes invalidate sessions and direct API calls cannot approve self recognition", async (t) => {
  const h = await harness(t);
  const user = await h.login("1");
  const reviewer = await h.login("2");
  const receipt = (
    await h.call("/controls/requests", { user, method: "POST", input: fixture({ collaborators: ["2"] }) })
  ).data;
  const approve = {
    version: receipt.version,
    decision: "accept",
    reason: "Synthetic review",
    conflict: false,
    policyVersion: "test-1",
    sourceReviewedPublic: true,
  };
  assert.equal(
    (await h.call(`/controls/requests/${receipt.id}/review`, { user, method: "POST", input: approve })).status,
    403,
  );
  assert.equal(
    (await h.call(`/controls/requests/${receipt.id}/review`, { user: reviewer, method: "POST", input: approve }))
      .status,
    403,
  );
  h.authorities.set("2", { roles: [], version: "2" });
  assert.equal((await h.call("/controls/session", { user: reviewer })).status, 401);
});

test("receipt access separates requester, collaborators, evidence reviewers and privacy staff", async (t) => {
  const h = await harness(t);
  const owner = await h.login("1");
  const stranger = await h.login("5");
  const reviewer = await h.login("2");
  const privacy = await h.login("4");
  const receipt = (
    await h.call("/controls/requests", {
      user: owner,
      method: "POST",
      input: { kind: "privacy", detail: "Synthetic confidential identity inquiry" },
    })
  ).data;
  assert.equal((await h.call(`/controls/requests/${receipt.id}`, { user: stranger })).status, 404);
  for (const action of ["review", "withdraw", "appeal", "amend", "consent"]) {
    assert.equal(
      (
        await h.call(`/controls/requests/${receipt.id}/${action}`, {
          user: stranger,
          method: "POST",
          input: { version: 999 },
        })
      ).status,
      404,
    );
  }
  assert.equal((await h.call(`/controls/requests/${receipt.id}`, { user: reviewer })).status, 404);
  assert.equal((await h.call(`/controls/requests/${receipt.id}`, { user: privacy })).status, 200);
  assert.deepEqual((await h.call("/controls/requests", { user: reviewer })).data.requests, []);
  assert.equal(
    (
      await h.call(`/controls/requests/${receipt.id}/review`, {
        user: privacy,
        method: "POST",
        input: { version: 1, decision: "accept", conflict: false, reason: "Cannot fabricate delivery" },
      })
    ).status,
    409,
  );
});

test("safe public locators are not fetched and private/unsafe locator forms are rejected", async (t) => {
  const h = await harness(t);
  const user = await h.login("1");
  for (const url of [
    "http://github.com/a/b/issues/1",
    "https://127.0.0.1/a/b",
    "https://github.com.evil.test/a/b/issues/1",
    "https://user:pass@github.com/a/b/issues/1",
    "javascript:alert(1)",
    "https://github.com:444/a/b/issues/1",
  ]) {
    assert.equal(
      (await h.call("/controls/requests", { user, method: "POST", input: fixture({ locator: url }) })).status,
      400,
      url,
    );
  }
});

test("independent acceptance, collaborator opt-in/decline, withdrawal and restart update actual output", async (t) => {
  const h = await harness(t);
  const owner = await h.login("1");
  const reviewer = await h.login("2");
  const collaborator = await h.login("5");
  let receipt = (
    await h.call("/controls/requests", { user: owner, method: "POST", input: fixture({ collaborators: ["5"] }) })
  ).data;
  const invitation = (await h.call("/controls/invitations", { user: collaborator })).data.invitations[0];
  assert.equal(invitation.id, receipt.id);
  assert.equal(invitation.detail, undefined);
  receipt = (
    await h.call(`/controls/requests/${receipt.id}/review`, {
      user: reviewer,
      method: "POST",
      input: {
        version: 1,
        decision: "accept",
        conflict: false,
        reason: "Synthetic public artifact/role verified",
        sourceReviewedPublic: true,
        policyVersion: "test-1",
      },
    })
  ).data;
  let published = (await h.call("/controls/public")).data;
  assert.deepEqual(published.claims[0].collaborators, []);
  receipt = (
    await h.call(`/controls/requests/${receipt.id}/consent`, {
      user: collaborator,
      method: "POST",
      input: { version: receipt.version, consent: true },
    })
  ).data;
  assert.deepEqual((await h.call("/controls/public")).data.claims[0].collaborators, ["5"]);
  receipt = (
    await h.call(`/controls/requests/${receipt.id}/consent`, {
      user: collaborator,
      method: "POST",
      input: { version: receipt.version, consent: false },
    })
  ).data;
  assert.deepEqual((await h.call("/controls/public")).data.claims[0].collaborators, []);
  const reopened = new ControlStore(h.filename);
  try {
    assert.equal(reopened.publicSnapshot().claims[0].id, receipt.id);
    assert.equal(reopened.read().requests[receipt.id].history.length, 4);
    assert.equal(
      (
        await h.call(`/controls/requests/${receipt.id}/withdraw`, {
          user: owner,
          method: "POST",
          input: { version: receipt.version },
        })
      ).status,
      200,
    );
    assert.deepEqual(reopened.publicSnapshot().claims, []);
  } finally {
    reopened.close();
  }
});

test("appeals require another reviewer, optimistic versions prevent stale changes and rollback removes claim", async (t) => {
  const h = await harness(t);
  const owner = await h.login("1");
  const reviewer = await h.login("2");
  const other = await h.login("3");
  let receipt = (await h.call("/controls/requests", { user: owner, method: "POST", input: fixture() })).data;
  const review = (version, decision) => ({
    version,
    decision,
    conflict: false,
    reason: "Synthetic reviewed decision",
    sourceReviewedPublic: true,
    policyVersion: "test-1",
  });
  receipt = (
    await h.call(`/controls/requests/${receipt.id}/review`, {
      user: reviewer,
      method: "POST",
      input: review(receipt.version, "reject"),
    })
  ).data;
  assert.equal(
    (
      await h.call(`/controls/requests/${receipt.id}/appeal`, {
        user: owner,
        method: "POST",
        input: { version: 1, reason: "Stale" },
      })
    ).status,
    409,
  );
  receipt = (
    await h.call(`/controls/requests/${receipt.id}/appeal`, {
      user: owner,
      method: "POST",
      input: { version: receipt.version, reason: "Synthetic additional evidence" },
    })
  ).data;
  assert.equal(
    (
      await h.call(`/controls/requests/${receipt.id}/review`, {
        user: reviewer,
        method: "POST",
        input: review(receipt.version, "accept"),
      })
    ).status,
    403,
  );
  receipt = (
    await h.call(`/controls/requests/${receipt.id}/review`, {
      user: other,
      method: "POST",
      input: review(receipt.version, "accept"),
    })
  ).data;
  assert.equal((await h.call("/controls/public")).data.claims.length, 1);
  const third = await h.login("6");
  h.authorities.set("6", { roles: ["reviewer"], version: "1" });
  const thirdReviewer = await h.login("6", third.cookie);
  receipt = (
    await h.call(`/controls/requests/${receipt.id}/review`, {
      user: thirdReviewer,
      method: "POST",
      input: review(receipt.version, "rollback"),
    })
  ).data;
  assert.equal(receipt.status, "pending");
  assert.deepEqual((await h.call("/controls/public")).data.claims, []);
});

test("self profile controls and suppression atomically remove profile, authored claim and collaborator attribution", async (t) => {
  const h = await harness(t);
  const owner = await h.login("1");
  const reviewer = await h.login("2");
  const other = await h.login("5");
  assert.equal(
    (
      await h.call("/controls/profile", {
        user: owner,
        method: "POST",
        input: {
          bio: "Synthetic public bio",
          highlights: ["https://github.com/synthetic-example/demo/issues/1"],
          public: true,
        },
      })
    ).status,
    200,
  );
  for (const user of [owner, other]) {
    const receipt = (
      await h.call("/controls/requests", {
        user,
        method: "POST",
        input: fixture(user === other ? { collaborators: ["1"] } : {}),
      })
    ).data;
    const accepted = (
      await h.call(`/controls/requests/${receipt.id}/review`, {
        user: reviewer,
        method: "POST",
        input: {
          version: 1,
          decision: "accept",
          conflict: false,
          reason: "Synthetic review",
          policyVersion: "test-1",
          sourceReviewedPublic: true,
        },
      })
    ).data;
    if (user === other)
      await h.call(`/controls/requests/${receipt.id}/consent`, {
        user: owner,
        method: "POST",
        input: { version: accepted.version, consent: true },
      });
  }
  assert.equal((await h.call("/controls/public")).data.claims.length, 2);
  const receipt = await h.call("/controls/profile/suppression", {
    user: owner,
    method: "POST",
    input: { suppressed: true },
  });
  assert.equal(receipt.status, 201);
  assert.equal(receipt.data.status, "applied");
  const snapshot = (await h.call("/controls/public")).data;
  assert.deepEqual(snapshot.profiles, []);
  assert.equal(snapshot.claims.length, 1);
  assert.deepEqual(snapshot.claims[0].collaborators, []);
  assert.ok(!JSON.stringify(snapshot).includes("suppressed"));
  assert.ok(!JSON.stringify(snapshot).includes("Synthetic private"));
  assert.equal((await h.call(`/controls/requests/${receipt.data.id}`, { user: other })).status, 404);
});

test("publication sink failure rolls private change, public snapshot and receipt back together", async (t) => {
  let fail = false;
  const h = await harness(t, {
    transactionalPublisher({ database, snapshot }) {
      database.exec("CREATE TABLE IF NOT EXISTS controls_sink (revision INTEGER)");
      database.prepare("INSERT INTO controls_sink VALUES(?)").run(snapshot.revision);
      if (fail) throw Error("Synthetic sink failure");
    },
  });
  const owner = await h.login("1");
  await h.call("/controls/profile", {
    user: owner,
    method: "POST",
    input: { bio: "Synthetic", highlights: [], public: true },
  });
  const before = h.store.read();
  const published = h.store.publicSnapshot();
  fail = true;
  assert.equal(
    (await h.call("/controls/profile/suppression", { user: owner, method: "POST", input: { suppressed: true } }))
      .status,
    500,
  );
  assert.deepEqual(h.store.read(), before);
  assert.deepEqual(h.store.publicSnapshot(), published);
  assert.equal(h.store.db.prepare("SELECT COUNT(*) AS n FROM controls_sink").get().n, 1);
});

test("duplicate acceptance is blocked and duplicate merge never awards another claim", async (t) => {
  const h = await harness(t);
  const owner = await h.login("1");
  const reviewer = await h.login("2");
  const submit = async (scope) =>
    (await h.call("/controls/requests", { user: owner, method: "POST", input: fixture({ scope }) })).data;
  let a = await submit("Same synthetic scope");
  let b = await submit("Same synthetic scope");
  const c = await submit("Different scope");
  const approve = {
    version: 1,
    decision: "accept",
    conflict: false,
    reason: "Synthetic review",
    sourceReviewedPublic: true,
    policyVersion: "test-1",
  };
  a = (await h.call(`/controls/requests/${a.id}/review`, { user: reviewer, method: "POST", input: approve })).data;
  assert.equal(
    (await h.call(`/controls/requests/${b.id}/review`, { user: reviewer, method: "POST", input: approve })).status,
    409,
  );
  assert.equal(
    (
      await h.call(`/controls/requests/${c.id}/review`, {
        user: reviewer,
        method: "POST",
        input: { version: 1, decision: "merge", duplicateOf: a.id, conflict: false, reason: "Wrong scope" },
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await h.call(`/controls/requests/${b.id}/review`, {
        user: reviewer,
        method: "POST",
        input: {
          version: b.version,
          decision: "merge",
          duplicateOf: a.id,
          conflict: false,
          reason: "One contribution, no additive credit",
        },
      })
    ).status,
    200,
  );
  assert.equal((await h.call("/controls/public")).data.claims.length, 1);
});

test("GitHub adapter requests no extra scope, uses only fixed hosts, revokes token and never retains email", async () => {
  const calls = [];
  const provider = githubOAuthProvider({
    clientId: "synthetic-client",
    clientSecret: "synthetic-secret-not-real",
    fetcher: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith("access_token"))
        return new Response(JSON.stringify({ access_token: "synthetic-token", scope: "" }));
      if (url.endsWith("/user"))
        return new Response(JSON.stringify({ id: 42, login: "synthetic-only", email: "not-retained@example.test" }));
      return new Response(null, { status: 204 });
    },
  });
  const destination = new URL(
    provider.authorizationURL({
      state: "state",
      challenge: "challenge",
      redirectURI: origin + "/controls/auth/callback",
    }),
  );
  assert.equal(destination.searchParams.get("scope"), "");
  assert.equal(destination.searchParams.get("code_challenge_method"), "S256");
  assert.deepEqual(
    await provider.exchange({
      code: "synthetic-code",
      verifier: "synthetic-verifier",
      redirectURI: origin + "/controls/auth/callback",
    }),
    { actorId: "42" },
  );
  assert.equal(calls[2].options.method, "DELETE");
  assert.equal(calls[2].url, "https://api.github.com/applications/synthetic-client/token");
  assert.ok(calls.every((c) => c.options.redirect === "error" && c.options.signal instanceof AbortSignal));
  assert.equal(JSON.parse(calls[0].options.body).code_verifier, "synthetic-verifier");
});

test("GitHub adapter rejects broad returned scopes and revokes even on identity error", async () => {
  for (const scenario of ["scope", "identity"]) {
    let revoked = false;
    const provider = githubOAuthProvider({
      clientId: "synthetic-client",
      clientSecret: "synthetic-secret-not-real",
      fetcher: async (url, options) => {
        if (url.endsWith("access_token"))
          return new Response(
            JSON.stringify({ access_token: "synthetic-token", scope: scenario === "scope" ? "repo" : "" }),
          );
        if (url.endsWith("/user")) return new Response("{}", { status: 403 });
        assert.equal(options.method, "DELETE");
        revoked = true;
        return new Response(null, { status: 204 });
      },
    });
    await assert.rejects(
      provider.exchange({ code: "code", verifier: "verifier", redirectURI: origin + "/controls/auth/callback" }),
    );
    assert.equal(revoked, true);
  }
});

test("amendment suspends recognition, preserves prior audit and requires collaborator consent again", async (t) => {
  const h = await harness(t);
  const owner = await h.login("1");
  const reviewer = await h.login("2");
  const collaborator = await h.login("5");
  let receipt = (
    await h.call("/controls/requests", { user: owner, method: "POST", input: fixture({ collaborators: ["5"] }) })
  ).data;
  receipt = (
    await h.call(`/controls/requests/${receipt.id}/consent`, {
      user: collaborator,
      method: "POST",
      input: { version: receipt.version, consent: false },
    })
  ).data;
  receipt = (
    await h.call(`/controls/requests/${receipt.id}/review`, {
      user: reviewer,
      method: "POST",
      input: {
        version: receipt.version,
        decision: "accept",
        conflict: false,
        reason: "Synthetic source verified",
        sourceReviewedPublic: true,
        policyVersion: "test-1",
      },
    })
  ).data;
  assert.equal((await h.call("/controls/public")).data.claims.length, 1);
  const input = {
    version: receipt.version,
    reason: "Synthetic amendment",
    locator: "https://github.com/synthetic-example/demo/issues/2",
    category: "governance",
    scope: "Revised synthetic change",
    detail: "Private amended detail",
    collaborators: ["5"],
  };
  assert.equal(
    (await h.call(`/controls/requests/${receipt.id}/amend`, { user: reviewer, method: "POST", input })).status,
    404,
  );
  receipt = (await h.call(`/controls/requests/${receipt.id}/amend`, { user: owner, method: "POST", input })).data;
  assert.equal(receipt.status, "pending");
  assert.deepEqual((await h.call("/controls/public")).data.claims, []);
  const stored = (await h.call(`/controls/requests/${receipt.id}`, { user: owner })).data;
  assert.equal(stored.collaborators["5"], "declined");
  assert.equal(stored.history.at(-1).previous.locator, fixture().locator);
  assert.equal(stored.policyVersion, undefined);
});

test("logout while mutation body is streaming prevents that mutation from committing", async (t) => {
  const h = await harness(t);
  const user = await h.login("1");
  const payload = JSON.stringify({ bio: "Must not save after logout", highlights: [], public: true });
  const result = new Promise((resolve, reject) => {
    const req = httpRequest(
      h.base + "/controls/profile",
      {
        method: "POST",
        headers: {
          cookie: user.cookie,
          origin,
          "x-csrf-token": user.csrf,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
        },
      },
      (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode));
      },
    );
    req.on("error", reject);
    req.write(payload.slice(0, 10));
    void h
      .call("/controls/logout", { user, method: "POST", input: {} })
      .then((logout) => {
        assert.equal(logout.status, 200);
        req.end(payload.slice(10));
      })
      .catch(reject);
  });
  assert.equal(await result, 401);
  assert.deepEqual(h.store.publicSnapshot().profiles, []);
});

test("GitHub provider bounds identity response bytes and does not follow redirects", async () => {
  let revoked = false;
  const provider = githubOAuthProvider({
    clientId: "synthetic-client",
    clientSecret: "synthetic-secret-not-real",
    fetcher: async (url, options) => {
      assert.equal(options.redirect, "error");
      if (url.endsWith("access_token"))
        return new Response(JSON.stringify({ access_token: "synthetic-token", scope: "" }));
      if (url.endsWith("/user")) return new Response("x".repeat(65_537));
      revoked = true;
      return new Response(null, { status: 204 });
    },
  });
  await assert.rejects(
    provider.exchange({ code: "code", verifier: "verifier", redirectURI: origin + "/controls/auth/callback" }),
    /too large/,
  );
  assert.equal(revoked, true);
});

test("unapproved policy cannot qualify evidence, even for an otherwise eligible reviewer", async (t) => {
  const h = await harness(t, { approvedPolicyVersions: [] });
  const owner = await h.login("1");
  const reviewer = await h.login("2");
  const receipt = (await h.call("/controls/requests", { user: owner, method: "POST", input: fixture() })).data;
  assert.equal(
    (
      await h.call(`/controls/requests/${receipt.id}/review`, {
        user: reviewer,
        method: "POST",
        input: {
          version: 1,
          decision: "accept",
          conflict: false,
          reason: "Synthetic review",
          sourceReviewedPublic: true,
          policyVersion: "test-1",
        },
      })
    ).status,
    409,
  );
  assert.equal(h.store.read().requests[receipt.id].status, "pending");
  assert.deepEqual(h.store.publicSnapshot().claims, []);
});

test("synthetic accepted/rejected receipts cover governance, sanitized deployment, mentorship and reliability", async (t) => {
  const h = await harness(t);
  const owner = await h.login("1");
  const reviewer = await h.login("2");
  for (const category of ["governance", "deployment_work", "mentorship", "reliability"]) {
    for (const decision of ["accept", "reject"]) {
      const receipt = (
        await h.call("/controls/requests", { user: owner, method: "POST", input: fixture({ category }) })
      ).data;
      const reviewed = await h.call(`/controls/requests/${receipt.id}/review`, {
        user: reviewer,
        method: "POST",
        input: {
          version: 1,
          decision,
          conflict: false,
          reason: `Synthetic ${category} ${decision} source and role review`,
          sourceReviewedPublic: true,
          policyVersion: "test-1",
        },
      });
      assert.equal(reviewed.status, 200);
      assert.equal(reviewed.data.status, decision === "accept" ? "accepted" : "rejected");
      const stored = (await h.call(`/controls/requests/${receipt.id}`, { user: owner })).data;
      assert.equal(stored.history.at(-1).actor, "2");
      assert.equal(stored.history.at(-1).action, reviewed.data.status);
    }
  }
  assert.equal(h.store.publicSnapshot().claims.length, 4);
  assert.ok(h.store.publicSnapshot().claims.every((c) => !Object.hasOwn(c, "score")));
});

const configurationFixture = () => ({
  repositories: [{ id: "101", installationId: "901", slug: "synthetic-example/demo", capabilities: ["issues"] }],
  projects: [{ id: "PVT_synthetic", fields: [{ key: "status", id: "PVTSSF_synthetic", type: "SINGLE_SELECT" }] }],
  metrics: ["pr_merged", "prs_reviewed"].map((id) => ({
    id,
    enabled: true,
    policyVersion: "test-1",
    policyLink: "https://github.com/synthetic-example/demo/blob/main/policy.md",
  })),
});
function sourceReceipt(input, now) {
  return {
    digest: input.digest,
    baseRevision: input.baseRevision,
    receiptId: "synthetic-source-test",
    verifiedAt: now,
    validUntil: now + 600_000,
    repositories: input.document.repositories.map((r) => ({
      ...r,
      approved: true,
      public: true,
      capabilities: r.capabilities.map((id) => ({
        id,
        permission: "issues:read",
        permissionVerified: true,
        tested: true,
        schemaVersion: "synthetic-v1",
        evidenceId: "synthetic-source-evidence",
      })),
    })),
    projects: input.document.projects.map((p) => ({
      ...p,
      approved: true,
      public: true,
      permissionVerified: true,
      evidenceId: "synthetic-project-fields",
    })),
    metrics: input.document.metrics.map((m) => ({
      id: m.id,
      policyVersion: m.policyVersion,
      policyLink: m.policyLink,
      policyApproved: true,
      sourceTested: true,
      evidenceId: "synthetic-metric-test",
    })),
  };
}
async function configurationProposal(h, owner, version, document, baseRevision = 0) {
  const response = await h.call("/controls/configuration/proposals", {
    user: owner,
    method: "POST",
    input: { version, document, baseRevision },
  });
  assert.equal(response.status, 201);
  return response.data;
}
async function configurationActivate(h, owner, approver, proposal) {
  const preview = await h.call(`/controls/configuration/proposals/${proposal.id}/preview`, {
    user: owner,
    method: "POST",
    input: { version: proposal.versionNumber },
  });
  assert.equal(preview.status, 200);
  const approval = await h.call(`/controls/configuration/proposals/${proposal.id}/approve`, {
    user: approver,
    method: "POST",
    input: { version: preview.data.versionNumber, previewDigest: preview.data.preview.digest, conflict: false },
  });
  assert.equal(approval.status, 200);
  const activated = await h.call(`/controls/configuration/proposals/${proposal.id}/activate`, {
    user: owner,
    method: "POST",
    input: { version: approval.data.versionNumber, approvalId: approval.data.approval.id },
  });
  assert.equal(activated.status, 200);
  return activated.data;
}

test("configuration defaults deny source verification and direct non-operator access", async (t) => {
  const h = await harness(t);
  const owner = await h.login("7");
  const outsider = await h.login("1");
  assert.equal((await h.call("/controls/configuration", { user: outsider })).status, 403);
  const proposal = await configurationProposal(h, owner, "synthetic-v1", configurationFixture());
  assert.equal(
    (
      await h.call(`/controls/configuration/proposals/${proposal.id}/preview`, {
        user: owner,
        method: "POST",
        input: { version: 1 },
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await h.call(`/controls/configuration/proposals/${proposal.id}/activate`, {
        user: owner,
        method: "POST",
        input: { version: 1, approvalId: "fabricated" },
      })
    ).status,
    409,
  );
  assert.equal(configurationOverlay(h.store.read()).allowedRepositoryIds, null);
  const unknown = configurationFixture();
  unknown.metrics[0].id = "invented_metric";
  assert.equal(
    (
      await h.call("/controls/configuration/proposals", {
        user: owner,
        method: "POST",
        input: { baseRevision: 0, version: "unknown-metric", document: unknown },
      })
    ).status,
    409,
  );
});

test("configuration preview, independent approval and fresh activation are durable and digest-bound", async (t) => {
  let calls = 0;
  const h = await harness(t, {
    sourceVerifier(input, now) {
      calls++;
      return sourceReceipt(input, now);
    },
  });
  const owner = await h.login("7");
  const approver = await h.login("8");
  const proposal = await configurationProposal(h, owner, "synthetic-v1", configurationFixture());
  let preview = await h.call(`/controls/configuration/proposals/${proposal.id}/preview`, {
    user: owner,
    method: "POST",
    input: { version: 1 },
  });
  assert.equal(preview.status, 200);
  preview = preview.data;
  assert.equal(preview.preview.configurationDigest, proposal.digest);
  assert.deepEqual(preview.preview.before.repositoryIds, []);
  assert.deepEqual(preview.preview.after.repositoryIds, ["101"]);
  const approvalInput = { version: preview.versionNumber, previewDigest: preview.preview.digest, conflict: false };
  assert.equal(
    (
      await h.call(`/controls/configuration/proposals/${proposal.id}/approve`, {
        user: owner,
        method: "POST",
        input: approvalInput,
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await h.call(`/controls/configuration/proposals/${proposal.id}/approve`, {
        user: approver,
        method: "POST",
        input: { ...approvalInput, previewDigest: "fabricated" },
      })
    ).status,
    409,
  );
  const approved = (
    await h.call(`/controls/configuration/proposals/${proposal.id}/approve`, {
      user: approver,
      method: "POST",
      input: approvalInput,
    })
  ).data;
  assert.equal(
    (
      await h.call(`/controls/configuration/proposals/${proposal.id}/activate`, {
        user: owner,
        method: "POST",
        input: { version: approved.versionNumber, approvalId: approved.approval.id },
      })
    ).status,
    200,
  );
  assert.equal(calls, 2);
  assert.deepEqual(configurationOverlay(h.store.read()), {
    revision: 1,
    version: "synthetic-v1",
    digest: proposal.digest,
    approvalReceipt: approved.approval.id,
    allowedRepositoryIds: ["101"],
    allowedRepositories: h.store.read().configuration.active.document.repositories,
    allowedProjectIds: h.store.read().configuration.active.document.projects.map((project) => project.id),
    disabledMetricIds: [],
    disabledMetrics: [],
  });
  const reopened = new ControlStore(h.filename);
  try {
    assert.equal(configurationOverlay(reopened.read()).digest, proposal.digest);
    assert.equal(reopened.publicSnapshot().configuration.version, "synthetic-v1");
  } finally {
    reopened.close();
  }
});

test("configuration rejects untested permissions, private scope, wrong fields, unapproved policy and spoofed receipts", async (t) => {
  let mutate = (report) => report;
  const h = await harness(t, {
    sourceVerifier(input, now) {
      return mutate(sourceReceipt(input, now));
    },
  });
  const owner = await h.login("7");
  const changes = [
    (r) => {
      r.digest = "spoof";
    },
    (r) => {
      r.repositories[0].public = false;
    },
    (r) => {
      r.repositories[0].approved = false;
    },
    (r) => {
      r.repositories[0].capabilities[0].permissionVerified = false;
    },
    (r) => {
      r.repositories[0].capabilities[0].tested = false;
    },
    (r) => {
      r.projects[0].fields = [{ id: "PVTSSF_wrong", type: "TEXT" }];
    },
    (r) => {
      r.metrics[0].policyApproved = false;
    },
    (r) => {
      r.metrics[0].policyLink = "https://github.com/synthetic-example/wrong/issues/1";
    },
    (r) => {
      r.validUntil = r.verifiedAt;
    },
  ];
  for (const [index, change] of changes.entries()) {
    mutate = (report) => {
      change(report);
      return report;
    };
    const proposal = await configurationProposal(h, owner, `synthetic-bad-${index}`, configurationFixture());
    assert.equal(
      (
        await h.call(`/controls/configuration/proposals/${proposal.id}/preview`, {
          user: owner,
          method: "POST",
          input: { version: 1 },
        })
      ).status,
      409,
    );
    assert.equal(configurationOverlay(h.store.read()).revision, 0);
  }
  mutate = (report) => report;
  const document = configurationFixture();
  document.metrics[0].policyVersion = "unapproved-policy";
  const proposal = await configurationProposal(h, owner, "synthetic-unapproved-policy", document);
  assert.equal(
    (
      await h.call(`/controls/configuration/proposals/${proposal.id}/preview`, {
        user: owner,
        method: "POST",
        input: { version: 1 },
      })
    ).status,
    409,
  );
});

test("metric disable is independent and retains reason/history while source outage cannot expand scope", async (t) => {
  let offline = false;
  const h = await harness(t, {
    sourceVerifier(input, now) {
      if (offline) throw Error("Synthetic source outage");
      return sourceReceipt(input, now);
    },
  });
  const owner = await h.login("7");
  const approver = await h.login("8");
  const original = await configurationProposal(h, owner, "synthetic-v1", configurationFixture());
  await configurationActivate(h, owner, approver, original);
  offline = true;
  const document = configurationFixture();
  document.metrics[0].enabled = false;
  document.metrics[0].reason = "Synthetic faulty metric suspended pending review";
  const disable = await configurationProposal(h, owner, "synthetic-v2", document, 1);
  const activated = await configurationActivate(h, owner, approver, disable);
  assert.equal(activated.source.restrictiveOverlay, true);
  const overlay = configurationOverlay(h.store.read());
  assert.deepEqual(overlay.disabledMetricIds, ["pr_merged"]);
  assert.equal(overlay.disabledMetrics[0].reason, document.metrics[0].reason);
  assert.equal(overlay.disabledMetrics[0].policyLink, document.metrics[0].policyLink);
  assert.equal((await h.call("/controls/public")).data.configuration.disabledMetrics[0].id, "pr_merged");
  assert.equal(h.store.read().configuration.active.document.metrics.find((m) => m.id === "prs_reviewed").enabled, true);
  const omitted = structuredClone(document);
  omitted.metrics = omitted.metrics.filter((m) => m.id !== "pr_merged");
  assert.equal(
    (
      await h.call("/controls/configuration/proposals", {
        user: owner,
        method: "POST",
        input: { baseRevision: 2, version: "synthetic-omission", document: omitted },
      })
    ).status,
    409,
  );
  assert.deepEqual(configurationOverlay(h.store.read()).disabledMetricIds, ["pr_merged"]);
  const expansion = configurationFixture();
  expansion.repositories.push({ ...expansion.repositories[0], id: "102" });
  const expand = await configurationProposal(h, owner, "synthetic-v3", expansion, 2);
  assert.equal(
    (
      await h.call(`/controls/configuration/proposals/${expand.id}/preview`, {
        user: owner,
        method: "POST",
        input: { version: 1 },
      })
    ).status,
    500,
  );
  assert.deepEqual(configurationOverlay(h.store.read()).allowedRepositoryIds, ["101"]);
});

test("stale configuration revisions, expired preview and revoked approval cannot activate", async (t) => {
  const h = await harness(t, { sourceVerifier: sourceReceipt });
  const owner = await h.login("7");
  const approver = await h.login("8");
  const proposal = await configurationProposal(h, owner, "synthetic-v1", configurationFixture());
  const preview = (
    await h.call(`/controls/configuration/proposals/${proposal.id}/preview`, {
      user: owner,
      method: "POST",
      input: { version: 1 },
    })
  ).data;
  const approved = (
    await h.call(`/controls/configuration/proposals/${proposal.id}/approve`, {
      user: approver,
      method: "POST",
      input: { version: preview.versionNumber, previewDigest: preview.preview.digest, conflict: false },
    })
  ).data;
  h.authorities.set("8", { roles: [], version: "2" });
  assert.equal(
    (
      await h.call(`/controls/configuration/proposals/${proposal.id}/activate`, {
        user: owner,
        method: "POST",
        input: { version: approved.versionNumber, approvalId: approved.approval.id },
      })
    ).status,
    409,
  );
  assert.equal(configurationOverlay(h.store.read()).revision, 0);
  h.authorities.set("8", { roles: ["operator"], version: "1" });
  h.advance(600_001);
  assert.equal(
    (
      await h.call(`/controls/configuration/proposals/${proposal.id}/activate`, {
        user: owner,
        method: "POST",
        input: { version: approved.versionNumber, approvalId: approved.approval.id },
      })
    ).status,
    409,
  );
});

test("source schema drift between approved preview and activation requires a new preview", async (t) => {
  let drift = false;
  const h = await harness(t, {
    sourceVerifier(input, now) {
      const report = sourceReceipt(input, now);
      if (drift) report.repositories[0].capabilities[0].schemaVersion = "synthetic-different-schema";
      return report;
    },
  });
  const owner = await h.login("7");
  const approver = await h.login("8");
  const proposal = await configurationProposal(h, owner, "synthetic-v1", configurationFixture());
  const preview = (
    await h.call(`/controls/configuration/proposals/${proposal.id}/preview`, {
      user: owner,
      method: "POST",
      input: { version: 1 },
    })
  ).data;
  const approved = (
    await h.call(`/controls/configuration/proposals/${proposal.id}/approve`, {
      user: approver,
      method: "POST",
      input: { version: preview.versionNumber, previewDigest: preview.preview.digest, conflict: false },
    })
  ).data;
  drift = true;
  assert.equal(
    (
      await h.call(`/controls/configuration/proposals/${proposal.id}/activate`, {
        user: owner,
        method: "POST",
        input: { version: approved.versionNumber, approvalId: approved.approval.id },
      })
    ).status,
    409,
  );
  assert.equal(configurationOverlay(h.store.read()).revision, 0);
});

test("rollback is a new tested independently approved version; publication failure remains atomic", async (t) => {
  let fail = false;
  const h = await harness(t, {
    sourceVerifier: sourceReceipt,
    transactionalPublisher() {
      if (fail) throw Error("Synthetic publication failure");
    },
  });
  const owner = await h.login("7");
  const approver = await h.login("8");
  const original = await configurationProposal(h, owner, "synthetic-v1", configurationFixture());
  await configurationActivate(h, owner, approver, original);
  const document = configurationFixture();
  document.metrics[0].enabled = false;
  document.metrics[0].reason = "Synthetic review hold";
  await configurationActivate(h, owner, approver, await configurationProposal(h, owner, "synthetic-v2", document, 1));
  let rollback = await h.call("/controls/configuration/rollback", {
    user: owner,
    method: "POST",
    input: { baseRevision: 2, version: "synthetic-v3", targetDigest: original.digest },
  });
  assert.equal(rollback.status, 201);
  rollback = rollback.data;
  let preview = (
    await h.call(`/controls/configuration/proposals/${rollback.id}/preview`, {
      user: owner,
      method: "POST",
      input: { version: 1 },
    })
  ).data;
  let approved = (
    await h.call(`/controls/configuration/proposals/${rollback.id}/approve`, {
      user: approver,
      method: "POST",
      input: { version: preview.versionNumber, previewDigest: preview.preview.digest, conflict: false },
    })
  ).data;
  const before = h.store.read();
  const published = h.store.publicSnapshot();
  fail = true;
  const input = { version: approved.versionNumber, approvalId: approved.approval.id };
  assert.equal(
    (await h.call(`/controls/configuration/proposals/${rollback.id}/activate`, { user: owner, method: "POST", input }))
      .status,
    500,
  );
  assert.deepEqual(h.store.read(), before);
  assert.deepEqual(h.store.publicSnapshot(), published);
  fail = false;
  assert.equal(
    (await h.call(`/controls/configuration/proposals/${rollback.id}/activate`, { user: owner, method: "POST", input }))
      .status,
    200,
  );
  assert.equal(configurationOverlay(h.store.read()).revision, 3);
  assert.deepEqual(configurationOverlay(h.store.read()).disabledMetricIds, []);
  assert.equal(
    (
      await h.call(`/controls/configuration/proposals/${original.id}/preview`, {
        user: owner,
        method: "POST",
        input: { version: 4 },
      })
    ).status,
    409,
  );
});

test("source receipt that expires during activation authority lookup cannot activate", async (t) => {
  const h = await harness(t, {
    sourceVerifier(input, now) {
      const receipt = sourceReceipt(input, now);
      if (input.phase === "activate") receipt.validUntil = now + 1000;
      return receipt;
    },
  });
  const owner = await h.login("7");
  const approver = await h.login("8");
  const proposal = await configurationProposal(h, owner, "synthetic-expiring-source", configurationFixture());
  const preview = (
    await h.call(`/controls/configuration/proposals/${proposal.id}/preview`, {
      user: owner,
      method: "POST",
      input: { version: 1 },
    })
  ).data;
  const approved = (
    await h.call(`/controls/configuration/proposals/${proposal.id}/approve`, {
      user: approver,
      method: "POST",
      input: { version: preview.versionNumber, previewDigest: preview.preview.digest, conflict: false },
    })
  ).data;
  const authority = h.authorities.get.bind(h.authorities);
  h.authorities.get = async (id) => {
    if (id === "8") {
      await Promise.resolve();
      h.advance(2000);
    }
    return authority(id);
  };
  const result = await h.call(`/controls/configuration/proposals/${proposal.id}/activate`, {
    user: owner,
    method: "POST",
    input: { version: approved.versionNumber, approvalId: approved.approval.id },
  });
  assert.equal(result.status, 409);
  assert.equal(configurationOverlay(h.store.read()).revision, 0);
});

test("own-profile reads require authentication and return only editable fields", async (t) => {
  const h = await harness(t);
  assert.equal((await h.call("/controls/profile")).status, 401);
  const owner = await h.login("1");
  const other = await h.login("2");
  assert.deepEqual((await h.call("/controls/profile", { user: owner })).data, {
    public: false,
    bio: "",
    highlights: [],
    suppressed: false,
  });
  await h.call("/controls/profile", {
    user: owner,
    method: "POST",
    input: { public: true, bio: "Opt-in text", highlights: [] },
  });
  assert.equal((await h.call("/controls/profile", { user: owner })).data.bio, "Opt-in text");
  assert.equal((await h.call("/controls/profile", { user: other })).data.bio, "");
  assert.equal((await h.call("/controls/profile", { user: owner })).response.headers.get("cache-control"), "no-store");
});

test("OAuth may land only on the configured same-origin account page", async (t) => {
  const h = await harness(t, { loginSuccessPath: "/account" });
  const started = await h.begin();
  const callback = await h.call("/controls/auth/callback?" + new URLSearchParams({ state: started.state, code: "1" }), {
    headers: { cookie: started.cookie },
  });
  assert.equal(callback.status, 303);
  assert.equal(callback.response.headers.get("location"), origin + "/account");
});

test("editorial HTTP workflow preserves session CSRF, independent approval, durable withdrawal and current evidence", async (t) => {
  const h = await harness(t, { spotlightEligibility: () => true });
  const owner = await h.login("1");
  const reviewer = await h.login("2");
  let receipt = (await h.call("/controls/requests", { user: owner, method: "POST", input: fixture() })).data;
  receipt = (
    await h.call(`/controls/requests/${receipt.id}/review`, {
      user: reviewer,
      method: "POST",
      input: {
        version: receipt.version,
        decision: "accept",
        conflict: false,
        reason: "Verified synthetic source",
        sourceReviewedPublic: true,
        policyVersion: "test-1",
      },
    })
  ).data;
  const input = { claimId: receipt.id, consent: true };
  assert.equal(
    (await h.call("/controls/spotlights", { user: owner, method: "POST", input, headers: { "x-csrf-token": "bad" } }))
      .status,
    403,
  );
  const nominated = await h.call("/controls/spotlights", { user: owner, method: "POST", input });
  assert.equal(nominated.status, 201);
  const id = nominated.data.nomination.id;
  assert.equal((await h.call("/controls/spotlights/queue")).status, 401);
  assert.equal((await h.call("/controls/spotlights/queue", { user: reviewer })).data.nominations.length, 1);
  const stranger = await h.login("6");
  assert.deepEqual((await h.call("/controls/spotlights/queue", { user: stranger })).data.nominations, []);
  const selection = {
    version: 1,
    action: "accept",
    conflict: false,
    reason: "Private selection audit",
    publicExplanation: "Public selection explanation",
  };
  assert.equal(
    (await h.call(`/controls/spotlights/${id}`, { user: owner, method: "POST", input: selection })).status,
    403,
  );
  assert.equal(
    (await h.call(`/controls/spotlights/${id}`, { user: reviewer, method: "POST", input: selection })).status,
    200,
  );
  let read = await h.call("/controls/spotlights");
  assert.equal(read.data.spotlights.length, 1);
  assert.equal(JSON.stringify(read.data).includes("Private selection audit"), false);
  assert.equal(read.response.headers.get("cache-control"), "no-store");
  assert.equal(JSON.stringify(read.data).includes("Synthetic private verification detail"), false);
  const reopened = new ControlStore(h.filename);
  assert.equal(reopened.read().spotlights[id].status, "accepted");
  reopened.close();
  assert.equal(
    (
      await h.call(`/controls/spotlights/${id}`, {
        user: owner,
        method: "POST",
        input: { version: 2, action: "withdraw", reason: "Remove spotlight" },
      })
    ).status,
    200,
  );
  assert.deepEqual((await h.call("/controls/spotlights")).data.spotlights, []);
});
