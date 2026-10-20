// Fictional source observations and disposable database fixtures only. These
// exercise the maintenance boundary, not real recognition or public rollout.
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { normalizeGithubObservation, applyRecognitionReceipt } from "@pick-your-ai/github";
import {
  aggregateMetric,
  getMetricDefinition,
  getMetricUi,
  metricRegistryV1,
  selectMetricView,
} from "@pick-your-ai/metrics";
import { materializeRecognition, recognitionFingerprint } from "../src/recognition-adapter.mjs";
import {
  attachSyntheticEvidenceIntake,
  attachSyntheticEvidenceState,
} from "../../../tests/fixtures/evidence-intake.mjs";

const fixture = JSON.parse(
  readFileSync(new URL("../../../packages/github/test/fixtures/engineering.json", import.meta.url), "utf8"),
);
const mergedAt = "2026-10-07T10:00:00.000Z";
const acceptedAt = "2026-10-09T10:00:00.000Z";
const cutoff = "2026-10-10T10:00:00.000Z";

function scenario({
  lifecycle = "merged",
  coauthor = false,
  number = 10,
  markerFree = false,
  collaborators = {},
  accepted = acceptedAt,
} = {}) {
  const data = markerFree ? JSON.parse(JSON.stringify(fixture).replace(/synthetic/gi, "fixture")) : fixture;
  const slug = markerFree ? "example-org/example-repo" : "synthetic-owner/repository";
  const family = lifecycle === "issue" ? "issue" : "pull_request";
  const payload = {
    ...structuredClone(data[family]),
    id: 1000 + number,
    node_id: `${family === "issue" ? "I" : "PR"}_${markerFree ? "fixture" : "synthetic"}_${number}`,
    number,
    user: data.author,
    html_url: `https://github.com/${slug}/${family === "issue" ? "issues" : "pull"}/${number}`,
    updated_at: acceptedAt,
    ...(family === "pull_request"
      ? {
          state: lifecycle === "open" ? "open" : "closed",
          merged: lifecycle === "merged",
          merged_at: lifecycle === "merged" ? mergedAt : null,
          closed_at: lifecycle === "open" ? null : mergedAt,
          merged_by: data.merger,
        }
      : { state: "open" }),
  };
  const input = normalizeGithubObservation({
    repository: { id: 2, slug, visibility: "public", defaultBranch: "main" },
    proof: { verified: true, source: "github_rest", revision: acceptedAt, isSynthetic: false },
    family,
    action: lifecycle === "merged" || lifecycle === "closed" ? "closed" : "opened",
    occurredAt: family === "issue" || lifecycle === "open" ? payload.created_at : mergedAt,
    observedAt: acceptedAt,
    payload: { repository: { ...data.repository, full_name: slug }, [family]: payload },
    ...(coauthor ? { verifiedCoauthors: [{ actor: data.reviewer, verificationReceipt: "fixture-account-link" }] } : {}),
  });
  const sourceMetricId =
    family === "issue"
      ? "issues_opened"
      : coauthor
        ? "pr_coauthored"
        : lifecycle === "merged"
          ? "pr_merged"
          : "pr_opened";
  const candidate = input.facts.find((fact) => fact.metricId === sourceMetricId);
  assert.ok(candidate);
  const evidence = input.evidence.find((entry) => entry.contribution.contributionId === candidate.id);
  assert.ok(evidence);
  const decision = {
    id: `private-maintenance-review-${number}-${candidate.actorId}`,
    action: "accepted",
    version: 2,
    actor: "202",
    at: Date.parse(accepted),
    policyVersion: "maintenance-policy-v1",
  };
  const request = {
    id: `private-maintenance-claim-${number}-${candidate.actorId}`,
    kind: "evidence",
    status: "accepted",
    version: 2,
    owner: candidate.actorId,
    category: "maintenance",
    scope: `repository:2:maintenance:${sourceMetricId}`,
    policyVersion: decision.policyVersion,
    locator: evidence.artifact.publicUrl,
    collaborators: structuredClone(collaborators),
    history: [decision],
  };
  const state = attachSyntheticEvidenceState({
    requests: { [request.id]: request },
    profiles: {},
    audit: [structuredClone(decision)],
  });
  const binding = {
    category: request.category,
    scope: request.scope,
    policyVersion: request.policyVersion,
    metricId: "maintenance",
    sourceMetricId,
    repositoryId: candidate.repoId,
    reviewerIds: ["202"],
  };
  const policy = {
    metricId: "maintenance",
    version: binding.policyVersion,
    definitionVersion: metricRegistryV1.policy_version,
    unit: getMetricDefinition("maintenance").definition.unit,
    aggregation: "count",
    dateBasis: "occurredAt",
    groupBy: "canonical",
    rankedStates: ["qualified"],
    roles: ["author", "coauthor"],
    sources: ["github_rest"],
    minimumSamples: 1,
    rank: false,
  };
  const policies = [{ policy }];
  const run = (apply = applyRecognitionReceipt) =>
    materializeRecognition(input, state, [binding], policies, apply, cutoff);
  return { input, candidate, evidence, decision, request, state, binding, policies, payload, run };
}

function board(input, policy, from = "2026-10-01T00:00:00.000Z", to = cutoff) {
  return aggregateMetric(
    {
      datasetId: "synthetic-maintenance-dataset",
      cutoff,
      backfillRevision: "synthetic-backfill-v1",
      repositoryIds: ["2"],
      actors: input.actors,
      facts: input.facts,
      coverage: [
        {
          schemaVersion: "leaderboard/v1",
          state: "complete",
          source: "github_rest",
          scopeId: "2",
          windowStart: "2026-10-01T00:00:00.000Z",
          windowEnd: cutoff,
          knownStart: "2026-10-01T00:00:00.000Z",
          lastSuccessfulSync: cutoff,
          sourceWatermark: cutoff,
          missingPages: 0,
          permissionsMissing: [],
          sourceErrors: [],
        },
      ],
    },
    policy,
    { timezone: "UTC", from, to, repos: [], projects: [], workstreams: [], roles: [], actors: "all", context: "event" },
  );
}

const qualified = (input) => input.facts.filter((fact) => fact.metricId === "maintenance");

test("maintenance: accepted merged participation uses its source period and leaves raw input intact", () => {
  const s = scenario(),
    original = structuredClone(s.input);
  const out = s.run();
  const facts = qualified(out);
  assert.equal(facts.length, 1);
  assert.equal(facts[0].state, "qualified");
  assert.equal(facts[0].occurredAt, mergedAt);
  assert.equal(facts[0].acceptedAt, acceptedAt);
  assert.equal(facts[0].actorId, "101");
  assert.equal(facts[0].role, "author");
  const proof = out.evidence.find((entry) => entry.contribution.contributionId === facts[0].id);
  assert.equal(proof.occurredAt, mergedAt);
  assert.equal(proof.evidenceMetadata.sourceOccurredAt, mergedAt);
  assert.equal(proof.evidenceMetadata.acceptedAt, acceptedAt);
  assert.deepEqual(proof.contribution.reasonCodes, ["independent_recognition_receipt"]);
  assert.deepEqual(out.facts.slice(0, original.facts.length), original.facts);
  assert.deepEqual(s.input, original);
  assert.equal(board(out, s.policies[0].policy, mergedAt, "2026-10-08T00:00:00.000Z").rows[0].value, 1);
  assert.deepEqual(board(out, s.policies[0].policy, acceptedAt, cutoff).rows, []);
});

for (const [name, patch] of Object.entries({
  "receipt time": { dateBasis: "acceptedAt" },
  "raw state": { rankedStates: ["observed"] },
  "mixed states": { rankedStates: ["qualified", "reviewed"] },
  "artifact grouping": { groupBy: "actor_artifact" },
})) {
  test(`maintenance: policy rejects ${name} before invoking a receipt callback`, () => {
    const s = scenario();
    Object.assign(s.policies[0].policy, patch);
    let calls = 0;
    assert.throws(
      () =>
        s.run((input) => {
          calls++;
          return input;
        }),
      /recognition_policy_not_configured/,
    );
    assert.equal(calls, 0);
  });
}

const invalidSources = {
  "an ineligible source proof": () => {
    const s = scenario();
    s.evidence.contribution.qualification = "ineligible";
    return s;
  },
  "prior source acceptance time": () => {
    const s = scenario();
    s.candidate.acceptedAt = acceptedAt;
    return s;
  },
  "prior source accepting reviewer": () => {
    const s = scenario();
    s.candidate.acceptedBy = "303";
    return s;
  },
  "prior source acceptance receipt": () => {
    const s = scenario();
    s.candidate.acceptanceReceipt = "synthetic-earlier-acceptance";
    return s;
  },
  "an open PR": () => scenario({ lifecycle: "open" }),
  "a closed-unmerged PR": () => scenario({ lifecycle: "closed" }),
  "an issue report": () => scenario({ lifecycle: "issue" }),
  "pending coauthorship": () => scenario({ lifecycle: "open", coauthor: true }),
  "a non-original recognized state": () => {
    const s = scenario();
    s.candidate.state = "qualified";
    return s;
  },
  "a different evidence contributor": () => {
    const s = scenario();
    s.evidence.contribution.actorId = "303";
    return s;
  },
  "a different evidence repository": () => {
    const s = scenario();
    s.evidence.artifact.repositoryId = "3";
    return s;
  },
  "a different PR identity": () => {
    const s = scenario();
    s.evidence.artifact.stableId = "different-pr";
    return s;
  },
  "a different canonical source event": () => {
    const s = scenario();
    s.evidence.contribution.canonicalEventId = "different-event";
    return s;
  },
  "a conflicting source role": () => {
    const s = scenario();
    s.evidence.contribution.roles = ["merger"];
    return s;
  },
  "a conflicting source clock": () => {
    const s = scenario();
    s.evidence.occurredAt = acceptedAt;
    return s;
  },
  "an ambiguous source proof": () => {
    const s = scenario();
    s.input.evidence.push(structuredClone(s.evidence));
    return s;
  },
  "a missing registered contributor": () => {
    const s = scenario();
    s.input.actors = s.input.actors.filter((actor) => actor.id !== s.candidate.actorId);
    return s;
  },
  "duplicate registered contributor entries": () => {
    const s = scenario();
    s.input.actors.push(structuredClone(s.input.actors.find((actor) => actor.id === s.candidate.actorId)));
    return s;
  },
  "acceptance before the merge": () => scenario({ accepted: "2026-10-06T10:00:00.000Z" }),
};
for (const [name, create] of Object.entries(invalidSources)) {
  test(`maintenance: pipeline rejects ${name} before custom receipt authority`, () => {
    const s = create(),
      original = structuredClone(s.input);
    let calls = 0;
    assert.throws(
      () =>
        s.run((input) => {
          calls++;
          return input;
        }),
      /recognition_source_unverified|maintenance/i,
    );
    assert.equal(calls, 0);
    assert.deepEqual(s.input, original);
  });
}

test("maintenance: absent public source proof cannot reach the receipt callback", () => {
  for (const absent of [true, false]) {
    const s = scenario();
    if (absent) s.input.evidence = [];
    else s.evidence.artifact.visibility = "private";
    let calls = 0;
    assert.deepEqual(
      s.run((input) => {
        calls++;
        return input;
      }),
      s.input,
    );
    assert.equal(calls, 0);
  }
});

function duplicateRequest(s, offset = 1000) {
  const request = structuredClone(s.request);
  request.id = "private-maintenance-alias";
  request.history[0].id = "private-maintenance-alias-review";
  request.history[0].receipt = request.id;
  request.history[0].at += offset;
  attachSyntheticEvidenceIntake(request);
  s.state.requests[request.id] = request;
  s.state.audit.push(structuredClone(request.history[0]));
  return request;
}

test("maintenance: repeat accepted receipts conserve one PR actor unit in either insertion order", () => {
  const keys = [];
  for (const reverse of [false, true]) {
    const s = scenario();
    duplicateRequest(s);
    if (reverse) s.state.requests = Object.fromEntries(Object.entries(s.state.requests).reverse());
    let calls = 0;
    const out = s.run((input, receipt, reviewers) => {
      calls++;
      return applyRecognitionReceipt(input, receipt, reviewers);
    });
    assert.equal(calls, 1);
    assert.equal(qualified(out).length, 1);
    assert.equal(qualified(out)[0].acceptanceReceipt, s.decision.id);
    assert.equal(qualified(out)[0].acceptedAt, acceptedAt);
    assert.equal(board(out, s.policies[0].policy).rows[0].value, 1);
    keys.push(qualified(out)[0].canonicalKey);
  }
  assert.equal(keys[0], keys[1]);
});

test("maintenance: invalid duplicate authority is checked before canonical receipt deduplication", () => {
  for (const earlier of [false, true]) {
    const s = scenario();
    const duplicate = duplicateRequest(s, earlier ? -1000 : 1000);
    s.state.audit = s.state.audit.filter((event) => event.id !== duplicate.history[0].id);
    let calls = 0;
    assert.throws(
      () =>
        s.run((input, receipt, reviewers) => {
          calls++;
          return applyRecognitionReceipt(input, receipt, reviewers);
        }),
      /recognition_decision_unverified/,
    );
    assert.equal(calls, earlier ? 0 : 1);
  }
});

function unique(values, key) {
  const result = new Map();
  for (const value of values) {
    const id = key(value);
    if (result.has(id))
      assert.deepEqual(value, result.get(id), "the combined fixture must not hide conflicting source records");
    else result.set(id, value);
  }
  return [...result.values()];
}

test("maintenance: distinct PRs and verified coauthor participation remain distinct accepted units", () => {
  const scenarios = [scenario(), scenario({ coauthor: true }), scenario({ number: 11 })];
  const input = {
    ...structuredClone(scenarios[0].input),
    facts: unique(
      scenarios.flatMap((s) => s.input.facts),
      (fact) => fact.id,
    ),
    evidence: unique(
      scenarios.flatMap((s) => s.input.evidence),
      (entry) => entry.contribution.contributionId,
    ),
    actors: unique(
      scenarios.flatMap((s) => s.input.actors),
      (actor) => actor.id,
    ),
  };
  const state = {
    requests: Object.fromEntries(scenarios.map((s) => [s.request.id, s.request])),
    profiles: {},
    audit: scenarios.map((s) => s.decision),
  };
  const bindings = unique(
    scenarios.map((s) => s.binding),
    (binding) => binding.scope,
  );
  const out = materializeRecognition(input, state, bindings, scenarios[0].policies, applyRecognitionReceipt, cutoff);
  assert.equal(qualified(out).length, 3);
  assert.equal(new Set(qualified(out).map((fact) => fact.canonicalKey)).size, 3);
  assert.deepEqual(
    qualified(out)
      .map((fact) => [fact.actorId, fact.role])
      .sort(),
    [
      ["101", "author"],
      ["101", "author"],
      ["303", "coauthor"],
    ],
  );
  assert.deepEqual(
    board(out, scenarios[0].policies[0].policy)
      .rows.map((row) => [row.actorId, row.value])
      .sort(),
    [
      ["101", 2],
      ["303", 1],
    ],
  );
});

test("maintenance: withdrawal, rejection, reviewer conflicts and audit removal retain their existing boundaries", () => {
  for (const status of ["withdrawn", "appealed", "pending", "rejected"]) {
    const s = scenario();
    s.request.status = status;
    assert.deepEqual(s.run(), s.input);
  }
  const conflict = scenario({ collaborators: { 202: "accepted" } });
  assert.throws(() => conflict.run(), /recognition_decision_unverified/);
  const missingAudit = scenario();
  missingAudit.state.audit = [];
  assert.throws(() => missingAudit.run(), /recognition_decision_unverified/);
});

// Isolate missing maintenance authority while retaining the other independent
// category fences. Automation tests separately preserve its exact prior format.
function previousAuthority(state, bindings) {
  const requests = Object.values(state.requests ?? {})
    .filter((request) => request.kind === "evidence")
    .sort((a, b) => a.id.localeCompare(b.id));
  const ids = new Set(
    requests.flatMap((request) =>
      (request.history ?? []).filter((entry) => entry.action === "accepted").map((entry) => entry.id),
    ),
  );
  const suppressed = Object.entries(state.profiles ?? {})
    .filter(([, profile]) => profile.suppressed)
    .map(([id]) => id)
    .sort();
  const audit = (state.audit ?? [])
    .filter((entry) => ids.has(entry.id))
    .map((entry) => JSON.stringify(entry))
    .sort();
  const authority = ["localization-review-target/v1", requests, suppressed, audit, bindings];
  if (bindings.some((binding) => binding.metricId === "data_quality")) authority.push("data-quality-recognition/v1");
  if (bindings.some((binding) => binding.metricId === "reproductions")) authority.push("reproduction-recognition/v1");
  if (bindings.some((binding) => binding.metricId === "confirmed_bugs"))
    authority.push("confirmed-bug-source-admission/v1");
  // Keep the independent tooling fence while isolating this category.
  if (bindings.some((binding) => binding.metricId === "automation")) authority.push("automation-merged-participant/v1");
  return createHash("sha256").update(JSON.stringify(authority)).digest("hex");
}

test("maintenance: configuration fences preserve automatic sources while manual intake retires prior claim authority", () => {
  const s = scenario();
  const empty = { requests: {}, profiles: {}, audit: [] };
  for (const metric of metricRegistryV1.metrics) {
    const bindings = [{ ...s.binding, metricId: metric.id }];
    // Legacy generic feedback selections lack the required native-thread contract.
    if (metric.id === "helpful_feedback") {
      for (const state of [s.state, empty])
        assert.throws(() => recognitionFingerprint(state, bindings), /invalid_discussion_feedback_contract/);
      continue;
    }
    assert.notEqual(
      recognitionFingerprint(s.state, bindings),
      previousAuthority(s.state, bindings),
      `${metric.id}: manual intake retires prior claim authority`,
    );
    // Keep the literal pre-maintenance authority; the answer clock has its own fence.
    if (
      [
        "maintenance",
        "issue_answers",
        "governance",
        "deployment_work",
        "incidents",
        "release_changes",
        "issue_ordering",
        "release_stewardship",
        "performance",
        "regressions_prevented",
      ].includes(metric.id)
    )
      assert.notEqual(recognitionFingerprint(empty, bindings), previousAuthority(empty, bindings));
    else assert.equal(recognitionFingerprint(empty, bindings), previousAuthority(empty, bindings), metric.id);
  }
  const unrelated = { ...s.binding, metricId: "accepted_findings" };
  assert.notEqual(
    recognitionFingerprint(empty, [unrelated, s.binding]),
    previousAuthority(empty, [unrelated, s.binding]),
  );
  assert.equal(recognitionFingerprint(empty, [unrelated]), previousAuthority(empty, [unrelated]));
  assert.equal(getMetricUi("maintenance").maturity, "definition_only");
  assert.throws(() => selectMetricView("maintenance"), /No supported selectable view/);
});

test("maintenance: obsolete authority withholds persisted public proofs and private previews across reopen and repair", async (t) => {
  const { harness, components, publicScope } = await import("./harness.mjs");
  const { createPipeline } = await import("../src/runtime.mjs");
  const s = scenario({ markerFree: true });
  s.evidence.contribution.reasonCodes.push("private-proof:PRIVATE_MAINTENANCE_RECORD");
  const h = await harness(t, {
    markerFreeConfig: true,
    dataMode: "public",
    payloads: [s.payload],
    normalizerFactory: () => async () => structuredClone(s.input),
    defaultDeliveryNormalizationVersion: components.github.defaultDeliveryNormalizationVersion,
    authorizePolicyPreview: async () => true,
    configure(config) {
      config.repositories[0].families = ["pull_requests"];
      config.recognitionBindings = [s.binding];
      const policy = { ...config.policies[0].policy, ...s.policies[0].policy };
      config.policies = [
        { policy, signature: components.metrics.stableJSON(policy), approvalReceipt: "fixture-approval" },
      ];
    },
  });
  h.controlsStore.transaction((state) => {
    state.requests = s.state.requests;
    state.audit = s.state.audit;
  });
  const publication = await h.runtime.runOnce({ cutoff });
  assert.equal(publication.state, "published");
  const snapshotId = publication.publications[0].snapshotId;
  const read = await h.runtime.source.read(publicScope, snapshotId, new AbortController().signal);
  assert.equal(read.selected.rows[0].result.value, 1);
  const proof = read.selected.evidence.find((entry) => entry.contribution.metricIds.includes("maintenance"));
  assert.ok(proof);
  assert.equal(proof.occurredAt, mergedAt);
  const proofId = proof.contribution.contributionId;
  const paths = [
    `/api/v1/boards?metric=maintenance&snapshot=${snapshotId}`,
    `/api/v1/contributors/101?metric=maintenance&snapshot=${snapshotId}`,
    `/api/v1/evidence/${proofId}?snapshot=${snapshotId}`,
    `/api/v1/exports?metric=maintenance&format=json&snapshot=${snapshotId}`,
    `/api/v1/exports?metric=maintenance&format=csv&snapshot=${snapshotId}`,
  ];
  for (const path of paths) {
    const response = await h.runtime.app.inject(path);
    assert.equal(response.statusCode, 200, response.body);
    assert.doesNotMatch(
      response.body,
      /private-proof|PRIVATE_MAINTENANCE_RECORD|private-maintenance-claim|private-maintenance-review/,
    );
  }
  const preview = (runtime) =>
    runtime.previewPolicy({
      snapshotId,
      policy: { ...h.options.config.policies[0].policy, version: "maintenance-policy-v2" },
      operatorId: "201",
    });
  assert.ok(await preview(h.runtime));
  assert.ok(await h.runtime.aggregateExplanations.read(snapshotId));
  const current = recognitionFingerprint(h.controlsStore.read(), [s.binding]);
  assert.equal(h.controlsStore.read().pipelinePublications[snapshotId].recognitionFingerprint, current);
  const old = previousAuthority(h.controlsStore.read(), [s.binding]);
  assert.notEqual(old, current);
  h.controlsStore.transaction((state) => {
    state.pipelinePublications[snapshotId].recognitionFingerprint = old;
  });
  const denied = async (runtime) => {
    for (const pin of [null, snapshotId])
      assert.equal(await runtime.source.read(publicScope, pin, new AbortController().signal), null);
    for (const path of paths) {
      const response = await runtime.app.inject(path);
      assert.equal(response.statusCode, 410, response.body);
      assert.match(response.headers["cache-control"], /no-store/);
    }
    await assert.rejects(preview(runtime), /policy_input_revoked/);
    await assert.rejects(runtime.aggregateExplanations.read(snapshotId), /authorization_changed/);
  };
  await denied(h.runtime);
  await h.runtime.stop();
  await h.reopenDatabase();
  const restarted = await createPipeline(h.options);
  t.after(() => restarted.stop());
  await denied(restarted);
  const recomputed = await restarted.runOnce({ cutoff });
  assert.equal(recomputed.state, "published");
  const currentId = recomputed.publications[0].snapshotId;
  const restored = await restarted.source.read(publicScope, currentId, new AbortController().signal);
  assert.equal(restored.selected.rows[0].result.value, 1);
  assert.equal((await restarted.app.inject(`/api/v1/evidence/${proofId}?snapshot=${currentId}`)).statusCode, 200);
  h.controlsStore.transaction((state) => {
    state.requests[s.request.id].status = "withdrawn";
  });
  assert.equal(await restarted.source.read(publicScope, currentId, new AbortController().signal), null);
});
