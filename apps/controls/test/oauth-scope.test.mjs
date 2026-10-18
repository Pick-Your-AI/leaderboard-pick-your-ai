import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { githubOAuthProvider } from "../src/github.mjs";
import { ControlStore } from "../src/store.mjs";
import { createControlsServer } from "../src/server.mjs";

// Fictional provider responses only; no GitHub request or real token is used.
const origin = "https://controls.example.test";
const absent = Symbol("omitted scope");
const identityToken = "synthetic-identity-token";
const exchange = {
  code: "synthetic-code",
  verifier: "synthetic-verifier",
  redirectURI: origin + "/controls/auth/callback",
};
const invalidScopes = [
  ["omitted", absent],
  ["null", null],
  ["false", false],
  ["zero", 0],
  ["true", true],
  ["positive number", 1],
  ["empty array", []],
  ["empty object", {}],
  ["broader scope", "repo"],
  ["whitespace", " "],
  ["numeric string", "0"],
];

function fixture() {
  const calls = [];
  let scope = "";
  let cleanupFails = false;
  const provider = githubOAuthProvider({
    clientId: "synthetic-client",
    clientSecret: "synthetic-secret-not-real",
    fetcher: async (url, options) => {
      assert.equal(options.redirect, "error");
      assert.ok(options.signal instanceof AbortSignal);
      if (url === "https://github.com/login/oauth/access_token") {
        calls.push("token");
        assert.equal(options.method, "POST");
        return new Response(
          JSON.stringify({
            access_token: identityToken,
            token_type: "bearer",
            ...(scope === absent ? {} : { scope }),
            unrelated_extension: false,
          }),
        );
      }
      if (url === "https://api.github.com/user") {
        calls.push("user");
        assert.equal(options.headers.authorization, "Bearer " + identityToken);
        return new Response(JSON.stringify({ id: 42, login: "synthetic-user" }));
      }
      assert.equal(url, "https://api.github.com/applications/synthetic-client/token");
      calls.push("revoke");
      assert.equal(options.method, "DELETE");
      assert.deepEqual(JSON.parse(options.body), { access_token: identityToken });
      return cleanupFails ? new Response("{}", { status: 503 }) : new Response(null, { status: 204 });
    },
  });
  return {
    provider,
    calls,
    setScope: (value) => {
      scope = value;
    },
    failCleanup: () => {
      cleanupFails = true;
    },
  };
}

for (const [name, scope] of invalidScopes) {
  test("OAuth rejects " + name + " scope before identity lookup and revokes the known token", async () => {
    const h = fixture();
    h.setScope(scope);
    await assert.rejects(h.provider.exchange(exchange), { status: 502, message: "Unexpected OAuth scopes" });
    assert.deepEqual(h.calls, ["token", "revoke"]);
  });
}

test("explicit empty scope permits identity lookup and successful token cleanup", async () => {
  const h = fixture();
  assert.deepEqual(await h.provider.exchange(exchange), { actorId: "42" });
  assert.deepEqual(h.calls, ["token", "user", "revoke"]);
});

test("cleanup failure after invalid scope still withholds identity without calling the user endpoint", async () => {
  const h = fixture();
  h.setScope(false);
  h.failCleanup();
  await assert.rejects(h.provider.exchange(exchange), { status: 502, message: "Identity provider unavailable" });
  assert.deepEqual(h.calls, ["token", "revoke"]);
});

async function callbackFixture(t) {
  const h = fixture();
  const directory = mkdtempSync(join(tmpdir(), "synthetic-oauth-scope-"));
  const store = new ControlStore(join(directory, "private.sqlite"));
  const server = createControlsServer({ store, provider: h.provider, origin });
  t.after(async () => {
    if (server.listening)
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const base = "http://127.0.0.1:" + server.address().port;
  async function begin() {
    const response = await fetch(base + "/controls/auth/login", { redirect: "manual" });
    assert.equal(response.status, 302);
    await response.arrayBuffer();
    return {
      state: new URL(response.headers.get("location")).searchParams.get("state"),
      cookie: response.headers.getSetCookie()[0].split(";")[0],
    };
  }
  async function callback(started, sessionCookie = "") {
    const response = await fetch(
      base + "/controls/auth/callback?" + new URLSearchParams({ state: started.state, code: "synthetic-code" }),
      {
        redirect: "manual",
        headers: { cookie: started.cookie + (sessionCookie ? "; " + sessionCookie : "") },
      },
    );
    return { response, body: await response.text() };
  }
  async function readSession(cookie) {
    const response = await fetch(base + "/controls/session", { headers: { cookie } });
    return { status: response.status, data: await response.json() };
  }
  return { ...h, store, begin, callback, readSession };
}

function sessionCookie(response) {
  return response.headers
    .getSetCookie()
    .find((value) => value.startsWith("__Host-controls_session="))
    .split(";")[0];
}

for (const [name, scope] of invalidScopes.slice(0, 4)) {
  test(
    "OAuth " + name + " scope callback consumes state, preserves the old session and allows a fresh login",
    async (t) => {
      const h = await callbackFixture(t);
      const initial = await h.callback(await h.begin());
      assert.equal(initial.response.status, 303);
      const oldCookie = sessionCookie(initial.response);
      h.store.transaction((state) => {
        state.profiles["42"] = { bio: "Synthetic private profile", highlights: [], public: false, suppressed: false };
      });
      const before = h.store.read();
      const publicBefore = h.store.publicSnapshot();
      const started = await h.begin();
      assert.equal(Object.keys(h.store.read().oauth).length, 1);
      h.setScope(scope);
      h.calls.length = 0;
      const rejected = await h.callback(started, oldCookie);
      assert.equal(rejected.response.status, 502);
      assert.deepEqual(JSON.parse(rejected.body), { error: "Unexpected OAuth scopes" });
      assert.deepEqual(rejected.response.headers.getSetCookie(), []);
      assert.deepEqual(h.calls, ["token", "revoke"]);
      assert.deepEqual(h.store.read(), before);
      assert.deepEqual(h.store.publicSnapshot(), publicBefore);
      assert.equal((await h.readSession(oldCookie)).status, 200);
      const replay = await h.callback(started, oldCookie);
      assert.equal(replay.response.status, 400);
      assert.deepEqual(JSON.parse(replay.body), { error: "Invalid login state" });
      assert.deepEqual(h.calls, ["token", "revoke"]);
      h.setScope("");
      const recovered = await h.callback(await h.begin(), oldCookie);
      assert.equal(recovered.response.status, 303);
      const newCookie = sessionCookie(recovered.response);
      assert.notEqual(newCookie, oldCookie);
      assert.equal((await h.readSession(oldCookie)).status, 401);
      const current = await h.readSession(newCookie);
      assert.equal(current.status, 200);
      assert.equal(current.data.actorId, "42");
      assert.equal(Object.keys(h.store.read().sessions).length, 1);
      assert.deepEqual(h.store.read().profiles, before.profiles);
      assert.deepEqual(h.store.publicSnapshot(), publicBefore);
    },
  );
}
