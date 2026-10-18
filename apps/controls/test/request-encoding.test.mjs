import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlStore } from "../src/store.mjs";
import { createControlsServer } from "../src/server.mjs";

// Fictional identity/session fixtures exercise the real HTTP and SQLite boundary.
// They do not perform or qualify a real OAuth login.
const origin = "https://controls.example.test";
const sessionToken = "A".repeat(43);
const csrf = "synthetic-csrf-value";
const recoveredText = "Recovered 日本語 café 🧪 �";
const targets = [
  {
    name: "public profile",
    path: "/controls/profile",
    prefix: '{"bio":"',
    suffix: '","highlights":[],"public":true}',
    input: (value) => ({ bio: value, highlights: [], public: true }),
    success: 200,
    stored: (state) => state.profiles["1"].bio,
  },
  {
    name: "private request",
    path: "/controls/requests",
    prefix: '{"kind":"privacy","detail":"',
    suffix: '"}',
    input: (value) => ({ kind: "privacy", detail: value }),
    success: 201,
    stored: (state) => Object.values(state.requests)[0].detail,
  },
];
const malformed = [
  ["isolated continuation", [0x80]],
  ["truncated multibyte", [0xe2, 0x82]],
  ["invalid continuation", [0xe2, 0x28, 0xa1]],
  ["overlong encoding", [0xc0, 0xaf]],
  ["encoded surrogate", [0xed, 0xa0, 0x80]],
  ["out-of-range code point", [0xf4, 0x90, 0x80, 0x80]],
];

async function harness(t) {
  const directory = mkdtempSync(join(tmpdir(), "controls-request-encoding-"));
  const store = new ControlStore(join(directory, "private.sqlite"));
  const sid = createHash("sha256").update(sessionToken).digest("base64url");
  store.transaction((state) => {
    state.sessions[sid] = { actorId: "1", csrf, roles: [], roleVersion: "0", expires: 1_000_000 };
  });
  const server = createControlsServer({
    store,
    origin,
    now: () => 100_000,
    provider: {
      authorizationURL() {
        throw Error("Synthetic provider must not be used");
      },
      exchange() {
        throw Error("Synthetic provider must not be used");
      },
    },
  });
  t.after(async () => {
    try {
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = {
    cookie: `__Host-controls_session=${sessionToken}`,
    origin,
    "x-csrf-token": csrf,
    "content-type": "application/json",
  };
  async function send(path, bytes, extra = {}) {
    const response = await fetch(base + path, { method: "POST", headers: { ...headers, ...extra }, body: bytes });
    return { status: response.status, data: await response.json() };
  }
  async function sendByteChunks(path, bytes) {
    return new Promise((resolve, reject) => {
      const outgoing = request(base + path, { method: "POST", headers }, (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("error", reject);
        response.on("end", () => {
          try {
            resolve({ status: response.statusCode, data: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
          } catch (error) {
            reject(error);
          }
        });
      });
      outgoing.on("error", reject);
      for (const byte of bytes) outgoing.write(Buffer.from([byte]));
      outgoing.end();
    });
  }
  return { store, send, sendByteChunks };
}

for (const target of targets) {
  for (const [name, bytes] of malformed) {
    test(`${target.name}: ${name} rejects without state change and a valid request recovers`, async (t) => {
      const h = await harness(t);
      const before = h.store.read();
      const publicBefore = h.store.publicSnapshot();
      const damaged = Buffer.concat([
        Buffer.from(target.prefix + "Synthetic private marker "),
        Buffer.from(bytes),
        Buffer.from(target.suffix),
      ]);
      const rejected = await h.send(target.path, damaged);
      assert.deepEqual(rejected, { status: 400, data: { error: "Invalid JSON" } });
      assert.deepEqual(h.store.read(), before);
      assert.deepEqual(h.store.publicSnapshot(), publicBefore);
      const recovered = await h.send(target.path, Buffer.from(JSON.stringify(target.input(recoveredText))));
      assert.equal(recovered.status, target.success);
      assert.equal(target.stored(h.store.read()), recoveredText);
      if (target.name === "private request") assert.deepEqual(h.store.publicSnapshot(), publicBefore);
      else assert.equal(h.store.publicSnapshot().profiles[0].bio, recoveredText);
    });
  }
  test(`${target.name}: valid Unicode survives one-byte writes without changing spelling`, async (t) => {
    const h = await harness(t);
    const value = "日本語 cafe\u0301 café 🧪 �";
    const result = await h.sendByteChunks(target.path, Buffer.from(JSON.stringify(target.input(value))));
    assert.equal(result.status, target.success);
    assert.equal(target.stored(h.store.read()), value);
  });
}

test("leading BOM and invalid JSON retain their existing rejection behavior", async (t) => {
  const h = await harness(t);
  const before = h.store.read();
  const publicBefore = h.store.publicSnapshot();
  const valid = Buffer.from(JSON.stringify(targets[0].input(recoveredText)));
  for (const bytes of [Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), valid]), valid.subarray(0, valid.length - 1)]) {
    assert.deepEqual(await h.send(targets[0].path, bytes), { status: 400, data: { error: "Invalid JSON" } });
    assert.deepEqual(h.store.read(), before);
    assert.deepEqual(h.store.publicSnapshot(), publicBefore);
  }
});

test("authentication and CSRF checks still precede malformed mutation-body decoding", async (t) => {
  const h = await harness(t);
  const before = h.store.read();
  const publicBefore = h.store.publicSnapshot();
  for (const [extra, expected] of [
    [{ cookie: "" }, { status: 401, data: { error: "Authentication required" } }],
    [{ origin: "https://untrusted.example.test" }, { status: 403, data: { error: "Origin rejected" } }],
    [{ "x-csrf-token": "synthetic-invalid-csrf" }, { status: 403, data: { error: "CSRF rejected" } }],
  ]) {
    assert.deepEqual(await h.send(targets[0].path, Buffer.from([0x80]), extra), expected);
    assert.deepEqual(h.store.read(), before);
    assert.deepEqual(h.store.publicSnapshot(), publicBefore);
  }
});

test("the encoded-byte request limit remains enforced before decoding", async (t) => {
  const h = await harness(t);
  const before = h.store.read();
  const publicBefore = h.store.publicSnapshot();
  assert.deepEqual(await h.send(targets[0].path, Buffer.alloc(16_385, 0x80)), {
    status: 413,
    data: { error: "Request too large" },
  });
  assert.deepEqual(h.store.read(), before);
  assert.deepEqual(h.store.publicSnapshot(), publicBefore);
});
