import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  canonicalPublicScope,
  publicContributionRoles,
  publicScopeKey,
  publicScopeParameters,
} from "@pick-your-ai/contracts";
import { createService } from "../../service/dist/app.js";
import { scopeFixture } from "../../../tests/fixtures/public-scope.mjs";
import { exportPage, health, liveParameters, parameters, request, selection } from "../src/remote/client.ts";
import { selectionScope } from "../src/remote/public-scope.ts";

const targetLimit = 48 * 1024;
function maximalScope(roles, encoded = false) {
  return canonicalPublicScope({
    organization: (encoded ? ":" : "O").repeat(200),
    repository: (encoded ? ":" : "R").repeat(200),
    workstream: (encoded ? ":" : "W").repeat(200),
    start: "2026-01-01T00:00:00.000Z",
    end: "2026-12-31T23:59:59.000Z",
    context: "current",
    projects: Array.from({ length: 100 }, (_, index) =>
      encoded
        ? ":".repeat(121) + index.toString(2).padStart(7, "0").replaceAll("0", ":").replaceAll("1", "=")
        : createHash("sha512").update(`SYNTHETIC_BROWSER_SCOPE_${index}`).digest("hex"),
    ),
    ...(roles ? { roles: publicContributionRoles } : {}),
  });
}
function harness(t, scope) {
  const read = scopeFixture(scope);
  const calls = [];
  const app = createService({
    source: {
      async read(requested, pin) {
        calls.push({ scope: structuredClone(requested), pin });
        return structuredClone(read);
      },
    },
  });
  t.after(() => app.close());
  const fetches = [];
  t.mock.method(globalThis, "fetch", async (raw, options) => {
    const url = new URL(raw);
    assert.equal(url.origin, "https://synthetic.invalid");
    assert.equal(options.credentials, "omit");
    assert.equal(options.cache, "no-store");
    assert.equal(options.redirect, "error");
    assert.ok(options.signal instanceof AbortSignal);
    const target = url.pathname + url.search;
    assert.ok(Buffer.byteLength(target) <= targetLimit);
    fetches.push(url);
    const response = await app.inject(target);
    return new Response(response.body, { status: response.statusCode, headers: response.headers });
  });
  return { app, read, calls, fetches };
}

for (const [label, scope] of [
  ["v2", maximalScope(false)],
  ["v3", maximalScope(true)],
  ["percent-encoded v3", maximalScope(true, true)],
]) {
  test(`browser scope capacity admits a complete 100-Project ${label} service read`, async (t) => {
    const original = structuredClone(scope);
    const h = harness(t, scope);
    const encoded = new URLSearchParams(publicScopeParameters(scope));
    const query = "?" + encoded;
    assert.ok(query.length > 4096);
    if (label === "percent-encoded v3") assert.ok(query.length > 39 * 1024);
    assert.ok(Buffer.byteLength("/api/v1/health" + query) < targetLimit);

    // Establish the actual server admission independently of the browser parser.
    const direct = await h.app.inject("/api/v1/health" + query);
    assert.equal(direct.statusCode, 200, direct.body);
    assert.deepEqual(direct.json().scope, scope);

    const selected = selection(query);
    assert.equal(publicScopeKey(selectionScope(selected)), publicScopeKey(scope));
    assert.equal(parameters(selected).toString(), encoded.toString());
    assert.equal(liveParameters("https://synthetic.invalid/api/v1", selected).toString(), encoded.toString());
    const response = await request(
      "https://synthetic.invalid/api/v1",
      "health",
      parameters(selected),
      new AbortController().signal,
    );
    assert.deepEqual(health(response, selected).scope, scope);
    assert.equal(h.fetches.length, 1);
    assert.equal(h.fetches[0].search, query);
    assert.ok(h.calls.length >= 2);
    assert.ok(h.calls.every((call) => publicScopeKey(call.scope) === publicScopeKey(scope)));
    assert.deepEqual(scope, original);
  });
}

test("browser scope capacity preserves a large displayed pin through actual JSON and CSV exports", async (t) => {
  const scope = maximalScope(true, true);
  const h = harness(t, scope);
  // Bypass selection only here so its admission cannot hide an export-preflight defect.
  const selected = { ...selection("?metric=pr_merged"), ...scope, snapshot: h.read.head.snapshotId };
  const boardParams = parameters(selected, { board: true });
  const displayed = await h.app.inject("/api/v1/boards?" + boardParams);
  assert.equal(displayed.statusCode, 200, displayed.body);
  const metric = displayed.json().metric;
  for (const format of ["json", "csv"]) {
    const blob = await exportPage(
      "https://synthetic.invalid/api/v1",
      selected,
      format,
      new AbortController().signal,
      metric,
    );
    assert.ok(blob.size > 0);
    const url = h.fetches.at(-1);
    assert.equal(url.pathname, "/api/v1/exports");
    assert.equal(url.searchParams.get("snapshot"), selected.snapshot);
    assert.equal(url.searchParams.get("project"), scope.projects.join(","));
    assert.equal(url.searchParams.get("role"), scope.roles.join(","));
    assert.equal(url.searchParams.get("format"), format);
  }
  assert.equal(h.fetches.length, 2);
  assert.ok(h.calls.every((call) => call.pin === selected.snapshot));
});

test("browser request capacity admits the complete 48 KiB target and rejects its next byte before fetch", async (t) => {
  const params = new URLSearchParams({ organization: "Pick-Your-AI" });
  const suffix = "/health?" + params;
  const base = "https://synthetic.invalid/" + "a".repeat(targetLimit - 1 - suffix.length);
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (raw, options) => {
    calls++;
    const url = new URL(raw);
    assert.equal(Buffer.byteLength(url.pathname + url.search), targetLimit);
    assert.equal(options.credentials, "omit");
    return new Response('{"synthetic":true}', { headers: { "content-type": "application/json" } });
  });
  assert.deepEqual(await request(base, "health", params, new AbortController().signal), { synthetic: true });
  assert.equal(calls, 1);
  await assert.rejects(() => request(base + "a", "health", params, new AbortController().signal), {
    status: 414,
    code: "query_too_large",
  });
  assert.equal(calls, 1);
});
