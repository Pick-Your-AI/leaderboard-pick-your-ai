import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { sourceEventSchema } from "@pick-your-ai/contracts";
import {
  canonicalizeObservations,
  getMetricDefinition,
  metricDefinitionsV1,
  metricRegistryV1,
} from "../dist/index.js";

const fixture = async (name) =>
  JSON.parse(
    await readFile(
      new URL(`../../../tests/fixtures/contracts/v1/${name}`, import.meta.url),
      "utf8",
    ),
  );

test("registry retains all 98 definitions and unresolved UI metadata", () => {
  assert.equal(metricDefinitionsV1.length, 98);
  assert.equal(new Set(metricDefinitionsV1.map(({ id }) => id)).size, 98);
  assert.equal(metricRegistryV1.ui_metadata.decision_state, "unresolved");
  assert.equal(getMetricDefinition("pr_merged").definition.numerator,
    "one per merged PR in window; show team/shared authorship");
  assert.equal(getMetricDefinition("not_a_metric"), undefined);
  assert.equal("universal_score" in metricRegistryV1, false);
});

test("webhook and REST observations of one evidenced action make one canonical group", async () => {
  const pair = await fixture("observation-pair.json");
  const observations = pair.map((event) => sourceEventSchema.parse(event));
  const groups = canonicalizeObservations(observations);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].state, "canonical");
  assert.deepEqual(groups[0].observationIds, [
    "fixture:observation:rest",
    "fixture:observation:webhook",
  ]);
  assert.equal(groups[0].observations.length, 2);
});

test("conflicting actor or missing dedupe evidence stays ambiguous or unknown", async () => {
  const pair = await fixture("observation-pair.json");
  pair[1].actor.githubNodeId = "MDQ6VXNlcjI=";
  const conflicting = canonicalizeObservations(
    pair.map((event) => sourceEventSchema.parse(event)),
  );
  assert.equal(conflicting.length, 1);
  assert.equal(conflicting[0].state, "ambiguous");

  const eventWithoutKey = await fixture("ambiguous-event.json");
  const unkeyed = canonicalizeObservations([
    sourceEventSchema.parse(eventWithoutKey),
  ]);
  assert.equal(unkeyed.length, 1);
  assert.equal(unkeyed[0].state, "unknown");
});
