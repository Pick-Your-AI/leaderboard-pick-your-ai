import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { metadata, parameters, ReadFailure, request, selection } from "../src/remote/client.ts";

const at = "2026-10-18T00:00:00.000Z";
const policyLink = "https://github.com/synthetic-api/example/blob/main/policy.md";
const disabled = { id: "pr_merged", reason: "policy_withdrawn", policyVersion: "review-v1", policyLink };
const original = {
  schemaVersion: "leaderboard/v1",
  scope: { organization: "Pick-Your-AI", repository: null, workstream: null, start: null, end: null },
  head: { snapshotId: "public-1", revision: 1, publishedAt: at },
  snapshotId: "public-1",
  revision: 1,
  generatedAt: at,
  metricDefinitionVersion: "candidate-0.1.1",
  computationVersion: "synthetic-only",
  policyVersion: "current-controls-v2",
  coverage: [],
  disabledMetrics: [disabled],
};

test("disabled metadata retains its historical policy independently of current publication controls", () => {
  const parsed = metadata(original, selection(""));
  assert.deepEqual(parsed.disabledMetrics, [disabled]);
  assert.equal(parsed.policyVersion, "current-controls-v2");
});

test("legacy disabled metadata records absent policy details as unavailable without inventing a version", () => {
  const parsed = metadata(
    { ...original, disabledMetrics: [{ id: disabled.id, reason: disabled.reason }] },
    selection(""),
  );
  assert.deepEqual(parsed.disabledMetrics, [{ ...disabled, policyVersion: null, policyLink: null }]);
});

const selected = selection("metric=pr_merged&snapshot=public-1");
const envelope = () => ({ ...structuredClone(original), error: "metric_disabled", metric: { ...disabled } });
type Envelope = ReturnType<typeof envelope>;
async function readFailure(
  t: TestContext,
  body: unknown,
  options: { path?: string; status?: number; context?: boolean; queryMetric?: string } = {},
) {
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    assert.equal(init.credentials, "omit");
    assert.equal(init.cache, "no-store");
    assert.equal(init.redirect, "error");
    assert.ok(init.signal instanceof AbortSignal);
    return new Response(JSON.stringify(body), {
      status: options.status ?? 503,
      headers: { "content-type": "application/json" },
    });
  });
  const query = parameters(selected, { board: true, cursor: selected.cursor });
  if (options.queryMetric) query.set("metric", options.queryMetric);
  try {
    await request(
      "https://public.example.invalid/api/v1",
      options.path ?? "boards",
      query,
      new AbortController().signal,
      options.context === false ? undefined : selected,
    );
    assert.fail("disabled response must never become a successful board");
  } catch (error) {
    assert.ok(error instanceof ReadFailure);
    return error;
  }
}

test("exact disabled board admits only its bounded historical policy fields", async (t) => {
  const error = await readFailure(t, { ...envelope(), privateDetail: "SYNTHETIC_PRIVATE_ERROR_DETAIL" });
  assert.equal(error.status, 503);
  assert.equal(error.code, "metric_disabled");
  assert.deepEqual(error.disabledMetric, disabled);
  assert.ok(!JSON.stringify(error).includes("SYNTHETIC_PRIVATE_ERROR_DETAIL"));
});

const invalidEnvelopes: Array<[string, (body: Envelope) => unknown]> = [
  [
    "foreign selected metric",
    (body) => ({
      ...body,
      metric: { ...disabled, id: "documentation" },
      disabledMetrics: [{ ...disabled, id: "documentation" }],
    }),
  ],
  ["different repository scope", (body) => ({ ...body, scope: { ...body.scope, repository: "foreign-repository" } })],
  ["different requested snapshot", (body) => ({ ...body, snapshotId: "foreign-snapshot" })],
  ["different actor filter", (body) => ({ ...body, actorFilter: "user" })],
  ["absent exact metric envelope", (body) => ({ ...body, metric: undefined })],
  ["absent disabled membership", (body) => ({ ...body, disabledMetrics: [] })],
  ["duplicate disabled membership", (body) => ({ ...body, disabledMetrics: [disabled, disabled] })],
  ["different reason binding", (body) => ({ ...body, metric: { ...disabled, reason: "different_reason" } })],
  ["different historical version", (body) => ({ ...body, metric: { ...disabled, policyVersion: "other-version" } })],
  [
    "different historical policy link",
    (body) => ({ ...body, metric: { ...disabled, policyLink: "https://github.com/synthetic-api/example/issues/999" } }),
  ],
  [
    "arbitrary governance prose",
    (body) => ({
      ...body,
      metric: { ...disabled, reason: "SYNTHETIC PRIVATE GOVERNANCE TEXT" },
      disabledMetrics: [{ ...disabled, reason: "SYNTHETIC PRIVATE GOVERNANCE TEXT" }],
    }),
  ],
  ["malformed policy identity", (body) => ({ ...body, metric: { ...disabled, policyVersion: { private: true } } })],
  ["invalid metadata timestamp", (body) => ({ ...body, generatedAt: "2026-02-30T00:00:00Z" })],
];
for (const [name, change] of invalidEnvelopes) {
  test(`disabled board rejects ${name} without retaining policy details`, async (t) => {
    const error = await readFailure(t, change(envelope()));
    assert.equal(error.status, 502);
    assert.equal(error.disabledMetric, undefined);
    assert.ok(!JSON.stringify(error).includes("SYNTHETIC PRIVATE"));
  });
}

for (const [name, options] of [
  ["another endpoint", { path: "health" }],
  ["another HTTP status", { status: 500 }],
  ["no captured board selection", { context: false }],
  ["different actual query", { queryMetric: "documentation" }],
] as const) {
  test(`structured disabled details remain opaque for ${name}`, async (t) => {
    const error = await readFailure(t, envelope(), options);
    assert.equal(error.disabledMetric, undefined);
    assert.equal(error.code, "metric_disabled");
  });
}

test("other error codes never admit a valid-looking disabled policy envelope", async (t) => {
  const error = await readFailure(t, { ...envelope(), error: "public_projection_unavailable" });
  assert.equal(error.code, "public_projection_unavailable");
  assert.equal(error.disabledMetric, undefined);
});

test("legacy disabled error policy fields remain explicitly unavailable", async (t) => {
  const row = { id: disabled.id, reason: disabled.reason };
  const error = await readFailure(t, { ...envelope(), metric: row, disabledMetrics: [row] });
  assert.deepEqual(error.disabledMetric, { ...disabled, policyVersion: null, policyLink: null });
});

test("unsafe historical URLs never become policy anchors or request destinations", async (t) => {
  for (const link of [
    "javascript:alert(1)",
    "https://evil.example/policy",
    "https://user:secret@github.com/synthetic-api/example/issues/1",
    "https://github.com/synthetic-api/example/issues/1?private=value",
    "https://github.com/synthetic-api/example/issues/1#arbitrary-fragment",
    "https://github.com/" + "a".repeat(2100),
  ]) {
    const row = { ...disabled, policyLink: link };
    const error = await readFailure(t, { ...envelope(), metric: row, disabledMetrics: [row] });
    assert.deepEqual(error.disabledMetric, { ...disabled, policyLink: null });
    t.mock.restoreAll();
  }
});

test("cancelled board transport cannot deliver disabled policy details after navigation", async (t) => {
  const controller = new AbortController();
  let release!: (response: Response) => void;
  const pendingResponse = new Promise<Response>((resolve) => {
    release = resolve;
  });
  t.mock.method(globalThis, "fetch", () => pendingResponse);
  const pending = request(
    "https://public.example.invalid/api/v1",
    "boards",
    parameters(selected, { board: true }),
    controller.signal,
    selected,
  );
  const rejected = assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof DOMException);
    assert.equal(error.name, "AbortError");
    return true;
  });
  controller.abort();
  release(new Response(JSON.stringify(envelope()), { status: 503, headers: { "content-type": "application/json" } }));
  await rejected;
});

for (const dimension of ["projects", "roles"] as const) {
  for (const returnedScope of ["original", "mutated"] as const) {
    test(`disabled request keeps captured ${dimension} when the caller mutates them and ${returnedScope} scope returns`, async (t) => {
      const exact = selection("metric=pr_merged&snapshot=public-1&context=current&project=PVT_A&role=author");
      const scope = {
        ...original.scope,
        schemaVersion: "public-scope/v3",
        context: "current",
        projects: ["PVT_A"],
        roles: ["author"],
      };
      const body = {
        ...envelope(),
        schemaVersion: "public-read/v3",
        snapshotSchemaVersion: "leaderboard/v1",
        scope,
      };
      assert.deepEqual(metadata(body, exact).disabledMetrics, [disabled]);
      let release!: (response: Response) => void;
      const transport = new Promise<Response>((resolve) => {
        release = resolve;
      });
      let sent!: URL;
      t.mock.method(globalThis, "fetch", (url: string) => {
        sent = new URL(url);
        return transport;
      });
      const pending = request(
        "https://public.example.invalid/api/v1",
        "boards",
        parameters(exact, { board: true }),
        new AbortController().signal,
        exact,
      );
      assert.equal(sent.searchParams.get("project"), "PVT_A");
      assert.equal(sent.searchParams.get("role"), "author");
      if (dimension === "projects") exact.projects![0] = "PVT_B";
      else exact.roles![0] = "reviewer";
      if (returnedScope === "mutated") scope[dimension][0] = exact[dimension]![0]!;
      const rejected = assert.rejects(pending, (error: unknown) => {
        assert.ok(error instanceof ReadFailure);
        assert.equal(error.status, returnedScope === "original" ? 503 : 502);
        assert.equal(error.code, returnedScope === "original" ? "metric_disabled" : "api_scope_mismatch");
        assert.deepEqual(error.disabledMetric, returnedScope === "original" ? disabled : undefined);
        return true;
      });
      release(
        new Response(JSON.stringify(body), {
          status: 503,
          headers: { "content-type": "application/json" },
        }),
      );
      await rejected;
    });
  }
}
