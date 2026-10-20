import assert from "node:assert/strict";
import test from "node:test";
import { normalizeGithubObservation, summarizeRepositoryNetLines } from "../dist/index.js";
import { aggregateMetric, getMetricDefinition } from "../../metrics/dist/index.js";

const at = "2026-10-07T10:00:00Z";
const scope = {
  repositoryIds: [2],
  from: "2026-10-01T00:00:00Z",
  to: "2026-11-01T00:00:00Z",
  cutoff: "2026-11-02T00:00:00Z",
};
function source({
  repositoryId = 2,
  before = "a".repeat(40),
  after = "b".repeat(40),
  canonicalId = "synthetic-change",
  occurredAt = at,
  additions = 10,
  deletions = 3,
} = {}) {
  const slug = `synthetic-owner/repository-${repositoryId}`;
  return {
    repository: { id: repositoryId, slug, visibility: "public", defaultBranch: "main" },
    family: "commit",
    action: "default_branch_integrated",
    occurredAt,
    observedAt: "2026-11-01T12:00:00Z",
    proof: {
      verified: true,
      source: "github_rest",
      revision: after,
      eventId: `synthetic-integration-${after}`,
      isSynthetic: true,
    },
    payload: {
      sha: after,
      html_url: `https://github.com/${slug}/commit/${after}`,
      repository: { id: repositoryId, private: false },
      author: null,
      committer: null,
      commit: { message: "Synthetic source text must not appear in the projection" },
    },
    integration: {
      before,
      after,
      defaultBranch: "main",
      targetBranch: "main",
      canonicalChangeId: canonicalId,
      commitShas: [after],
      diff: { before, after, complete: true, files: [{ path: "src/example.ts", additions, deletions }] },
    },
  };
}
const summarize = (sources, patch = {}) => summarizeRepositoryNetLines(sources, { ...scope, ...patch });
const row = (sources, patch = {}) => summarize(sources, patch).rows[0];
const noCredit = (input, reason) => {
  const actual = row([input]);
  assert.equal(actual.knownNetLines, null);
  assert.equal(actual.knownIntegrations, 0);
  assert.equal(actual.state, "unknown");
  assert.ok(actual.reasons.includes(reason), JSON.stringify(actual));
};

test("net_lines counts signed verified repository integrations without an actor-row sum", () => {
  const input = [source(), source({ repositoryId: 3, additions: 2, deletions: 9 })];
  assert.ok(normalizeGithubObservation(input[0]).facts.every((fact) => fact.actorId === null));
  const result = summarize(input, { repositoryIds: [3, 2] });
  assert.deepEqual(
    result.rows.map((entry) => [entry.repositoryId, entry.knownAdditions, entry.knownDeletions, entry.knownNetLines]),
    [
      ["2", 10, 3, 7],
      ["3", 2, 9, -7],
    ],
  );
  assert.equal(result.unit, getMetricDefinition("net_lines").definition.unit);
  assert.equal(result.aggregation, getMetricDefinition("net_lines").definition.aggregation);
  assert.equal(result.publicEnabled, false);
  assert.equal(result.ranked, false);
  assert.equal(result.coverage, "incomplete");
});

test("net_lines replay and observation-clock changes conserve one canonical integration", () => {
  const one = source(),
    replay = structuredClone(one);
  replay.proof.eventId = "synthetic-replay";
  replay.observedAt = "2026-11-01T15:00:00Z";
  replay.occurredAt = "2026-10-07T10:00:00.000Z";
  const result = summarize([one, replay, one]);
  assert.equal(result.rows[0].knownIntegrations, 1);
  assert.equal(result.rows[0].knownNetLines, 7);
  assert.deepEqual(summarize([replay, one]), result);
});

test("net_lines distinct integrations retain signed cancellation as a known subtotal", () => {
  const first = source();
  const second = source({
    before: "b".repeat(40),
    after: "c".repeat(40),
    canonicalId: "synthetic-next",
    additions: 1,
    deletions: 8,
  });
  const result = summarize([first, second]);
  assert.equal(result.rows[0].knownNetLines, 0);
  assert.equal(result.rows[0].knownIntegrations, 2);
  assert.equal(result.rows[0].state, "partial");
  assert.equal(result.coverage, "incomplete");
  assert.equal(row([]).knownNetLines, null, "No supplied integration cannot establish measured zero");
});

test("net_lines reuses physical classification rather than counting excluded file categories", () => {
  const input = source();
  input.integration.diff.files.push(
    { path: "docs/readme.md", additions: 4, deletions: 1 },
    { path: "test/unit.test.ts", additions: 2, deletions: 0 },
    ...["vendor/lib.js", "build/out.js", "package-lock.json"].map((path) => ({ path, additions: 1000, deletions: 0 })),
    { path: "image.bin", additions: 0, deletions: 1000, binary: true },
    { path: "src/import.ts", additions: 1000, deletions: 0, imported: true },
    { path: "src/format.ts", additions: 1000, deletions: 1000, formattingOnly: true },
  );
  const actual = row([input]);
  assert.equal(actual.knownAdditions, 16);
  assert.equal(actual.knownDeletions, 4);
  assert.equal(actual.knownNetLines, 12);
});

test("net_lines source integration clock owns half-open windows and later observations cannot backfill them", () => {
  const low = source({ occurredAt: scope.from });
  const high = source({ occurredAt: scope.to, after: "c".repeat(40), canonicalId: "synthetic-at-end" });
  const older = source({
    occurredAt: "2026-09-30T23:59:59.999Z",
    after: "d".repeat(40),
    canonicalId: "synthetic-before-start",
  });
  assert.equal(row([low, high, older]).knownIntegrations, 1);
  const futureObservation = source();
  futureObservation.observedAt = "2026-11-03T00:00:00Z";
  assert.equal(row([futureObservation]).knownNetLines, null);
  assert.equal(row([source({ occurredAt: null })]).knownNetLines, null);
});

test("net_lines missing, future and unsupported-precision source clocks remain unavailable", () => {
  for (const occurredAt of [
    null,
    undefined,
    "2026-11-02T00:00:00Z",
    "2026-10-07T10:00:00.000001Z",
    "2026-10-07T06:00:00-04:00",
    "2026-02-30T10:00:00Z",
  ]) {
    const input = source();
    input.occurredAt = occurredAt;
    noCredit(input, "integration_time_unverified");
  }
});

test("net_lines public source and host proof are required independently of payload claims", () => {
  for (const verified of [false, undefined, "true"]) {
    const input = source();
    input.proof.verified = verified;
    input.payload.integration_verified = true;
    noCredit(input, "integration_source_unverified");
  }
  for (const visibility of ["private", "unknown"]) {
    const hidden = source();
    hidden.repository.visibility = visibility;
    const result = row([source(), hidden]);
    assert.equal(result.knownNetLines, null);
    assert.deepEqual(result.changeIds, []);
    assert.ok(result.reasons.includes("public_repository_visibility_unverified"));
  }
  const privatePayload = source();
  privatePayload.payload.repository.private = true;
  assert.equal(row([source(), privatePayload]).knownNetLines, null);
});

test("net_lines other repositories and mismatched payload identities cannot enter selected totals", () => {
  const input = source({ repositoryId: 3 });
  const result = summarize([input]);
  assert.equal(result.outsideScopeObservations, 1);
  assert.equal(result.rows[0].knownNetLines, null);
  const mismatch = source();
  mismatch.payload.repository.id = 3;
  noCredit(mismatch, "integration_diff_unavailable");
});

test("net_lines requires the known repository default branch rather than a staging branch", () => {
  for (const change of [
    (input) => {
      delete input.integration;
    },
    (input) => {
      delete input.repository.defaultBranch;
    },
    (input) => {
      input.integration.defaultBranch = "other";
    },
    (input) => {
      input.integration.targetBranch = "staging";
    },
  ]) {
    const input = source();
    change(input);
    noCredit(input, "default_branch_integration_unverified");
  }
});

test("net_lines requires an integration-commit envelope, not a PR diff or personal attribution", () => {
  const input = source();
  input.family = "pull_request";
  noCredit(input, "integration_commit_required");
  const valid = source();
  valid.payload.author = { id: 101, node_id: "U_SYNTHETIC_101", login: "synthetic-author", type: "User" };
  valid.payload.committer = { id: 202, node_id: "U_SYNTHETIC_202", login: "synthetic-pusher", type: "User" };
  assert.equal(row([valid]).knownNetLines, row([source()]).knownNetLines);
  assert.ok(!JSON.stringify(summarize([valid])).includes("synthetic-author"));
  assert.ok(!JSON.stringify(summarize([valid])).includes("synthetic-pusher"));
});

test("net_lines exact commit URL, after identity and enumerated integration membership are mandatory", () => {
  for (const change of [
    (input) => {
      input.payload.sha = "c".repeat(40);
    },
    (input) => {
      input.payload.html_url += "?source=unverified";
    },
    (input) => {
      input.payload.html_url = input.payload.html_url.replace("repository-2", "other");
    },
    (input) => {
      input.payload.pull_request = { id: 10, html_url: "https://github.com/synthetic-owner/repository-2/pull/10" };
    },
    (input) => {
      input.payload.sha = input.payload.sha.toUpperCase();
    },
  ]) {
    const input = source();
    change(input);
    noCredit(input, "integration_commit_identity_unverified");
  }
  const missing = source();
  missing.integration.commitShas = ["c".repeat(40)];
  noCredit(missing, "integration_pins_or_identity_unverified");
});

test("net_lines incomplete diffs remain unknown while an actual empty complete diff has a known zero subtotal", () => {
  const truncated = source();
  truncated.integration.diff.complete = false;
  noCredit(truncated, "integration_diff_unavailable");
  const empty = source();
  empty.integration.diff.files = [];
  assert.equal(row([empty]).knownNetLines, 0);
  assert.equal(row([empty]).knownIntegrations, 1);
  assert.equal(row([empty]).state, "partial");
  const absent = source();
  delete absent.integration.diff;
  noCredit(absent, "integration_diff_unavailable");
});

test("net_lines competing interpretations of one canonical integration are withheld before window filtering", () => {
  for (const change of [
    (input) => {
      input.integration.diff.files[0].additions++;
    },
    (input) => {
      input.occurredAt = "2026-09-30T00:00:00Z";
    },
    (input) => {
      input.integration.diff.files[0].path = "src/other.ts";
    },
  ]) {
    const changed = source();
    change(changed);
    const result = summarize([source(), changed]);
    assert.equal(result.rows[0].knownNetLines, null);
    assert.ok(result.rows[0].reasons.includes("conflicting_integration_unit"));
    assert.deepEqual(summarize([changed, source()]), result);
  }
});

test("net_lines a second canonical name cannot credit the same repository integration twice", () => {
  const second = source({ canonicalId: "synthetic-alias" });
  const result = row([source(), second]);
  assert.equal(result.knownNetLines, null);
  assert.equal(result.knownIntegrations, 0);
  assert.ok(result.reasons.includes("conflicting_integration_unit"));
  assert.deepEqual(summarize([second, source()]), summarize([source(), second]));
});

test("net_lines independent repository namespaces preserve otherwise identical integrations", () => {
  const result = summarize([source(), source({ repositoryId: 3 })], { repositoryIds: [2, 3] });
  assert.deepEqual(
    result.rows.map((entry) => entry.knownNetLines),
    [7, 7],
  );
  assert.notEqual(result.rows[0].changeIds[0], result.rows[1].changeIds[0]);
});

test("net_lines retained known subtotals do not turn missing integration evidence into measured completeness", () => {
  const missing = source({ after: "c".repeat(40), canonicalId: "synthetic-unavailable" });
  missing.integration.diff.complete = false;
  const result = summarize([source(), missing]);
  assert.equal(result.rows[0].knownNetLines, 7);
  assert.equal(result.rows[0].unavailableObservations, 1);
  assert.equal(result.rows[0].state, "partial");
  assert.equal(result.coverage, "incomplete");
});

test("net_lines malformed pins, paths and quantities cannot manufacture a signed result", () => {
  for (const change of [
    (input) => {
      input.integration.diff.before = "c".repeat(40);
    },
    (input) => {
      input.integration.diff.files[0].path = "../private";
    },
    (input) => {
      input.integration.diff.files[0].additions = -1;
    },
    (input) => {
      input.integration.diff.files[0].deletions = 0.5;
    },
    (input) => {
      input.integration.diff.files.push(input.integration.diff.files[0]);
    },
    (input) => {
      input.integration.diff.files = new Array(1);
    },
    (input) => {
      input.integration.diff.complete = "true";
    },
    (input) => {
      input.integration.before = "a".repeat(41);
    },
  ]) {
    const input = source();
    change(input);
    assert.equal(row([input]).knownNetLines, null);
  }
});

test("net_lines dense bounded selections and explicit valid windows are required", () => {
  for (const repositoryIds of [[], [2, 2], [0], [2.5], ["2"], new Array(1)])
    assert.throws(() => summarize([], { repositoryIds }), /bounded/);
  assert.throws(() => summarize(new Array(1)), /bounded/);
  assert.throws(() => summarize(Array.from({ length: 10_001 }, () => source())), /bounded/);
  for (const patch of [
    { from: scope.to },
    { to: scope.from },
    { cutoff: scope.from },
    { from: "2026-02-30T00:00:00Z" },
  ])
    assert.throws(() => summarize([], patch), /window/);
});

test("net_lines exact aggregate arithmetic rejects unsafe totals before publishing a rounded subtotal", () => {
  const quantity = Math.floor(Number.MAX_SAFE_INTEGER / 2) + 1;
  assert.throws(
    () =>
      summarize([
        source({ additions: quantity, deletions: 0 }),
        source({ after: "c".repeat(40), canonicalId: "synthetic-next", additions: quantity, deletions: 0 }),
      ]),
    /safe integer/,
  );
});

test("net_lines does not mutate its source or expose private source text and the actor engine stays unsupported", () => {
  const input = [source()],
    before = JSON.stringify(input),
    frozenScope = structuredClone(scope);
  const result = summarizeRepositoryNetLines(input, frozenScope);
  assert.equal(JSON.stringify(input), before);
  assert.deepEqual(frozenScope, scope);
  assert.ok(!JSON.stringify(result).includes(input[0].payload.commit.message));
  assert.ok(!JSON.stringify(result).includes("synthetic-change"));
  assert.throws(
    () =>
      aggregateMetric(
        {},
        {
          version: "synthetic-net-lines/v1",
          definitionVersion: "candidate-0.1.1",
          metricId: "net_lines",
          aggregation: "sum_additions_minus_sum_deletions",
        },
        {},
      ),
    /signed net changes are unsupported/,
  );
});
