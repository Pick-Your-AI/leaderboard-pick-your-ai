import test from "node:test";
import assert from "node:assert/strict";
import { publicDocumentationReasons } from "../dist/index.js";

const policy = "documentation_path_policy:synthetic-docs-v1";
const labels = [policy, "locale:fr", "localization_category:documentation"];
const project = (reasonCodes, metricIds = ["localization"]) => publicDocumentationReasons({ reasonCodes, metricIds });

test("public documentation classification copies only explicit bounded policy and locale labels", () => {
  const reasons = ["private reviewer context SECRET", labels[2], labels[0], "independent_recognition_receipt", labels[1]];
  assert.deepEqual(project(reasons), labels);
  assert.deepEqual(project([policy], ["documentation"]), [policy]);
  assert.deepEqual(project(["public_observed_work"]), []);
  assert.deepEqual(project([policy, "private context"], ["pr_opened"]), []);
  assert.deepEqual(project([policy, "locale:zh-Hant-TW", labels[2]]), [policy, "locale:zh-Hant-TW", labels[2]]);
  assert.deepEqual(reasons, ["private reviewer context SECRET", labels[2], labels[0], "independent_recognition_receipt", labels[1]]);
});

test("partial, ambiguous, noncanonical and overlarge locale classifications cannot become public proof", () => {
  for (const reasons of [
    [policy], labels.slice(1), labels.slice(0, 2), [policy, labels[2]],
    [...labels, labels[1]], [...labels, "locale:de"], [...labels, "documentation_path_policy:other"],
    ["documentation_path_policy:../private", ...labels.slice(1)],
    [policy, "locale:FR", labels[2]], [policy, "locale:und", labels[2]],
    [policy, "locale:mul", labels[2]], [policy, "locale:zxx", labels[2]],
    [policy, "locale:en-u-ca-gregory", labels[2]], [policy, "locale:fr-x-private", labels[2]],
    [policy, "locale:en_US", labels[2]], [policy, labels[1], "localization_category:../secret"],
    [...labels, ...Array(30).fill("internal")],
  ]) assert.throws(() => project(reasons), JSON.stringify(reasons));
  assert.throws(() => project(labels, ["documentation"]));
});
