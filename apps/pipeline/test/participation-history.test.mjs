import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createPipeline } from "../src/index.mjs";
import { harness, components, publicScope } from "./harness.mjs";
import { attachSyntheticEvidenceState } from "../../../tests/fixtures/evidence-intake.mjs";
import {
  assembleParticipationHistory,
  copyParticipationHistoryJSON,
  createParticipationHistoryAuthority,
} from "../src/participation-history.mjs";

const origin = "2020-01-01T00:00:00.000Z";
const scope = { ...publicScope, repository: "2", start: "2020-01-07T00:00:00.000Z", end: "2020-01-10T00:00:00.000Z" };
const hash = (value) => createHash("sha256").update(components.metrics.stableJSON(value)).digest("hex");
const signal = () => new AbortController().signal;
const url = (pin) =>
  `/api/v1/contributors/101/participation-history?${new URLSearchParams({ repository: "2", start: scope.start, end: scope.end, snapshot: pin })}`;

async function fixture(t, { enabled = true } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "synthetic-participation-client-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cutoff = new Date(Date.now() + 60_000).toISOString();
  const repositories = [
    {
      id: 2,
      slug: "synthetic-org/synthetic-repo",
      occurredAt: "2020-01-08T00:00:00.000Z",
      acceptedAt: "2020-01-08T12:00:00.000Z",
    },
    {
      id: 3,
      slug: "synthetic-org/synthetic-other",
      occurredAt: "2020-01-02T00:00:00.000Z",
      acceptedAt: "2020-01-09T00:00:00.000Z",
    },
  ];
  const payloads = new Map(
    repositories.map((repo) => [
      repo.id,
      {
        id: 1000 + repo.id,
        node_id: `SYNTHETIC_HISTORY_ISSUE_${repo.id}`,
        number: 1,
        title: `Synthetic history ${repo.id}`,
        html_url: `https://github.com/${repo.slug}/issues/1`,
        created_at: repo.occurredAt,
        updated_at: repo.occurredAt,
        user: { id: 101, node_id: "U_SYNTHETIC_HISTORY_101", login: "synthetic-history-user", type: "User" },
      },
    ]),
  );
  let requests = 0;
  const githubClient = new components.github.GithubReadClient({
    apiOrigin: "https://api.synthetic.invalid",
    token: async () => "synthetic-test-token",
    maxRetries: 0,
    checkpoints: new components.github.FileCheckpointStore(join(directory, "cache")),
    fetch: async (value) => {
      requests++;
      const path = new URL(value).pathname;
      const repo = repositories.find(
        (candidate) => path === `/repos/${candidate.slug}` || path.startsWith(`/repos/${candidate.slug}/`),
      );
      assert.ok(repo, "only the independently configured synthetic repository inventory is read");
      let body;
      if (path === `/repos/${repo.slug}`)
        body = { id: repo.id, private: false, full_name: repo.slug, default_branch: "main" };
      else if (path === `/repos/${repo.slug}/issues`) body = [payloads.get(repo.id)];
      else if (path === `/repos/${repo.slug}/issues/1`) body = payloads.get(repo.id);
      else assert.fail(`Unexpected synthetic request: ${path}`);
      return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    },
  });
  let admission = null;
  let epoch = "synthetic-admission-1";
  let resolver = async (request) =>
    admission && hash(request.selectedInput) === hash(admission.selectedInput) ? structuredClone(admission) : null;
  const authority = {
    epoch: () => epoch,
    resolve: (request, signal) => resolver(request, signal),
  };
  const h = await harness(t, {
    githubClient,
    source: undefined,
    probeRepository: undefined,
    now: () => cutoff,
    ...(enabled ? { participationHistoryAuthority: authority } : {}),
    configure(config) {
      config.repositories.push({
        id: 3,
        installationId: 1,
        slug: repositories[1].slug,
        families: ["issues"],
        approvalReceipt: "synthetic-other-approval",
      });
      config.scopes = [publicScope, scope];
      const policy = {
        ...config.policies[0].policy,
        version: "synthetic-history-policy-v1",
        dateBasis: "acceptedAt",
        rankedStates: ["qualified"],
      };
      config.policies = [
        { policy, signature: components.metrics.stableJSON(policy), approvalReceipt: "synthetic-history-policy" },
      ];
      config.recognitionBindings = repositories.map((repo) => ({
        category: "finding",
        scope: `repository:${repo.id}`,
        policyVersion: policy.version,
        metricId: "issues_opened",
        sourceMetricId: "issues_opened",
        repositoryId: String(repo.id),
        reviewerIds: ["202"],
      }));
    },
  });
  h.controlsStore.transaction((state) => {
    for (const repo of repositories) {
      const id = `synthetic-history-claim-${repo.id}`;
      const event = {
        id: `synthetic-history-receipt-${repo.id}`,
        actor: "202",
        action: "accepted",
        at: Date.parse(repo.acceptedAt),
        policyVersion: h.config.policies[0].policy.version,
      };
      state.requests[id] = {
        id,
        kind: "evidence",
        status: "accepted",
        owner: "101",
        category: "finding",
        scope: `repository:${repo.id}`,
        policyVersion: event.policyVersion,
        locator: payloads.get(repo.id).html_url,
        collaborators: {},
        history: [event],
      };
      state.audit.push(event);
    }
    attachSyntheticEvidenceState(state);
  });
  const published = await h.runtime.runOnce({ cutoff });
  assert.equal(published.state, "published");
  assert.equal(published.publications.length, 2);
  const rows = (
    await h.db.query(
      "SELECT snapshot_id,document,document_hash FROM leaderboard_pipeline.snapshots ORDER BY snapshot_id",
    )
  ).rows;
  const find = (selectedScope) => {
    const matches = rows.filter(
      (row) =>
        components.contracts.publicScopeKey(row.document.scope) === components.contracts.publicScopeKey(selectedScope),
    );
    assert.equal(matches.length, 1);
    return matches[0];
  };
  const selected = find(scope),
    history = find(publicScope);
  const retained = (
    await h.db.query(
      "SELECT snapshot_id,document,document_hash FROM leaderboard_pipeline.frozen_inputs ORDER BY snapshot_id",
    )
  ).rows;
  const binding = (row) => {
    const input = retained.find((entry) => entry.snapshot_id === row.snapshot_id);
    assert.ok(input);
    assert.equal(input.document.frozen.cutoff, cutoff);
    return {
      snapshotId: row.snapshot_id,
      revision: row.document.snapshot.revision,
      sha256: input.document_hash,
      cutoff,
    };
  };
  const requiredInventory = [
    { repositoryId: "2", source: "github_rest" },
    { repositoryId: "3", source: "github_rest" },
  ];
  const policy = h.config.policies[0];
  admission = {
    schemaVersion: "pipeline-participation-history-admission/v1",
    selectedInput: binding(selected),
    historyInput: binding(history),
    admission: {
      decisionId: "synthetic-independent-history-decision",
      organization: "Pick-Your-AI",
      origin,
      reviewedAt: origin,
      sourceInventory: requiredInventory,
      policies: [
        {
          metricId: "issues_opened",
          version: policy.policy.version,
          signature: hash(policy.policy),
          roles: ["reporter"],
          sources: ["github_rest"],
        },
      ],
    },
    coverage: requiredInventory.map(({ repositoryId, source }) => ({
      schemaVersion: "leaderboard/v1",
      state: "complete",
      source,
      scopeId: repositoryId,
      windowStart: origin,
      windowEnd: cutoff,
      knownStart: origin,
      lastSuccessfulSync: cutoff,
      sourceWatermark: cutoff,
      missingPages: 0,
      permissionsMissing: [],
      sourceErrors: [],
    })),
    proofSources: history.document.portfolioEvidence.map((entry) => ({
      contributionId: entry.contribution.contributionId,
      repositoryId: entry.artifact.repositoryId,
      source: "github_rest",
    })),
    unresolved: [],
  };
  assert.ok(
    history.document.portfolioEvidence.some(
      (entry) => entry.activityState === "accepted" && entry.artifact.repositoryId === "3",
    ),
  );
  assert.ok(selected.document.portfolioEvidence.every((entry) => entry.artifact.repositoryId === "2"));
  assert.ok(rows.every((row) => row.document.snapshot.coverage.every((entry) => entry.state === "partial")));
  return {
    ...h,
    selected,
    history,
    retained,
    cutoff,
    authority,
    admission,
    requests: () => requests,
    revoke: () => {
      epoch = null;
    },
    resolveWith: (value) => {
      resolver = value;
    },
  };
}

test("protected history uses the earlier accepted organization occurrence across a narrower persisted selection", async (t) => {
  const h = await fixture(t);
  const requestCount = h.requests();
  const response = await h.runtime.app.inject(url(h.selected.snapshot_id));
  assert.equal(response.statusCode, 200, response.body);
  const history = response.json().history;
  const paired = await h.runtime.source.readParticipationHistory(scope, h.selected.snapshot_id, "101", signal());
  assert.deepEqual(
    paired.history.unresolved,
    [],
    "known unaccepted observations do not fabricate missing acceptance clocks",
  );
  assert.equal(history.state, "known", response.body);
  assert.equal(history.firstProof.proof.repositoryId, "3");
  assert.equal(history.firstProof.proof.occurredAt, "2020-01-02T00:00:00.000Z");
  assert.equal(history.newcomer, false);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(h.requests(), requestCount, "history GET performs no source collection or hydration");
  assert.deepEqual(
    (
      await h.db.query(
        "SELECT snapshot_id,document,document_hash FROM leaderboard_pipeline.frozen_inputs ORDER BY snapshot_id",
      )
    ).rows,
    h.retained,
    "admitted coverage never rewrites frozen inputs",
  );
  assert.equal(paired.current.selected.scope.repository, "2");
  assert.deepEqual(paired.history.publication.selected.scope, publicScope);
  assert.equal(paired.history.publication.selected.rows.length, 0);
  assert.equal(paired.history.publication.selected.evidence.length, 0);
  assert.ok(paired.history.publication.selected.snapshot.coverage.every((entry) => entry.state === "complete"));
  assert.ok(
    (await h.runtime.source.read(publicScope, h.history.snapshot_id, signal())).selected.snapshot.coverage.every(
      (entry) => entry.state === "partial",
    ),
  );
});

test("the same exact admitted immutable history survives physical database reopen without another producer run", async (t) => {
  const h = await fixture(t);
  await h.runtime.stop();
  await h.reopenDatabase();
  const controlsStore = new components.controls.ControlStore(join(h.directory, "controls.sqlite"));
  const runtime = await createPipeline({ ...h.options, controlsStore });
  t.after(async () => {
    await runtime.stop();
    controlsStore.close();
  });
  const requestCount = h.requests();
  const response = await runtime.app.inject(url(h.selected.snapshot_id));
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().history.state, "known", response.body);
  assert.equal(response.json().history.firstProof.proof.repositoryId, "3");
  assert.equal(h.requests(), requestCount);
});

test("stock publications and receipt strings without the protected host capability remain unknown", async (t) => {
  const h = await fixture(t, { enabled: false });
  assert.equal(h.runtime.source.readParticipationHistory, undefined);
  const response = await h.runtime.app.inject(url(h.selected.snapshot_id));
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().history.state, "unknown");
  assert.equal(response.json().history.reason, "reviewed_history_unavailable");
  assert.equal(response.json().history.firstProof, null);
});

test("the actual reader rejects incomplete or mismatched protected admission without recollecting source", async (t) => {
  const h = await fixture(t);
  const requests = h.requests();
  const denied = [
    [
      "selected identity",
      (value) => {
        value.selectedInput.revision++;
      },
    ],
    [
      "history input hash",
      (value) => {
        value.historyInput.sha256 = "0".repeat(64);
      },
    ],
    [
      "history cutoff",
      (value) => {
        value.historyInput.cutoff = origin;
      },
    ],
    [
      "selected snapshot reused as history",
      (value) => {
        value.historyInput = structuredClone(value.selectedInput);
      },
    ],
    [
      "missing configured repository",
      (value) => {
        value.admission.sourceInventory.pop();
        value.coverage.pop();
      },
    ],
    [
      "missing configured policy",
      (value) => {
        value.admission.policies = [];
      },
    ],
    [
      "different policy signature",
      (value) => {
        value.admission.policies[0].signature = "1".repeat(64);
      },
    ],
    [
      "partial coverage",
      (value) => {
        value.coverage[1].state = "partial";
      },
    ],
    [
      "missing source page",
      (value) => {
        value.coverage[1].missingPages = 1;
      },
    ],
    [
      "late coverage origin",
      (value) => {
        value.coverage[1].knownStart = "2020-01-02T00:00:00.000Z";
      },
    ],
    [
      "missing proof provenance",
      (value) => {
        value.proofSources.pop();
      },
    ],
    [
      "wrong proof repository",
      (value) => {
        value.proofSources[0].repositoryId = value.proofSources[0].repositoryId === "2" ? "3" : "2";
      },
    ],
    [
      "unadmitted proof adapter",
      (value) => {
        value.proofSources[0].source = "github_graphql";
      },
    ],
    [
      "unknown unresolved reason",
      (value) => {
        value.unresolved.push({ actorId: "101", reason: "looks_complete" });
      },
    ],
  ];
  for (const [name, damage] of denied)
    await t.test(name, async () => {
      const value = structuredClone(h.admission);
      damage(value);
      h.resolveWith(async () => value);
      const response = await h.runtime.app.inject(url(h.selected.snapshot_id));
      assert.equal(response.statusCode, name === "selected snapshot reused as history" ? 410 : 503, response.body);
      if (name === "selected snapshot reused as history")
        assert.equal(response.json().error, "snapshot_expired_refetch");
      assert.equal(response.json().history, undefined);
    });
  h.resolveWith(async () => null);
  const absent = await h.runtime.app.inject(url(h.selected.snapshot_id));
  assert.equal(absent.statusCode, 200, absent.body);
  assert.equal(absent.json().history.reason, "reviewed_history_unavailable");
  h.resolveWith(async () => h.admission);
  const restored = await h.runtime.app.inject(url(h.selected.snapshot_id));
  assert.equal(restored.statusCode, 200, restored.body);
  assert.equal(restored.json().history.state, "known");
  assert.equal(h.requests(), requests);
});

test("an actual first-proof route rechecks its host decision and never substitutes a later proof", async (t) => {
  const h = await fixture(t);
  const initial = await h.runtime.app.inject(url(h.selected.snapshot_id));
  assert.equal(initial.statusCode, 200, initial.body);
  const history = initial.json().history;
  assert.equal(history.state, "known");
  const proofUrl = url(h.selected.snapshot_id).replace(
    "?",
    `/${history.historyKey}/evidence/${history.firstProof.proof.contributionId}?`,
  );
  const proof = await h.runtime.app.inject(proofUrl);
  assert.equal(proof.statusCode, 200, proof.body);
  assert.equal(proof.json().history.firstProof.proof.repositoryId, "3");
  h.revoke();
  const stale = await h.runtime.app.inject(proofUrl);
  assert.equal(stale.statusCode, 409, stale.body);
  assert.equal(stale.json().error, "participation_history_changed_refetch");
  assert.equal(stale.json().history, undefined);
});

test("withheld and globally unattributed host gaps remain unknown before requested-actor filtering", async (t) => {
  const h = await fixture(t);
  for (const gap of [
    { actorId: "101", reason: "withheld" },
    { actorId: null, reason: "unknown_actor" },
    { actorId: "101", reason: "conflicting" },
  ])
    await t.test(gap.reason, async () => {
      h.resolveWith(async () => ({ ...h.admission, unresolved: [gap] }));
      const response = await h.runtime.app.inject(url(h.selected.snapshot_id));
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.json().history.state, "unknown");
      assert.equal(response.json().history.firstProof, null);
    });
});

test("observed-only clock handling requires every exact audited variant and preserves all genuine gaps", async (t) => {
  const h = await fixture(t);
  const paired = await h.runtime.source.readParticipationHistory(scope, h.selected.snapshot_id, "101", signal());
  const explanation = JSON.parse(
    h.controlsStore.db
      .prepare("SELECT document FROM pipeline_aggregate_explanations WHERE snapshot_id=?")
      .get(h.history.snapshot_id).document,
  );
  const retainedInput = h.retained.find((row) => row.snapshot_id === h.history.snapshot_id).document;
  const retained = retainedInput.frozen;
  const metric = explanation.metrics.find((entry) =>
    entry.audit.some((audit) => audit.reason === "unknown_effective_time"),
  );
  assert.ok(metric);
  const audit = metric.audit.find((entry) => entry.reason === "unknown_effective_time");
  assert.ok(audit.factIds.length > 0);
  const originalFact = retained.facts.find((fact) => fact.metricId === metric.metricId && fact.id === audit.factIds[0]);
  assert.equal(originalFact.state, "observed");
  assert.equal(originalFact.acceptedAt, null);
  const portfolioFacts = retainedInput.policies.flatMap(({ policy }) =>
    components.metrics.selectPortfolioFacts(retained, policy, retainedInput.engineScope),
  );
  const base = {
    current: paired.current,
    selectedInput: paired.selectedInput,
    history: paired.history.publication,
    retained,
    portfolioFacts,
    explanation,
    admission: h.admission,
  };
  const project = (value) =>
    assembleParticipationHistory({ ...value, contracts: components.contracts, digest: hash }).history.unresolved;
  assert.deepEqual(project(base), []);
  const cases = [
    ["missing referenced variant", (value, entry) => entry.factIds.push("synthetic-missing-fact"), "unknown_time"],
    [
      "empty audit fact set",
      (value, entry) => {
        entry.factIds = [];
      },
      "unknown_time",
    ],
    [
      "qualified duplicate with missing acceptance",
      (value) => value.retained.facts.push({ ...originalFact, state: "qualified" }),
      "unknown_time",
    ],
    [
      "malformed source occurrence",
      (value, entry, fact) => {
        fact.occurredAt = "not-a-source-instant";
      },
      "unknown_time",
    ],
    [
      "missing source occurrence",
      (value, entry, fact) => {
        fact.occurredAt = null;
      },
      "unknown_time",
    ],
    [
      "unknown qualification",
      (value, entry, fact) => {
        fact.state = "unknown";
      },
      "unknown_qualification",
    ],
    [
      "unknown actor",
      (value, entry, fact) => {
        fact.actorId = "synthetic-unresolved-actor";
      },
      "unknown_actor",
    ],
    [
      "accepted-time audit for accepted fact",
      (value, entry, fact) => {
        fact.state = "qualified";
      },
      "unknown_time",
    ],
    [
      "conflicting audit",
      (value, entry) => {
        entry.reason = "conflicting_observation";
      },
      "conflicting",
    ],
  ];
  for (const [name, damage, reason] of cases)
    await t.test(name, () => {
      const value = structuredClone(base);
      const entry = value.explanation.metrics
        .find((item) => item.metricId === metric.metricId)
        .audit.find((item) => item.reason === "unknown_effective_time");
      const fact = value.retained.facts.find(
        (item) => item.metricId === originalFact.metricId && item.id === originalFact.id,
      );
      damage(value, entry, fact);
      assert.ok(
        project(value).some((gap) => gap.reason === reason),
        `${name} must remain an unresolved gap`,
      );
    });
  for (const state of ["qualified", "pending"])
    await t.test(`omitted effective ${state} proof outside ranked evidence remains unresolved`, () => {
      const value = structuredClone(base);
      const fact = value.retained.facts.find((item) => item.state === "qualified");
      assert.ok(fact);
      fact.state = state;
      if (state === "pending") fact.acceptedAt = null;
      const policy = { ...retainedInput.policies[0].policy, dateBasis: "occurredAt", rankedStates: ["observed"] };
      value.portfolioFacts = components.metrics.selectPortfolioFacts(value.retained, policy, retainedInput.engineScope);
      assert.ok(value.portfolioFacts.some((item) => item.id === fact.id && item.state === state));
      value.explanation.metrics = [
        {
          ...metric,
          dateBasis: "occurredAt",
          audit: [
            {
              factIds: [fact.id],
              actorId: fact.actorId,
              reason: state === "pending" ? "pending_not_ranked" : "evidence_class_not_ranked",
            },
          ],
        },
      ];
      value.history.selected.portfolioEvidence = value.history.selected.portfolioEvidence.filter(
        (item) => item.contribution.contributionId !== fact.id,
      );
      value.admission.proofSources = value.admission.proofSources.filter((item) => item.contributionId !== fact.id);
      assert.ok(
        project(value).some(
          (gap) =>
            gap.actorId === fact.actorId && gap.reason === (state === "pending" ? "unknown_qualification" : "withheld"),
        ),
      );
    });
});

test("protected callback shape and bounded JSON reject executable or incomplete data without invoking hooks", async (t) => {
  let hooks = 0;
  const accessor = Object.defineProperty({}, "private", {
    enumerable: true,
    get() {
      hooks++;
      throw new Error("must not run");
    },
  });
  const proxy = new Proxy(
    {},
    {
      ownKeys() {
        hooks++;
        throw new Error("must not run");
      },
    },
  );
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  const cycle = {};
  cycle.self = cycle;
  let deep = {};
  for (let index = 0; index < 34; index++) deep = { child: deep };
  const hidden = Object.defineProperty({}, "hidden", { value: "not enumerable" });
  const arrays = [new Array(2), Object.assign([], { unexpected: true }), Array(20_001).fill(null)];
  for (const [name, value] of [
    ["accessor", accessor],
    ["proxy", proxy],
    ["revoked proxy", revoked.proxy],
    ["cycle", cycle],
    ["depth", deep],
    ["hidden", hidden],
    ["NaN", NaN],
    ["oversize string", "x".repeat(8_000_001)],
    ...arrays.map((value, index) => [`array ${index}`, value]),
  ])
    await t.test(name, () => {
      assert.throws(() => copyParticipationHistoryJSON(value), /participation_history_admission_invalid/);
    });
  assert.equal(hooks, 0);
  assert.deepEqual(copyParticipationHistoryJSON(Object.freeze({ values: Object.freeze([1, null, "text"]) })), {
    values: [1, null, "text"],
  });
  for (const value of [
    true,
    "receipt",
    { epoch: "approved", resolve() {} },
    Object.defineProperty({ resolve() {} }, "epoch", {
      get() {
        hooks++;
        return () => "epoch";
      },
    }),
  ])
    assert.throws(() => createParticipationHistoryAuthority(value), /participation_history_admission_invalid/);
  assert.equal(hooks, 0);
  const foreign = Object.defineProperty({}, "then", {
    get() {
      hooks++;
      throw new Error("must not read then");
    },
  });
  for (const callback of [
    () => true,
    () => foreign,
    () => Promise.reject(new Error("synthetic rejected epoch")),
    () => {
      throw Promise.reject(new Error("synthetic thrown rejection"));
    },
  ]) {
    const authority = createParticipationHistoryAuthority({ epoch: callback, resolve: async () => null });
    assert.equal(authority.epoch({ selectedInput: "synthetic" }), null);
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(hooks, 0);
  const directThenable = createParticipationHistoryAuthority({ epoch: () => "synthetic", resolve: () => foreign });
  await assert.rejects(directThenable.resolve({}, signal()), /participation_history_admission_invalid/);
  assert.equal(hooks, 0, "a direct callback value is inspected before Promise assimilation");
});
