import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  defaultDeliveryNormalizationVersion,
  fieldChangeNormalizationVersion,
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
const delivery = (signature) => digest([defaultDeliveryNormalizationVersion, signature]);
const field = (signature) => digest([fieldChangeNormalizationVersion, signature]);
const triage = (signature) => digest([triageMetadataNormalizationVersion, signature]);
const fieldOption = { version: fieldChangeNormalizationVersion, signature: field };
const triageOption = { version: triageMetadataNormalizationVersion, signature: triage };
const merge = mergeTargetGenerationSignature(baseSignature, generation, digest);
const unavailable = /merge_target_normalization_binding_unavailable/;
const ordinary = () => ({ pullRequestMergeTargetNormalization: { ...marker }, facts: [] });
const withTriage = (withField = false) => ({
  ...ordinary(),
  ...(withField ? { fieldChangeNormalizationVersion } : {}),
  triageMetadataNormalizationVersion,
});
const validate = (document, signature, triageBinding = triageOption, fieldBinding = fieldOption) =>
  validateMergeTargetGeneration(document, signature, baseSignature, digest, delivery, fieldBinding, triageBinding);

test("an unused triage option preserves legacy merge and field generations without admitting a triage wrapper", () => {
  for (const withField of [false, true]) {
    const document = {
      ...ordinary(),
      ...(withField ? { fieldChangeNormalizationVersion } : {}),
    };
    const signatures = withField ? [field(merge), field(delivery(merge))] : [merge, delivery(merge)];
    for (const signature of signatures) {
      assert.deepEqual(validate(document, signature), marker);
      assert.deepEqual(validate(document, signature, null), marker);
      assert.throws(() => validate(document, triage(signature)), unavailable);
    }
  }
});

test("a triage marker admits only its outer wrapper of the exact merge and delivery generation", () => {
  const document = withTriage();
  assert.deepEqual(document.facts, []);
  for (const signature of [triage(merge), triage(delivery(merge))])
    assert.deepEqual(validate(document, signature), marker);
  for (const signature of [
    merge,
    delivery(merge),
    delivery(triage(merge)),
    triage(triage(merge)),
    triage(field(merge)),
    triage(field(delivery(merge))),
    field(triage(merge)),
    triage(delivery(delivery(merge))),
  ])
    assert.throws(() => validate(document, signature), unavailable);
});

test("triage wraps the complete field and delivery generation in the established order", () => {
  const document = withTriage(true);
  for (const signature of [triage(field(merge)), triage(field(delivery(merge)))])
    assert.deepEqual(validate(document, signature), marker);
  for (const signature of [
    merge,
    delivery(merge),
    field(merge),
    field(delivery(merge)),
    triage(merge),
    triage(delivery(merge)),
    field(triage(merge)),
    field(triage(delivery(merge))),
    delivery(triage(field(merge))),
    triage(delivery(field(merge))),
    triage(triage(field(merge))),
    triage(field(field(merge))),
  ])
    assert.throws(() => validate(document, signature), unavailable);
});

test("a declared triage generation requires the compatible callable wrapper and any declared field wrapper", () => {
  for (const option of [
    null,
    {},
    { version: "triage-metadata-json-values/old", signature: triage },
    { version: triageMetadataNormalizationVersion },
    { version: triageMetadataNormalizationVersion, signature: null },
    { version: triageMetadataNormalizationVersion, signature: (value) => value },
    { version: triageMetadataNormalizationVersion, signature: delivery },
  ])
    assert.throws(() => validate(withTriage(), triage(merge), option), unavailable);
  assert.throws(
    () => validateMergeTargetGeneration(withTriage(), triage(merge), baseSignature, digest, delivery, fieldOption),
    unavailable,
  );
  assert.throws(() => validate(withTriage(true), triage(field(merge)), triageOption, null), unavailable);
  assert.throws(
    () =>
      validate(withTriage(true), triage(field(merge)), triageOption, {
        version: "field-change-json-values/old",
        signature: field,
      }),
    unavailable,
  );
});

test("malformed or obsolete triage markers cannot fall back to an unwrapped merge generation", () => {
  for (const version of [
    null,
    false,
    1,
    "",
    "triage-metadata-json-values/old",
    { version: triageMetadataNormalizationVersion },
  ])
    for (const withField of [false, true]) {
      const document = { ...withTriage(withField), triageMetadataNormalizationVersion: version };
      const unwrapped = withField ? field(merge) : merge;
      for (const signature of [unwrapped, triage(unwrapped)])
        assert.throws(() => validate(document, signature), unavailable);
    }
});

test("an outer triage wrapper cannot conceal a different merge base, generation, or invalid native marker", () => {
  const wrongBase = "c".repeat(64);
  const wrongGeneration = "d".repeat(64);
  for (const withField of [false, true]) {
    const outer = (signature) => triage(withField ? field(signature) : signature);
    for (const signature of [
      outer(mergeTargetGenerationSignature(wrongBase, generation, digest)),
      outer(delivery(mergeTargetGenerationSignature(baseSignature, wrongGeneration, digest))),
    ])
      assert.throws(() => validate(withTriage(withField), signature), unavailable);
    for (const changed of [
      { ...marker, baseSignature: wrongBase },
      { ...marker, generation: wrongGeneration },
      { ...marker, generation: "not-a-hash" },
      { ...marker, schemaVersion: "pr-merge-target-normalization/old" },
      { ...marker, extra: true },
    ])
      assert.throws(
        () => validate({ ...withTriage(withField), pullRequestMergeTargetNormalization: changed }, outer(merge)),
        unavailable,
      );
  }
});
