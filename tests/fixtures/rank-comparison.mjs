// Synthetic retained engine inputs for Node and real-handler browser regressions.
// Never import this fixture into a public runtime or seed it into real rankings.
import { createHash } from "node:crypto";
import { canonicalPublicScope, publicScopeParameters } from "../../packages/contracts/dist/index.js";
import {
  aggregateMetric,
  getMetricDefinition,
  metricRegistryV1,
  resolveMetricWindow,
  stableJSON,
} from "../../packages/metrics/dist/index.js";
import { createService } from "../../apps/service/dist/app.js";

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
const actorIds = Object.fromEntries(["a", "b", "c", "d", "e"].map((letter) => [letter, `synthetic-rank-${letter}`]));
const actors = Object.entries(actorIds).map(([letter, id]) => ({
  id,
  login: `synthetic-${letter}`,
  kind: "user",
  publicState: "visible",
}));
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
  acceptedBy: "synthetic-reviewer",
  subjectActorId: actorId,
  eventContext: null,
  currentContext: null,
  ...patch,
});
const oldFacts = [
  fact("synthetic-a1", actorIds.a),
  fact("synthetic-a2", actorIds.a),
  fact("synthetic-a3", actorIds.a),
  fact("synthetic-b1", actorIds.b),
  fact("synthetic-b2", actorIds.b),
  fact("synthetic-d1", actorIds.d),
  fact("synthetic-e1", actorIds.e),
];
const fresh = [
  fact("synthetic-b3", actorIds.b, "2026-10-17T12:00:00.000Z"),
  fact("synthetic-b4", actorIds.b, "2026-10-17T12:00:00.000Z"),
  fact("synthetic-c1", actorIds.c, "2026-10-17T13:00:00.000Z"),
];
function published(id, revision, cutoff, facts, scopeFilters) {
  const window = resolveMetricWindow("30d", cutoff);
  const scope = canonicalPublicScope({
    organization: "Pick-Your-AI",
    repository: null,
    workstream: null,
    start: window.from,
    end: window.to,
    ...scopeFilters,
  });
  const engineScope = {
    ...window,
    repos: ["synthetic-repo"],
    projects: scope.projects ?? [],
    workstreams: scope.workstream === null ? [] : [scope.workstream],
    roles: scope.roles ?? [],
    actors: "all",
    context: scope.context ?? "event",
  };
  // Scoped cases use explicit synthetic membership evidence. The original
  // legacy fixture and its facts remain unchanged. Current and event views
  // deliberately have different Project memberships; no history is inferred.
  const scopedFacts = scope.schemaVersion
    ? facts.map((entry) => ({
        ...entry,
        eventContext: {
          projects: ["PVT_PAST"],
          workstreams: ["engineering"],
          projectScope: ["PVT_A", "PVT_B=", "PVT_PAST"],
          workstreamsKnown: true,
        },
        currentContext: {
          projects: ["PVT_A", "PVT_B="],
          workstreams: ["engineering"],
          projectScope: ["PVT_A", "PVT_B=", "PVT_PAST"],
          workstreamsKnown: true,
        },
      }))
    : facts;
  const aggregate = aggregateMetric(
    {
      datasetId: `synthetic-dataset-${id}`,
      cutoff,
      backfillRevision: "synthetic-backfill-1",
      repositoryIds: ["synthetic-repo"],
      actors,
      facts: scopedFacts,
      coverage: [coverage],
    },
    policy,
    engineScope,
  );
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

/** Callers close app. The mutable pair contains only synthetic provider-private
 * inputs for adversarial tests; the actual service computes every public result.
 */
export function createRankComparisonHarness(scopeFilters = {}) {
  const beforeId = "synthetic-before",
    afterId = "synthetic-after";
  const before = published(beforeId, 1, beforeAt, oldFacts, scopeFilters),
    after = published(afterId, 2, afterAt, [...oldFacts, ...fresh], scopeFilters);
  const pair = {
    current: after.read,
    previous: before.read,
    currentHistory: after.history,
    previousHistory: before.history,
  };
  const scope = structuredClone(after.read.selected.scope),
    previousScope = structuredClone(before.read.selected.scope);
  const calls = [];
  let unavailable = false;
  let controlRevision = 1;
  const lookup = (pin) => {
    if (pin === null || pin === afterId) return { read: pair.current, history: pair.currentHistory };
    if (pin === beforeId && pair.previous) return { read: pair.previous, history: pair.previousHistory };
    return null;
  };
  const sameScope = (left, right) => stableJSON(left) === stableJSON(right);
  const checkRead = (signal) => {
    signal.throwIfAborted();
    if (unavailable) throw Error("SENSITIVE_SYNTHETIC_COMPARISON_PROVIDER_FAILURE");
  };
  const app = createService({
    now: () => Date.parse(afterAt),
    cursorSecret: "synthetic-rank-browser-cursor-secret-0001",
    source: {
      async read(requestedScope, pin, signal) {
        calls.push("read");
        checkRead(signal);
        const chosen = lookup(pin);
        if (!chosen) return null;
        const result = structuredClone(chosen.read);
        // Ordinary health/proof routes also request generic scopes. This fixture
        // materializes their synthetic view; comparison reads below stay exact.
        result.selected.scope = { ...requestedScope };
        result.head = structuredClone(pair.current.head);
        result.controls = structuredClone(pair.current.controls);
        return result;
      },
      async readComparison(requestedScope, pin, requestedPrevious, signal) {
        calls.push("pair");
        checkRead(signal);
        const current = lookup(pin);
        if (!current || !sameScope(requestedScope, current.read.selected.scope)) return null;
        const earlier = lookup(requestedPrevious.snapshotId);
        const previous = earlier && sameScope(requestedPrevious.scope, earlier.read.selected.scope) ? earlier : null;
        // Clone the complete pair in the same synchronous provider boundary.
        // Incoherent synthetic controls are deliberately retained for fail-closed tests.
        return structuredClone({
          current: current.read,
          previous: previous?.read ?? null,
          currentHistory: current.history,
          previousHistory: previous?.history ?? null,
        });
      },
    },
  });
  const updateControls = (update) => {
    const controls = structuredClone(pair.current.controls);
    controls.version = `synthetic-controls-${++controlRevision}`;
    update(controls);
    pair.current.controls = structuredClone(controls);
    if (pair.previous) pair.previous.controls = structuredClone(controls);
  };
  const params = new URLSearchParams({
    metric: "pr_merged",
    snapshot: afterId,
    start: scope.start,
    end: scope.end,
    compare: beforeId,
    compareStart: previousScope.start,
    compareEnd: previousScope.end,
  });
  if (scope.schemaVersion) {
    const filters = publicScopeParameters(scope);
    for (const key of ["context", "project", "role"]) if (filters[key] !== undefined) params.set(key, filters[key]);
  }
  return {
    app,
    pair,
    params,
    scope,
    previousScope,
    beforeId,
    afterId,
    actorIds: { ...actorIds },
    calls,
    fail() {
      unavailable = true;
    },
    recover() {
      unavailable = false;
    },
    revoke(side = "current") {
      if (!["current", "previous"].includes(side)) throw Error("unknown synthetic snapshot side");
      const id = side === "current" ? afterId : beforeId;
      updateControls((controls) => {
        if (!controls.revokedSnapshotIds.includes(id)) controls.revokedSnapshotIds.push(id);
      });
    },
    suppressActor(actorId = actorIds.a) {
      if (!Object.values(actorIds).includes(actorId)) throw Error("unknown synthetic actor");
      updateControls((controls) => {
        if (!controls.suppressedActorIds.includes(actorId)) controls.suppressedActorIds.push(actorId);
      });
    },
    hideBaselineActor(actorId = actorIds.a) {
      const actor = pair.previous?.selected.actors.find((entry) => entry.actorId === actorId);
      if (!actor) throw Error("unknown synthetic baseline actor");
      actor.state = "hidden";
    },
    backfill() {
      pair.currentHistory.metrics[0].backfillRevision = "synthetic-backfill-2";
    },
  };
}
