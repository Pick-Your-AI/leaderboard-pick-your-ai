import assert from "node:assert/strict";
import test from "node:test";
import { GithubQuotaObservations, quotaResources } from "../dist/quota.js";

const origin = "https://api.synthetic.invalid";
const source = "installation:synthetic-pool";
const observedAt = "2026-10-18T13:00:00.000Z";
const now = () => Date.parse(observedAt);
const response = (headers, status = 200) => ({ status, headers: new Headers(headers) });
const headers = {
  "x-ratelimit-resource": "core",
  "x-ratelimit-limit": "5000",
  "x-ratelimit-remaining": "4321",
  "x-ratelimit-used": "679",
  "x-ratelimit-reset": String(Date.parse("2026-10-18T14:00:00.000Z") / 1000),
};

class MemoryStore {
  values = new Map();
  loads = [];
  async load(key) {
    this.loads.push(key);
    return structuredClone(this.values.get(key));
  }
  async save(key, value) {
    this.values.set(key, structuredClone(value));
  }
}

const resource = (diagnostics, name = "core") => diagnostics.resources.find((row) => row.resource === name);

test("quota diagnostics read exactly five bounded resources without inventing absent observations", async () => {
  const store = new MemoryStore();
  const observer = new GithubQuotaObservations(store, origin, now);
  const result = await observer.read(source);
  assert.match(result.scopeKey, /^[a-f0-9]{64}$/);
  assert.deepEqual(
    result.resources.map((row) => row.resource),
    quotaResources,
  );
  assert.ok(result.resources.every((row) => row.state === "unknown" && row.observation === null));
  assert.equal(store.loads.length, 5);
  assert.equal(store.values.size, 0);
});

test("quota response metadata survives a new observer and returns detached numeric observations", async () => {
  const store = new MemoryStore();
  const first = new GithubQuotaObservations(store, origin, now);
  assert.equal(await first.observe(source, response(headers)), true);
  const restarted = new GithubQuotaObservations(store, origin, now);
  const snapshot = resource(await restarted.read(source));
  assert.deepEqual(snapshot, {
    resource: "core",
    state: "observed",
    observation: {
      observedAt,
      responseStatus: 200,
      limit: 5000,
      remaining: 4321,
      used: 679,
      resetAt: "2026-10-18T14:00:00.000Z",
      retryAfterSeconds: null,
    },
  });
  snapshot.observation.remaining = 0;
  assert.equal(resource(await restarted.read(source)).observation.remaining, 4321);
});

test("quota scope binds the exact credential pool and API origin independently of resource", async () => {
  const store = new MemoryStore();
  const one = new GithubQuotaObservations(store, origin, now);
  const otherOrigin = new GithubQuotaObservations(store, "https://enterprise.synthetic.invalid", now);
  await one.observe(source, response(headers));
  await one.observe("installation:other", response({ ...headers, "x-ratelimit-remaining": "111" }));
  await otherOrigin.observe(source, response({ ...headers, "x-ratelimit-remaining": "222" }));
  assert.equal(resource(await one.read(source)).observation.remaining, 4321);
  assert.equal(resource(await one.read("installation:other")).observation.remaining, 111);
  assert.equal(resource(await otherOrigin.read(source)).observation.remaining, 222);
  assert.equal(new Set([...store.values.values()].map((row) => row.scopeKey)).size, 3);
  assert.equal(JSON.stringify([...store.values]).includes(source), false);
  assert.equal(JSON.stringify([...store.values]).includes(origin), false);
});

test("quota observations keep resource pools separate and never infer an omitted or unfamiliar identity", async () => {
  const store = new MemoryStore();
  const observer = new GithubQuotaObservations(store, origin, now);
  for (const [index, name] of quotaResources.slice(0, -1).entries())
    await observer.observe(
      source,
      response({ ...headers, "x-ratelimit-resource": name, "x-ratelimit-remaining": String(index) }),
    );
  for (const name of [undefined, "unrecognized-synthetic-resource"])
    await observer.observe(
      source,
      response({ "x-ratelimit-remaining": "7", ...(name === undefined ? {} : { "x-ratelimit-resource": name }) }),
    );
  const result = await observer.read(source);
  assert.deepEqual(
    result.resources.map((row) => row.observation.remaining),
    [0, 1, 2, 3, 7],
  );
  assert.equal(store.values.size, 5);
  assert.equal(JSON.stringify([...store.values]).includes("unrecognized-synthetic-resource"), false);
});

test("malformed quota numbers and absent values stay unknown rather than becoming zero", async () => {
  const invalid = ["", "-1", "+1", "1.5", "1e3", "Infinity", "NaN", "9007199254740992", "²", "synthetic-secret"];
  for (const value of invalid) {
    const observer = new GithubQuotaObservations(new MemoryStore(), origin, now);
    await observer.observe(
      source,
      response({
        "x-ratelimit-resource": "core",
        "x-ratelimit-limit": value,
        "x-ratelimit-remaining": value,
        "x-ratelimit-used": value,
        "x-ratelimit-reset": value,
        "retry-after": value,
      }),
    );
    const result = resource(await observer.read(source)).observation;
    for (const field of ["limit", "remaining", "used", "resetAt", "retryAfterSeconds"])
      assert.equal(result[field], null, `${JSON.stringify(value)} in ${field}`);
  }
  const observer = new GithubQuotaObservations(new MemoryStore(), origin, now);
  await observer.observe(source, response({ "x-ratelimit-resource": "core" }));
  assert.equal(resource(await observer.read(source)).observation.remaining, null);
  await observer.observe(source, response({ "x-ratelimit-resource": "core", "x-ratelimit-remaining": "0" }));
  assert.equal(resource(await observer.read(source)).observation.remaining, 0);
});

test("quota reset instants reject overflow while zero retains its real epoch meaning", async () => {
  const observer = new GithubQuotaObservations(new MemoryStore(), origin, now);
  for (const [input, expected] of [
    ["0", "1970-01-01T00:00:00.000Z"],
    ["253402300799", "9999-12-31T23:59:59.000Z"],
    ["253402300800", null],
  ]) {
    await observer.observe(source, response({ ...headers, "x-ratelimit-reset": input }));
    assert.equal(resource(await observer.read(source)).observation.resetAt, expected);
  }
});

test("later regional counters may increase and observations never sum or manufacture consumption", async () => {
  const store = new MemoryStore();
  let clock = now();
  const observer = new GithubQuotaObservations(store, origin, () => clock);
  await observer.observe(source, response({ ...headers, "x-ratelimit-remaining": "2" }));
  clock += 1000;
  await observer.observe(
    source,
    response({ ...headers, "x-ratelimit-remaining": "10", "x-ratelimit-used": "4990" }, 304),
  );
  const result = resource(await observer.read(source)).observation;
  assert.equal(result.remaining, 10);
  assert.equal(result.used, 4990);
  assert.equal(result.observedAt, "2026-10-18T13:00:01.000Z");
  assert.equal(result.responseStatus, 304);
  assert.equal(Object.hasOwn(result, "consumed"), false);
});

test("no quota headers do not refresh an old observation or create an implicit healthy balance", async () => {
  const store = new MemoryStore();
  let clock = now();
  const observer = new GithubQuotaObservations(store, origin, () => clock);
  assert.equal(await observer.observe(source, response({})), false);
  assert.equal(store.values.size, 0);
  await observer.observe(source, response(headers));
  clock += 60_000;
  assert.equal(await observer.observe(source, response({ "x-synthetic-private": "synthetic-secret" })), false);
  assert.equal(resource(await observer.read(source)).observation.observedAt, observedAt);
});

test("quota records never retain unrelated headers, source labels or transport response bodies", async () => {
  const store = new MemoryStore();
  const observer = new GithubQuotaObservations(store, origin, now);
  await observer.observe(source, {
    ...response(
      {
        ...headers,
        authorization: "Bearer synthetic-secret",
        "set-cookie": "synthetic-secret",
        "retry-after": "12",
        "x-request-id": "synthetic-secret",
      },
      429,
    ),
    body: { private: "synthetic-secret" },
    url: `${origin}/synthetic-secret`,
  });
  const serialized = JSON.stringify([...store.values]);
  assert.equal(serialized.includes("synthetic-secret"), false);
  assert.equal(serialized.includes(source), false);
  assert.equal(serialized.includes(origin), false);
  assert.equal(resource(await observer.read(source)).observation.retryAfterSeconds, 12);
});

test("quota readback rejects unknown fields, bad shapes and cross-scope or resource substitution", async () => {
  const store = new MemoryStore();
  const observer = new GithubQuotaObservations(store, origin, now);
  await observer.observe(source, response(headers));
  const [key, original] = [...store.values][0];
  for (const patch of [
    { secret: "synthetic-secret" },
    { scopeKey: "f".repeat(64) },
    { resource: "graphql" },
    { version: 2 },
    { observedAt: "2026-02-30T00:00:00.000Z" },
    { remaining: -1 },
    { used: true },
    { limit: "5000" },
    { responseStatus: 0 },
    { retryAfterSeconds: 1.5 },
  ]) {
    store.values.set(key, { ...original, ...patch });
    assert.deepEqual(resource(await observer.read(source)), {
      resource: "core",
      state: "unavailable",
      observation: null,
    });
  }
  for (const malformed of [null, [], "synthetic-secret", { ...original, resetAt: "tomorrow" }]) {
    store.values.set(key, malformed);
    assert.equal(resource(await observer.read(source)).state, "unavailable");
  }
  const missing = { ...original };
  delete missing.limit;
  store.values.set(key, missing);
  assert.equal(resource(await observer.read(source)).state, "unavailable");
});

test("quota persistence errors are sanitized and preserve the last successfully retained observation", async () => {
  const store = new MemoryStore();
  const observer = new GithubQuotaObservations(store, origin, now);
  await observer.observe(source, response(headers));
  store.save = async () => {
    throw new Error("synthetic-secret");
  };
  assert.equal(await observer.observe(source, response({ ...headers, "x-ratelimit-remaining": "123" })), false);
  assert.equal(resource(await observer.read(source)).observation.remaining, 4321);
  store.load = async () => {
    throw new Error("synthetic-secret");
  };
  assert.ok(
    (await observer.read(source)).resources.every((row) => row.state === "unavailable" && row.observation === null),
  );
});

test("quota writes serialize observations within a resource and reads await already pending retention", async () => {
  const store = new MemoryStore();
  const originalSave = store.save.bind(store);
  let release;
  let started;
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  const held = new Promise((resolve) => {
    release = resolve;
  });
  let count = 0;
  store.save = async (key, value) => {
    count += 1;
    if (count === 1) {
      started();
      await held;
    }
    await originalSave(key, value);
  };
  const observer = new GithubQuotaObservations(store, origin, now);
  const first = observer.observe(source, response(headers));
  await ready;
  const second = observer.observe(source, response({ ...headers, "x-ratelimit-remaining": "9" }));
  const reading = observer.read(source);
  await Promise.resolve();
  assert.equal(count, 1);
  release();
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.equal(resource(await reading).observation.remaining, 9);
});

test("an invalid observation clock never fabricates a current timestamp", async () => {
  for (const clock of [NaN, Infinity, 1e30, Date.parse("+010000-01-01T00:00:00.000Z")]) {
    const store = new MemoryStore();
    const observer = new GithubQuotaObservations(store, origin, () => clock);
    assert.equal(await observer.observe(source, response(headers)), false);
    assert.equal(store.values.size, 0);
  }
});

test("revocation while an observation waits behind a prior write prevents its new retention", async () => {
  const store = new MemoryStore();
  const originalSave = store.save.bind(store);
  let release;
  let started;
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  const held = new Promise((resolve) => {
    release = resolve;
  });
  let writes = 0;
  store.save = async (key, value) => {
    writes += 1;
    if (writes === 1) {
      started();
      await held;
    }
    await originalSave(key, value);
  };
  const observer = new GithubQuotaObservations(store, origin, now);
  const first = observer.observe(source, response(headers));
  await ready;
  let authorized = true;
  const second = observer.observe(source, response({ ...headers, "x-ratelimit-remaining": "9" }), () => {
    if (!authorized) throw new Error("synthetic-private-revocation");
  });
  authorized = false;
  release();
  assert.equal(await first, true);
  assert.equal(await second, false);
  assert.equal(writes, 1);
  assert.equal(resource(await observer.read(source)).observation.remaining, 4321);
});
