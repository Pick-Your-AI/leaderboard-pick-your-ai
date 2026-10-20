import assert from "node:assert/strict";
import test from "node:test";
import { createService } from "../dist/app.js";
import {
  canonicalPublicScope,
  parsePublicWindows,
  publicScopeParameters,
  publicWindowPeriods,
} from "@pick-your-ai/contracts";
import { resolveMetricWindow } from "@pick-your-ai/metrics";
import { legacyScope, scopeFixture } from "../../../tests/fixtures/public-scope.mjs";

// Synthetic published projections; this does not collect or authorize GitHub data.
const cutoff = "2026-10-18T12:00:00.000Z";
const branchScope = (branch = "release/Δ=1") =>
  canonicalPublicScope({
    ...legacyScope,
    repository: "2",
    context: "current",
    projects: ["PVT_A", "PVT_B="],
    roles: ["author"],
    branch,
  });
function choices(scope) {
  return {
    scope: structuredClone(scope),
    windows: publicWindowPeriods.map((period) => {
      const bounds = resolveMetricWindow(period, cutoff);
      return {
        period,
        read: scopeFixture({
          ...structuredClone(scope),
          start: bounds.from,
          end: period === "all" ? null : bounds.to,
        }),
      };
    }),
  };
}
function fixture(t, provider = choices) {
  const calls = [];
  let ordinary = 0;
  const app = createService({
    source: {
      async read() {
        ordinary++;
        throw new Error("Discovery must not infer a data publication");
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
const url = (scope) => "/api/v1/windows?" + new URLSearchParams(publicScopeParameters(scope));

test("published-window discovery binds exact case-sensitive merge targets and complete public choices", async (t) => {
  const h = fixture(t);
  const scopes = [branchScope("release/Δ=1"), branchScope("release/δ=1")];
  const snapshotIds = [];
  for (const scope of scopes) {
    const before = structuredClone(scope);
    const expected = choices(scope);
    const response = await h.app.inject({ url: url(scope), headers: { "if-none-match": "*" } });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.headers["cache-control"], "no-store");
    assert.equal(response.headers.etag, undefined);
    const value = response.json();
    assert.deepEqual(parsePublicWindows(value, scope, resolveMetricWindow), value);
    assert.deepEqual(value.scope, scope);
    assert.equal(value.scope.schemaVersion, "public-scope/v4");
    assert.deepEqual(
      value.windows.map((entry) => entry.period),
      publicWindowPeriods,
    );
    for (const [index, entry] of value.windows.entries()) {
      assert.deepEqual(entry.scope, expected.windows[index].read.selected.scope);
      assert.equal(entry.scope.branch, scope.branch);
      assert.equal(entry.snapshotId, expected.windows[index].read.head.snapshotId);
      assert.equal(entry.revision, expected.windows[index].read.head.revision);
    }
    snapshotIds.push(value.windows[0].snapshotId);
    assert.deepEqual(scope, before);
  }
  assert.notEqual(snapshotIds[0], snapshotIds[1]);
  assert.deepEqual(
    h.calls.map((call) => call.scope),
    scopes,
  );
  assert.ok(h.calls.every((call) => call.signal instanceof AbortSignal));
  assert.equal(h.ordinary(), 0);
});

test("branch-window discovery rejects malformed, repository-free and non-discovery selectors before provider work", async (t) => {
  const h = fixture(t);
  for (const [tail, error] of [
    ["branch=", "invalid_public_scope"],
    ["branch=main&branch=other", "invalid_window_query"],
    ["branch=%FF", "invalid_merge_target_branch"],
    ["branch=%ED%A0%80", "invalid_merge_target_branch"],
    ["branch=%", "invalid_merge_target_branch"],
    ["branch=a%00b", "invalid_public_scope"],
    ["branch=../main", "invalid_public_scope"],
    ["branch=main&metric=pr_merged", "invalid_window_query"],
    ["branch=main&start=2026-10-01T00%3A00%3A00.000Z", "invalid_window_query"],
  ]) {
    const response = await h.app.inject("/api/v1/windows?repository=2&" + tail);
    assert.equal(response.statusCode, 400, response.body);
    assert.equal(response.json().error, error);
  }
  const missingRepository = await h.app.inject("/api/v1/windows?branch=main");
  assert.equal(missingRepository.statusCode, 400, missingRepository.body);
  assert.equal(missingRepository.json().error, "invalid_public_scope");
  assert.equal(h.calls.length, 0);
  assert.equal(h.ordinary(), 0);
});

test("a discovery provider cannot replace, omit or mutate the requested merge-target authority", async (t) => {
  const scope = branchScope();
  const before = structuredClone(scope);
  for (const provider of [
    (requested) => choices({ ...requested, branch: "release/other" }),
    (requested) => {
      const value = choices(requested);
      delete value.scope.branch;
      return value;
    },
    (requested) => {
      const value = choices(requested);
      value.windows[0].read.selected.scope.branch = "release/other";
      return value;
    },
    (requested) => {
      const value = choices(requested);
      delete value.windows[0].read.selected.scope.branch;
      return value;
    },
    (requested) => {
      requested.branch = "release/other";
      return choices(requested);
    },
  ]) {
    const h = fixture(t, provider);
    const response = await h.app.inject(url(scope));
    assert.equal(response.statusCode, 503, response.body);
    assert.equal(response.headers["cache-control"], "no-store");
    assert.equal(response.json().scope, undefined);
    assert.equal(response.json().windows, undefined);
    assert.deepEqual(
      h.calls.map((call) => call.scope),
      [scope],
    );
    assert.equal(h.ordinary(), 0);
    assert.deepEqual(scope, before);
  }
});
