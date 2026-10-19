import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { normalizeGithubObservation } from "../dist/index.js";
import { githubPhysicalContextReceiptSchema } from "../../contracts/dist/index.js";

const fixture = JSON.parse(await readFile(new URL("fixtures/engineering.json", import.meta.url), "utf8"));
const before = "b".repeat(40),
  after = "c".repeat(40);
const at = "2026-10-07T10:00:00.000Z",
  observedAt = "2026-10-08T10:00:00.000Z";
const files = [
  { path: "src/main.ts", additions: 10, deletions: 2 },
  { path: "docs/guide.md", additions: 3, deletions: 1 },
  { path: "test/behavior.mjs", additions: 4, deletions: 5 },
  { path: "src/format.ts", additions: 4, deletions: 4, formattingOnly: true },
  { path: "generated/output.ts", additions: 20, deletions: 0 },
  { path: "vendor/dependency.ts", additions: 7, deletions: 3 },
  { path: "package-lock.json", additions: 10, deletions: 11 },
  { path: "assets/image.png", additions: 0, deletions: 0, binary: true },
  { path: "src/import.ts", additions: 30, deletions: 30, imported: true },
];
function observation(selected = files) {
  return {
    repository: { id: 2, slug: "synthetic-owner/repository", visibility: "public", defaultBranch: "main" },
    proof: { verified: true, source: "github_webhook", revision: at, eventId: "synthetic-context", isSynthetic: true },
    family: "pull_request",
    action: "closed",
    occurredAt: at,
    observedAt,
    payload: {
      repository: fixture.repository,
      pull_request: {
        ...structuredClone(fixture.pull_request),
        user: fixture.author,
        merged_by: fixture.merger,
        merged: true,
        merged_at: at,
        merge_commit_sha: after,
        base: { ref: "main" },
      },
      sender: fixture.merger,
    },
    integration: {
      before,
      after,
      targetBranch: "main",
      defaultBranch: "main",
      canonicalChangeId: "exact-integration",
      commitShas: [after],
      diff: { before, after, complete: true, files: structuredClone(selected) },
    },
  };
}
const physicalIds = new Set(["pr_lines_added", "pr_lines_removed", "pr_lines_changed", "files_changed"]);

test("one pinned integration retains exact physical classes and original emitted fact bindings", () => {
  const input = observation(),
    output = normalizeGithubObservation(input),
    receipt = output.physicalContext;
  assert.ok(receipt);
  assert.equal(receipt.schemaVersion, "github-physical-context/v1");
  assert.equal(receipt.classifierVersion, "github-path-classifier/v1");
  assert.equal(receipt.repositoryId, "2");
  assert.equal(receipt.artifactId, output.facts.find((fact) => fact.metricId === "pr_merged").artifactId);
  assert.equal(receipt.actorId, "101");
  assert.equal(receipt.canonicalIntegrationId, "exact-integration");
  assert.equal(receipt.before, before);
  assert.equal(receipt.after, after);
  assert.equal(receipt.integratedAt, at);
  assert.equal(receipt.targetBranch, "main");
  assert.deepEqual(receipt.summary.raw, { files: 9, additions: 88, deletions: 56 });
  assert.deepEqual(receipt.summary.eligible, { files: 3, additions: 17, deletions: 8 });
  assert.deepEqual(receipt.summary.formattingOnly, { files: 1, additions: 4, deletions: 4 });
  assert.deepEqual(receipt.summary.classes.source.raw, { files: 2, additions: 14, deletions: 6 });
  assert.deepEqual(receipt.summary.classes.source.eligible, { files: 1, additions: 10, deletions: 2 });
  assert.deepEqual(receipt.summary.classes.docs.eligible, { files: 1, additions: 3, deletions: 1 });
  assert.deepEqual(receipt.summary.classes.tests.eligible, { files: 1, additions: 4, deletions: 5 });
  for (const kind of ["generated", "vendor", "lock", "binary", "imported"])
    assert.deepEqual(receipt.summary.classes[kind].eligible, { files: 0, additions: 0, deletions: 0 });
  assert.deepEqual(
    receipt.facts,
    output.facts
      .filter((fact) => physicalIds.has(fact.metricId))
      .map((fact) => ({
        factId: fact.id,
        canonicalKey: fact.canonicalKey,
        metricId: fact.metricId,
        quantity: fact.quantity ?? 1,
      })),
  );
  assert.equal(receipt.facts.length, 6);
  const serialized = JSON.stringify(receipt);
  for (const file of files) assert.equal(serialized.includes(file.path), false);
  input.integration.diff.files[0].additions = 900;
  input.integration.after = "d".repeat(40);
  assert.equal(receipt.after, after);
  assert.equal(receipt.summary.eligible.additions, 17);
});

for (const [beforeWidth, afterWidth] of [
  [40, 40],
  [64, 64],
  [40, 64],
  [64, 40],
])
  test(`private physical receipt ${beforeWidth}/${afterWidth} pins require one storage-format width`, () => {
    const original = normalizeGithubObservation(observation()).physicalContext;
    assert.ok(original);
    const receipt = structuredClone(original);
    receipt.before = "b".repeat(beforeWidth);
    receipt.after = "c".repeat(afterWidth);
    assert.equal(githubPhysicalContextReceiptSchema.safeParse(receipt).success, beforeWidth === afterWidth);
    assert.deepEqual(receipt.facts, original.facts);
    assert.deepEqual(receipt.summary, original.summary);
  });

test("complete zero and negative descriptive net remain separate from missing context", () => {
  const zero = normalizeGithubObservation(observation([])).physicalContext;
  assert.ok(zero);
  assert.deepEqual(zero.summary.eligible, { files: 0, additions: 0, deletions: 0 });
  assert.equal(zero.facts.length, 3);
  assert.ok(zero.facts.every((fact) => fact.quantity === 0));
  const negative = normalizeGithubObservation(observation([{ path: "src/deletion.ts", additions: 0, deletions: 7 }]));
  assert.equal(
    negative.physicalContext.summary.eligible.additions - negative.physicalContext.summary.eligible.deletions,
    -7,
  );
  assert.equal(
    negative.facts.some((fact) => fact.metricId === "net_lines"),
    false,
  );
});

test("receipt absence never changes existing physical units or invents unverified PR pins", async (t) => {
  const original = normalizeGithubObservation(observation());
  for (const [name, mutate] of [
    [
      "missing merge revision",
      (input) => {
        delete input.payload.pull_request.merge_commit_sha;
      },
    ],
    [
      "different merge revision",
      (input) => {
        input.payload.pull_request.merge_commit_sha = "d".repeat(40);
      },
    ],
    [
      "unmerged source",
      (input) => {
        input.payload.pull_request.merged = false;
      },
    ],
    [
      "unknown target",
      (input) => {
        delete input.payload.pull_request.base;
      },
    ],
    [
      "different original clock",
      (input) => {
        input.occurredAt = "2026-10-07T09:00:00.000Z";
      },
    ],
  ])
    await t.test(name, () => {
      const input = observation();
      mutate(input);
      const output = normalizeGithubObservation(input);
      assert.equal(Object.hasOwn(output, "physicalContext"), false);
      assert.deepEqual(output.physicalDiff, original.physicalDiff);
      assert.deepEqual(
        output.facts.filter((fact) => physicalIds.has(fact.metricId)).map((fact) => [fact.metricId, fact.quantity]),
        original.facts.filter((fact) => physicalIds.has(fact.metricId)).map((fact) => [fact.metricId, fact.quantity]),
      );
    });
  const incomplete = observation();
  incomplete.integration.diff.complete = false;
  assert.equal(normalizeGithubObservation(incomplete).physicalContext, undefined);
  const hidden = observation();
  hidden.repository.visibility = "private";
  const output = normalizeGithubObservation(hidden);
  assert.equal(output.physicalContext, undefined);
  assert.equal(output.facts.length, 0);
});

test("closed receipt rejects mismatched fact, inventory, exclusion and revision assertions", async (t) => {
  const original = normalizeGithubObservation(observation()).physicalContext;
  assert.ok(githubPhysicalContextReceiptSchema.safeParse(original).success);
  for (const [name, mutate] of [
    [
      "duplicate fact",
      (value) => {
        value.facts[1] = structuredClone(value.facts[0]);
      },
    ],
    [
      "missing selected file",
      (value) => {
        value.facts.pop();
      },
    ],
    [
      "changed scalar",
      (value) => {
        value.facts.find((fact) => fact.metricId === "pr_lines_added").quantity++;
      },
    ],
    [
      "invented file count",
      (value) => {
        value.facts.find((fact) => fact.metricId === "files_changed").quantity = 2;
      },
    ],
    [
      "wrong canonical key",
      (value) => {
        value.facts[0].canonicalKey = "unbound";
      },
    ],
    [
      "raw inventory mismatch",
      (value) => {
        value.summary.raw.files++;
      },
    ],
    [
      "ineligible class admitted",
      (value) => {
        value.summary.classes.vendor.eligible.files = 1;
      },
    ],
    [
      "formatting mismatch",
      (value) => {
        value.summary.formattingOnly.additions--;
      },
    ],
    [
      "unsafe aggregate",
      (value) => {
        value.summary.raw.additions = Number.MAX_SAFE_INTEGER;
        value.summary.raw.deletions = 1;
      },
    ],
    [
      "same revisions",
      (value) => {
        value.before = value.after;
      },
    ],
    [
      "non-PR source",
      (value) => {
        value.sourceKind = "commit";
      },
    ],
    [
      "unreviewed classifier",
      (value) => {
        value.classifierVersion = "latest";
      },
    ],
    [
      "injected private payload",
      (value) => {
        value.payload = { secret: "synthetic-private-value" };
      },
    ],
  ])
    await t.test(name, () => {
      const value = structuredClone(original);
      mutate(value);
      assert.equal(githubPhysicalContextReceiptSchema.safeParse(value).success, false);
    });
});
