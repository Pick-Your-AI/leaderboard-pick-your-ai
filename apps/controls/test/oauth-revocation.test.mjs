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
const identityToken = "synthetic-identity-token";
const exchange = {
  code: "synthetic-code",
  verifier: "synthetic-verifier",
  redirectURI: origin + "/controls/auth/callback",
};
const unexpected = [
  ["200 OK with JSON", 200, '{"deleted":true}'],
  ["empty 200 OK", 200, null],
  ["201 Created", 201, '{"deleted":true}'],
  ["empty 202 Accepted", 202, null],
  ["202 Accepted with JSON", 202, '{"accepted":true}'],
  ["203 Non-Authoritative Information", 203, '{"deleted":true}'],
  ["205 Reset Content", 205, null],
  ["206 Partial Content", 206, '{"deleted":true}'],
  ["299 extension", 299, "{}"],
];

function fixture() {
  const calls = [];
  let revocation = () => new Response(null, { status: 204 });
  const provider = githubOAuthProvider({
    clientId: "synthetic-client",
    clientSecret: "synthetic-secret-not-real",
    fetcher: async (url, options) => {
      assert.equal(options.redirect, "error");
      assert.ok(options.signal instanceof AbortSignal);
      if (url === "https://github.com/login/oauth/access_token") {
        calls.push("token");
        assert.equal(options.method, "POST");
        return new Response(JSON.stringify({ access_token: identityToken, scope: "" }));
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
      return revocation();
    },
  });
  return {
    provider,
    calls,
    setRevocation: (status, body = null) => {
      revocation = () => new Response(body, { status });
    },
  };
}

for (const [name, status, body] of unexpected) {
  test("OAuth withholds identity when token revocation returns " + name, async () => {
    const h = fixture();
    h.setRevocation(status, body);
    await assert.rejects(h.provider.exchange(exchange), { status: 502, message: "Identity provider unavailable" });
    assert.deepEqual(h.calls, ["token", "user", "revoke"]);
  });
}

test("OAuth returns identity after the documented empty 204 token-revocation acknowledgment", async () => {
  const h = fixture();
  assert.deepEqual(await h.provider.exchange(exchange), { actorId: "42" });
  assert.deepEqual(h.calls, ["token", "user", "revoke"]);
});

async function callbackFixture(t) {
  const h = fixture();
  const directory = mkdtempSync(join(tmpdir(), "synthetic-oauth-revocation-"));
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
const bytes = (value) => Buffer.from(JSON.stringify(value));

for (const status of [200, 202]) {
  test(
    "OAuth revocation " + status + " callback preserves state and the old session until a fresh 204 login",
    async (t) => {
      const h = await callbackFixture(t);
      const initial = await h.callback(await h.begin());
      assert.equal(initial.response.status, 303);
      const oldCookie = sessionCookie(initial.response);
      h.store.transaction(
        (state) => {
          state.profiles["42"] = { bio: "Synthetic private profile", highlights: [], public: false, suppressed: false };
          state.profiles["84"] = { bio: "Synthetic public profile", highlights: [], public: true, suppressed: false };
        },
        { publish: true },
      );
      const before = h.store.read();
      const publicBefore = h.store.publicSnapshot();
      assert.equal(publicBefore.profiles.length, 1);
      assert.equal(publicBefore.profiles[0].actorId, "84");
      const started = await h.begin();
      assert.equal(Object.keys(h.store.read().oauth).length, 1);
      h.setRevocation(status, '{"accepted":true}');
      h.calls.length = 0;
      const rejected = await h.callback(started, oldCookie);
      assert.equal(rejected.response.status, 502);
      assert.deepEqual(JSON.parse(rejected.body), { error: "Identity provider unavailable" });
      assert.deepEqual(rejected.response.headers.getSetCookie(), []);
      assert.deepEqual(h.calls, ["token", "user", "revoke"]);
      assert.deepEqual(bytes(h.store.read()), bytes(before));
      assert.deepEqual(bytes(h.store.publicSnapshot()), bytes(publicBefore));
      const existing = await h.readSession(oldCookie);
      assert.equal(existing.status, 200);
      assert.equal(existing.data.actorId, "42");
      const replay = await h.callback(started, oldCookie);
      assert.equal(replay.response.status, 400);
      assert.deepEqual(JSON.parse(replay.body), { error: "Invalid login state" });
      assert.deepEqual(replay.response.headers.getSetCookie(), []);
      assert.deepEqual(h.calls, ["token", "user", "revoke"]);
      assert.deepEqual(bytes(h.store.read()), bytes(before));
      h.setRevocation(204);
      const recovered = await h.callback(await h.begin(), oldCookie);
      assert.equal(recovered.response.status, 303);
      const newCookie = sessionCookie(recovered.response);
      assert.notEqual(newCookie, oldCookie);
      assert.equal((await h.readSession(oldCookie)).status, 401);
      const current = await h.readSession(newCookie);
      assert.equal(current.status, 200);
      assert.equal(current.data.actorId, "42");
      assert.equal(Object.keys(h.store.read().sessions).length, 1);
      assert.equal(Object.keys(h.store.read().oauth).length, 0);
      assert.deepEqual(bytes(h.store.read().profiles), bytes(before.profiles));
      assert.deepEqual(bytes(h.store.publicSnapshot()), bytes(publicBefore));
    },
  );
}
