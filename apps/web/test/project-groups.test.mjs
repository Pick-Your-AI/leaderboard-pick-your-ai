import assert from "node:assert/strict";
import test from "node:test";
import { createService } from "../../service/dist/app.js";
import { at, readFixture } from "../../../tests/fixtures/pending-metric.mjs";
import { projectFixture } from "../../../tests/fixtures/public-project-context.mjs";
import { profile, evidence, ReadFailure, selection } from "../src/remote/client.ts";
import { projectGroups } from "../src/remote/project-groups.ts";

const selected = selection("?category=pr_merged&snapshot=synthetic-pending-1&limit=100");
async function response(t, input = projectFixture()) {
  const before = JSON.stringify(input);
  const app = createService({
    now: () => Date.parse(at),
    source: {
      async read() {
        return structuredClone(input);
      },
    },
  });
  t.after(() => app.close());
  const result = await app.inject("/api/v1/contributors/101?category=pr_merged&snapshot=synthetic-pending-1&limit=100");
  assert.equal(result.statusCode, 200, result.body.slice(0, 300));
  assert.equal(JSON.stringify(input), before);
  return result.json();
}

function parse(input) {
  const before = JSON.stringify(input);
  try {
    return profile(input, selected);
  } finally {
    assert.equal(JSON.stringify(input), before);
  }
}

test("actual service Project groups reference unique page proofs without changing independent totals", async (t) => {
  const raw = await response(t);
  const parsed = parse(raw);
  const groups = projectGroups(parsed.timeline);
  assert.deepEqual(
    groups.map((group) => group.projectId),
    ["PVT_A", "PVT_B"],
  );
  assert.equal(parsed.evidenceCount, 14);
  assert.equal(parsed.timeline.length, 14);
  assert.deepEqual(
    groups.map((group) => group.proofs.length),
    [14, 14],
  );
  assert.equal(
    new Set(groups.flatMap((group) => group.proofs.map((proof) => proof.contribution.contributionId))).size,
    14,
  );
  assert.deepEqual(parsed.categories, raw.categories);
  assert.deepEqual(parsed.results, raw.results);
  assert.ok(groups.every((group) => group.proofs[0] === parsed.timeline[0]));
});

test("legacy, explicit unknown and verified scoped-empty Project knowledge remain distinct", async (t) => {
  const input = projectFixture();
  for (const collection of [input.selected.evidence, input.selected.portfolioEvidence]) {
    delete collection[0].projectContext;
    Object.assign(collection[1].projectContext, { state: "unknown", projects: [], projectScope: [], observedAt: null });
    collection[2].projectContext.projects = [];
  }
  const parsed = parse(await response(t, input));
  const groups = projectGroups(parsed.timeline);
  assert.deepEqual(
    groups.map((group) => [group.state, group.proofs.length]),
    [
      ["project", 11],
      ["project", 11],
      ["empty", 1],
      ["unknown", 2],
    ],
  );
  assert.equal(
    parse(await response(t, readFixture())).timeline.every((proof) => proof.projectContext === undefined),
    true,
  );
});

test("the actual client rejects foreign, malformed and unversioned Project context before grouping", async (t) => {
  const original = await response(t);
  for (const mutate of [
    (context) => {
      context.binding.repositoryId = "other";
    },
    (context) => {
      context.binding.artifactId = "other";
    },
    (context) => {
      context.binding.contributionId = "other";
    },
    (context) => {
      context.basis = "current";
    },
    (context) => {
      context.schemaVersion = "public-project-context/v2";
    },
    (context) => {
      delete context.schemaVersion;
    },
    (context) => {
      context.state = ["known"];
    },
    (context) => {
      context.projects = [["PVT_A"]];
    },
    (context) => {
      context.projectScope = [];
    },
    (context) => {
      context.observedAt = null;
    },
    (context) => {
      context.title = "Unverified";
    },
  ]) {
    const raw = structuredClone(original);
    mutate(raw.timeline[0].projectContext);
    assert.throws(
      () => parse(raw),
      (error) => error instanceof ReadFailure && error.status === 502 && error.code === "invalid_api_response",
    );
  }
  const raw = structuredClone(original);
  raw.timeline[0].projectContext = null;
  assert.throws(() => parse(raw), { code: "invalid_api_response" });
  const proof = structuredClone(original.timeline[0]);
  proof.projectContext.binding.contributionId = "other";
  assert.throws(
    () => evidence(proof, selected),
    { code: "invalid_api_response" },
    "standalone evidence has the same subject admission",
  );
});

test("Project grouping admits the maximum declared scope while preserving canonical order and page population", async (t) => {
  const projects = Array.from({ length: 100 }, (_, index) => `${String(index).padStart(3, "0")}${"x".repeat(125)}`);
  const raw = await response(t, projectFixture({ count: 100, projects }));
  const parsed = parse(raw);
  assert.ok(raw.nextCursor, "byte paging retains a complete subset instead of flattening all proofs");
  assert.ok(parsed.timeline.length > 20 && parsed.timeline.length < 100);
  const groups = projectGroups(parsed.timeline);
  assert.deepEqual(
    groups.map((group) => group.projectId),
    projects,
  );
  assert.equal(
    groups.every((group) => group.proofs.length === parsed.timeline.length),
    true,
  );
  assert.equal(
    new Set(groups.flatMap((group) => group.proofs.map((proof) => proof.contribution.contributionId))).size,
    parsed.timeline.length,
  );
  assert.equal(parsed.evidenceCount, 100);
});
