import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { components } from "./harness.mjs";
import { operatorSettings, publishedOperatorReplay } from "./operator-harness.mjs";

const origin = "https://controls.synthetic.invalid";
async function http(t, { serialize = () => {} } = {}) {
  let current = true,
    grantReads = 0,
    grantHook = () => {};
  const grant = { allowed: true, policyVersion: "synthetic-operator-policy", revision: "grant-1" };
  const { h, receipt } = await publishedOperatorReplay(t, { operatorDiagnostics: operatorSettings(() => current) });
  let depth = 0;
  const transaction = h.db.transaction;
  h.db.transaction = (work) =>
    transaction(async (tx) => {
      depth++;
      try {
        return await work(tx);
      } finally {
        depth--;
      }
    });
  const token = "a".repeat(43),
    viewer = "c".repeat(43),
    csrf = "b".repeat(43);
  const sid = createHash("sha256").update(token).digest("base64url");
  const initialProfiles = structuredClone(h.controlsStore.read().profiles);
  const reset = () => {
    current = true;
    grantReads = 0;
    grantHook = () => {};
    Object.assign(grant, { allowed: true, policyVersion: "synthetic-operator-policy", revision: "grant-1" });
    h.controlsStore.transaction((state) => {
      state.profiles = structuredClone(initialProfiles);
      for (const [actorId, value, roles] of [
        ["201", token, ["operator"]],
        ["202", viewer, []],
      ])
        state.sessions[createHash("sha256").update(value).digest("base64url")] = {
          actorId,
          csrf,
          roles,
          roleVersion: "synthetic-roster-1",
          expires: Date.now() + 900_000,
        };
    });
  };
  reset();
  const controls = {
    ...h,
    receipt,
    reset,
    get depth() {
      return depth;
    },
    get grantReads() {
      return grantReads;
    },
    setGrantHook(fn) {
      grantHook = fn;
      grantReads = 0;
    },
    deny() {
      grant.allowed = false;
    },
    changeRevision() {
      grant.revision = "grant-2";
    },
    changePolicy() {
      grant.policyVersion = "synthetic-operator-policy-2";
    },
    expire() {
      h.controlsStore.transaction((state) => {
        state.sessions[sid].expires = 0;
      });
    },
    revokeConfiguration() {
      current = false;
    },
    suppress() {
      h.controlsStore.transaction((state) => {
        state.profiles["101"] = { ...state.profiles["101"], suppressed: true };
      });
    },
  };
  const observe = (callback) => async (data, beforeSend) => {
    Object.defineProperty(data, "toJSON", {
      value() {
        serialize(controls);
        return data;
      },
    });
    await callback(data, beforeSend);
  };
  const operations = {
    readHealth(repositoryId, authorize, callback) {
      return h.runtime.operations.readHealth(repositoryId, authorize, observe(callback));
    },
    readReplayResult(repositoryId, receiptId, authorize, callback) {
      return h.runtime.operations.readReplayResult(repositoryId, receiptId, authorize, observe(callback));
    },
  };
  const server = components.controls.createControlsServer({
    store: h.controlsStore,
    origin,
    operations,
    provider: {
      exchange() {
        throw new Error("Synthetic established sessions only");
      },
      authorizationURL() {
        throw new Error("Synthetic established sessions only");
      },
    },
    rolesForActor: (actorId) => ({ roles: actorId === "201" ? ["operator"] : [], version: "synthetic-roster-1" }),
    authorizeRepository: async ({ actorId, repositoryId }) => {
      await Promise.resolve();
      ++grantReads;
      await grantHook(controls);
      return { ...grant, allowed: grant.allowed && actorId === "201" && repositoryId === 2 };
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  controls.call = async (path, options = {}) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/controls/operations/${path}`, {
      method: options.method ?? "GET",
      redirect: "error",
      headers: {
        ...(options.anonymous ? {} : { cookie: `__Host-controls_session=${options.viewer ? viewer : token}` }),
        origin,
        "x-csrf-token": csrf,
        ...(options.method === "POST" ? { "content-type": "application/json" } : {}),
      },
      ...(options.method === "POST" ? { body: "{}" } : {}),
    });
    return { status: response.status, headers: response.headers, data: await response.json() };
  };
  return controls;
}
const routes = (h) => ["2/health", `2/replays/${h.receipt.id}`];
const noPrivate = (value) =>
  assert.doesNotMatch(
    JSON.stringify(value),
    /SYNTHETIC_ISSUE|synthetic-alice|sourceUrl|source_generations|operationKey|synthetic-test-token/,
  );

test("actual protected HTTP diagnostics expose only authorized fixed health and exact verified replay publications", async (t) => {
  const h = await http(t);
  const before = { ...h.githubReads };
  for (const path of routes(h)) {
    assert.equal((await h.call(path, { anonymous: true })).status, 401);
    assert.equal((await h.call(path, { viewer: true })).status, 403);
    assert.equal((await h.call(path.replace(/^2\//, "3/"))).status, 403);
    assert.equal((await h.call(path, { method: "POST" })).status, 405);
    assert.equal((await h.call(path + "?repositoryId=3")).status, 400);
    const response = await h.call(path);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.data.repositoryId, 2);
    assert.equal(response.data.sourceGeneration, "1");
    assert.equal(response.data.policyVersion, "synthetic-operator-policy");
    assert.equal(response.data.authorityRevision, "grant-1");
    noPrivate(response.data);
    if (path.endsWith("health")) {
      assert.equal(response.data.collector.state, "progress");
      assert.equal(response.data.publication.state, "verified");
      assert.equal(response.data.publication.publications.length, 2);
    } else {
      assert.equal(response.data.status, "published");
      assert.equal(response.data.receiptId, h.receipt.id);
      assert.equal(response.data.deliveryId, h.receipt.deliveryId);
      assert.equal(response.data.publications.length, 2);
    }
  }
  assert.deepEqual(h.githubReads, before);
  assert.equal((await h.call("2/replays/missing-synthetic-receipt")).status, 409);
  assert.equal(
    (await h.db.query("SELECT count(*)::integer AS n FROM leaderboard_ingestion.replay_receipts")).rows[0].n,
    1,
  );
  assert.equal(
    (await h.db.query("SELECT count(*)::integer AS n FROM leaderboard_ingestion.observations")).rows[0].n,
    1,
  );
});

test("the real SQL result transaction spans the final asynchronous HTTP grant and withholds changed authority", async (t) => {
  const h = await http(t);
  for (const path of routes(h)) {
    for (const [change, expected] of [
      ["deny", 403],
      ["changeRevision", 409],
      ["changePolicy", 409],
      ["expire", 401],
    ]) {
      h.reset();
      h.setGrantHook(async (value) => {
        if (value.grantReads === 4) {
          assert.equal(
            value.depth,
            1,
            "native source and normalization locks must still be held at the last HTTP grant",
          );
          await Promise.resolve();
          value[change]();
        }
      });
      const response = await h.call(path);
      assert.equal(h.grantReads, 4);
      assert.equal(response.status, expected, `${path} ${change}`);
      assert.equal(h.depth, 0);
      noPrivate(response.data);
      assert.equal(JSON.stringify(response.data).includes(h.receipt.id), false);
    }
  }
});

test("configuration, privacy and session changes during JSON serialization withhold actual HTTP publication results", async (t) => {
  let change = null,
    serializations = 0;
  const h = await http(t, {
    serialize(value) {
      assert.equal(value.depth, 1, "the native read transaction must span HTTP serialization");
      serializations++;
      if (change) value[change]();
    },
  });
  for (const path of routes(h)) {
    for (const [mutation, expected] of [
      ["revokeConfiguration", 409],
      ["suppress", 409],
      ["expire", 401],
    ]) {
      h.reset();
      change = mutation;
      const response = await h.call(path);
      assert.equal(response.status, expected, `${path} ${mutation}`);
      noPrivate(response.data);
      assert.equal(JSON.stringify(response.data).includes(h.receipt.id), false);
      assert.equal(h.depth, 0);
    }
  }
  assert.equal(serializations, 6);
});
