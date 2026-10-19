import assert from "node:assert/strict";
import test from "node:test";
import { createPhysicalContextHarness, physicalSnapshotId } from "../../../tests/fixtures/physical-context.mjs";
import { board, selection, validateExport } from "../../web/src/remote/client.ts";
import { parseCSVExport } from "../../web/src/remote/csv-export.ts";
import { githubPhysicalContextReceiptSchema, physicalContextLimits } from "@pick-your-ai/contracts";
import { physicalFixture } from "../../../tests/fixtures/physical-context.mjs";
import { projectRead } from "../src/public-source.ts";

function harness(t, options) {
  const h = createPhysicalContextHarness(options);
  t.after(() => h.app.close());
  return h;
}
const query = (metric = "pr_lines_added") => `?metric=${metric}&snapshot=${physicalSnapshotId}`;
function allPhysicalMetrics(files) {
  const inputs = ["pr_lines_added", "pr_lines_removed", "pr_lines_changed", "files_changed"].map((metricId) =>
    physicalFixture({ metricId, ...(files === undefined ? {} : { files }) }),
  );
  const input = inputs[0];
  for (const field of ["rows", "ranking", "methodology", "physicalContexts", "evidence"])
    input.selected[field] = inputs.flatMap((entry) => entry.selected[field]);
  return input;
}
async function responses(h, metric = "pr_lines_added") {
  const values = [];
  for (const path of [
    `/api/v1/boards?metric=${metric}`,
    `/api/v1/boards${query(metric)}`,
    `/api/v1/exports${query(metric)}&format=json`,
    `/api/v1/exports${query(metric)}&format=csv`,
  ]) {
    const response = await h.app.inject(path);
    assert.equal(response.statusCode, 200, response.body);
    assert.doesNotMatch(
      response.body,
      /github-physical-context|canonicalIntegrationId|mergedEvidenceId|"physicalEvidence"|"physicalContexts"/,
    );
    const metricDefinition = values[0]?.metric;
    const parsed = path.endsWith("format=csv") ? parseCSVExport(response.body, metricDefinition, 20) : response.json();
    if (path.startsWith("/api/v1/exports")) validateExport(parsed, selection(query(metric)), metricDefinition);
    else board(parsed, selection(query(metric)));
    values.push(parsed);
  }
  return values;
}
for (const [metric, value, units] of [
  ["pr_lines_added", 17, 1],
  ["pr_lines_removed", 8, 1],
  ["pr_lines_changed", 25, 1],
  ["files_changed", 3, 3],
])
  test(`${metric}: current, pinned, JSON and CSV reconcile the same complete classified context`, async (t) => {
    const h = harness(t, { metricId: metric });
    const results = await responses(h, metric);
    for (const data of results) {
      const row = data.rows[0],
        context = row.physicalContext;
      assert.equal(row.result.value, value);
      assert.equal(row.rank, null);
      assert.equal(data.rankingPresentation.state, metric === "files_changed" ? "not_ranked" : "small_cohort");
      assert.equal(context.state, "available");
      assert.equal(context.unitCount, units);
      assert.equal(context.sampleCount, 1, "file or line units are not extra PR samples");
      assert.deepEqual(context.summary.raw, { files: 9, additions: 88, deletions: 56 });
      assert.deepEqual(context.summary.eligible, { files: 3, additions: 17, deletions: 8 });
      assert.deepEqual(context.summary.formattingOnly, { files: 1, additions: 4, deletions: 4 });
      assert.equal(Object.keys(context.summary.classes).length, 8);
      assert.deepEqual(context.samples.flatMap((sample) => sample.evidenceIds).sort(), [...row.evidenceIds].sort());
      assert.equal(data.coverage[0].state, "partial", "classification does not certify historical coverage");
      assert.notEqual(context.samples[0].beforeUrl, context.samples[0].afterUrl);
      assert.deepEqual(context, results[0].rows[0].physicalContext);
    }
  });
test("two canonical integrations are counted once each and all class arithmetic composes", async (t) => {
  const h = harness(t, { sampleCount: 2 });
  for (const data of await responses(h)) {
    assert.equal(data.rows[0].result.value, 34);
    assert.equal(data.rows[0].physicalContext.sampleCount, 2);
    assert.deepEqual(data.rows[0].physicalContext.summary.raw, { files: 18, additions: 176, deletions: 112 });
    assert.equal(data.rows[0].physicalContext.summary.classes.tests.eligible.deletions, 10);
  }
});
test("a measured physical zero remains distinct from absent retained context", async (t) => {
  const h = harness(t, { files: [] });
  const value = (await responses(h))[0].rows[0];
  assert.equal(value.result.value, 0);
  assert.equal(value.physicalContext.state, "available");
  assert.deepEqual(value.physicalContext.summary.eligible, { files: 0, additions: 0, deletions: 0 });
  delete h.input.selected.physicalContexts;
  for (const data of await responses(h)) {
    assert.equal(data.rows[0].result.value, 0);
    assert.equal(data.rows[0].physicalContext.state, "unknown");
    assert.equal(data.rows[0].physicalContext.summary, undefined);
  }
});
const substitutions = [
  [
    "selected fact",
    (h) => {
      h.input.selected.physicalContexts[0].samples[0].receipt.facts.find(
        (f) => f.metricId === "pr_lines_added",
      ).factId = `gh:${"a".repeat(64)}`;
    },
  ],
  [
    "canonical fact",
    (h) => {
      h.input.selected.physicalContexts[0].samples[0].receipt.facts.find(
        (f) => f.metricId === "pr_lines_added",
      ).canonicalKey = `gh:${"a".repeat(64)}`;
    },
  ],
  [
    "merge proof",
    (h) => {
      h.input.selected.physicalContexts[0].samples[0].mergedEvidenceId = `gh:${"a".repeat(64)}`;
    },
  ],
  [
    "merged revision",
    (h) => {
      h.input.selected.physicalContexts[0].samples[0].receipt.after = "d".repeat(40);
    },
  ],
  [
    "original actor",
    (h) => {
      h.input.selected.physicalContexts[0].samples[0].receipt.actorId = "202";
    },
  ],
  [
    "policy binding",
    (h) => {
      h.input.selected.physicalContexts[0].policySignature = "f".repeat(64);
    },
  ],
  [
    "future integration",
    (h) => {
      h.input.selected.physicalContexts[0].samples[0].receipt.integratedAt = "2026-10-20T00:00:00.000Z";
    },
  ],
  [
    "missing dependency",
    (h) => {
      h.input.selected.physicalEvidence.pop();
    },
  ],
];
for (const [name, change] of substitutions)
  test(`schema-valid ${name} substitution cannot authorize a partial physical context`, async (t) => {
    const h = harness(t, { sampleCount: 2 });
    change(h);
    for (const sample of h.input.selected.physicalContexts[0].samples)
      assert.equal(githubPhysicalContextReceiptSchema.safeParse(sample.receipt).success, true);
    for (const data of await responses(h)) {
      const row = data.rows[0];
      assert.equal(row.result.value, 34, "the independently selected metric is not a context subtotal");
      assert.equal(row.physicalContext.state, "unknown");
      assert.equal(row.physicalContext.reason, "current_context_unavailable");
      for (const key of ["summary", "samples", "sampleCount", "unitCount"])
        assert.equal(row.physicalContext[key], undefined);
    }
  });
test("collapsed file units do not advertise the complete original inventory", async (t) => {
  const h = harness(t, { metricId: "files_changed" });
  h.input.selected.rows[0].evidenceIds.pop();
  h.input.selected.rows[0].result.value = 2;
  for (const data of await responses(h, "files_changed")) {
    assert.equal(data.rows[0].result.value, 2);
    assert.equal(data.rows[0].physicalContext.state, "unknown");
  }
});
test("all private copies participate in visibility checks before any public counts or pins", async (t) => {
  const h = harness(t);
  h.input.selected.physicalEvidence[0].artifact.visibility = "private";
  for (const path of [
    `/api/v1/boards${query()}`,
    `/api/v1/exports${query()}`,
    `/api/v1/exports${query()}&format=csv`,
  ]) {
    const response = await h.app.inject(path);
    assert.equal(response.statusCode, 503);
    assert.match(response.body, /public_projection_unavailable/);
    assert.equal(response.headers["cache-control"], "no-store");
    assert.doesNotMatch(response.body, /bbbbbbbb|cccccccc|synthetic-author|physicalContext|"value"/);
  }
});
test("current actor, artifact and role privacy applies equally to historical pins and exports", async (t) => {
  const h = harness(t);
  for (const action of [
    () => {
      h.input.controls.suppressedActorIds = ["101"];
    },
    () => {
      h.input.controls.suppressedActorIds = [];
      h.input.controls.suppressedArtifactIds = [h.input.selected.evidence[0].artifact.stableId];
    },
  ]) {
    action();
    for (const data of await responses(h)) assert.deepEqual(data.rows, []);
  }
  h.input.controls.suppressedArtifactIds = [];
  const { canonicalPublicScope } = await import("@pick-your-ai/contracts");
  h.input.selected.scope = canonicalPublicScope({
    organization: "Pick-Your-AI",
    repository: null,
    workstream: null,
    start: null,
    end: null,
    context: "event",
    projects: [],
    roles: ["reviewer"],
  });
  const response = await h.app.inject(`/api/v1/boards${query()}&role=reviewer`);
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json().rows, []);
});
test("public size budget withholds the whole context only after current dependency privacy", async (t) => {
  const h = harness(t, { sampleCount: 220 });
  let data = (await responses(h))[0];
  assert.equal(data.rows[0].physicalContext.state, "unknown");
  assert.equal(data.rows[0].physicalContext.reason, "context_budget_exceeded");
  assert.equal(data.rows[0].result.value, 3740);
  h.input.selected.physicalEvidence.pop();
  data = (await responses(h))[0];
  assert.equal(data.rows[0].physicalContext.reason, "current_context_unavailable");
  assert.equal(data.rows[0].physicalContext.summary, undefined);
});

test("the full 10000-file receipt budget survives four metric copies without exposing a partial inventory", () => {
  const input = allPhysicalMetrics(
    Array.from({ length: 10000 }, (_, index) => ({
      path: `src/synthetic-${index}.ts`,
      additions: 1,
      deletions: 0,
    })),
  );
  const refs = input.selected.physicalContexts.reduce(
    (sum, candidate) => sum + candidate.samples[0].receipt.facts.length,
    0,
  );
  assert.equal(refs, 40012, "four complete copies must not consume four distinct-source budgets");
  assert.equal(input.selected.evidence.length, 10003);
  const projected = projectRead(input, input.selected.scope, null);
  for (const row of projected.selected.rows) {
    assert.equal(row.result.value, row.result.metricId === "pr_lines_removed" ? 0 : 10000);
    const context = row.physicalContext;
    if (row.result.metricId === "files_changed") {
      assert.equal(context.state, "unknown");
      assert.equal(context.reason, "context_budget_exceeded");
      assert.equal(context.summary, undefined);
      assert.equal(context.samples, undefined);
    } else {
      assert.equal(context.state, "available");
      assert.equal(context.sampleCount, 1);
      assert.equal(context.summary.eligible.files, 10000);
    }
  }
  input.selected.physicalEvidence = [];
  for (const row of projectRead(input, input.selected.scope, null).selected.rows) {
    assert.equal(row.physicalContext.state, "unknown");
    assert.equal(row.physicalContext.reason, "current_context_unavailable");
    assert.equal(row.physicalContext.summary, undefined);
  }
  const repeated = input.selected.physicalContexts[0];
  repeated.samples = Array(17).fill(repeated.samples[0]);
  assert.throws(
    () => projectRead(input, input.selected.scope, null),
    /public_projection_unavailable/,
    "the separate raw work cap applies before parsing repeated large receipts",
  );
});

for (const [name, change] of [
  [
    "before revision",
    (sample) => {
      sample.receipt.before = "d".repeat(40);
    },
  ],
  [
    "classified inventory",
    (sample) => {
      sample.receipt.summary.raw.additions++;
      sample.receipt.summary.classes.source.raw.additions++;
      sample.receipt.summary.formattingOnly.additions++;
    },
  ],
  [
    "fact order",
    (sample) => {
      sample.receipt.facts.reverse();
    },
  ],
  [
    "merge dependency",
    (sample) => {
      sample.mergedEvidenceId = `gh:${"a".repeat(64)}`;
    },
  ],
])
  test(`same-integration ${name} disagreement cannot be discounted as an identical metric copy`, () => {
    const input = allPhysicalMetrics();
    assert.doesNotThrow(() => projectRead(input, input.selected.scope, null));
    const sample = input.selected.physicalContexts[3].samples[0];
    change(sample);
    assert.equal(githubPhysicalContextReceiptSchema.safeParse(sample.receipt).success, true);
    assert.throws(() => projectRead(input, input.selected.scope, null), /public_projection_unavailable/);
  });
test("oversized sample lists are rejected before any zero-fact entry is read", () => {
  const input = allPhysicalMetrics();
  assert.doesNotThrow(() => projectRead(input, input.selected.scope, null));
  let sampleReads = 0;
  const sample = { receipt: { facts: [] } };
  const samples = Array(physicalContextLimits.units + 1).fill(sample);
  Object.defineProperty(samples, 0, {
    get() {
      sampleReads++;
      return sample;
    },
  });
  input.selected.physicalContexts[0].samples = samples;
  let rejection;
  assert.throws(
    () => projectRead(input, input.selected.scope, null),
    (error) => {
      rejection = error;
      return true;
    },
  );
  assert.equal(sampleReads, 0, "over-limit input must not be traversed even when each receipt has no fact references");
  assert.match(String(rejection), /public_projection_unavailable/);
});
test("repeating a complete receipt inside one metric does not acquire cross-metric deduplication credit", () => {
  const input = allPhysicalMetrics();
  input.selected.physicalContexts[0].samples.push(structuredClone(input.selected.physicalContexts[0].samples[0]));
  assert.throws(() => projectRead(input, input.selected.scope, null), /public_projection_unavailable/);
});
for (const scope of [{}, { context: "current", projects: [] }, { context: "event", projects: [], roles: ["author"] }])
  test(`legacy ${JSON.stringify(scope)} never gains inferred context or new export columns`, async (t) => {
    const h = harness(t, { legacy: true, scope });
    const { canonicalPublicScope, publicScopeParameters } = await import("@pick-your-ai/contracts");
    const params = new URLSearchParams(publicScopeParameters(canonicalPublicScope(h.input.selected.scope)));
    params.set("metric", "pr_lines_added");
    params.set("snapshot", physicalSnapshotId);
    for (const format of ["json", "csv"]) {
      const response = await h.app.inject(`/api/v1/exports?${params}&format=${format}`);
      assert.equal(response.statusCode, 200, response.body);
      assert.doesNotMatch(response.body, /physicalContext|physical_context|ranking_presentation|rankingPresentation/);
    }
  });
