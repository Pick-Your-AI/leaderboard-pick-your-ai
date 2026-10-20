import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { defaultDeliveryNormalizationVersion, fieldChangeNormalizationVersion } from "@pick-your-ai/github";
import {
  mergeTargetGenerationSignature,
  mergeTargetNormalizationVersion,
  validateMergeTargetGeneration,
} from "../src/pull-request-merge-target.mjs";

const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const baseSignature = "a".repeat(64);
const generation = "b".repeat(64);
const marker = { schemaVersion: mergeTargetNormalizationVersion, baseSignature, generation };
const delivery = (signature) => digest([defaultDeliveryNormalizationVersion, signature]);
const field = (signature) => digest([fieldChangeNormalizationVersion, signature]);
const fieldOption = { version: fieldChangeNormalizationVersion, signature: field };
const merge = mergeTargetGenerationSignature(baseSignature, generation, digest);
const unavailable = /merge_target_normalization_binding_unavailable/;
const ordinary = () => ({ pullRequestMergeTargetNormalization: { ...marker }, facts: [] });
const withField = () => ({ ...ordinary(), fieldChangeNormalizationVersion });
const validate = (document, signature, option) =>
  validateMergeTargetGeneration(document, signature, baseSignature, digest, delivery, option);

test("merge generations preserve exactly the two legacy signatures without a field marker", () => {
  for (const signature of [merge, delivery(merge)]) {
    assert.deepEqual(validate(ordinary(), signature), marker);
    assert.deepEqual(validate(ordinary(), signature, fieldOption), marker);
  }
  for (const signature of [field(merge), field(delivery(merge)), baseSignature, delivery(baseSignature)])
    assert.throws(() => validate(ordinary(), signature, fieldOption), unavailable);
});

test("a field marker admits only the outer field wrapper of the exact merge generation", () => {
  for (const signature of [field(merge), field(delivery(merge))])
    assert.deepEqual(validate(withField(), signature, fieldOption), marker);
  // Empty corrected field output still owns its versioned generation.
  assert.deepEqual(withField().facts, []);
  for (const signature of [
    merge,
    delivery(merge),
    delivery(field(merge)),
    field(field(merge)),
    field(delivery(delivery(merge))),
    mergeTargetGenerationSignature(field(baseSignature), generation, digest),
    field(baseSignature),
    field(delivery(baseSignature)),
  ])
    assert.throws(() => validate(withField(), signature, fieldOption), unavailable);
});

test("a declared field generation cannot borrow a missing or incompatible wrapper", () => {
  for (const option of [
    undefined,
    null,
    {},
    { version: "field-change-json-values/old", signature: field },
    { version: fieldChangeNormalizationVersion },
    { version: fieldChangeNormalizationVersion, signature: null },
  ])
    assert.throws(() => validate(withField(), field(merge), option), unavailable);
  assert.throws(
    () => validate(withField(), field(merge), { version: fieldChangeNormalizationVersion, signature: delivery }),
    unavailable,
  );
});

test("malformed or obsolete field markers do not downgrade to an unwrapped generation", () => {
  for (const version of [
    null,
    false,
    1,
    "",
    "field-change-json-values/old",
    { version: fieldChangeNormalizationVersion },
  ])
    for (const signature of [merge, delivery(merge), field(merge), field(delivery(merge))])
      assert.throws(
        () => validate({ ...ordinary(), fieldChangeNormalizationVersion: version }, signature, fieldOption),
        unavailable,
      );
});

test("outer field wrapping cannot conceal the wrong merge base or run generation", () => {
  const wrongBase = "c".repeat(64);
  const wrongGeneration = "d".repeat(64);
  for (const signature of [
    field(mergeTargetGenerationSignature(wrongBase, generation, digest)),
    field(delivery(mergeTargetGenerationSignature(baseSignature, wrongGeneration, digest))),
  ])
    assert.throws(() => validate(withField(), signature, fieldOption), unavailable);
  for (const changed of [
    { ...marker, baseSignature: wrongBase },
    { ...marker, generation: wrongGeneration },
    { ...marker, generation: "not-a-hash" },
    { ...marker, schemaVersion: "pr-merge-target-normalization/old" },
    { ...marker, extra: true },
  ])
    assert.throws(
      () => validate({ ...withField(), pullRequestMergeTargetNormalization: changed }, field(merge), fieldOption),
      unavailable,
    );
});
