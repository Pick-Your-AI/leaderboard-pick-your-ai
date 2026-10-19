import test from "node:test";
import assert from "node:assert/strict";
import fixture from "../../../tests/fixtures/issue-transfer-metadata.json" with { type: "json" };
import {
  validateIssueTransfers,
  issueTransferClosure,
  expandIssueTransferSuppressions,
} from "../src/issue-transfer-privacy.mjs";

const edge = (changes = {}) => ({ ...structuredClone(fixture), ...changes });
const onward = () =>
  edge({
    sourceArtifactId: fixture.targetArtifactId,
    targetArtifactId: "SYNTHETIC_ISSUE_C",
    sourceRepositoryId: "3",
    targetRepositoryId: "4",
    sourceUrl: fixture.targetUrl,
    targetUrl: "https://github.com/synthetic-org/synthetic-third/issues/4",
    observationId: "gh:synthetic-next",
    eventId: "synthetic-next-event",
  });

test("destination dependency exists without any target fact or view", () => {
  assert.deepEqual(issueTransferClosure([edge()], { artifactIds: [fixture.sourceArtifactId], repositoryIds: ["2"] }), {
    artifactIds: [fixture.sourceArtifactId, fixture.targetArtifactId],
    repositoryIds: ["2", "3"],
    transfers: [edge()],
  });
  assert.deepEqual(issueTransferClosure([edge()], { repositoryIds: ["3"] }).artifactIds, [
    fixture.sourceArtifactId,
    fixture.targetArtifactId,
  ]);
});
test("either unavailable endpoint withdraws all aliases", () => {
  for (const id of ["2", "3"])
    assert.deepEqual(expandIssueTransferSuppressions([edge()], { unavailableRepositoryIds: [id] }), [
      fixture.sourceArtifactId,
      fixture.targetArtifactId,
    ]);
  for (const id of [fixture.sourceArtifactId, fixture.targetArtifactId])
    assert.deepEqual(expandIssueTransferSuppressions([edge()], { artifactIds: [id] }), [
      fixture.sourceArtifactId,
      fixture.targetArtifactId,
    ]);
});
test("multi-hop and reverse replay retain one deterministic closure", () => {
  const reverse = edge({
    sourceArtifactId: fixture.targetArtifactId,
    targetArtifactId: fixture.sourceArtifactId,
    sourceRepositoryId: "3",
    targetRepositoryId: "2",
    sourceUrl: fixture.targetUrl,
    targetUrl: fixture.sourceUrl,
  });
  const rows = [edge(), onward(), reverse, edge(), onward()];
  const expected = [fixture.sourceArtifactId, fixture.targetArtifactId, "SYNTHETIC_ISSUE_C"];
  assert.deepEqual(expandIssueTransferSuppressions(rows, { artifactIds: ["SYNTHETIC_ISSUE_C"] }), expected);
  assert.deepEqual(
    issueTransferClosure(rows, { repositoryIds: ["4"] }),
    issueTransferClosure(rows.toReversed(), { repositoryIds: ["4"] }),
  );
  assert.equal(validateIssueTransfers(rows).length, 3);
});
test("unrelated issues sharing repositories do not join a selected identity", () => {
  const other = edge({
    sourceArtifactId: "SYNTHETIC_OTHER_A",
    targetArtifactId: "SYNTHETIC_OTHER_B",
    observationId: "gh:synthetic-other",
  });
  assert.deepEqual(expandIssueTransferSuppressions([edge(), other], { artifactIds: [fixture.sourceArtifactId] }), [
    fixture.sourceArtifactId,
    fixture.targetArtifactId,
  ]);
  assert.deepEqual(issueTransferClosure([edge(), other], { artifactIds: [fixture.targetArtifactId] }).transfers, [
    edge(),
  ]);
});
test("late binding attaches a new alias to an already unavailable component", () => {
  assert.deepEqual(expandIssueTransferSuppressions([edge()], { artifactIds: [fixture.sourceArtifactId] }), [
    fixture.sourceArtifactId,
    fixture.targetArtifactId,
  ]);
  assert.deepEqual(expandIssueTransferSuppressions([edge(), onward()], { artifactIds: [fixture.sourceArtifactId] }), [
    fixture.sourceArtifactId,
    fixture.targetArtifactId,
    "SYNTHETIC_ISSUE_C",
  ]);
});
test("retained edge omitted by the current normalization remains authoritative", () => {
  const retained = [edge()];
  const current = [onward()];
  assert.deepEqual(issueTransferClosure([...retained, ...current], { repositoryIds: ["4"] }).repositoryIds, [
    "2",
    "3",
    "4",
  ]);
  assert.deepEqual(expandIssueTransferSuppressions([...retained, ...current], { unavailableRepositoryIds: ["2"] }), [
    fixture.sourceArtifactId,
    fixture.targetArtifactId,
    "SYNTHETIC_ISSUE_C",
  ]);
});
test("the same native ID at two endpoints has both repository dependencies", () => {
  const item = edge({ targetArtifactId: fixture.sourceArtifactId });
  assert.deepEqual(issueTransferClosure([item], { artifactIds: [fixture.sourceArtifactId] }).repositoryIds, ["2", "3"]);
  assert.deepEqual(expandIssueTransferSuppressions([item], { unavailableRepositoryIds: ["3"] }), [
    fixture.sourceArtifactId,
  ]);
});
test("unrelated direct removals survive while generic lineage grants no alias", () => {
  assert.deepEqual(expandIssueTransferSuppressions([], { artifactIds: ["SYNTHETIC_UNRELATED"] }), [
    "SYNTHETIC_UNRELATED",
  ]);
  assert.throws(
    () =>
      validateIssueTransfers([
        {
          relation: "transferred_to",
          sourceIds: [fixture.sourceArtifactId],
          targetId: fixture.targetArtifactId,
          evidenceIds: [fixture.observationId],
        },
      ]),
    /invalid_issue_transfer_binding/,
  );
});
for (const [field, value] of [
  ["schemaVersion", "github-issue-transfer/v2"],
  ["sourceArtifactId", "SYNTHETIC_A\n"],
  ["targetArtifactId", "bad/id"],
  ["sourceRepositoryId", "02"],
  ["targetRepositoryId", 3],
  ["targetRepositoryId", "9007199254740992"],
  ["sourceUrl", fixture.sourceUrl + "?private=1"],
  ["targetUrl", fixture.targetUrl + "#issuecomment-1"],
  ["targetUrl", "https://github.com/synthetic-org/synthetic-target/pull/9"],
  ["observedAt", "2026-02-30T01:00:00.000Z"],
  ["occurredAt", "2026-10-20T01:00:00.000Z"],
  ["eventId", "synthetic-event\n"],
  ["observationId", null],
  ["sourceRevision", ""],
])
  test(`invalid ${field}=${JSON.stringify(value)} cannot confer equivalence`, () => {
    assert.throws(
      () => issueTransferClosure([edge({ [field]: value })], { repositoryIds: ["2"] }),
      /invalid_issue_transfer_binding/,
    );
  });
test("missing and unrecognized fields fail before graph admission", () => {
  const missing = edge();
  delete missing.targetUrl;
  for (const item of [missing, edge({ unreviewed: true })])
    assert.throws(() => validateIssueTransfers([item]), /invalid_issue_transfer_binding/);
});
test("current plus retained exact replays respect separate raw and distinct bounds", () => {
  assert.equal(validateIssueTransfers(Array.from({ length: 20000 }, () => edge())).length, 1);
  assert.throws(
    () => validateIssueTransfers(Array.from({ length: 20001 }, () => edge())),
    /invalid_issue_transfer_binding/,
  );
  assert.throws(
    () => validateIssueTransfers(Array.from({ length: 10001 }, (_, i) => edge({ observationId: `gh:synthetic-${i}` }))),
    /invalid_issue_transfer_binding/,
  );
});
test("repository scope and returned arrays cannot mutate private input proof", () => {
  const rows = [edge(), onward()];
  const before = structuredClone(rows);
  const result = issueTransferClosure(rows, { repositoryIds: ["2"] });
  result.transfers[0].targetArtifactId = "SYNTHETIC_CHANGED";
  assert.deepEqual(rows, before);
  assert.throws(() => issueTransferClosure(rows, { repositoryIds: ["2\n"] }), /invalid_issue_transfer_binding/);
});
