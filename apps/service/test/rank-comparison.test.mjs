import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import {
  aggregateMetric,
  getMetricDefinition,
  metricRegistryV1,
  resolveMetricWindow,
  stableJSON,
} from "../../../packages/metrics/dist/index.js";
import { createService } from "../dist/app.js";
import { comparePublishedRanks } from "../dist/rank-comparison.js";
const beforeAt = "2026-10-17T00:00:00.000Z",
  afterAt = "2026-10-18T00:00:00.000Z";
const hash = (v) => createHash("sha256").update(v).digest("hex");
const policy = {
  metricId: "pr_merged",
  version: "synthetic-policy-v1",
  definitionVersion: metricRegistryV1.policy_version,
  unit: getMetricDefinition("pr_merged").definition.unit,
  aggregation: "count",
  dateBasis: "acceptedAt",
  rankedStates: ["qualified"],
  roles: ["author"],
  groupBy: "actor_artifact",
  sources: ["github_rest"],
  minimumSamples: 1,
  rank: true,
};
const coverage = {
  schemaVersion: "leaderboard/v1",
  state: "complete",
  source: "github_rest",
  scopeId: "synthetic-repo",
  windowStart: "2026-09-01T00:00:00.000Z",
  windowEnd: "2026-11-01T00:00:00.000Z",
  knownStart: "2026-09-01T00:00:00.000Z",
  lastSuccessfulSync: afterAt,
  sourceWatermark: afterAt,
  missingPages: 0,
  permissionsMissing: [],
  sourceErrors: [],
};
const actors = ["a", "b", "c"].map((id) => ({ id, login: `synthetic-${id}`, kind: "user", publicState: "visible" }));
const fact = (id, actorId, at = "2026-10-10T00:00:00.000Z", patch = {}) => ({
  id,
  canonicalKey: `synthetic-action-${id}`,
  metricId: "pr_merged",
  actorId,
  artifactId: `synthetic-${id}`,
  repoId: "synthetic-repo",
  role: "author",
  state: "qualified",
  occurredAt: at,
  acceptedAt: at,
  observedAt: at,
  revision: 0,
  correctionReceipt: null,
  acceptanceReceipt: "private-acceptance-secret",
  acceptedBy: "reviewer",
  subjectActorId: actorId,
  eventContext: null,
  currentContext: null,
  ...patch,
});
const oldFacts = [fact("a1", "a"), fact("a2", "a"), fact("b1", "b")];
const fresh = [
  fact("b2", "b", "2026-10-17T12:00:00.000Z"),
  fact("b3", "b", "2026-10-17T12:00:00.000Z"),
  fact("c1", "c", "2026-10-17T13:00:00.000Z"),
];
function published(id, revision, cutoff, facts) {
  const engineScope = {
    ...resolveMetricWindow("30d", cutoff),
    repos: ["synthetic-repo"],
    projects: [],
    workstreams: [],
    roles: [],
    actors: "all",
    context: "event",
  };
  const aggregate = aggregateMetric(
    {
      datasetId: `synthetic-dataset-${id}`,
      cutoff,
      backfillRevision: "synthetic-backfill-1",
      repositoryIds: ["synthetic-repo"],
      actors,
      facts,
      coverage: [coverage],
    },
    policy,
    engineScope,
  );
  const scope = {
    organization: "Pick-Your-AI",
    repository: null,
    workstream: null,
    start: engineScope.from,
    end: engineScope.to,
  };
  const history = {
    snapshotId: id,
    revision,
    metrics: [{ ...aggregate, sources: [...policy.sources], policySignature: hash(aggregate.policySignature) }],
  };
  const read = {
    head: { snapshotId: id, revision, publishedAt: cutoff },
    controls: {
      version: "synthetic-controls-1",
      suppressedActorIds: [],
      suppressedArtifactIds: [],
      revokedSnapshotIds: [],
    },
    selected: {
      approvedPublic: true,
      scope,
      snapshot: {
        schemaVersion: "leaderboard/v1",
        snapshotId: id,
        revision,
        generatedAt: cutoff,
        metricDefinitionVersion: metricRegistryV1.policy_version,
        computationVersion: "synthetic-computation-v1",
        coverage: [coverage],
        results: [],
      },
      actors: actors.map((a) => ({
        actorId: a.id,
        state: "public",
        actor: {
          schemaVersion: "leaderboard/v1",
          identityState: "resolved",
          githubNodeId: `synthetic-node-${a.id}`,
          login: a.login,
          kind: "user",
          executionMode: "unknown",
        },
      })),
      rows: aggregate.rows.map((r) => ({
        actorId: r.actorId,
        result: { schemaVersion: "leaderboard/v1", metricId: "pr_merged", state: "measured", value: r.value, coverage },
        evidenceIds: r.evidenceIds,
      })),
      evidence: aggregate.rows.flatMap((r) =>
        r.evidence.map((e, i) => ({
          artifact: {
            schemaVersion: "leaderboard/v1",
            source: "github",
            kind: "pull_request",
            stableId: `synthetic-${e.id}`,
            repositoryId: "synthetic-repo",
            publicUrl: `https://github.com/synthetic/example/pull/${i + 1}`,
            visibility: "public",
          },
          contribution: {
            schemaVersion: "leaderboard/v1",
            contributionId: e.id,
            canonicalEventId: `synthetic-action-${e.id}`,
            artifactId: `synthetic-${e.id}`,
            actorId: r.actorId,
            roles: ["author"],
            qualification: "eligible",
            metricIds: ["pr_merged"],
            reasonCodes: ["synthetic_fixture"],
          },
          occurredAt: e.effectiveAt,
          sourceRevision: null,
          sourceRevisionUrl: null,
        })),
      ),
      ranking: [{ metricId: "pr_merged", direction: "descending", rank: true }],
      methodology: [
        {
          metricId: "pr_merged",
          policyVersion: policy.version,
          policySignature: hash(stableJSON(policy)),
          policyLink: null,
        },
      ],
    },
  };
  return { read: structuredClone(read), history };
}
test("comparison receipts consume engine-validated clocks and never truncate finer source precision", () => {
  for (const field of ["acceptedAt", "observedAt"])
    assert.throws(
      () =>
        published("synthetic-fine-time", 1, beforeAt, [
          fact("fine-time", "a", undefined, {
            [field]: "2026-10-10T00:00:00.0001Z",
          }),
        ]),
      /Expected an explicit UTC instant/,
    );
});
function harness(t, patch = () => {}) {
  const before = published("synthetic-before", 1, beforeAt, oldFacts),
    after = published("synthetic-after", 2, afterAt, [...oldFacts, ...fresh]);
  const pair = {
    current: after.read,
    previous: before.read,
    currentHistory: after.history,
    previousHistory: before.history,
  };
  patch(pair);
  const calls = [];
  const app = createService({
    source: {
      async read() {
        calls.push("read");
        return structuredClone(pair.current);
      },
      async readComparison(scope, pin, previous, signal) {
        assert.equal(signal.aborted, false);
        assert.deepEqual(scope, after.read.selected.scope);
        assert.equal(pin === null || pin === "synthetic-after", true);
        assert.deepEqual(previous, { snapshotId: "synthetic-before", scope: before.read.selected.scope });
        calls.push("pair");
        return structuredClone(pair);
      },
    },
    now: () => Date.parse(afterAt),
  });
  t.after(() => app.close());
  const params = new URLSearchParams({
    metric: "pr_merged",
    start: after.read.selected.scope.start,
    end: afterAt,
    compare: "synthetic-before",
    compareStart: before.read.selected.scope.start,
    compareEnd: beforeAt,
  });
  return { app, pair, calls, params, url: `/api/v1/boards?${params}` };
}
const safe = (body) => {
  for (const key of [
    "private-acceptance-secret",
    "private-correction-secret",
    "comparisonSignature",
    "backfillRevision",
    "datasetId",
    "audit",
    "currentHistory",
    "previousHistory",
  ])
    assert.equal(body.includes(key), false, key);
};

test("actual retained engine rolling scopes yield public movement and new entrants without changing values", async (t) => {
  const h = harness(t),
    response = await h.app.inject(h.url);
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(
    response.json().rows.map((r) => [r.actorId, r.rank, r.movement.state, r.movement.delta]),
    [
      ["b", 1, "comparable", 1],
      ["a", 2, "comparable", -1],
      ["c", 3, "new_entrant", null],
    ],
  );
  assert.deepEqual(h.calls, ["pair"]);
  assert.equal(response.json().comparison.snapshotId, "synthetic-before");
  safe(response.body);
  const ordinary = new URL(h.url, "http://localhost");
  for (const key of ["compare", "compareStart", "compareEnd"]) ordinary.searchParams.delete(key);
  const plain = (await h.app.inject(ordinary.pathname + ordinary.search)).json();
  assert.equal(Object.hasOwn(plain, "comparison"), false);
  assert.ok(plain.rows.every((r) => !Object.hasOwn(r, "movement")));
  assert.deepEqual(
    plain.rows.map((r) => [r.actorId, r.rank, r.result.value]),
    response.json().rows.map((r) => [r.actorId, r.rank, r.result.value]),
  );
});
test("an existing provider without atomic comparison support keeps its current board and explicit unavailable movement", async (t) => {
  const h = harness(t);
  const app = createService({
    source: {
      async read() {
        return structuredClone(h.pair.current);
      },
    },
  });
  t.after(() => app.close());
  const response = await app.inject(h.url);
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(
    response.json().rows.map((row) => row.result.value),
    [3, 2, 1],
  );
  assert.ok(
    response
      .json()
      .rows.every((row) => row.movement.reason === "comparison_unavailable" && row.movement.delta === null),
  );
  assert.equal(response.json().comparison.snapshotId, null);
  safe(response.body);
});
test("coverage, policy, backfill, legacy and authority incompatibility stay explicitly unavailable", async (t) => {
  for (const [reason, patch] of [
    [
      "insufficient_history",
      (p) => {
        p.currentHistory.metrics[0].coverage = "incomplete";
      },
    ],
    [
      "insufficient_history",
      (p) => {
        p.current.selected.snapshot.coverage[0].state = "partial";
      },
    ],
    [
      "backfill_or_reconciliation",
      (p) => {
        p.currentHistory.metrics[0].backfillRevision = "synthetic-backfill-2";
      },
    ],
    [
      "mixed_policy_versions",
      (p) => {
        p.currentHistory.metrics[0].policyVersion = "synthetic-v2";
        p.current.selected.methodology[0].policyVersion = "synthetic-v2";
      },
    ],
    [
      "insufficient_evidence_history",
      (p) => {
        p.previousHistory = null;
      },
    ],
    [
      "comparison_unavailable",
      (p) => {
        p.previous = null;
      },
    ],
    [
      "mixed_computation_versions",
      (p) => {
        p.previous.selected.snapshot.computationVersion = "synthetic-old-computation";
      },
    ],
  ])
    await t.test(reason, async (t) => {
      const h = harness(t, patch),
        response = await h.app.inject(h.url);
      assert.equal(response.statusCode, 200, response.body);
      assert.ok(
        response
          .json()
          .rows.every(
            (r) => r.movement.state === "unavailable" && r.movement.delta === null && r.movement.reason === reason,
          ),
        response.body,
      );
      safe(response.body);
    });
});
test("late additions and corrected retained evidence cannot become fresh public progress", async (t) => {
  for (const [reason, facts] of [
    ["late_history", [...oldFacts, fact("late", "b")]],
    [
      "corrected_or_removed_evidence",
      [
        ...oldFacts,
        {
          ...oldFacts[0],
          revision: 1,
          correctionReceipt: "private-correction-secret",
          observedAt: "2026-10-17T12:00:00.000Z",
        },
      ],
    ],
  ])
    await t.test(reason, async (t) => {
      const replacement = published("synthetic-after", 2, afterAt, facts);
      const h = harness(t, (p) => {
          p.current = replacement.read;
          p.currentHistory = replacement.history;
        }),
        response = await h.app.inject(h.url);
      assert.equal(response.statusCode, 200, response.body);
      assert.ok(
        response.json().rows.every((r) => r.movement.reason === reason && r.movement.delta === null),
        response.body,
      );
      safe(response.body);
    });
});
test("privacy projects BOTH snapshots and narrower actor cohorts never infer hidden ranks", async (t) => {
  for (const target of ["current", "previous"])
    await t.test(target, async (t) => {
      const h = harness(t, (p) => {
          p[target].selected.actors.find((actor) => actor.actorId === "a").state = "hidden";
        }),
        response = await h.app.inject(h.url);
      assert.equal(response.statusCode, 200, response.body);
      assert.ok(
        response
          .json()
          .rows.every((r) => r.movement.reason === "history_or_visible_cohort_changed" && r.movement.delta === null),
      );
      assert.equal(response.json().comparison.snapshotId, null);
      if (target === "current") assert.ok(response.json().rows.every((r) => r.actorId !== "a"));
    });
  const h = harness(t),
    filtered = (await h.app.inject(h.url + "&actors=user")).json();
  assert.ok(filtered.rows.every((r) => r.movement.reason === "filtered_cohort_unavailable"));
  h.pair.previous.controls.revokedSnapshotIds.push("synthetic-before");
  h.pair.current.controls.revokedSnapshotIds.push("synthetic-before");
  const revoked = (await h.app.inject(h.url)).json();
  assert.ok(revoked.rows.every((r) => r.movement.reason === "comparison_unavailable"));
  assert.equal(revoked.comparison.snapshotId, null);
});
test("mismatched paired authority rejects all current rows, including unversioned privacy changes", async (t) => {
  for (const field of ["version", "suppressedActorIds", "suppressedArtifactIds", "revokedSnapshotIds"])
    await t.test(field, async (t) => {
      const h = harness(t, (p) => {
        if (field === "version") p.previous.controls.version = "synthetic-controls-old";
        else p.previous.controls[field].push("synthetic-private-changed");
      });
      const response = await h.app.inject(h.url);
      assert.equal(response.statusCode, 503, response.body);
      assert.deepEqual(response.json(), { error: "public_comparison_authority_changed" });
      safe(response.body);
    });
});
test("comparison cursors/share links bind both scopes and exports contain only public movement", async (t) => {
  const h = harness(t),
    first = (await h.app.inject(h.url + "&limit=1")).json();
  assert.ok(first.nextCursor);
  const next = await h.app.inject(h.url + `&limit=1&cursor=${first.nextCursor}`);
  assert.equal(next.statusCode, 200, next.body);
  assert.equal(next.json().rows[0].actorId, "a");
  const other = new URL(h.url, "http://localhost");
  other.searchParams.set("compareEnd", "2026-10-16T00:00:00.000Z");
  other.searchParams.set("limit", "1");
  other.searchParams.set("cursor", first.nextCursor);
  assert.equal((await h.app.inject(other.pathname + other.search)).statusCode, 400);
  assert.equal(
    new URL(first.shareUrl, "http://localhost").searchParams.get("compareStart"),
    h.params.get("compareStart"),
  );
  const exported = await h.app.inject(h.url.replace("/boards?", "/exports?"));
  assert.equal(exported.statusCode, 200, exported.body);
  assert.equal(exported.json().comparison.snapshotId, "synthetic-before");
  assert.equal(exported.json().rows[0].movement.delta, 1);
  safe(exported.body);
  const csv = await h.app.inject(h.url.replace("/boards?", "/exports?") + "&format=csv");
  assert.equal(csv.statusCode, 200, csv.body);
  assert.match(csv.body, /"comparison","movement"/);
  assert.match(csv.body, /new_entrant/);
  safe(csv.body);
});
test("invalid baseline queries cannot be silently ignored", async (t) => {
  const h = harness(t);
  for (const query of [
    "compareStart=" + beforeAt,
    "compare=x&compareEnd=" + beforeAt,
    "compare=x&compareStart=" + afterAt + "&compareEnd=" + beforeAt,
    "compare=x&compare=x",
  ])
    assert.equal((await h.app.inject("/api/v1/boards?metric=pr_merged&" + query)).statusCode, 400);
  assert.equal((await h.app.inject("/api/v1/health?compare=x")).statusCode, 400);
});

test("comparison coverage uses only evidenced selected-policy source and repository pairs", async (t) => {
  const h = harness(t, (p) => {
    for (const read of [p.current, p.previous])
      read.selected.snapshot.coverage.push(
        { ...coverage, source: "github_graphql", state: "partial" },
        { ...coverage, scopeId: "synthetic-unrelated", state: "partial" },
      );
  });
  const response = await h.app.inject(h.url);
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().rows.find((row) => row.actorId === "b").movement.delta, 1);
  for (const patch of [
    (p) => {
      p.current.selected.snapshot.coverage = [];
    },
    (p) => {
      p.currentHistory.metrics[0].sources.push("github_graphql");
    },
    (p) => {
      p.currentHistory.metrics[0].scope.repos.push("synthetic-missing");
      p.previousHistory.metrics[0].scope.repos.push("synthetic-missing");
    },
    (p) => {
      p.current.selected.snapshot.coverage.push({ ...coverage, state: "partial" });
    },
    (p) => {
      delete p.currentHistory.metrics[0].sources;
    },
  ]) {
    const denied = harness(t, patch);
    const result = await denied.app.inject(denied.url);
    assert.equal(result.statusCode, 200, result.body);
    assert.ok(
      result.json().rows.every((row) => row.movement.reason === "insufficient_history" && row.movement.delta === null),
    );
  }
});

test("large public cohorts validate retained rows and dense ranks without repeated scans", (t) => {
  const size = 5_000;
  const originalIndexOf = Array.prototype.indexOf;
  let denseRankScans = 0;
  t.after(() => {
    Array.prototype.indexOf = originalIndexOf;
  });
  Array.prototype.indexOf = function (value, ...args) {
    if (typeof value === "number" && this.length >= size / 2) {
      denseRankScans++;
      assert.fail("dense rank values must be indexed once");
    }
    return originalIndexOf.call(this, value, ...args);
  };
  for (const direction of ["ascending", "descending"]) {
    let actorReads = 0;
    const large = (id, revision, cutoff) => {
      const item = published(id, revision, cutoff, oldFacts);
      item.read.selected.ranking[0].direction = direction;
      item.read.selected.evidence = [];
      item.read.selected.rows = Array.from({ length: size }, (_, index) => ({
        actorId: `synthetic-indexed-${index}`,
        result: {
          schemaVersion: "leaderboard/v1",
          metricId: policy.metricId,
          state: "measured",
          value: Math.floor(index / 2) + 1,
          coverage,
        },
        evidenceIds: [],
      }));
      item.history.metrics[0].rows = item.read.selected.rows.map((row) => ({
        get actorId() {
          assert.ok(++actorReads <= size * 12, "retained actor lookups must stay linear");
          return row.actorId;
        },
        value: row.result.value,
        rank: direction === "ascending" ? row.result.value : size / 2 - row.result.value + 1,
        evidence: [],
      }));
      return item;
    };
    const before = large("synthetic-before", 1, beforeAt);
    const after = large("synthetic-after", 2, afterAt);
    const result = comparePublishedRanks(after.read, before.read, after.history, before.history, policy.metricId);
    assert.equal(result.comparison.snapshotId, "synthetic-before");
    assert.equal(result.movement.length, size);
    assert.ok(result.movement.every((row) => row.state === "comparable" && row.delta === 0));
    assert.ok(actorReads <= size * 12);
  }
  assert.equal(denseRankScans, 0);
});

test("duplicate retained actors cannot collapse into the visible cohort index", async (t) => {
  for (const target of ["currentHistory", "previousHistory"])
    for (const replace of [false, true]) {
      const h = harness(t, (pair) => {
        const rows = pair[target].metrics[0].rows;
        if (replace) rows[1] = structuredClone(rows[0]);
        else rows.push(structuredClone(rows[0]));
      });
      const response = await h.app.inject(h.url);
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.json().comparison.snapshotId, null);
      assert.ok(
        response
          .json()
          .rows.every(
            (row) => row.movement.reason === "history_or_visible_cohort_changed" && row.movement.delta === null,
          ),
      );
    }
});
