import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlStore, locator } from "../src/store.mjs";
import { createControlsServer } from "../src/server.mjs";

// Real loopback HTTP and SQLite with a synthetic pre-authorized session.
// No live OAuth ownership, provider token or external source is exercised.
async function harness(t) {
  const directory = mkdtempSync(join(tmpdir(), "controls-profile-presentation-"));
  const filename = join(directory, "controls.sqlite");
  const store = new ControlStore(filename);
  const token = "A".repeat(43);
  const csrf = "synthetic-profile-csrf";
  const origin = "https://controls.example.test";
  store.transaction((state) => {
    state.sessions[createHash("sha256").update(token).digest("base64url")] = {
      actorId: "101",
      csrf,
      roles: [],
      roleVersion: "0",
      expires: 1_000_000,
    };
    state.profiles["102"] = { bio: "Another owner's private text", highlights: [], public: false };
  });
  const server = createControlsServer({
    store,
    origin,
    now: () => 100_000,
    provider: {
      authorizationURL() {
        throw Error("No synthetic login expected");
      },
      exchange() {
        throw Error("No synthetic login expected");
      },
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    try {
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  return {
    store,
    filename,
    async save(input, extraHeaders = {}) {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/controls/profile`, {
        method: "POST",
        headers: {
          cookie: `__Host-controls_session=${token}`,
          origin,
          "x-csrf-token": csrf,
          "content-type": "application/json",
          ...extraHeaders,
        },
        body: JSON.stringify(input),
      });
      return { status: response.status, data: await response.json() };
    },
  };
}

test("unsupported profile URLs reject atomically, then the same owner saves an exact public profile", async (t) => {
  const h = await harness(t);
  const input = { bio: "Synthetic cafe\u0301 日本語 🧪", highlights: [], public: true };
  const before = h.store.read();
  const projection = h.store.publicSnapshot();
  for (const link of [
    "https://github.com/synthetic/repo/issues/1?private=marker",
    "https://github.com/synthetic/repo#unsupported",
    "https://github.com.evil.invalid/synthetic/repo",
    "javascript:alert(1)",
  ]) {
    const result = await h.save({ ...input, highlights: [link] });
    assert.equal(result.status, 400);
    assert.deepEqual(h.store.read(), before);
    assert.deepEqual(h.store.publicSnapshot(), projection);
  }
  const highlights = [
    " HTTPS://GITHUB.COM/synthetic/repo ",
    "https://github.com/synthetic/repo/issues/1#issuecomment-2",
  ];
  assert.equal((await h.save({ ...input, highlights })).status, 200);
  assert.deepEqual(h.store.read().profiles["101"], {
    ...input,
    highlights: highlights.map((url) => new URL(url).href),
  });
  assert.deepEqual(h.store.read().profiles["102"], before.profiles["102"]);
  const reopened = new ControlStore(h.filename);
  try {
    assert.deepEqual(reopened.read().profiles, h.store.read().profiles);
  } finally {
    reopened.close();
  }
  assert.equal(h.store.publicSnapshot().profiles[0].bio, input.bio);
  // The generic evidence/request locator retains its distinct existing contract.
  const legacyLocator = "https://github.com/synthetic/repo/issues/1?existing=allowed";
  assert.equal(locator(legacyLocator), legacyLocator);
});

test("profile text and opt-in stay owner-bound and failed authentication cannot change either profile", async (t) => {
  const h = await harness(t);
  const input = { bio: "Synthetic owner text", highlights: ["https://github.com/synthetic/repo"], public: true };
  const before = h.store.read();
  for (const [body, headers, status] of [
    [{ ...input, actorId: "102" }, {}, 400],
    [input, { cookie: "" }, 401],
    [input, { "x-csrf-token": "wrong" }, 403],
    [{ ...input, bio: "otherwise safe\n" }, {}, 400],
  ]) {
    assert.equal((await h.save(body, headers)).status, status);
    assert.deepEqual(h.store.read(), before);
  }
  assert.equal((await h.save({ ...input, public: false })).status, 200);
  assert.equal(h.store.read().profiles["101"].bio, input.bio);
  assert.deepEqual(h.store.publicSnapshot().profiles, []);
});
