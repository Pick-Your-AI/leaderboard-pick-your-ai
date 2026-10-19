// Existing public normalization/receipt APIs; all data are fictional protected-host fixtures.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { applyRecognitionReceipt } from "../dist/index.js";
import {
  stewardshipSource,
  stewardshipTarget,
  stewardshipProof,
  stewardshipReceipt,
  stewardshipScenario,
  applyStewardshipReceipt,
  stewardshipBoard,
  stewardshipValue,
  stewardshipPolicy,
  invalidStewardshipSources,
  publicationAt,
  stewardshipAcceptedAt,
  stewardshipCutoff,
} from "../../../tests/fixtures/release-stewardship.mjs";

const priorIdentity = JSON.parse(
  readFileSync(new URL("../../../tests/fixtures/release-stewardship-authority-v1.json", import.meta.url), "utf8"),
).recognizedDefault;

test("release stewardship source: publisher and notes author remain separate; drafts and snapshots create no publication", () => {
  const source = stewardshipSource(),
    target = stewardshipTarget(source);
  assert.equal(target.actorId, "101");
  assert.equal(target.subjectActorId, "303");
  assert.equal(target.state, "observed");
  assert.equal(target.occurredAt, publicationAt);
  for (const options of [{ draft: true }, { action: "snapshot" }])
    assert.equal(stewardshipTarget(stewardshipSource(options)), undefined);
});
test("release stewardship source: default recognized identity and publication period remain conserved", () => {
  const input = stewardshipSource(),
    original = structuredClone(input),
    target = stewardshipTarget(input);
  const output = applyStewardshipReceipt(input),
    fact = output.facts.at(-1);
  assert.equal(fact.id, priorIdentity.id);
  assert.equal(fact.canonicalKey, priorIdentity.canonicalKey);
  assert.equal(fact.occurredAt, publicationAt);
  assert.equal(fact.acceptedAt, stewardshipAcceptedAt);
  assert.equal(
    stewardshipValue(stewardshipBoard(output, stewardshipPolicy(), publicationAt, "2026-10-08T00:00:00.000Z")),
    1,
  );
  assert.equal(
    stewardshipValue(stewardshipBoard(output, stewardshipPolicy(), stewardshipAcceptedAt, stewardshipCutoff)),
    0,
  );
  assert.equal(stewardshipBoard(output).publicEnabled, false);
  assert.deepEqual(input, original);
  assert.deepEqual(output.facts.slice(0, input.facts.length), input.facts);
});
test("release stewardship source: public proof uses publication time and keeps acceptance as separate metadata", () => {
  const output = applyStewardshipReceipt(stewardshipSource()),
    proof = output.evidence.at(-1);
  assert.equal(proof.occurredAt, publicationAt);
  assert.equal(proof.evidenceMetadata.sourceOccurredAt, publicationAt);
  assert.equal(proof.evidenceMetadata.acceptedAt, stewardshipAcceptedAt);
  assert.equal(proof.evidenceMetadata.sourceAction, "recognition_accepted");
  assert.equal(proof.evidenceMetadata.activityState, "accepted");
});
test("release stewardship source: caller changeset aliases cannot create another publisher-release identity", () => {
  const input = stewardshipSource(),
    expected = applyStewardshipReceipt(input).facts.at(-1);
  for (const changesetId of ["private-batch-one", "private-batch-two"]) {
    const actual = applyStewardshipReceipt(input, { changesetId }).facts.at(-1);
    assert.equal(actual.id, expected.id);
    assert.equal(actual.canonicalKey, expected.canonicalKey);
  }
  const other = applyStewardshipReceipt(stewardshipSource({ number: 61 })).facts.at(-1);
  assert.notEqual(other.canonicalKey, expected.canonicalKey);
});
test("release stewardship source: opaque revisions and omitted optional display metadata retain supported identity", () => {
  const input = stewardshipSource({ revision: "host-event-revision:opaque-42" });
  delete stewardshipProof(input).evidenceMetadata;
  const output = applyStewardshipReceipt(input);
  assert.equal(output.evidence.at(-1).sourceRevision, "host-event-revision:opaque-42");
  assert.equal(output.evidence.at(-1).occurredAt, publicationAt);
});
test("release stewardship source: an explicit synthetic kernel source remains separate from public authority", () => {
  const input = stewardshipSource();
  input.isSynthetic = true;
  const output = applyStewardshipReceipt(input);
  assert.equal(output.isSynthetic, true);
  assert.equal(stewardshipBoard(output).publicEnabled, false);
});
test("release stewardship source: automation publisher roles and filtering remain intact", () => {
  const input = stewardshipSource({ bot: true }),
    output = applyStewardshipReceipt(input),
    fact = output.facts.at(-1);
  assert.equal(fact.actorId, "404");
  assert.equal(fact.subjectActorId, "303");
  assert.equal(fact.role, "automation");
  assert.equal(input.actors.find((actor) => actor.id === "404").kind, "bot");
  assert.equal(stewardshipValue(stewardshipBoard(output, stewardshipPolicy(), null, stewardshipCutoff, "user")), 0);
  assert.equal(
    stewardshipValue(stewardshipBoard(output, stewardshipPolicy(), null, stewardshipCutoff, "automation")),
    1,
  );
});
for (const [name, mutate] of Object.entries(invalidStewardshipSources))
  test(`release stewardship source: rejects ${name}`, () => {
    const s = stewardshipScenario();
    mutate(s);
    const receipt = stewardshipReceipt(s.input);
    assert.throws(() => applyRecognitionReceipt(s.input, receipt, ["202"]), /Release stewardship/);
  });
test("release stewardship source: independent review cannot precede publication, including supported millisecond clocks", () => {
  const input = stewardshipSource();
  assert.throws(
    () => applyStewardshipReceipt(input, { acceptedAt: "2026-10-06T10:00:00.000Z" }),
    /Release stewardship/,
  );
  const s = stewardshipScenario();
  s.target.occurredAt = "2026-10-07T10:00:00.001Z";
  s.evidence.occurredAt = s.target.occurredAt;
  s.evidence.evidenceMetadata.sourceOccurredAt = s.target.occurredAt;
  assert.throws(
    () => applyStewardshipReceipt(s.input, { acceptedAt: "2026-10-07T10:00:00.000Z" }),
    /Release stewardship/,
  );
  assert.equal(
    applyStewardshipReceipt(s.input, { acceptedAt: "2026-10-07T10:00:00.002Z" }).facts.at(-1).occurredAt,
    s.target.occurredAt,
  );
});
test("release stewardship source: an accepted result cannot be reused as original publication evidence", () => {
  const input = stewardshipSource(),
    output = applyStewardshipReceipt(input),
    accepted = output.facts.at(-1);
  assert.throws(
    () =>
      applyRecognitionReceipt(
        output,
        stewardshipReceipt(input, { targetFactId: accepted.id, evidenceIds: [accepted.id] }),
        ["202"],
      ),
    /Release stewardship/,
  );
});
test("release stewardship source: original independent reviewer and excluded-receipt behavior remain explicit", () => {
  const input = stewardshipSource(),
    receipt = stewardshipReceipt(input);
  assert.throws(() => applyRecognitionReceipt(input, receipt, ["303"]), /Independent verified/);
  assert.throws(
    () => applyRecognitionReceipt(input, { ...receipt, reviewerId: "101" }, ["101"]),
    /Independent verified/,
  );
  const excluded = applyStewardshipReceipt(input, { decision: "excluded" });
  assert.equal(excluded.facts.at(-1).state, "excluded");
  assert.equal(stewardshipValue(stewardshipBoard(excluded)), 0);
});
