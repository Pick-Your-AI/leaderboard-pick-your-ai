import test from "node:test";
import assert from "node:assert/strict";
import {
  encodeWorkstreamHelpStatement,
  parseWorkstreamHelpStatement,
  workstreamHelpStatementSchema,
  publicWorkstreamHelpSchema,
  reviewedWorkstreamHelpBindingSchema,
  workstreamHelpVersion,
} from "../dist/index.js";

const statement = () => ({
  schemaVersion: "cross-workstream-help-statement/v1",
  organization: "fixture-org", definitionVersion: "fixture-workstreams-v1",
  from: { id: "platform", label: "Platform" }, to: { id: "documentation", label: "Documentation" },
  actorId: "101", repositoryId: "2", artifactId: "PR_fixture_10",
  sourceUrl: "https://github.com/example-org/example-repo/pull/10",
  sourceRevision: "2026-10-09T10:00:00.000Z", occurredAt: "2026-10-07T10:00:00.0001Z",
  role: "author", helpKind: "authored_merged_change",
});
const help = () => ({
  ruleVersion: workstreamHelpVersion, contributionId: "accepted-fixture-contribution",
  acceptedAt: "2026-10-07T10:00:00.0002Z", reviewedAt: "2026-10-09T10:00:00.000Z",
  statement: statement(), statementRevision: "b".repeat(40),
  statementUrl: "https://github.com/example-org/example-repo/blob/" + "b".repeat(40) + "/docs/help.json",
  statementHash: "a".repeat(64),
});

test("canonical statement bytes preserve a separate observed revision and reject ambiguous JSON encodings", () => {
  const source = statement();
  const encoded = encodeWorkstreamHelpStatement(source);
  assert.deepEqual(parseWorkstreamHelpStatement(encoded), source);
  assert.equal(parseWorkstreamHelpStatement(encoded).sourceRevision, "2026-10-09T10:00:00.000Z");
  for (const changed of [
    JSON.stringify(source), JSON.stringify(source, null, 2) + "\n", encoded + "\n",
    encoded.replace('"role":"author"', '"role":"unknown","role":"author"'),
    JSON.stringify({ ...source, privateReason: "PRIVATE" }) + "\n",
    JSON.stringify(Object.fromEntries(Object.entries(source).reverse())) + "\n",
    " ".repeat(8193),
  ]) assert.throws(() => parseWorkstreamHelpStatement(changed));
});

test("statement identity, safe immutable repository binding and precise clock order are closed", () => {
  assert.equal(publicWorkstreamHelpSchema.safeParse(help()).success, true);
  for (const mutate of [
    (value) => { value.statement.from.id = value.statement.to.id; },
    (value) => { value.statement.from.label += "\u202e"; },
    (value) => { value.statement.actorId = ".."; },
    (value) => { value.statement.role = "coauthor"; },
    (value) => { value.statement.sourceUrl += "?private=1"; },
    (value) => { value.statement.sourceUrl += "?"; },
    (value) => { value.statement.sourceUrl += "#"; },
    (value) => { value.statementUrl += "?"; },
    (value) => { value.statementUrl += "#"; },
    (value) => { value.statement.sourceUrl = "https://github.com/example-org/example-repo/pull/0"; },
    (value) => { value.statementUrl = value.statementUrl.replace("example-repo", "another-repo"); },
    (value) => { value.statementUrl = value.statementUrl.replace("b".repeat(40), "main"); },
    (value) => { value.statementUrl = value.statementUrl.replace("/docs/", "/docs%2f"); },
    (value) => { value.statementUrl += "\n"; },
    (value) => { value.statementRevision = "c".repeat(40); },
    (value) => { value.statementHash += "\n"; },
    (value) => { value.acceptedAt = "2026-10-07T10:00:00.0000Z"; },
    (value) => { value.reviewedAt = "2026-10-07T10:00:00.0001Z"; },
    (value) => { value.reviewedAt = null; },
    (value) => { value.privateDecision = "PRIVATE"; },
  ]) {
    const value = help();
    mutate(value);
    assert.equal(publicWorkstreamHelpSchema.safeParse(value).success, false);
  }
});

test("the protected binding explicitly names both current review identities and never accepts an approval flag", () => {
  const source = statement();
  const record = {
    requestId: "help-request", requestVersion: 2, decisionId: "help-decision", factId: "observed-source",
    sourceAcceptance: { requestId: "source-request", requestVersion: 1, decisionId: "source-decision" },
    validUntil: "2026-10-10T00:00:00Z",
    statement: {
      revision: help().statementRevision, url: help().statementUrl,
      sha256: help().statementHash, content: encodeWorkstreamHelpStatement(source),
    },
  };
  const binding = {
    ruleVersion: workstreamHelpVersion, organization: source.organization, definitionVersion: source.definitionVersion,
    workstreams: [source.from, source.to], records: [record],
  };
  assert.equal(reviewedWorkstreamHelpBindingSchema.safeParse(binding).success, true);
  assert.equal(workstreamHelpStatementSchema.safeParse({ ...source, approved: true }).success, false);
  const missing = structuredClone(binding);
  delete missing.records[0].sourceAcceptance;
  assert.equal(reviewedWorkstreamHelpBindingSchema.safeParse(missing).success, false);
  const claimed = structuredClone(binding);
  claimed.approved = true;
  assert.equal(reviewedWorkstreamHelpBindingSchema.safeParse(claimed).success, false);
  const repeated = structuredClone(binding);
  repeated.records.push(structuredClone(record));
  assert.equal(reviewedWorkstreamHelpBindingSchema.safeParse(repeated).success, false);
});
