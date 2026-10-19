import test from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { createService } from "../dist/app.js";
import {
  canonicalPublicScope,
  parsePublicWindows,
  publicContributionRoles,
  publicScopeParameters,
  publicWindowPeriods,
} from "../../../packages/contracts/dist/index.js";
import { resolveMetricWindow } from "../../../packages/metrics/dist/index.js";
import { legacyScope, scopeFixture } from "../../../tests/fixtures/public-scope.mjs";

const cutoff = "2026-10-18T12:00:00.000Z";
const filter = canonicalPublicScope({
  ...legacyScope,
  context: "current",
  projects: ["PVT_A", "PVT_B="],
  roles: ["author"],
});
const params = (scope = filter) => new URLSearchParams(publicScopeParameters(scope));
function choices(scope = filter) {
  return {
    scope: structuredClone(scope),
    windows: publicWindowPeriods.map((period) => {
      const window = resolveMetricWindow(period, cutoff);
      const selected = { ...structuredClone(scope), start: window.from, end: period === "all" ? null : window.to };
      return { period, read: scopeFixture(selected) };
    }),
  };
}
function harness(t, provider = async () => choices(), options = {}) {
  let ordinary = 0;
  const calls = [];
  const app = createService({
    ...options,
    source: {
      async read() {
        ordinary++;
        throw new Error("Discovery must not guess a data scope");
      },
      async readWindows(scope, signal) {
        calls.push({ scope: structuredClone(scope), signal });
        return provider(scope, signal);
      },
    },
  });
  t.after(() => app.close());
  return { app, calls, ordinary: () => ordinary };
}
const url = (scope = filter) => "/api/v1/windows?" + params(scope);

async function overHTTP(app, target) {
  await app.listen({ host: "127.0.0.1", port: 0 });
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: app.server.address().port,
        path: target,
        method: "GET",
        headers: { Connection: "close" },
        agent: false,
        timeout: 5_000,
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("error", reject);
        response.on("end", () =>
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("synthetic_window_http_timeout")));
    req.end();
  });
}

test("published windows expose only exact public choices, with a fresh no-store response", async (t) => {
  const privateValue = choices();
  privateValue.privateProof = "synthetic-private-never-serialize";
  privateValue.windows[0].read.privateCredential = "synthetic-private-never-serialize";
  const h = harness(t, async () => structuredClone(privateValue));
  const response = await h.app.inject({ url: url(), headers: { "if-none-match": "*" } });
  assert.equal(response.statusCode, 200, response.body);
  const value = response.json();
  assert.deepEqual(Object.keys(value).sort(), ["schemaVersion", "scope", "windows"]);
  assert.equal(value.schemaVersion, "public-windows/v1");
  assert.deepEqual(value.scope, filter);
  assert.deepEqual(
    value.windows.map((w) => w.period),
    publicWindowPeriods,
  );
  for (const window of value.windows)
    assert.deepEqual(Object.keys(window).sort(), ["period", "revision", "scope", "snapshotId"]);
  assert.equal(value.windows[3].snapshotId, value.windows[4].snapshotId);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(response.headers.etag, undefined);
  assert.doesNotMatch(response.body, /synthetic-private|controls|actors|coverage|generatedAt/);
  assert.equal(h.ordinary(), 0);
  const root = await h.app.inject("/api/v1");
  assert.ok(root.json().endpoints.includes("windows"));
});

test("legacy and canonical current/role filters retain their exact identities", async (t) => {
  for (const scope of [legacyScope, canonicalPublicScope({ ...legacyScope, context: "current" }), filter]) {
    const h = harness(t, async (received) => choices(received));
    const response = await h.app.inject(url(scope));
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json().scope, scope);
    assert.deepEqual(h.calls[0].scope, scope);
  }
});

test("dates, pins, pagination, actor/metric/UI and comparison selectors fail before provider access", async (t) => {
  const h = harness(t);
  for (const extra of [
    "start=2026-10-01T00:00:00.000Z",
    "end=2026-10-18T00:00:00.000Z",
    "snapshot=old",
    "cursor=old",
    "actors=all",
    "metric=pr_merged",
    "ui=api",
    "compare=old",
    "compareStart=2026-10-01T00:00:00.000Z",
    "limit=1",
    "format=json",
    "search=alice",
    "category=pr_merged",
    "period=30d",
    "unknown=x",
    "organization=Other",
    "role=author",
    "context=event",
  ]) {
    const response = await h.app.inject(url() + "&" + extra);
    assert.equal(response.statusCode, 400, response.body);
  }
  assert.equal(h.calls.length, 0);
  assert.equal(h.ordinary(), 0);
});

for (const roles of [[], publicContributionRoles])
  test(`maximum-width ${roles.length ? "v3" : "v2"} discovery retains 100 Projects and all choices over real HTTP`, async (t) => {
    const scope = canonicalPublicScope({
      organization: ":".repeat(200),
      repository: ":".repeat(200),
      workstream: ":".repeat(200),
      start: null,
      end: null,
      context: "current",
      // Every character needs three URL bytes. Seven punctuation bits make
      // exactly 100 distinct, legal, maximum-length native Project identifiers.
      projects: Array.from(
        { length: 100 },
        (_, index) => "=".repeat(121) + index.toString(2).padStart(7, "0").replaceAll("0", "=").replaceAll("1", ":"),
      ),
      ...(roles.length ? { roles } : {}),
    });
    assert.equal(new Set(scope.projects).size, 100);
    assert.ok(scope.projects.every((id) => id.length === 128 && /^[=:]+$/.test(id)));
    const publication = choices(scope);
    for (const { read } of publication.windows) {
      for (const entry of [...read.selected.evidence, ...read.selected.pendingEvidence])
        entry.artifact.repositoryId = scope.repository;
      for (const coverage of [
        ...read.selected.snapshot.coverage,
        ...read.selected.rows.map((row) => row.result.coverage),
      ])
        coverage.scopeId = scope.repository;
    }
    const h = harness(t, async () => structuredClone(publication));
    const target = url(scope);
    assert.ok(target.length > 40_000 && target.length < 48 * 1024, target.length);
    assert.equal(Buffer.byteLength(target), target.length);
    const response = await overHTTP(h.app, target);
    assert.equal(response.status, 200, response.body);
    assert.equal(response.headers["cache-control"], "no-store");
    const body = JSON.parse(response.body);
    assert.deepEqual(parsePublicWindows(body, scope, resolveMetricWindow), body);
    assert.deepEqual(body.scope, scope);
    assert.deepEqual(
      body.windows.map((choice) => choice.period),
      publicWindowPeriods,
    );
    for (const [index, choice] of body.windows.entries()) {
      assert.deepEqual(choice.scope, publication.windows[index].read.selected.scope);
      assert.equal(choice.snapshotId, publication.windows[index].read.head.snapshotId);
      assert.equal(choice.revision, publication.windows[index].read.head.revision);
    }
    assert.ok(Buffer.byteLength(response.body) < 2_000_000);
    assert.deepEqual(
      h.calls.map((call) => call.scope),
      [scope],
    );
    assert.equal(h.ordinary(), 0);
  });

test("the complete 48 KiB discovery target limit rejects before source work over injection and real HTTP", async (t) => {
  const h = harness(t);
  const query = params();
  query.set("project", "x".repeat(48 * 1024));
  const target = "/api/v1/windows?" + query;
  assert.ok(target.length > 48 * 1024 && target.length < 66_560);
  assert.equal((await h.app.inject(target)).statusCode, 414);
  assert.equal((await overHTTP(h.app, target)).status, 414);
  assert.equal(h.calls.length, 0);
  assert.equal(h.ordinary(), 0);
});

test("absent or unavailable discovery never falls back; an authorized empty menu stays empty", async (t) => {
  const absent = createService({
    source: {
      async read() {
        throw new Error("Do not fall back");
      },
    },
  });
  t.after(() => absent.close());
  assert.equal((await absent.inject(url())).statusCode, 503);
  const unavailable = harness(t, async () => null);
  assert.equal((await unavailable.app.inject(url())).statusCode, 503);
  assert.equal(unavailable.ordinary(), 0);
  const empty = harness(t, async () => ({ scope: filter, windows: [] }));
  const response = await empty.app.inject(url());
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json().windows, []);
  assert.equal(empty.ordinary(), 0);
});

test("a provider cannot mutate the requested Project/role authority or return broader choices", async (t) => {
  for (const mutate of [
    (s) => {
      s.projects = [];
    },
    (s) => {
      s.roles = ["reviewer"];
    },
    (s) => {
      s.organization = "Other";
    },
  ]) {
    const h = harness(t, async (scope) => {
      mutate(scope);
      return choices(scope);
    });
    assert.equal((await h.app.inject(url())).statusCode, 503);
  }
});

test("every menu item must be a valid current projection under the same privacy authority", async (t) => {
  for (const mutate of [
    (v) => {
      v.windows[0].read.head.revision++;
    },
    (v) => {
      v.windows[0].read.head.snapshotId = "synthetic-newer";
    },
    (v) => {
      v.windows[0].read.selected.approvedPublic = false;
    },
    (v) => {
      v.windows[0].read.controls.version = "synthetic-other-controls";
    },
    (v) => {
      v.windows[0].read.controls.suppressedActorIds = ["101"];
    },
    (v) => {
      v.windows[0].read.controls.suppressedArtifactIds = ["synthetic-artifact"];
    },
    (v) => {
      v.windows[0].read.controls.revokedSnapshotIds = ["synthetic-unrelated"];
    },
    (v) => {
      const selected = v.windows[0].read.selected;
      selected.portfolioEvidence = [
        { ...structuredClone(selected.evidence[0]), activityState: "accepted", observedAt: cutoff },
      ];
      selected.portfolioEvidence[0].contribution.actorId = "102";
    },
  ]) {
    const value = choices();
    mutate(value);
    const h = harness(t, async () => value);
    const response = await h.app.inject(url());
    assert.equal(response.statusCode, 503, response.body);
    assert.equal(response.headers["cache-control"], "no-store");
    assert.equal(response.json().windows, undefined);
  }
});

test("revocation, registry mismatch and malformed alias identity cannot publish a partial menu", async (t) => {
  for (const [mutate, status] of [
    [
      (v) => {
        v.windows[0].read.controls.revokedSnapshotIds.push(v.windows[0].read.selected.snapshot.snapshotId);
      },
      410,
    ],
    [
      (v) => {
        v.windows[0].read.selected.snapshot.metricDefinitionVersion = "synthetic-other-policy";
      },
      409,
    ],
    [
      (v) => {
        v.windows[4].read.selected.snapshot.snapshotId = "synthetic-conflicting-alias";
      },
      503,
    ],
    [
      (v) => {
        v.windows[0].read.selected.scope.start = "2026-10-10T12:00:00.000Z";
      },
      503,
    ],
  ]) {
    const value = choices();
    mutate(value);
    const h = harness(t, async () => value);
    const response = await h.app.inject(url());
    assert.equal(response.statusCode, status, response.body);
    assert.equal(response.json().windows, undefined);
  }
});

test("discovery retains a read-budget slot until a canceled provider actually settles", async (t) => {
  let release, signal;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const h = harness(
    t,
    async (_scope, selectedSignal) => {
      signal = selectedSignal;
      return held;
    },
    { sourceTimeoutMs: 5, maxConcurrentReads: 1 },
  );
  const first = await h.app.inject(url());
  assert.equal(first.statusCode, 503);
  assert.equal(first.json().error, "snapshot_source_timeout");
  assert.equal(signal.aborted, true);
  assert.equal((await h.app.inject(url())).statusCode, 429);
  release({ scope: filter, windows: [] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await h.app.inject(url())).statusCode, 200);
});
