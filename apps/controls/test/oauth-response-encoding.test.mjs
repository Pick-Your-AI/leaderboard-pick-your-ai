import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { githubOAuthProvider } from "../src/github.mjs";
import { ControlStore } from "../src/store.mjs";
import { createControlsServer } from "../src/server.mjs";

// Fictional provider bytes only. This file never contacts GitHub or obtains a token.
const origin = "https://controls.example.test";
const identityToken = "synthetic-identity-token";
const stages = ["token", "user", "revoke"];
const endpoints = {
  token: "https://github.com/login/oauth/access_token",
  user: "https://api.github.com/user",
  revoke: "https://api.github.com/applications/synthetic-client/token",
};
const exchange = {
  code: "synthetic-code",
  verifier: "synthetic-verifier",
  redirectURI: origin + "/controls/auth/callback",
};
const malformed = [
  ["isolated continuation", [0x80]],
  ["truncated sequence", [0xe2, 0x82]],
  ["invalid continuation", [0xc3, 0x28]],
  ["overlong sequence", [0xc0, 0xaf]],
  ["encoded surrogate", [0xed, 0xa0, 0x80]],
  ["out-of-range code point", [0xf4, 0x90, 0x80, 0x80]],
];
function jsonBytes(stage, note = "synthetic-note") {
  return Buffer.from(
    JSON.stringify({
      ...(stage === "token" ? { access_token: identityToken, scope: "" } : {}),
      ...(stage === "user" ? { id: 42, login: "synthetic-user" } : {}),
      note,
    }),
  );
}
function damagedBytes(stage, bytes) {
  const marker = "synthetic-replacement-marker";
  const encoded = jsonBytes(stage, marker);
  const index = encoded.indexOf(marker);
  assert.ok(index > 0);
  return Buffer.concat([encoded.subarray(0, index), Buffer.from(bytes), encoded.subarray(index + marker.length)]);
}
function streamed(bytes, oneByte = false) {
  return new Response(
    new ReadableStream({
      start(controller) {
        if (oneByte) for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
        else controller.enqueue(bytes);
        controller.close();
      },
    }),
  );
}
function fixture() {
  const calls = [];
  const responses = {
    token: () => streamed(jsonBytes("token")),
    user: () => streamed(jsonBytes("user")),
    revoke: () => new Response(null, { status: 204 }),
  };
  const provider = githubOAuthProvider({
    clientId: "synthetic-client",
    clientSecret: "synthetic-secret-not-real",
    fetcher: async (url, options) => {
      const stage = stages.find((name) => endpoints[name] === url);
      assert.ok(stage, "Only the existing fixed identity endpoints are allowed");
      assert.equal(options.redirect, "error");
      assert.ok(options.signal instanceof AbortSignal);
      calls.push({ stage, options });
      if (stage === "user") assert.equal(options.headers.authorization, "Bearer " + identityToken);
      if (stage === "revoke") {
        assert.equal(options.method, "DELETE");
        assert.deepEqual(JSON.parse(options.body), { access_token: identityToken });
      }
      return responses[stage]();
    },
  });
  return { provider, calls, responses };
}
function expectedCalls(stage) {
  return stage === "token" ? ["token"] : stages;
}

for (const stage of stages) {
  for (const [name, bytes] of malformed) {
    test(stage + " response rejects " + name + " without accepting identity", async () => {
      const h = fixture();
      h.responses[stage] = () => streamed(damagedBytes(stage, bytes), true);
      await assert.rejects(h.provider.exchange(exchange), TypeError);
      assert.deepEqual(
        h.calls.map((call) => call.stage),
        expectedCalls(stage),
      );
    });
  }
  test(stage + " response decodes valid byte-split multilingual text and literal U+FFFD", async () => {
    const h = fixture();
    h.responses[stage] = () => streamed(jsonBytes(stage, "Équité 日本語 🎉 \uFFFD"), true);
    // Valid revoke200 JSON passes decoding but cannot confirm GitHub's required 204 acknowledgment.
    if (stage === "revoke")
      await assert.rejects(h.provider.exchange(exchange), { status: 502, message: "Identity provider unavailable" });
    else assert.deepEqual(await h.provider.exchange(exchange), { actorId: "42" });
    assert.deepEqual(
      h.calls.map((call) => call.stage),
      stages,
    );
  });
  test(stage + " response preserves leading-BOM and invalid-JSON rejection", async () => {
    for (const bytes of [Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), jsonBytes(stage)]), Buffer.from('{"note":')]) {
      const h = fixture();
      h.responses[stage] = () => streamed(bytes);
      await assert.rejects(h.provider.exchange(exchange), SyntaxError);
      assert.deepEqual(
        h.calls.map((call) => call.stage),
        expectedCalls(stage),
      );
    }
  });
  test(stage + " response preserves the exact encoded byte bound", async () => {
    const h = fixture();
    const bytes = jsonBytes(stage, "a".repeat(65_536 - jsonBytes(stage, "").byteLength));
    assert.equal(bytes.byteLength, 65_536);
    h.responses[stage] = () => streamed(bytes);
    if (stage === "revoke")
      await assert.rejects(h.provider.exchange(exchange), { status: 502, message: "Identity provider unavailable" });
    else assert.deepEqual(await h.provider.exchange(exchange), { actorId: "42" });
    assert.deepEqual(
      h.calls.map((call) => call.stage),
      stages,
    );
    const rejected = fixture();
    rejected.responses[stage] = () => streamed(Buffer.alloc(65_537, 0x78));
    await assert.rejects(rejected.provider.exchange(exchange), { status: 502, message: "Identity response too large" });
    assert.deepEqual(
      rejected.calls.map((call) => call.stage),
      expectedCalls(stage),
    );
  });
  test(stage + " unsuccessful HTTP response retains its fixed provider failure", async () => {
    const h = fixture();
    h.responses[stage] = () => new Response(damagedBytes(stage, [0x80]), { status: 503 });
    await assert.rejects(h.provider.exchange(exchange), { status: 502, message: "Identity provider unavailable" });
    assert.deepEqual(
      h.calls.map((call) => call.stage),
      expectedCalls(stage),
    );
  });
}

test("an empty 204 revocation still completes the exact identity exchange", async () => {
  const h = fixture();
  assert.deepEqual(await h.provider.exchange(exchange), { actorId: "42" });
  assert.deepEqual(
    h.calls.map((call) => call.stage),
    stages,
  );
});

async function callbackFixture(t) {
  const h = fixture();
  const directory = mkdtempSync(join(tmpdir(), "synthetic-oauth-encoding-"));
  const store = new ControlStore(join(directory, "private.sqlite"));
  const server = createControlsServer({
    store,
    provider: h.provider,
    origin,
    rolesForActor: () => ({ roles: [], version: "synthetic-1" }),
  });
  t.after(async () => {
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
    const state = new URL(response.headers.get("location")).searchParams.get("state");
    return { state, cookie: response.headers.getSetCookie()[0].split(";")[0] };
  }
  async function callback(started, session = "") {
    const response = await fetch(
      base + "/controls/auth/callback?" + new URLSearchParams({ state: started.state, code: "synthetic-code" }),
      {
        redirect: "manual",
        headers: { cookie: started.cookie + (session ? "; " + session : "") },
      },
    );
    const body = await response.text();
    return { response, body };
  }
  return { ...h, store, base, begin, callback };
}

for (const stage of stages) {
  test(
    stage + " malformed callback consumes only login state, preserves session and permits a fresh login",
    async (t) => {
      const h = await callbackFixture(t);
      const initial = await h.callback(await h.begin());
      assert.equal(initial.response.status, 303);
      const oldCookie = initial.response.headers
        .getSetCookie()
        .find((value) => value.startsWith("__Host-controls_session="))
        .split(";")[0];
      const before = h.store.read();
      const publicBefore = h.store.publicSnapshot();
      const started = await h.begin();
      assert.equal(Object.keys(h.store.read().oauth).length, 1);
      const originalResponse = h.responses[stage];
      h.responses[stage] = () => streamed(damagedBytes(stage, [0x80]));
      h.calls.length = 0;
      const rejected = await h.callback(started, oldCookie);
      assert.equal(rejected.response.status, 500);
      assert.deepEqual(JSON.parse(rejected.body), { error: "Request failed" });
      assert.deepEqual(rejected.response.headers.getSetCookie(), []);
      assert.deepEqual(
        h.calls.map((call) => call.stage),
        expectedCalls(stage),
      );
      assert.deepEqual(h.store.read(), before);
      assert.deepEqual(h.store.publicSnapshot(), publicBefore);
      const existing = await fetch(h.base + "/controls/session", { headers: { cookie: oldCookie } });
      assert.equal(existing.status, 200);
      assert.equal((await existing.json()).actorId, "42");
      const replay = await h.callback(started, oldCookie);
      assert.equal(replay.response.status, 400);
      assert.deepEqual(JSON.parse(replay.body), { error: "Invalid login state" });
      assert.deepEqual(
        h.calls.map((call) => call.stage),
        expectedCalls(stage),
      );
      h.responses[stage] = originalResponse;
      const recovered = await h.callback(await h.begin(), oldCookie);
      assert.equal(recovered.response.status, 303);
      const sessions = Object.values(h.store.read().sessions);
      assert.equal(sessions.length, 1);
      assert.equal(sessions[0].actorId, "42");
      assert.deepEqual(h.store.publicSnapshot(), publicBefore);
    },
  );
}
