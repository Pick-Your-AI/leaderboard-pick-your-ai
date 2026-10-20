import assert from "node:assert/strict";
import test from "node:test";
import { createService } from "../../service/dist/app.js";
import { canonicalPublicScope, publicScopeParameters } from "@pick-your-ai/contracts";
import { legacyScope, scopeFixture } from "../../../tests/fixtures/public-scope.mjs";
import { selection, parameters, uiHref, metadata, validateExport, board } from "../src/remote/client.ts";
import { parseCSVExport } from "../src/remote/csv-export.ts";
import { proofHref } from "../src/remote/proof.ts";

const scope = canonicalPublicScope({ ...legacyScope, repository: "2", branch: "release/Δ=1" });
const query = (extra = {}) => new URLSearchParams({ ...publicScopeParameters(scope), metric: "pr_merged", ...extra });
test("selected target names round-trip exactly through navigation and proof URLs without current-branch inference", () => {
  const selected = selection(`?${query({ snapshot: "snapshot-1" })}`);
  assert.equal(selected.schemaVersion, "public-scope/v4");
  assert.equal(parameters(selected).get("branch"), scope.branch);
  for (const href of [uiHref("/contributors", selected), proofHref("/leaderboards/pr_merged", selected, "proof-1")]) {
    const url = new URL(href, "https://synthetic.invalid");
    assert.equal(url.searchParams.get("branch"), scope.branch);
    assert.equal(selection(url.search).branch, scope.branch);
  }
  assert.equal(selection("?repository=2&branch=main").metric, "pr_merged");
  for (const raw of [
    "metric=pr_ready&repository=2&branch=main",
    "metric=pr_accepted_rate&repository=2&branch=main",
    "metric=pr_merged&branch=main",
    "repository=2&branch=%FF",
    "repository=2&branch=%ED%A0%80",
    "repository=2&branch=%",
    "repository=2&branch=main&branch=other",
  ])
    assert.throws(() => selection(`?${raw}`));
});
test("actual v5 service exports are accepted only with the exact branch, version and selected snapshot", async (t) => {
  const read = scopeFixture(scope);
  const app = createService({
    source: {
      async read() {
        return structuredClone(read);
      },
    },
  });
  t.after(() => app.close());
  const raw = await app.inject(`/api/v1/boards?${query()}`);
  assert.equal(raw.statusCode, 200, raw.body);
  const selected = selection(`?${query({ snapshot: raw.json().snapshotId })}`);
  const metric = board(raw.json(), selected).metric;
  assert.deepEqual(metadata(raw.json(), selected).scope, scope);
  const json = await app.inject(`/api/v1/exports?${query({ snapshot: selected.snapshot })}`);
  assert.equal(json.statusCode, 200, json.body);
  assert.equal(json.json().exportSchemaVersion, "public-export/v5");
  assert.doesNotThrow(() => validateExport(json.json(), selected, metric));
  const csv = await app.inject(`/api/v1/exports?${query({ snapshot: selected.snapshot, format: "csv" })}`);
  assert.equal(csv.statusCode, 200, csv.body);
  const parsed = parseCSVExport(csv.body, metric, 50);
  assert.deepEqual(parsed.scope, scope);
  assert.doesNotThrow(() => validateExport(parsed, selected, metric));
  for (const change of [
    (body) => {
      body.scope.branch = "release/other";
    },
    (body) => {
      delete body.scope.branch;
    },
    (body) => {
      body.exportSchemaVersion = "public-export/v4";
    },
    (body) => {
      body.scope.schemaVersion = "public-scope/v3";
    },
  ]) {
    const invalid = json.json();
    change(invalid);
    assert.throws(() => validateExport(invalid, selected, metric));
  }
  assert.throws(() =>
    validateExport(
      parseCSVExport(csv.body.replaceAll('"release/Δ=1"', '"release/other"'), metric, 50),
      selected,
      metric,
    ),
  );
});
