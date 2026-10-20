import assert from "node:assert/strict";
import test from "node:test";
import { createService } from "../dist/app.js";
import { canonicalPublicScope, publicScopeParameters } from "@pick-your-ai/contracts";
import { legacyScope, scopeFixture } from "../../../tests/fixtures/public-scope.mjs";

const scope = canonicalPublicScope({ ...legacyScope, repository: "2", branch: "release/one" });
const query = (extra = {}) => new URLSearchParams({ ...publicScopeParameters(scope), metric: "pr_merged", ...extra });
function fixture(t, change = (read) => read) {
  const calls = [],
    read = change(scopeFixture(scope));
  const app = createService({
    source: {
      async read(selected, pin) {
        calls.push({ selected, pin });
        return structuredClone(read);
      },
    },
  });
  t.after(() => app.close());
  return { app, calls, read };
}
test("merge branch selection, JSON/CSV exports and cards bind the historical target and snapshot", async (t) => {
  const h = fixture(t);
  const board = await h.app.inject(`/api/v1/boards?${query({ limit: "1" })}`);
  assert.equal(board.statusCode, 200, board.body);
  assert.equal(board.json().schemaVersion, "public-read/v4");
  assert.deepEqual(board.json().scope, scope);
  assert.equal(new URL(board.json().shareUrl, "https://fixture.invalid").searchParams.get("branch"), scope.branch);
  const exported = await h.app.inject(`/api/v1/exports?${query({ snapshot: board.json().snapshotId })}`);
  assert.equal(exported.statusCode, 200, exported.body);
  assert.equal(exported.json().exportSchemaVersion, "public-export/v5");
  assert.deepEqual(exported.json().scope, scope);
  const csv = await h.app.inject(`/api/v1/exports?${query({ format: "csv" })}`);
  assert.equal(csv.statusCode, 200, csv.body);
  assert.match(csv.body, /"branch"/);
  assert.match(csv.body, /"release\/one"/);
  const card = await h.app.inject(`/api/v1/cards/101?${query()}`);
  assert.equal(card.statusCode, 200, card.body);
  assert.match(card.body, /Merge target at merge/);
  const cursor = board.json().nextCursor,
    before = h.calls.length;
  const changed = await h.app.inject(`/api/v1/boards?${query({ cursor, limit: "1", branch: "release/two" })}`);
  assert.equal(changed.statusCode, 400);
  assert.equal(changed.json().error, "cursor_scope_mismatch");
  assert.equal(h.calls.length, before);
});
test("unsupported clocks and malformed target transport fail before reading the provider", async (t) => {
  const h = fixture(t);
  for (const metric of ["pr_opened", "pr_ready", "pr_accepted_rate", "reverted_delivery", "pr_lines_added"]) {
    const response = await h.app.inject(`/api/v1/boards?${query({ metric })}`);
    assert.equal(response.statusCode, 400, response.body);
    assert.equal(response.json().error, "unsupported_merge_target_metric");
  }
  for (const tail of [
    "branch=",
    "branch=main&branch=other",
    "branch=%FF",
    "branch=%ED%A0%80",
    "branch=%",
    "branch=a%00b",
    "branch=../main",
  ]) {
    const response = await h.app.inject(`/api/v1/boards?metric=pr_merged&repository=2&${tail}`);
    assert.equal(response.statusCode, 400, response.body);
  }
  assert.equal((await h.app.inject("/api/v1/boards?metric=pr_merged&branch=main")).statusCode, 400);
  assert.equal(h.calls.length, 0);
});
test("a provider cannot relabel a branch or fall back to a legacy scope even with identical original fields", async (t) => {
  for (const mutate of [
    (value) => {
      value.branch = "release/two";
    },
    (value) => {
      delete value.branch;
    },
    (value) => {
      delete value.roles;
    },
    (value) => {
      value.schemaVersion = "public-scope/v3";
    },
  ]) {
    const h = fixture(t, (read) => {
      mutate(read.selected.scope);
      return read;
    });
    const response = await h.app.inject(`/api/v1/boards?${query()}`);
    assert.equal(response.statusCode, 503, response.body);
  }
});
