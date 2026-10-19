import test from "node:test";
import assert from "node:assert/strict";
import { createService } from "../dist/app.js";
import { projectRead } from "../dist/public-source.js";
import { publicDocumentationRecognitionReasons } from "@pick-your-ai/contracts";
import { readFixture, at } from "../../../tests/fixtures/pending-metric.mjs";
import {
  notesDomainReasons,
  notesPurpose,
  notesPathReason,
  notesRevision,
  notesMergeTime,
} from "../../../tests/fixtures/authored-release-notes.mjs";

// Synthetic provider output tests public boundaries, never source/reviewer authority.
const reasonCodes = ["independent_recognition_receipt", ...notesDomainReasons, notesPurpose, notesPathReason];
function fixture() {
  const input = readFixture(),
    proof = input.selected.evidence[0],
    actorId = proof.contribution.actorId;
  proof.contribution.metricIds = ["documentation"];
  proof.contribution.roles = ["author"];
  proof.contribution.reasonCodes = [...reasonCodes, "PRIVATE_NOTES_DETAIL"];
  proof.sourceRevision = notesRevision;
  proof.sourceRevisionUrl = "https://github.com/synthetic-org/synthetic-repo/commit/" + notesRevision;
  proof.occurredAt = notesMergeTime;
  const row = input.selected.rows.find((x) => x.actorId === actorId);
  row.result.metricId = "documentation";
  row.result.value = 1;
  row.evidenceIds = [proof.contribution.contributionId];
  delete row.pending;
  input.selected.rows = [row];
  input.selected.actors = input.selected.actors.filter((x) => x.actorId === actorId);
  input.selected.evidence = [proof];
  input.selected.portfolioEvidence = [{ ...structuredClone(proof), activityState: "accepted", observedAt: at }];
  input.selected.pendingEvidence = [];
  input.selected.diagnostics = [];
  input.selected.ranking = [{ metricId: "documentation", direction: "descending", rank: false }];
  input.selected.methodology[0].metricId = "documentation";
  return input;
}
test("authored notes public explanation: complete accepted purpose is fixed and private strings are discarded", () => {
  assert.deepEqual(
    publicDocumentationRecognitionReasons({
      metricIds: ["documentation"],
      reasonCodes: [...reasonCodes, "PRIVATE_NOTES_DETAIL"],
    }),
    [...notesDomainReasons, notesPurpose],
  );
  assert.deepEqual(
    publicDocumentationRecognitionReasons({
      metricIds: ["documentation"],
      reasonCodes: reasonCodes.filter((x) => x !== notesPurpose),
    }),
    notesDomainReasons,
  );
});
test("authored notes current and pinned public APIs retain identical purpose and immutable source", async (t) => {
  const input = fixture(),
    before = structuredClone(input);
  const projected = projectRead(input, input.selected.scope, null);
  assert.ok(projected.selected.evidence[0].contribution.reasonCodes.includes(notesPurpose));
  assert.ok(projected.selected.portfolioEvidence[0].contribution.reasonCodes.includes(notesPurpose));
  assert.deepEqual(input, before);
  const app = createService({ now: () => Date.parse(at), source: { read: async () => structuredClone(input) } });
  t.after(() => app.close());
  const id = input.selected.evidence[0].contribution.contributionId;
  for (const pin of ["", "snapshot=" + input.head.snapshotId])
    for (const route of [
      "boards?metric=documentation",
      "contributors/101?metric=documentation",
      "evidence/" + id,
      "exports?metric=documentation&format=json",
      "exports?metric=documentation&format=csv",
    ]) {
      const response = await app.inject("/api/v1/" + route + (pin ? (route.includes("?") ? "&" : "?") + pin : ""));
      assert.equal(response.statusCode, 200, response.body);
      assert.doesNotMatch(response.body, /PRIVATE_NOTES_DETAIL/);
      if (route.startsWith("evidence/") || route.startsWith("contributors/"))
        assert.ok(response.body.includes(notesPurpose));
    }
});
for (const [name, mutate] of [
  [
    "missing portfolio purpose",
    (x) => (x.selected.portfolioEvidence[0].contribution.reasonCodes = reasonCodes.filter((v) => v !== notesPurpose)),
  ],
  [
    "unsupported purpose",
    (x) => x.selected.evidence[0].contribution.reasonCodes.push("documentation_purpose:release_publication"),
  ],
  ["duplicate purpose", (x) => x.selected.evidence[0].contribution.reasonCodes.push(notesPurpose)],
  [
    "missing authored explanation",
    (x) =>
      (x.selected.evidence[0].contribution.reasonCodes = reasonCodes.filter((v) => v !== "domain_authorship:authored")),
  ],
  [
    "missing path-policy identity",
    (x) => (x.selected.evidence[0].contribution.reasonCodes = reasonCodes.filter((v) => v !== notesPathReason)),
  ],
  [
    "different portfolio revision",
    (x) => {
      x.selected.portfolioEvidence[0].sourceRevision = "d".repeat(40);
      x.selected.portfolioEvidence[0].sourceRevisionUrl =
        "https://github.com/synthetic-org/synthetic-repo/commit/" + "d".repeat(40);
    },
  ],
  [
    "missing source pin",
    (x) => {
      x.selected.evidence[0].sourceRevision = null;
      x.selected.evidence[0].sourceRevisionUrl = null;
    },
  ],
  [
    "foreign pinned repository",
    (x) => (x.selected.evidence[0].sourceRevisionUrl = "https://github.com/foreign/repo/commit/" + notesRevision),
  ],
  ["different source merge clock", (x) => (x.selected.portfolioEvidence[0].occurredAt = at)],
  ["unaccepted portfolio", (x) => (x.selected.portfolioEvidence[0].activityState = "observed")],
  [
    "publication operator role",
    (x) => {
      for (const list of [x.selected.evidence, x.selected.portfolioEvidence]) list[0].contribution.roles = ["merger"];
    },
  ],
])
  test("authored notes public " + name + " fails closed for both current and pinned reads", async (t) => {
    const input = fixture();
    mutate(input);
    assert.throws(() => projectRead(input, input.selected.scope, null), /documentation|public_projection_unavailable/i);
    const app = createService({ now: () => Date.parse(at), source: { read: async () => structuredClone(input) } });
    t.after(() => app.close());
    for (const pin of ["", "&snapshot=" + input.head.snapshotId]) {
      const response = await app.inject("/api/v1/boards?metric=documentation" + pin);
      assert.equal(response.statusCode, 503, response.body);
      assert.equal(response.headers["cache-control"], "no-store");
      assert.deepEqual(response.json(), { error: "public_projection_unavailable" });
    }
  });
test("legacy documentation without any purpose remains readable and does not acquire a release label", () => {
  const input = fixture();
  for (const list of [input.selected.evidence, input.selected.portfolioEvidence])
    list[0].contribution.reasonCodes = reasonCodes.filter((x) => x !== notesPurpose);
  // Keep the established legacy path-policy omission readable only without a new purpose.
  input.selected.portfolioEvidence[0].contribution.reasonCodes = ["public_accepted_work", ...notesDomainReasons];
  const projected = projectRead(input, input.selected.scope, null);
  for (const list of [projected.selected.evidence, projected.selected.portfolioEvidence])
    assert.ok(!list[0].contribution.reasonCodes.includes(notesPurpose));
});
