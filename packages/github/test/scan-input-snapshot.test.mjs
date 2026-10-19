import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { GithubClientError, GithubReadClient } from "../dist/index.js";

const ORIGIN = "https://api.synthetic.invalid";
const SOURCE = "scope:original";
const KEY = "original-items/v1";
const QUERY =
  "query Original($first: Int!, $after: String) { original { nodes { id } pageInfo { hasNextPage endCursor } } }";
const OTHER_QUERY =
  "query Other($first: Int!, $after: String) { other { nodes { id } pageInfo { hasNextPage endCursor } } }";
const json = (value, headers = {}) => new Response(JSON.stringify(value), { headers });
const page = (id, hasNextPage = false, endCursor = null) => ({ nodes: [{ id }], pageInfo: { hasNextPage, endCursor } });
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

class MemoryStore {
  values = new Map();
  loads = [];
  writes = [];
  scanLoad = Promise.withResolvers();
  releaseScan = Promise.withResolvers();
  holdScan = false;
  async load(key) {
    this.loads.push(key);
    if (this.holdScan && key.startsWith("scan:")) {
      this.holdScan = false;
      this.scanLoad.resolve();
      await this.releaseScan.promise;
    }
    return structuredClone(this.values.get(key));
  }
  async save(key, value) {
    this.writes.push(key);
    this.values.set(key, structuredClone(value));
  }
}

function setup(fetch, extra = {}) {
  const checkpoints = new MemoryStore();
  const tokens = [];
  const client = new GithubReadClient({
    apiOrigin: ORIGIN,
    checkpoints,
    token: async (source) => {
      tokens.push(source);
      return undefined;
    },
    fetch,
    maxRetries: 0,
    random: () => 0,
    ...extra,
  });
  return { checkpoints, tokens, client };
}

function scanOptions(kind, assertAuthorized = () => {}) {
  const shared = { source: SOURCE, key: KEY, maxPages: 3, assertAuthorized };
  return kind === "REST"
    ? { ...shared, url: "/original", select: (body) => body.original }
    : { ...shared, query: QUERY, variables: { filter: { labels: ["original"] } }, select: (body) => body.original };
}

function scan(kind, client, options) {
  return kind === "REST" ? client.scanRest(options) : client.scanGraphql(options);
}

for (const kind of ["REST", "GraphQL"]) {
  test(`${kind} captures the original source query and selector before checkpoint loading`, async () => {
    const calls = [];
    let replacementChecks = 0;
    const context = setup(async (url, request) => {
      calls.push({ url, body: request.body && JSON.parse(request.body) });
      return kind === "REST"
        ? json({ original: [{ id: "original" }], other: [{ id: "other" }] })
        : json({ data: { original: page("original"), other: page("other") } });
    });
    const options = scanOptions(kind);
    context.checkpoints.holdScan = true;
    const pending = scan(kind, context.client, options);
    await context.checkpoints.scanLoad.promise;
    options.source = "scope:replacement";
    options.key = "replacement-items/v1";
    options.select = (body) => body.other;
    options.assertAuthorized = () => {
      replacementChecks++;
    };
    if (kind === "REST") options.url = "/replacement";
    else options.query = OTHER_QUERY;
    context.checkpoints.releaseScan.resolve();
    assert.deepEqual(await pending, [{ id: "original" }]);
    assert.deepEqual(context.tokens, [SOURCE]);
    assert.equal(replacementChecks, 0);
    if (kind === "REST") assert.equal(calls[0].url, `${ORIGIN}/original`);
    else assert.equal(calls[0].body.query, QUERY);
    const checkpoint = context.checkpoints.values.get(`scan:${hash([SOURCE, KEY])}`);
    assert.deepEqual(checkpoint.items, [{ id: "original" }]);
    assert.equal(checkpoint.complete, true);
  });
}

for (const method of ["scanGraphql", "graphql"]) {
  test(`${method} detaches nested variables before an awaited token lookup`, async () => {
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    const sent = [];
    const context = setup(
      async (_url, request) => {
        sent.push(JSON.parse(request.body));
        return json({ data: { original: page("original") } });
      },
      {
        token: async () => {
          entered.resolve();
          await release.promise;
          return undefined;
        },
      },
    );
    const variables = { filter: { labels: ["original"], scope: { repository: "owner/original" } } };
    const pending =
      method === "scanGraphql"
        ? context.client.scanGraphql({ ...scanOptions("GraphQL"), variables })
        : context.client.graphql(SOURCE, QUERY, variables);
    await entered.promise;
    variables.filter.labels[0] = "replacement";
    variables.filter.scope.repository = "owner/replacement";
    release.resolve();
    await pending;
    assert.deepEqual(sent[0].variables.filter, { labels: ["original"], scope: { repository: "owner/original" } });
  });
}

for (const kind of ["REST", "GraphQL"]) {
  test(`${kind} keeps the captured authority callback live through token preparation`, async () => {
    let authorized = true;
    let calls = 0;
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    const context = setup(
      async () => {
        calls++;
        return kind === "REST" ? json({ original: [] }) : json({ data: { original: page("original") } });
      },
      {
        token: async () => {
          entered.resolve();
          await release.promise;
          return undefined;
        },
      },
    );
    const options = scanOptions(kind, () => {
      if (!authorized) throw new Error("private revoked policy");
    });
    context.checkpoints.holdScan = true;
    const outcome = scan(kind, context.client, options).then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    await context.checkpoints.scanLoad.promise;
    options.assertAuthorized = () => {};
    context.checkpoints.releaseScan.resolve();
    await entered.promise;
    authorized = false;
    release.resolve();
    const result = await outcome;
    assert.ok(result.error instanceof GithubClientError);
    assert.equal(result.error.outcome.kind, "unsafe_request");
    assert.equal(calls, 0, "the original revoked callback must prevent HTTP dispatch, not merely final delivery");
    assert.equal([...context.checkpoints.values.keys()].filter((key) => key.startsWith("scan:")).length, 0);
  });
}

test("GraphQL keeps one nested variable snapshot across all pages and the saved fingerprint", async () => {
  const options = scanOptions("GraphQL");
  const originalVariables = structuredClone(options.variables);
  const sent = [];
  const context = setup(async (_url, request) => {
    sent.push(JSON.parse(request.body));
    if (sent.length === 1) {
      options.variables.filter.labels.push("late");
      return json({ data: { original: page("first", true, "next") } });
    }
    return json({ data: { original: page("second") } });
  });
  assert.deepEqual(await context.client.scanGraphql(options), [{ id: "first" }, { id: "second" }]);
  assert.deepEqual(
    sent.map((request) => request.variables),
    [
      { ...originalVariables, first: 100, after: null },
      { ...originalVariables, first: 100, after: "next" },
    ],
  );
  const checkpoint = context.checkpoints.values.get(`scan:${hash([SOURCE, KEY])}`);
  assert.equal(
    checkpoint.fingerprint,
    hash(["graphql/v1", ORIGIN, "/graphql", "2022-11-28", QUERY, originalVariables, 100, KEY]),
  );
  assert.deepEqual(checkpoint.visited, ["", "next"]);
  assert.equal(checkpoint.complete, true);
});

test("unchanged direct GraphQL variables preserve ordinary JSON wire serialization", async () => {
  const variables = {
    time: new Date("2026-01-01T00:00:00Z"),
    absent: undefined,
    values: [null, 1, "é"],
    explicit: null,
  };
  const sent = [];
  const context = setup(async (_url, request) => {
    sent.push(request.body);
    return json({ data: { original: page("original") } });
  });
  assert.deepEqual(await context.client.graphql(SOURCE, QUERY, variables), { original: page("original") });
  assert.equal(sent[0], JSON.stringify({ query: QUERY, variables }));
});

test("an unchanged captured callback still observes later authorization revocation", async () => {
  let authorized = true;
  let calls = 0;
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const context = setup(
    async () => {
      calls++;
      return json({ original: [] });
    },
    {
      token: async () => {
        entered.resolve();
        await release.promise;
        return undefined;
      },
    },
  );
  const options = scanOptions("REST", () => {
    if (!authorized) throw new Error("revoked");
  });
  const result = context.client.scanRest(options).then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  await entered.promise;
  authorized = false;
  release.resolve();
  assert.equal((await result).error?.outcome.kind, "unsafe_request");
  assert.equal(calls, 0);
});

for (const method of ["scanGraphql", "graphql"]) {
  test(`${method} retries the original serialized request after caller data changes`, async () => {
    let now = 0;
    let conversions = 0;
    const variables = {
      filter: { labels: ["original"] },
      date: new Date("2026-01-01T00:00:00Z"),
      projected: {
        toJSON() {
          conversions++;
          return { value: "original" };
        },
      },
    };
    const sent = [];
    const sleeps = [];
    const context = setup(
      async (_url, request) => {
        sent.push(request.body);
        if (sent.length === 1) {
          variables.filter.labels.push("late");
          variables.date.setUTCFullYear(2027);
          return new Response("temporary synthetic outage", { status: 503 });
        }
        return json({ data: { original: page("original") } });
      },
      {
        maxRetries: 1,
        now: () => now,
        sleep: async (milliseconds) => {
          sleeps.push(milliseconds);
          now += milliseconds;
        },
      },
    );
    if (method === "scanGraphql") await context.client.scanGraphql({ ...scanOptions("GraphQL"), variables });
    else await context.client.graphql(SOURCE, QUERY, variables);
    assert.equal(sent.length, 2);
    assert.equal(sent[1], sent[0], "a retry must use the same captured request body");
    assert.deepEqual(JSON.parse(sent[0]).variables.filter, { labels: ["original"] });
    assert.equal(JSON.parse(sent[0]).variables.date, "2026-01-01T00:00:00.000Z");
    assert.equal(conversions, 1, "caller conversion hooks run once at the request/scan entry");
    assert.deepEqual(sleeps, [1000]);
  });
}

test("GraphQL scan preserves JSON values and converted object fields across pages and resume", async () => {
  let conversions = 0;
  const variables = {
    date: new Date("2026-01-01T00:00:00Z"),
    absent: undefined,
    values: [undefined, , null, "é", () => "omitted"],
    nested: {
      toJSON(key) {
        conversions++;
        return { key, preserved: true };
      },
    },
  };
  const wireVariables = {
    date: "2026-01-01T00:00:00.000Z",
    values: [null, null, null, "é", null],
    nested: { key: "nested", preserved: true },
  };
  const sent = [];
  const context = setup(async (_url, request) => {
    sent.push(JSON.parse(request.body));
    return json({
      data: {
        original: page(sent.length === 1 ? "first" : "second", sent.length === 1, sent.length === 1 ? "next" : null),
      },
    });
  });
  const options = { ...scanOptions("GraphQL"), variables };
  assert.deepEqual(await context.client.scanGraphql(options), [{ id: "first" }, { id: "second" }]);
  assert.equal(conversions, 1);
  assert.deepEqual(
    sent.map((request) => request.variables),
    [
      { ...wireVariables, first: 100, after: null },
      { ...wireVariables, first: 100, after: "next" },
    ],
  );
  const checkpoint = context.checkpoints.values.get(`scan:${hash([SOURCE, KEY])}`);
  assert.equal(
    checkpoint.fingerprint,
    hash(["graphql/v1", ORIGIN, "/graphql", "2022-11-28", QUERY, wireVariables, 100, KEY]),
  );
  const resumed = new GithubReadClient({
    apiOrigin: ORIGIN,
    checkpoints: context.checkpoints,
    token: async () => assert.fail("completed checkpoint must not resolve a token"),
    fetch: async () => assert.fail("completed checkpoint must not repeat HTTP"),
  });
  assert.deepEqual(await resumed.scanGraphql({ ...options, variables: wireVariables }), [
    { id: "first" },
    { id: "second" },
  ]);
});

const invalidVariables = [
  [
    "cyclic data",
    () => {
      const value = {};
      value.self = value;
      return value;
    },
  ],
  ["BigInt", () => ({ value: 1n })],
  [
    "a throwing getter",
    () =>
      Object.defineProperty({}, "value", {
        enumerable: true,
        get() {
          throw new Error("synthetic private conversion detail");
        },
      }),
  ],
  [
    "a throwing conversion",
    () => ({
      nested: {
        toJSON() {
          throw new Error("synthetic private conversion detail");
        },
      },
    }),
  ],
];
for (const method of ["scanGraphql", "graphql"]) {
  for (const [name, makeVariables] of invalidVariables) {
    test(`${method} sanitizes ${name} before HTTP, retry, or checkpoint state`, async () => {
      let now = 0;
      let checks = 0;
      const context = setup(async () => assert.fail("unserializable input cannot authorize HTTP"), {
        maxRetries: 1,
        now: () => now,
        sleep: async (milliseconds) => {
          now += milliseconds;
        },
      });
      const assertAuthorized = () => {
        checks++;
      };
      const pending =
        method === "scanGraphql"
          ? context.client.scanGraphql({ ...scanOptions("GraphQL", assertAuthorized), variables: makeVariables() })
          : context.client.graphql(SOURCE, QUERY, makeVariables(), assertAuthorized);
      await assert.rejects(pending, (error) => {
        assert.ok(error instanceof GithubClientError);
        assert.equal(error.outcome.kind, "unsafe_request");
        assert.equal(error.source, SOURCE);
        assert.equal(error.message, "GitHub source request failed: unsafe_request");
        assert.doesNotMatch(error.stack, /synthetic private conversion detail/);
        return true;
      });
      assert.ok(checks > 0, "the original live callback still guards rejection");
      assert.deepEqual(context.tokens, []);
      assert.deepEqual(context.checkpoints.loads, []);
      assert.deepEqual(context.checkpoints.writes, []);
      assert.equal(now, 0, "local serialization failures are not retryable transport failures");
    });
  }
}

test("GraphQL scan accepts a JSON object conversion without retaining its mutable hook", async () => {
  const keys = [];
  const variables = {
    toJSON(key) {
      keys.push(key);
      return { filter: { labels: ["original"] } };
    },
  };
  const sent = [];
  const context = setup(async (_url, request) => {
    sent.push(JSON.parse(request.body));
    return json({ data: { original: page("original") } });
  });
  assert.deepEqual(await context.client.scanGraphql({ ...scanOptions("GraphQL"), variables }), [{ id: "original" }]);
  assert.deepEqual(keys, ["variables"]);
  assert.deepEqual(sent[0].variables, { filter: { labels: ["original"] }, first: 100, after: null });
});

for (const converted of [null, [], "not an object", { first: 25 }, { after: "injected" }]) {
  test(`GraphQL scan rejects a conversion that cannot supply unmanaged object variables: ${JSON.stringify(converted)}`, async () => {
    const context = setup(async () => assert.fail("invalid managed variables cannot authorize HTTP"));
    const variables = {
      toJSON() {
        return converted;
      },
    };
    await assert.rejects(context.client.scanGraphql({ ...scanOptions("GraphQL"), variables }), (error) => {
      assert.ok(error instanceof GithubClientError);
      assert.equal(error.outcome.kind, "unsafe_request");
      return true;
    });
    assert.deepEqual(context.tokens, []);
    assert.deepEqual(context.checkpoints.loads, []);
    assert.deepEqual(context.checkpoints.writes, []);
  });
}

test("nested GraphQL children capture reused option objects independently", async () => {
  const options = scanOptions("GraphQL");
  const sent = [];
  const context = setup(
    async (_url, request) => {
      const body = JSON.parse(request.body);
      sent.push(body.variables);
      return json({ data: { original: page(body.variables.parent) } });
    },
    { concurrency: 2 },
  );
  const parents = ["first", "second"];
  const result = await context.client.scanNestedGraphql(parents, (parent) => {
    options.key = `${KEY}:${parent}`;
    options.variables.parent = parent;
    return options;
  });
  assert.deepEqual(result, [
    { parent: "first", items: [{ id: "first" }] },
    { parent: "second", items: [{ id: "second" }] },
  ]);
  assert.deepEqual(sent.map((variables) => variables.parent).sort(), ["first", "second"]);
});

for (const kind of ["REST", "GraphQL"]) {
  test(`${kind} preserves the original selector receiver while capturing its function`, async () => {
    const context = setup(async () =>
      kind === "REST" ? json({ original: [{ id: "original" }] }) : json({ data: { original: page("original") } }),
    );
    const options = scanOptions(kind);
    options.select = function (body) {
      assert.equal(this, options);
      return body.original;
    };
    assert.deepEqual(await scan(kind, context.client, options), [{ id: "original" }]);
  });
}

test("REST preserves its captured source and selector across pagination", async () => {
  const options = scanOptions("REST");
  const calls = [];
  const context = setup(async (url) => {
    calls.push(url);
    if (calls.length === 1) {
      options.source = "scope:replacement";
      options.select = (body) => body.other;
      return json({ original: [{ id: "first" }], other: [{ id: "wrong" }] }, { link: `<${ORIGIN}/next>; rel="next"` });
    }
    return json({ original: [{ id: "second" }], other: [{ id: "wrong" }] });
  });
  assert.deepEqual(await context.client.scanRest(options), [{ id: "first" }, { id: "second" }]);
  assert.deepEqual(context.tokens, [SOURCE, SOURCE]);
  assert.deepEqual(calls, [`${ORIGIN}/original`, `${ORIGIN}/next`]);
});
