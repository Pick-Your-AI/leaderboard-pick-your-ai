import assert from "node:assert/strict";
import test from "node:test";
import { publicProjectContextSchema, publicProjectContextMatches } from "../dist/index.js";

const value = () => ({
  schemaVersion: "public-project-context/v1",
  binding: { repositoryId: "2", artifactId: "native:subject", contributionId: "native:event" },
  basis: "current",
  state: "known",
  projects: ["PVT_A"],
  projectScope: ["PVT_A", "PVT_B"],
  observedAt: "2026-10-02T01:00:00+01:00",
});

test("Project context preserves exact known, scoped-empty and unknown receipts without normalization", () => {
  for (const context of [
    value(),
    { ...value(), basis: "event" },
    { ...value(), projects: [] },
    { ...value(), state: "unknown", projects: [], projectScope: [], observedAt: null },
  ]) {
    const before = JSON.stringify(context);
    assert.deepEqual(publicProjectContextSchema.parse(context), context);
    assert.equal(JSON.stringify(context), before);
  }
});

test("Project context rejects coercion, extensions, unversioned input and contradictory knowledge", () => {
  for (const change of [
    { schemaVersion: undefined },
    { schemaVersion: "public-project-context/v2" },
    { title: "Unverified title" },
    { basis: ["current"] },
    { state: ["known"] },
    { state: "Known" },
    { projects: null },
    { projects: [["PVT_A"]] },
    { projectScope: [] },
    { projects: ["PVT_other"] },
    { state: "unknown" },
    { observedAt: null },
    { observedAt: "2026-02-30T00:00:00Z" },
  ]) {
    const input = { ...value(), ...change };
    const before = JSON.stringify(input);
    assert.equal(publicProjectContextSchema.safeParse(input).success, false, before);
    assert.equal(JSON.stringify(input), before);
  }
  for (const input of [null, [], "known"]) assert.equal(publicProjectContextSchema.safeParse(input).success, false);
});

test("Project IDs retain the canonical ordered 100 by 128 bound and reject ambiguous spelling", () => {
  const ids = Array.from({ length: 100 }, (_, index) => `${String(index).padStart(3, "0")}${"x".repeat(125)}`);
  assert.deepEqual(publicProjectContextSchema.parse({ ...value(), projects: ids, projectScope: ids }).projects, ids);
  for (const ids of [
    ["PVT_B", "PVT_A"],
    ["PVT_A", "PVT_A"],
    ["PVT_A\n"],
    ["PVT_A "],
    [" PVT_A"],
    ["PVT_é"],
    ["PVT_\ud800"],
    ["x".repeat(129)],
    Array.from({ length: 101 }, (_, i) => `PVT_${i}`),
  ]) {
    assert.equal(publicProjectContextSchema.safeParse({ ...value(), projects: ids, projectScope: ids }).success, false);
  }
});

test("Project context binds repository, native artifact, contribution and basis independently", () => {
  const context = publicProjectContextSchema.parse(value());
  const artifact = { repositoryId: "2", stableId: "native:subject" };
  const contribution = { contributionId: "native:event", artifactId: "native:subject" };
  assert.equal(publicProjectContextMatches(context, artifact, contribution, "current"), true);
  for (const [a, c, basis] of [
    [{ ...artifact, repositoryId: "3" }, contribution, "current"],
    [{ ...artifact, stableId: "other" }, contribution, "current"],
    [artifact, { ...contribution, contributionId: "other" }, "current"],
    [artifact, { ...contribution, artifactId: "other" }, "current"],
    [artifact, contribution, "event"],
  ])
    assert.equal(publicProjectContextMatches(context, a, c, basis), false);
});
