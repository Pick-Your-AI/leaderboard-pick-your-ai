import assert from "node:assert/strict";
import test from "node:test";
import { createService } from "../dist/app.js";
import { projectRead } from "../dist/public-source.js";
import { readFixture, at } from "../../../tests/fixtures/pending-metric.mjs";

// Synthetic provider output; these tests check public projection, not source acceptance.
const kinds = ["dependency_maintenance", "build_fix", "accepted_bug_fix"];
const codes = (selected) => [
  "maintenance_classification_policy:maintenance-classification/v1",
  ...[...selected].sort().map((k) => "maintenance_kind:" + k),
];
function fixture(selected = kinds) {
  const input = readFixture(),
    proof = input.selected.evidence[0],
    actorId = proof.contribution.actorId;
  proof.artifact.kind = "pull_request";
  proof.contribution.metricIds = ["maintenance"];
  proof.contribution.roles = ["author"];
  proof.contribution.reasonCodes = [
    "independent_recognition_receipt",
    ...codes(selected),
    "PRIVATE_CLASSIFICATION_DETAIL",
  ];
  const row = input.selected.rows.find((r) => r.actorId === actorId);
  row.result.metricId = "maintenance";
  row.result.value = 1;
  row.evidenceIds = [proof.contribution.contributionId];
  delete row.pending;
  input.selected.rows = [row];
  input.selected.actors = input.selected.actors.filter((a) => a.actorId === actorId);
  input.selected.evidence = [proof];
  input.selected.portfolioEvidence = [{ ...structuredClone(proof), activityState: "accepted", observedAt: at }];
  input.selected.pendingEvidence = [];
  input.selected.diagnostics = [];
  input.selected.ranking = [{ metricId: "maintenance", direction: "descending", rank: false }];
  input.selected.methodology[0].metricId = "maintenance";
  return input;
}
test("maintenance public evidence and portfolio keep the same reviewed facets without private detail", async (t) => {
  const input = fixture(),
    before = structuredClone(input),
    out = projectRead(input, input.selected.scope, null);
  assert.deepEqual(out.selected.evidence[0].contribution.reasonCodes, [
    "independent_recognition_receipt",
    ...codes(kinds),
  ]);
  assert.deepEqual(out.selected.portfolioEvidence[0].contribution.reasonCodes, [
    "public_accepted_work",
    ...codes(kinds),
  ]);
  assert.deepEqual(input, before);
  const app = createService({ now: () => Date.parse(at), source: { read: async () => structuredClone(input) } });
  t.after(() => app.close());
  const id = input.selected.evidence[0].contribution.contributionId;
  for (const pin of ["", "snapshot=" + input.head.snapshotId]) {
    for (const route of [
      "boards?metric=maintenance",
      "contributors/101?metric=maintenance",
      "evidence/" + id,
      "exports?metric=maintenance&format=json",
      "exports?metric=maintenance&format=csv",
    ]) {
      const response = await app.inject("/api/v1/" + route + (pin ? (route.includes("?") ? "&" : "?") + pin : ""));
      assert.equal(response.statusCode, 200, response.body);
      assert.doesNotMatch(response.body, /PRIVATE_CLASSIFICATION_DETAIL/);
      if (route.startsWith("evidence/") || route.startsWith("contributors/"))
        for (const code of codes(kinds)) assert.ok(response.body.includes(code), code);
    }
  }
});
for (const [name, mutate] of [
  [
    "missing portfolio class",
    (x) => (x.selected.portfolioEvidence[0].contribution.reasonCodes = ["public_accepted_work"]),
  ],
  [
    "different portfolio class",
    (x) =>
      (x.selected.portfolioEvidence[0].contribution.reasonCodes = ["public_accepted_work", ...codes(["build_fix"])]),
  ],
  ["unsupported kind", (x) => x.selected.evidence[0].contribution.reasonCodes.push("maintenance_kind:green_workflow")],
  ["duplicate kind", (x) => x.selected.evidence[0].contribution.reasonCodes.push("maintenance_kind:build_fix")],
  ["unaccepted portfolio", (x) => (x.selected.portfolioEvidence[0].activityState = "observed")],
]) {
  test("maintenance public " + name + " fails closed for current and pinned reads", async (t) => {
    const input = fixture();
    mutate(input);
    assert.throws(
      () => projectRead(input, input.selected.scope, null),
      /maintenance.classification|public_projection_unavailable/i,
    );
    const app = createService({ now: () => Date.parse(at), source: { read: async () => structuredClone(input) } });
    t.after(() => app.close());
    for (const pin of ["", "&snapshot=" + input.head.snapshotId]) {
      const res = await app.inject("/api/v1/boards?metric=maintenance" + pin);
      assert.equal(res.statusCode, 503, res.body);
      assert.equal(res.headers["cache-control"], "no-store");
      assert.deepEqual(res.json(), { error: "public_projection_unavailable" });
    }
  });
}
test("legacy generic maintenance remains readable with unknown classification", () => {
  const input = fixture();
  input.selected.evidence[0].contribution.reasonCodes = ["independent_recognition_receipt"];
  input.selected.portfolioEvidence[0].contribution.reasonCodes = ["public_accepted_work"];
  const out = projectRead(input, input.selected.scope, null);
  assert.deepEqual(out.selected.evidence[0].contribution.reasonCodes, ["independent_recognition_receipt"]);
  assert.deepEqual(out.selected.portfolioEvidence[0].contribution.reasonCodes, ["public_accepted_work"]);
});
