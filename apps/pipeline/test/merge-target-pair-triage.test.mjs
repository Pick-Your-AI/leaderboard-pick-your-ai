import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  defaultDeliveryNormalizationVersion,
  fieldChangeNormalizationVersion,
  relationshipPairNormalizationVersion,
  triageMetadataNormalizationVersion,
} from "@pick-your-ai/github";
import {
  mergeTargetGenerationSignature,
  mergeTargetNormalizationVersion,
  validateMergeTargetGeneration,
} from "../src/pull-request-merge-target.mjs";

const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const baseSignature = "a".repeat(64);
const generation = "b".repeat(64);
const marker = { schemaVersion: mergeTargetNormalizationVersion, baseSignature, generation };
const delivery = (value) => digest([defaultDeliveryNormalizationVersion, value]);
const field = (value) => digest([fieldChangeNormalizationVersion, value]);
const pair = (value) => digest([relationshipPairNormalizationVersion, value]);
const triage = (value) => digest([triageMetadataNormalizationVersion, value]);
const fieldOption = { version: fieldChangeNormalizationVersion, signature: field };
const pairOption = { version: relationshipPairNormalizationVersion, signature: pair };
const triageOption = { version: triageMetadataNormalizationVersion, signature: triage };
const merge = mergeTargetGenerationSignature(baseSignature, generation, digest);
const document = (withField, withPair, withTriage) => ({
  pullRequestMergeTargetNormalization: { ...marker },
  facts: [],
  ...(withField ? { fieldChangeNormalizationVersion } : {}),
  ...(withPair ? { relationshipPairNormalizationVersion } : {}),
  ...(withTriage ? { triageMetadataNormalizationVersion } : {}),
});
const validate = (value, signature, pairBinding = pairOption, triageBinding = triageOption) =>
  validateMergeTargetGeneration(
    value,
    signature,
    baseSignature,
    digest,
    delivery,
    fieldOption,
    pairBinding,
    triageBinding,
  );
const unavailable = /merge_target_normalization_binding_unavailable/;

test("pair and triage wrappers preserve all sixteen optional merge generations", () => {
  // Literal expectations retain both owners' old keys, not a second copy of
  // the runtime's generation enumerator.
  const cases = [
    [false, false, false, merge],
    [false, false, false, delivery(merge)],
    [true, false, false, field(merge)],
    [true, false, false, field(delivery(merge))],
    [false, false, true, triage(merge)],
    [false, false, true, triage(delivery(merge))],
    [true, false, true, triage(field(merge))],
    [true, false, true, triage(field(delivery(merge)))],
    [false, true, false, pair(merge)],
    [false, true, false, pair(delivery(merge))],
    [true, true, false, pair(field(merge))],
    [true, true, false, pair(field(delivery(merge)))],
    [false, true, true, pair(triage(merge))],
    [false, true, true, pair(triage(delivery(merge)))],
    [true, true, true, pair(triage(field(merge)))],
    [true, true, true, pair(triage(field(delivery(merge))))],
  ];
  assert.equal(new Set(cases.map((entry) => entry[3])).size, 16);
  for (const [withField, withPair, withTriage, signature] of cases) {
    const value = document(withField, withPair, withTriage);
    assert.deepEqual(value.facts, []);
    assert.deepEqual(validate(value, signature), marker);
    if (!withPair) assert.deepEqual(validate(value, signature, null), marker);
    if (!withTriage) assert.deepEqual(validate(value, signature, pairOption, null), marker);
  }
});

test("mixed empty pair and triage generations reject exchanged descriptors and wrapper order", () => {
  const value = document(true, true, true);
  const signature = pair(triage(field(delivery(merge))));
  assert.deepEqual(validate(value, signature), marker);
  for (const wrong of [
    triage(pair(field(delivery(merge)))),
    pair(field(triage(delivery(merge)))),
    field(pair(triage(delivery(merge)))),
    pair(field(delivery(merge))),
    triage(field(delivery(merge))),
    pair(triage(field(delivery(mergeTargetGenerationSignature(baseSignature, "c".repeat(64), digest))))),
  ])
    assert.throws(() => validate(value, wrong), unavailable);
  assert.throws(() => validate(value, signature, triageOption, pairOption), unavailable);
  for (const invalid of [null, {}, { version: "obsolete", signature: pair }, { ...pairOption, signature: null }])
    assert.throws(() => validate(value, signature, invalid), unavailable);
  for (const invalid of [null, {}, { version: "obsolete", signature: triage }, { ...triageOption, signature: null }])
    assert.throws(() => validate(value, signature, pairOption, invalid), unavailable);
  for (const key of ["relationshipPairNormalizationVersion", "triageMetadataNormalizationVersion"]) {
    const absent = { ...value };
    delete absent[key];
    assert.throws(() => validate(absent, signature), unavailable);
    assert.throws(() => validate({ ...value, [key]: "obsolete" }, signature), unavailable);
  }
});
