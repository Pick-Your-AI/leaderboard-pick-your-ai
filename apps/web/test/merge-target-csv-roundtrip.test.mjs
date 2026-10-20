import assert from "node:assert/strict";
import test from "node:test";
import { createService } from "../../service/dist/app.js";
import { canonicalPublicScope, publicScopeParameters } from "@pick-your-ai/contracts";
import { legacyScope, scopeFixture } from "../../../tests/fixtures/public-scope.mjs";
import { selection, validateExport, board } from "../src/remote/client.ts";
import { parseCSVExport } from "../src/remote/csv-export.ts";

for (const branch of [
  "release/Δ=1",
  "=main",
  "'=main",
  "+main",
  "'+main",
  "@main",
  "'@main",
  "'plain",
  "''=main",
  "'''=main",
]) {
  test(`v5 service CSV preserves the exact merge target ${JSON.stringify(branch)}`, async (t) => {
    const scope = canonicalPublicScope({ ...legacyScope, repository: "2", branch });
    const read = scopeFixture(scope);
    const app = createService({
      source: {
        async read() {
          return structuredClone(read);
        },
      },
    });
    t.after(() => app.close());
    const query = new URLSearchParams({ ...publicScopeParameters(scope), metric: "pr_merged" });
    const raw = await app.inject(`/api/v1/boards?${query}`);
    assert.equal(raw.statusCode, 200, raw.body);
    query.set("snapshot", raw.json().snapshotId);
    const selected = selection(`?${query}`);
    const metric = board(raw.json(), selected).metric;
    const json = await app.inject(`/api/v1/exports?${query}`);
    assert.equal(json.statusCode, 200, json.body);
    assert.deepEqual(json.json().scope, scope);
    assert.doesNotThrow(() => validateExport(json.json(), selected, metric));
    query.set("format", "csv");
    const csv = await app.inject(`/api/v1/exports?${query}`);
    assert.equal(csv.statusCode, 200, csv.body);
    const parsed = parseCSVExport(csv.body, metric, 50);
    assert.equal(parsed.exportSchemaVersion, "public-export/v5");
    assert.equal(parsed.scope.branch, branch);
    assert.deepEqual(parsed.scope, scope);
    assert.doesNotThrow(() => validateExport(parsed, selected, metric));
  });
}

test("v5 branch CSV rejects an unescaped literal-apostrophe alias", async (t) => {
  const scope = canonicalPublicScope({ ...legacyScope, repository: "2", branch: "'plain" });
  const read = scopeFixture(scope);
  const app = createService({
    source: {
      async read() {
        return structuredClone(read);
      },
    },
  });
  t.after(() => app.close());
  const query = new URLSearchParams({ ...publicScopeParameters(scope), metric: "pr_merged" });
  const raw = await app.inject(`/api/v1/boards?${query}`);
  assert.equal(raw.statusCode, 200, raw.body);
  const selected = selection(`?${query}`);
  const metric = board(raw.json(), selected).metric;
  query.set("format", "csv");
  const csv = await app.inject(`/api/v1/exports?${query}`);
  assert.equal(csv.statusCode, 200, csv.body);
  assert.doesNotThrow(() => parseCSVExport(csv.body, metric, 50));
  const aliased = csv.body.replaceAll("\"''plain\"", '"\'plain"');
  assert.notEqual(aliased, csv.body);
  assert.throws(() => parseCSVExport(aliased, metric, 50), /invalid_export_csv/);
});
