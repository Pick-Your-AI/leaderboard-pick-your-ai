import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { normalizeGithubObservation } from "../dist/index.js";

const fixture = JSON.parse(await readFile(new URL("fixtures/engineering.json", import.meta.url), "utf8"));
const envelope = (family, subtype) => ({
  repository: { id: 2, slug: "synthetic-owner/repository", visibility: "public", defaultBranch: "main" },
  proof: {
    verified: true,
    source: "github_webhook",
    revision: "synthetic",
    eventId: "synthetic-event",
    isSynthetic: true,
  },
  family,
  action: family === "relationship" ? "added" : subtype,
  observedAt: "2026-10-08T10:00:00Z",
  occurredAt: "2026-10-07T10:00:00Z",
  payload: {
    issue: { ...structuredClone(fixture.issue), user: fixture.author },
    sender: fixture.merger,
    label: { id: 90, node_id: "L_synthetic", name: "synthetic" },
    change: { before: "before", after: "after" },
    relationship: {
      kind: subtype,
      from: "issue:a",
      to: "issue:b",
      intentional: true,
      publicEndpointsVerified: true,
    },
  },
});
const reasons = {
  triage: "unsupported_or_unproven_triage_action",
  field_change: "unsupported_or_unproven_field_subtype",
  relationship: "automatic_reference_or_relationship_actor_unverified",
};
const assertUnsupported = (input) => {
  const original = structuredClone(input);
  const output = normalizeGithubObservation(input);
  assert.deepEqual(output.facts, []);
  assert.deepEqual(output.evidence, []);
  assert.ok(output.reasons.includes(reasons[input.family]));
  assert.equal(output.observations.length, 1);
  assert.equal(output.observations[0].action, input.action);
  assert.deepEqual(input, original);
};

for (const family of Object.keys(reasons)) {
  test(`${family} cannot inherit a supported subtype from Object.prototype`, async (t) => {
    for (const subtype of Object.getOwnPropertyNames(Object.prototype)) {
      await t.test(subtype, () => assertUnsupported(envelope(family, subtype)));
    }
  });
}

test("ordinary unsupported subtypes retain the same reason and raw observation", () => {
  for (const family of Object.keys(reasons)) assertUnsupported(envelope(family, "synthetic_unsupported"));
});

test("relationship kinds must be literal supported strings without coercing payload values", async (t) => {
  for (const [name, kind] of [
    ["null", null],
    ["missing", undefined],
    ["number", 17],
    ["boolean", true],
    ["empty array", []],
    ["array containing supported kind", ["related"]],
    ["object", { kind: "related" }],
  ]) {
    await t.test(name, () => assertUnsupported(envelope("relationship", kind)));
  }
});

test("supported field, triage and relationship types retain actual metric and actor semantics", () => {
  for (const [family, subtype, metrics] of [
    ["field_change", "issue_field_changed", ["issue_field_updates"]],
    ["triage", "labeled", ["labels_applied", "items_triaged"]],
    ["relationship", "related", ["related_links"]],
  ]) {
    const input = envelope(family, subtype);
    const original = structuredClone(input);
    const output = normalizeGithubObservation(input);
    assert.deepEqual(
      output.facts.map((fact) => fact.metricId),
      metrics,
    );
    assert.ok(output.facts.every((fact) => fact.state === "observed" && fact.actorId === "202"));
    assert.ok(output.facts.every((fact) => fact.occurredAt === "2026-10-07T10:00:00.000Z"));
    assert.deepEqual(output.reasons, []);
    assert.deepEqual(input, original);
  }
});

test("automatic and unverified endpoint references remain unsupported for a real relationship kind", () => {
  for (const field of ["intentional", "publicEndpointsVerified"]) {
    const input = envelope("relationship", "related");
    input.payload.relationship[field] = false;
    const output = normalizeGithubObservation(input);
    assert.deepEqual(output.facts, []);
    assert.deepEqual(output.evidence, []);
    assert.ok(
      output.reasons.includes(
        field === "intentional" ? reasons.relationship : "relationship_endpoint_visibility_unverified",
      ),
    );
  }
});
