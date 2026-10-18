import assert from "node:assert/strict";
import test from "node:test";
import { publicReproductionRecognitionReasons } from "../dist/index.js";

const fixed = [
  "domain_metric:reproductions",
  "domain_clock:accepted_at",
  "accepted_reproduction_scenario_not_bug_confirmation",
];
const project = (reasonCodes, accepted = undefined, metricIds = ["reproductions"]) =>
  publicReproductionRecognitionReasons({ reasonCodes, metricIds }, accepted);

for (const outcome of ["reproduced", "not_reproduced", "inconclusive"]) {
  test(`accepted reproduction explanation preserves explicit ${outcome} without certifying a bug`, () => {
    const expected = [...fixed, `domain_outcome:${outcome}`];
    for (const marker of ["independent_recognition_receipt", "public_accepted_work"]) {
      const input = ["private proof PRIVATE_SENTINEL", ...expected.toReversed(), marker];
      assert.deepEqual(project(input), expected);
      assert.deepEqual(project(input, true), expected);
      assert.deepEqual(input, ["private proof PRIVATE_SENTINEL", ...expected.toReversed(), marker]);
      assert.deepEqual(project(input, false, ["confirmed_bugs"]), []);
    }
    assert.deepEqual(project(expected), [], "Explanation labels cannot supply acceptance");
    assert.deepEqual(project(expected, true), expected, "An already accepted projection still needs exact labels");
  });
}

test("raw, pending and unknown reproduction work does not invent an accepted outcome", () => {
  for (const marker of ["public_observed_work", "public_pending_work", "public_unknown_work", "raw_observed_only"]) {
    assert.deepEqual(project([marker, "private result details"]), []);
    assert.deepEqual(project([marker, ...fixed, "domain_outcome:reproduced"]), []);
  }
});

test("explicit nonaccepted context cannot inherit an accepted reproduction marker", () => {
  for (const marker of ["independent_recognition_receipt", "public_accepted_work"]) {
    for (const outcome of ["reproduced", "not_reproduced", "inconclusive"]) {
      const input = [marker, ...fixed, `domain_outcome:${outcome}`];
      assert.throws(() => project(input, false), /Invalid accepted reproduction explanation/);
      assert.deepEqual(project(input), [...fixed, `domain_outcome:${outcome}`]);
      assert.deepEqual(project(input, true), [...fixed, `domain_outcome:${outcome}`]);
    }
  }
  assert.deepEqual(project([...fixed, "domain_outcome:reproduced"], false), []);
});

test("missing or contradictory accepted reproduction labels fail closed", async (t) => {
  const valid = ["public_accepted_work", ...fixed, "domain_outcome:reproduced"];
  const invalid = [
    ["public_accepted_work"],
    ...fixed.map((value) => valid.filter((entry) => entry !== value)),
    ...fixed.map((value) => [...valid, value]),
    valid.filter((value) => !value.startsWith("domain_outcome:")),
    [...valid, "domain_outcome:inconclusive"],
    [...valid, "domain_outcome:reproduced"],
    [...valid.slice(0, -1), "domain_outcome:unknown"],
    [...valid.slice(0, -1), "domain_outcome:confirmed_bug"],
    [...valid, "domain_clock:confirmed_at"],
    [...valid, "domain_metric:confirmed_bugs"],
    ...["raw_observed_only", "public_observed_work", "public_pending_work", "public_unknown_work"].map((value) => [...valid, value]),
  ];
  for (let index = 0; index < invalid.length; index++) {
    await t.test(`invalid fixed explanation ${index + 1}`, () => {
      assert.throws(() => project(invalid[index]), /Invalid accepted reproduction explanation/);
    });
  }
  assert.throws(() => project([], true), /Invalid accepted reproduction explanation/);
  assert.throws(() => project(valid, false, ["reproductions", "confirmed_bugs"]));
  assert.throws(() => project([...valid, ...Array(28).fill("private")]), /exceeds reason bound/);
});
