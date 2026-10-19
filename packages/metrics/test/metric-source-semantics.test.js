import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  applyRecognitionReceipt,
  createGithubEvidenceNormalizer,
  groupTriageTransitions,
  githubReviewRevision,
  normalizeGithubObservation,
} from "../../github/dist/index.js";
import { syntheticRepositoryClient } from "../../github/test/synthetic-client.mjs";
import { createGithubCollectionSource } from "../../../apps/pipeline/src/github-source.mjs";
import { metricRegistrySchema } from "../../contracts/dist/index.js";
import {
  aggregateMetric,
  getMetricDefinition,
  getMetricGroupingPolicy,
  getMetricUi,
  metricDefinitionsV1,
  metricRegistryV1,
} from "../dist/index.js";

// Deliberately synthetic public transport payloads. They exercise the real
// normalizer and engine, without claiming collection coverage or release approval.
const fixture = JSON.parse(await readFile(new URL("../../github/test/fixtures/engineering.json", import.meta.url)));
const inventory = JSON.parse(await readFile(new URL("fixtures/metric-source-semantics.json", import.meta.url)));
const at = "2026-10-07T10:00:00Z";
const observedAt = "2026-10-08T10:00:00Z";
const firstReadyAt = "2026-10-02T10:00:00Z";
const scope = {
  timezone: "UTC",
  from: "2026-10-01T00:00:00Z",
  to: observedAt,
  repos: [],
  projects: [],
  workstreams: [],
  roles: [],
  actors: "user",
  context: "event",
};
const cases = new Map(inventory.cases.map((entry) => [entry.id, entry]));
const registered = new Set();
function semanticCase(id, run) {
  assert.ok(cases.has(id), `Unmapped source case: ${id}`);
  assert.ok(!registered.has(id), `Repeated source case: ${id}`);
  registered.add(id);
  test(`${id}: ${cases.get(id).name}`, run);
}
function pull(patch = {}) {
  return { ...structuredClone(fixture.pull_request), user: fixture.author, merged_by: fixture.merger, ...patch };
}
function envelope(patch = {}) {
  return {
    repository: { id: 2, slug: "synthetic-owner/repository", visibility: "public", defaultBranch: "main" },
    proof: { verified: true, source: "github_webhook", revision: at, eventId: "synthetic-event-1", isSynthetic: true },
    family: "pull_request",
    action: "closed",
    occurredAt: at,
    observedAt,
    payload: { repository: fixture.repository, pull_request: pull(), sender: fixture.merger },
    ...patch,
  };
}
const normalize = (patch = {}) => normalizeGithubObservation(envelope(patch));
function policy(metricId, patch = {}) {
  const entry = inventory.metrics.find((entry) => entry.id === metricId);
  assert.ok(entry, `No explicit semantic policy for ${metricId}`);
  return {
    metricId,
    version: "synthetic-source-semantics/v1",
    definitionVersion: metricRegistryV1.policy_version,
    unit: getMetricDefinition(metricId).definition.unit,
    aggregation: entry.aggregation,
    dateBasis: entry.date_basis,
    rankedStates: ["observed"],
    roles: [entry.role],
    groupBy: entry.group_by,
    ...(entry.grouping_seconds ? { groupingSeconds: entry.grouping_seconds } : {}),
    ...(entry.grouping_policy_version ? { groupingPolicyVersion: entry.grouping_policy_version } : {}),
    sources: ["github_webhook", "github_rest"],
    minimumSamples: 1,
    rank: false,
    ...patch,
  };
}
function aggregate(metricId, outputs, policyPatch = {}, scopePatch = {}) {
  const result = aggregateMetric(
    {
      datasetId: "synthetic-metric-source-semantics",
      cutoff: scope.to,
      backfillRevision: "synthetic-source-semantics/v1",
      repositoryIds: ["2"],
      actors: [...new Map(outputs.flatMap((output) => output.actors).map((actor) => [actor.id, actor])).values()],
      facts: outputs.flatMap((output) => output.facts),
      coverage: [],
    },
    policy(metricId, policyPatch),
    { ...scope, ...scopePatch },
  );
  assert.equal(result.publicEnabled, false);
  assert.equal(result.coverage, "incomplete", "Synthetic examples do not prove the source history complete");
  assert.ok(result.rows.every((row) => row.rank === null));
  return result;
}
const values = (result) => result.rows.filter((row) => row.value !== null).map((row) => [row.actorId, row.value]);
const metricFacts = (output, metricId) => output.facts.filter((fact) => fact.metricId === metricId);
function review(id, patch = {}) {
  return {
    id,
    user: fixture.reviewer,
    state: "COMMENTED",
    created_at: at,
    submitted_at: at,
    commit_id: "a".repeat(40),
    html_url: `${fixture.pull_request.html_url}#pullrequestreview-${id}`,
    ...patch,
  };
}
async function hydrateReview(current, cohort = [current], parent = pull(), options = {}) {
  const client = syntheticRepositoryClient(2, {
    rest: async (_source, path) => {
      if (path === `/repos/synthetic-owner/repository/pulls/10/reviews/${current.id}`) return current;
      if (path === "/repos/synthetic-owner/repository/pulls/10") return parent;
      assert.equal(path, "/repos/synthetic-owner/repository");
      return fixture.repository;
    },
    scanRest: async (request) => {
      assert.equal(request.url, "/repos/synthetic-owner/repository/pulls/10/reviews?per_page=100");
      return request.select(cohort);
    },
  });
  return createGithubEvidenceNormalizer({
    client,
    source: "synthetic",
    allowedRepositoryIds: [2],
    isSynthetic: true,
    ...options,
  })({
    repository: { id: 2, slug: "synthetic-owner/repository" },
    family: "reviews",
    factKey: `synthetic-review-${current.id}`,
    observedAt,
    policyVersion: "synthetic/v1",
    fact: {
      subjectId: String(current.id),
      sourceRevision: githubReviewRevision(current),
      sourceUrl: current.html_url,
      evidence: "current_state",
      actorId: null,
      occurredAt: null,
      state: "present",
    },
  });
}

semanticCase("PR-CREATION", () => {
  const draft = normalize({ payload: { pull_request: pull({ draft: true }), sender: fixture.merger } });
  assert.deepEqual(values(aggregate("pr_opened", [draft, draft])), [["101", 1]]);
  assert.equal(metricFacts(draft, "pr_opened")[0].occurredAt, "2026-10-01T10:00:00.000Z");
  const noClock = normalize({ payload: { pull_request: pull({ created_at: null }), sender: fixture.merger } });
  assert.deepEqual(values(aggregate("pr_opened", [noClock])), []);
  assert.deepEqual(aggregate("pr_opened", [draft], {}, { roles: ["merger"] }).rows, []);
});

semanticCase("PR-READINESS", () => {
  const cohort = { verified: true, firstReadyAt, firstSubmittedReviewAt: null };
  const first = normalize({ action: "ready_for_review", occurredAt: firstReadyAt, reviewCohort: cohort });
  const toggle = normalize({ action: "ready_for_review", reviewCohort: cohort });
  assert.deepEqual(values(aggregate("pr_ready", [first, toggle])), [["101", 1]]);
  assert.equal(metricFacts(toggle, "pr_ready")[0].occurredAt, "2026-10-02T10:00:00.000Z");
  assert.deepEqual(aggregate("pr_ready", [toggle], {}, { from: "2026-10-03T00:00:00Z" }).rows, []);
  for (const patch of [
    { action: "snapshot" },
    { action: "ready_for_review" },
    { reviewCohort: { ...cohort, verified: false } },
  ]) {
    assert.deepEqual(metricFacts(normalize(patch), "pr_ready"), []);
  }
});

semanticCase("PR-DELIVERY", () => {
  const merged = normalize();
  assert.deepEqual(values(aggregate("pr_merged", [merged, merged])), [["101", 1]]);
  assert.deepEqual(aggregate("pr_merged", [merged], {}, { roles: ["merger"] }).rows, []);
  for (const change of [{ merged: false }, { merged_at: null }]) {
    const closed = normalize({ payload: { pull_request: pull(change), sender: fixture.merger } });
    assert.deepEqual(metricFacts(closed, "pr_merged"), []);
    assert.deepEqual(values(aggregate("pr_merged", [closed])), []);
  }
  assert.deepEqual(aggregate("pr_merged", [merged], {}, { from: "2026-10-08T00:00:00Z" }).rows, []);
});

semanticCase("PR-COAUTHOR", () => {
  const verifiedCoauthors = [
    { actor: fixture.reviewer, verificationReceipt: "synthetic-coauthor-link" },
    { actor: fixture.reviewer, verificationReceipt: "synthetic-repeated-link" },
    { actor: fixture.author, verificationReceipt: "synthetic-primary-is-not-coauthor" },
    { actor: fixture.merger, verificationReceipt: "" },
  ];
  const merged = normalize({ verifiedCoauthors });
  assert.deepEqual(values(aggregate("pr_coauthored", [merged, merged])), [["303", 1]]);
  assert.deepEqual(values(aggregate("pr_merged", [merged])), [["101", 1]]);
  const pending = normalize({
    verifiedCoauthors,
    payload: { pull_request: pull({ state: "open", merged: false, merged_at: null, closed_at: null }) },
  });
  assert.equal(metricFacts(pending, "pr_coauthored")[0].state, "pending");
  assert.equal(metricFacts(pending, "pr_coauthored")[0].occurredAt, null);
  assert.deepEqual(values(aggregate("pr_coauthored", [pending])), []);
});

semanticCase("MERGE-STEWARD", () => {
  const merged = normalize();
  assert.deepEqual(values(aggregate("maintainer_merges", [merged])), [["202", 1]]);
  const automated = normalize({ payload: { pull_request: pull({ merged_by: fixture.bot }), sender: fixture.merger } });
  assert.deepEqual(values(aggregate("pr_merged", [automated])), [["101", 1]]);
  assert.deepEqual(aggregate("maintainer_merges", [automated]).rows, []);
  assert.deepEqual(values(aggregate("maintainer_merges", [automated], {}, { actors: "automation" })), [["404", 1]]);
  const unknown = normalize({ payload: { pull_request: pull({ merged_by: null }), sender: fixture.merger } });
  assert.deepEqual(values(aggregate("maintainer_merges", [unknown])), [], "The sender cannot replace merged_by");
});

function decision(number, outcome, patch = {}) {
  const decisionAt = outcome === "pending" ? null : at;
  const resource = pull({
    id: number,
    node_id: `PR_synthetic_${number}`,
    number,
    html_url: `https://github.com/synthetic-owner/repository/pull/${number}`,
    merged: outcome === "merged",
    merged_at: outcome === "merged" ? at : null,
    closed_at: decisionAt,
    state: outcome === "pending" ? "open" : "closed",
  });
  return normalize({
    payload: { pull_request: resource, sender: fixture.merger },
    decisionCohort: { verified: true, asOf: observedAt, outcome, decisionAt },
    frozenCutoff: observedAt,
    ...patch,
  });
}
semanticCase("DECIDED-SHARE", () => {
  const merged = decision(11, "merged"),
    closed = decision(12, "closed_unmerged"),
    pending = decision(13, "pending");
  const result = aggregate("pr_accepted_rate", [merged, closed, pending, merged]);
  assert.deepEqual(values(result), [["101", 0.5]]);
  assert.deepEqual([result.rows[0].numerator, result.rows[0].denominator, result.rows[0].pending], [1, 2, 1]);
  assert.equal(result.rows[0].sampleCount, 2);
  assert.equal(result.rows[0].evidenceIds.length, 2, "Pending PRs are not numerator or denominator evidence");
  assert.throws(() => aggregate("pr_accepted_rate", [merged], { rank: true }), /Descriptive metrics/);
  assert.throws(() => aggregate("pr_accepted_rate", [merged], { dateBasis: "occurredAt" }), /decision time/);
});

semanticCase("DECISION-PROOF", () => {
  for (const decisionCohort of [
    undefined,
    { verified: false, asOf: observedAt, outcome: "merged", decisionAt: at },
    { verified: true, asOf: at, outcome: "merged", decisionAt: at },
    { verified: true, asOf: observedAt, outcome: "closed_unmerged", decisionAt: at },
  ]) {
    const out = decision(11, "merged", { decisionCohort });
    assert.deepEqual(metricFacts(out, "pr_accepted_rate"), []);
    assert.deepEqual(values(aggregate("pr_accepted_rate", [out])), []);
  }
  const pending = aggregate("pr_accepted_rate", [decision(13, "pending")]).rows[0];
  assert.deepEqual([pending.value, pending.numerator, pending.denominator, pending.pending], [null, 0, 0, 1]);
  assert.equal(pending.state, "insufficient_sample");
});

semanticCase("REVIEW-PARTICIPATION", async () => {
  const records = [review(51), review(52, { state: "APPROVED" }), review(53, { state: "CHANGES_REQUESTED" })];
  const outputs = await Promise.all(records.map((item) => hydrateReview(item, records)));
  assert.deepEqual(values(aggregate("prs_reviewed", outputs)), [["303", 1]]);
  assert.ok(outputs.every((out) => metricFacts(out, "prs_reviewed")[0].role === "reviewer"));
  assert.deepEqual(aggregate("prs_reviewed", outputs, {}, { roles: ["author"] }).rows, []);
  for (const user of [fixture.author, fixture.bot]) {
    const out = await hydrateReview(review(54, { user }));
    assert.deepEqual(metricFacts(out, "prs_reviewed"), []);
    assert.deepEqual(values(aggregate("prs_reviewed", [out])), []);
  }
  const pending = await hydrateReview(review(55, { state: "PENDING", submitted_at: null }));
  assert.deepEqual(pending.facts, []);
});

semanticCase("REVIEW-ROUNDS", async () => {
  const records = [
    review(61),
    review(62, { state: "CHANGES_REQUESTED", submitted_at: "2026-10-07T11:00:00Z" }),
    review(63, { state: "APPROVED", commit_id: "b".repeat(40), submitted_at: "2026-10-07T12:00:00Z" }),
  ];
  const outputs = await Promise.all(records.map((item) => hydrateReview(item, records)));
  assert.deepEqual(values(aggregate("review_rounds", outputs)), [["303", 2]]);
  assert.deepEqual(values(aggregate("prs_reviewed", outputs)), [["303", 1]]);
  assert.equal(metricFacts(outputs[1], "review_rounds")[0].occurredAt, "2026-10-07T10:00:00.000Z");
  const missing = await hydrateReview(review(64, { commit_id: null }));
  assert.deepEqual(metricFacts(missing, "review_rounds"), []);
  const dismissed = await hydrateReview(review(65, { state: "DISMISSED" }));
  assert.equal(metricFacts(dismissed, "review_rounds")[0].state, "excluded");
  assert.deepEqual(values(aggregate("review_rounds", [dismissed])), []);
});

semanticCase("REVIEW-COHORT-PROOF", async () => {
  const current = review(71);
  const earlier = review(70, { submitted_at: firstReadyAt });
  const valid = await hydrateReview(current, [earlier, current]);
  assert.deepEqual(values(aggregate("prs_reviewed", [valid])), [["303", 1]]);
  assert.deepEqual(aggregate("prs_reviewed", [valid], {}, { from: "2026-10-03T00:00:00Z" }).rows, []);
  for (const cohort of [[current, earlier, earlier], [current, { ...earlier, submitted_at: null }], [earlier]]) {
    const out = await hydrateReview(current, cohort);
    for (const metricId of ["prs_reviewed", "review_rounds"]) {
      assert.deepEqual(metricFacts(out, metricId), []);
      assert.deepEqual(values(aggregate(metricId, [out])), []);
    }
  }
});

semanticCase("REVIEW-FEEDBACK", async () => {
  const first = await hydrateReview(review(81));
  const second = await hydrateReview(review(82, { state: "CHANGES_REQUESTED" }));
  assert.deepEqual(values(aggregate("review_feedback", [first, first, second])), [["303", 2]]);
  assert.ok(first.facts.every((fact) => fact.state === "observed"));
  assert.deepEqual(
    values(aggregate("review_feedback", [first], { rankedStates: ["qualified"], dateBasis: "acceptedAt" })),
    [],
  );
  const target = metricFacts(first, "review_feedback")[0];
  const receipt = {
    verified: true,
    id: "synthetic-independent-feedback",
    metricId: "review_feedback",
    actorId: "303",
    reviewerId: "202",
    acceptedAt: "2026-10-07T15:00:00Z",
    decision: "accepted",
    targetFactId: target.id,
    evidenceIds: ["synthetic-feedback-outcome"],
  };
  const recognized = applyRecognitionReceipt(structuredClone(first), receipt, ["202"]);
  assert.deepEqual(
    values(aggregate("review_feedback", [recognized], { rankedStates: ["qualified"], dateBasis: "acceptedAt" })),
    [["303", 1]],
  );
  assert.throws(
    () => applyRecognitionReceipt(structuredClone(first), { ...receipt, reviewerId: "303" }, ["303"]),
    /Independent verified/,
  );
  const rejected = applyRecognitionReceipt(structuredClone(first), { ...receipt, decision: "rejected" }, ["202"]);
  assert.deepEqual(
    values(aggregate("review_feedback", [rejected], { rankedStates: ["qualified"], dateBasis: "acceptedAt" })),
    [],
  );
  const pending = await hydrateReview(review(83, { state: "PENDING", submitted_at: null }));
  assert.deepEqual(metricFacts(pending, "review_feedback"), []);
});

semanticCase("THREAD-RESOLUTION-CLOCK", () => {
  // This is a host-proven transition boundary, not a claim that REST snapshots
  // reconstruct every thread's history or identify the feedback's actual fixer.
  const payload = {
    issue: { ...fixture.issue, user: fixture.author },
    sender: fixture.reviewer,
    resolvedBy: fixture.merger,
  };
  const transition = normalize({ family: "thread_resolution", action: "resolved_transition", payload });
  assert.deepEqual(values(aggregate("review_threads_resolved", [transition, transition])), [["303", 1]]);
  const snapshot = normalize({ family: "thread_resolution", action: "snapshot", payload });
  assert.deepEqual(metricFacts(snapshot, "review_threads_resolved"), []);
  const noClock = normalize({ family: "thread_resolution", action: "resolved_transition", occurredAt: null, payload });
  assert.deepEqual(values(aggregate("review_threads_resolved", [noClock])), []);
  assert.deepEqual(aggregate("review_threads_resolved", [transition], {}, { roles: ["author"] }).rows, []);
});

semanticCase("REVIEW-WAIT-CLOCKS", () => {
  const cohort = (number, ready, submitted) =>
    normalize({
      payload: { pull_request: pull({ id: number, node_id: `PR_synthetic_wait_${number}`, number }) },
      reviewCohort: { verified: true, firstReadyAt: ready, firstSubmittedReviewAt: submitted },
    });
  const measured = cohort(91, firstReadyAt, "2026-10-02T12:00:00Z");
  const censored = cohort(92, firstReadyAt, null);
  const unknown = cohort(93, null, null);
  const result = aggregate("review_wait", [measured, censored, unknown]);
  assert.deepEqual(values(result), [["101", 2]]);
  assert.deepEqual([result.rows[0].sampleCount, result.rows[0].censored, result.rows[0].missingReadiness], [1, 1, 1]);
  assert.deepEqual(result.rows[0].samples, [2]);
  assert.equal(result.rows[0].p75, 2);
  const empty = aggregate("review_wait", [censored, unknown]).rows[0];
  assert.equal(empty.value, null);
  assert.equal(empty.sampleCount, 0);
  assert.deepEqual(aggregate("review_wait", [measured], {}, { from: "2026-10-03T00:00:00Z" }).rows, []);
  assert.throws(() => aggregate("review_wait", [measured], { rank: true }), /Descriptive metrics/);
});

semanticCase("ISSUE-REPORTER-CLOSER", () => {
  const payload = {
    issue: { ...fixture.issue, user: fixture.author, assignees: [fixture.reviewer] },
    sender: fixture.merger,
  };
  const closed = normalize({ family: "issue", action: "closed", payload });
  assert.deepEqual(values(aggregate("issues_opened", [closed])), [["101", 1]]);
  assert.deepEqual(values(aggregate("issue_closure_stewardship", [closed])), [["202", 1]]);
  for (const id of ["issue_resolution", "accepted_findings", "confirmed_bugs"])
    assert.deepEqual(metricFacts(closed, id), []);
  assert.ok(
    closed.facts.every((fact) => fact.actorId !== "303"),
    "An assignee receives neither reporter nor closer credit",
  );
  const snapshot = normalize({ family: "issue", action: "snapshot", payload });
  assert.deepEqual(metricFacts(snapshot, "issue_closure_stewardship"), []);
  const unknownReporter = normalize({
    family: "issue",
    action: "closed",
    payload: { ...payload, issue: { ...payload.issue, user: null } },
  });
  assert.deepEqual(values(aggregate("issues_opened", [unknownReporter])), []);
  assert.deepEqual(values(aggregate("issue_closure_stewardship", [unknownReporter])), [["202", 1]]);
});

async function collectedTimeline(event, hydrated = event) {
  const repository = {
    id: 2,
    installationId: 1,
    slug: "synthetic-owner/repository",
    families: ["timelines"],
  };
  const calls = [];
  const client = syntheticRepositoryClient(2, {
    rest: async (_source, path) => {
      calls.push(path);
      if (path === "/repos/synthetic-owner/repository") return fixture.repository;
      assert.equal(path, `/repos/synthetic-owner/repository/issues/events/${event.id}`);
      return structuredClone(hydrated);
    },
    scanRest: async (request) => {
      assert.equal(request.url, "/repos/synthetic-owner/repository/issues/events?per_page=100");
      return request.select([structuredClone(event)]);
    },
  });
  const source = createGithubCollectionSource({
    client,
    sourceId: "synthetic",
    repositories: [repository],
    isSynthetic: true,
  });
  const page = await source.readPage({
    repositoryId: 2,
    runId: "synthetic",
    family: "timelines",
    cursor: null,
    limit: 10,
  });
  assert.equal(page.facts.length, 1);
  assert.equal(page.nextCursor, null);
  const output = await createGithubEvidenceNormalizer({
    client,
    source: "synthetic",
    allowedRepositoryIds: [2],
    isSynthetic: true,
  })({
    repository,
    family: "timelines",
    factKey: `synthetic-timeline-${event.id}`,
    observedAt,
    policyVersion: "synthetic/v1",
    fact: page.facts[0],
  });
  assert.ok(calls.includes(`/repos/synthetic-owner/repository/issues/events/${event.id}`));
  return { page, output };
}

function timelineEvent(action, field, patch = {}) {
  return {
    id: 901,
    event: action,
    actor: fixture.merger,
    created_at: at,
    issue: {
      ...structuredClone(fixture.issue),
      user: fixture.author,
      labels: [{ id: 81 }],
      assignees: [fixture.reviewer],
      milestone: { id: 82 },
    },
    ...(field ? { [field]: { id: 90, node_id: "SYNTHETIC_TARGET" } } : {}),
    ...patch,
  };
}

for (const [id, metricId, action, field] of [
  ["COLLECTED-LABEL", "labels_applied", "labeled", "label"],
  ["COLLECTED-ASSIGNMENT", "assignments_coordinated", "assigned", "assignee"],
  ["COLLECTED-MILESTONE", "milestones_curated", "milestoned", "milestone"],
]) {
  semanticCase(id, async () => {
    const event = timelineEvent(action, field);
    const before = structuredClone(event);
    const { page, output } = await collectedTimeline(event);
    assert.equal(page.facts[0].actorId, "202");
    assert.equal(page.facts[0].occurredAt, "2026-10-07T10:00:00.000Z");
    const fact = metricFacts(output, metricId)[0];
    assert.equal(fact.actorId, "202");
    assert.equal(fact.role, "triager");
    assert.equal(fact.occurredAt, page.facts[0].occurredAt);
    assert.equal(fact.rawState, `${action}:SYNTHETIC_TARGET`);
    assert.deepEqual(values(aggregate(metricId, [output, output])), [["202", 1]]);
    assert.deepEqual(aggregate(metricId, [output], {}, { roles: ["author"] }).rows, []);
    assert.deepEqual(aggregate(metricId, [output], {}, { from: "2026-10-07T11:00:00Z" }).rows, []);
    assert.equal(
      output.facts.some((entry) => entry.actorId === "303"),
      false,
      "The current assignee is not the editor",
    );

    for (const missing of [undefined, {}, { name: "Synthetic display name without identity" }]) {
      const unrelated = field === "label" ? "milestone" : "label";
      const absent = await collectedTimeline(
        timelineEvent(action, field, { [field]: missing, [unrelated]: { id: 99 } }),
      );
      assert.equal(metricFacts(absent.output, metricId)[0].state, "unknown");
      assert.deepEqual(values(aggregate(metricId, [absent.output])), []);
    }
    const changed = await collectedTimeline(event, { ...event, [field]: { id: 91 } });
    assert.deepEqual(changed.output.facts, []);
    assert.ok(changed.output.reasons.includes("hydrated_source_revision_unverified"));
    const wrongSubject = await collectedTimeline(event, {
      ...event,
      issue: { ...event.issue, html_url: `${event.issue.html_url}1` },
    });
    assert.deepEqual(wrongSubject.output.facts, []);
    const unknownActor = await collectedTimeline(timelineEvent(action, field, { actor: null }));
    assert.deepEqual(values(aggregate(metricId, [unknownActor.output])), []);
    const bot = await collectedTimeline(timelineEvent(action, field, { actor: fixture.bot }));
    assert.deepEqual(aggregate(metricId, [bot.output]).rows, []);
    const snapshot = normalize({
      family: "issue",
      action: "snapshot",
      payload: { issue: event.issue, sender: fixture.merger },
    });
    assert.deepEqual(metricFacts(snapshot, metricId), []);
    if (metricId === "milestones_curated") {
      const removed = await collectedTimeline(timelineEvent("demilestoned", field, { id: 902 }));
      assert.equal(metricFacts(removed.output, metricId)[0].rawState, "demilestoned:SYNTHETIC_TARGET");
      assert.deepEqual(
        values(aggregate(metricId, [output, removed.output])),
        [["202", 2]],
        "The raw event lens retains both actions",
      );
      const transitions = [output, removed.output].map((result, index) => {
        const fact = metricFacts(result, metricId)[0];
        return {
          id: fact.id,
          artifactId: fact.artifactId,
          actorId: fact.actorId,
          occurredAt: fact.occurredAt,
          facet: "milestone",
          targetId: "SYNTHETIC_TARGET",
          before: index ? "present" : "absent",
          after: index ? "absent" : "present",
        };
      });
      const grouped = groupTriageTransitions(transitions, {
        version: "synthetic-milestone/v1",
        intervalSeconds: 3600,
        cooldownSeconds: 86400,
      });
      assert.equal(grouped.sessions.length, 1);
      assert.equal(grouped.sessions[0].rawActions, 2);
      assert.equal(grouped.sessions[0].reversalSuppressed, true);
      assert.equal(grouped.qualifiedOutcomes, 0, "A reversal group does not manufacture completed curation");
      const definition = normalize({
        family: "triage",
        action: "milestone_edited",
        payload: {
          milestone: { ...event.milestone, html_url: "https://github.com/synthetic-owner/repository/milestone/1" },
          sender: fixture.merger,
        },
      });
      assert.deepEqual(metricFacts(definition, metricId), []);
      assert.equal(metricFacts(definition, "milestone_definitions").length, 1);
    }
    assert.deepEqual(event, before);
  });
}

semanticCase("PUBLIC-STEWARDSHIP-DAY", async () => {
  const grouping = getMetricGroupingPolicy("public_moderation");
  assert.equal(grouping.version, "public-stewardship-day/v1");
  assert.equal(grouping.grouping_seconds, 86400);
  assert.equal(grouping.public_enabled, false);
  assert.equal(getMetricUi("public_moderation").default_combination, null);
  const outputs = [];
  for (const [index, action] of ["pinned", "unpinned", "locked", "unlocked"].entries()) {
    const { output } = await collectedTimeline(timelineEvent(action, null, { id: 910 + index }));
    assert.equal(metricFacts(output, "public_moderation")[0].rawState, `${action}:unknown`);
    outputs.push(output);
  }
  assert.deepEqual(values(aggregate("public_moderation", [...outputs, ...outputs])), [["202", 1]]);
  const previousDay = await collectedTimeline(
    timelineEvent("locked", null, { id: 919, created_at: "2026-10-06T23:59:59Z" }),
  );
  assert.deepEqual(values(aggregate("public_moderation", [...outputs, previousDay.output])), [["202", 2]]);
  const snapshot = normalize({
    family: "issue",
    action: "snapshot",
    payload: { issue: { ...fixture.issue, locked: true, pinned: true }, sender: fixture.merger },
  });
  assert.deepEqual(metricFacts(snapshot, "public_moderation"), []);
  const privateSource = normalize({
    family: "triage",
    action: "locked",
    repository: { id: 2, slug: "synthetic-owner/repository", visibility: "private" },
  });
  assert.deepEqual(metricFacts(privateSource, "public_moderation"), []);
  const organizationBlock = normalize({ family: "triage", action: "member_blocked" });
  assert.deepEqual(metricFacts(organizationBlock, "public_moderation"), []);
  assert.throws(() => aggregate("public_moderation", outputs, { rank: true }), /Descriptive metrics/);
  for (const patch of [
    { groupingSeconds: 3600 },
    { groupingPolicyVersion: undefined },
    { groupBy: "canonical" },
    { dateBasis: "acceptedAt" },
  ]) {
    assert.throws(() => aggregate("public_moderation", outputs, patch), /exact versioned grouping/);
  }
  const altered = structuredClone(metricRegistryV1);
  altered.grouping_policies.find((entry) => entry.metric_id === "public_moderation").grouping_seconds = 3600;
  assert.equal(metricRegistrySchema.safeParse(altered).success, false);
});

semanticCase("FIRST-REVIEW-SEQUENCE", async () => {
  const first = review(941, { state: "COMMENTED" });
  const tie = review(942, { user: fixture.merger, state: "CHANGES_REQUESTED" });
  const later = review(943, { user: fixture.merger, submitted_at: "2026-10-07T11:00:00Z" });
  const own = review(944, { user: fixture.author, submitted_at: "2026-10-06T10:00:00Z" });
  const automated = review(945, { user: fixture.bot, submitted_at: "2026-10-06T09:00:00Z" });
  const pending = review(946, { state: "PENDING", user: null, submitted_at: null });
  const cohort = [later, own, pending, tie, automated, first];
  const earlyOutput = await hydrateReview(first, cohort);
  const tieOutput = await hydrateReview(tie, cohort);
  assert.deepEqual(values(aggregate("first_reviews", [earlyOutput, tieOutput, earlyOutput])), [
    ["202", 1],
    ["303", 1],
  ]);
  assert.equal(metricFacts(earlyOutput, "first_reviews")[0].occurredAt, "2026-10-07T10:00:00.000Z");
  assert.deepEqual(metricFacts(await hydrateReview(later, cohort), "first_reviews"), []);
  assert.deepEqual(metricFacts(await hydrateReview(own, cohort), "first_reviews"), []);
  assert.deepEqual(metricFacts(await hydrateReview(automated, cohort), "first_reviews"), []);
  assert.deepEqual(metricFacts(await hydrateReview(pending, cohort), "first_reviews"), []);
  assert.deepEqual(metricFacts(await hydrateReview(first, [...cohort, first]), "first_reviews"), []);
  assert.deepEqual(
    metricFacts(
      await hydrateReview(
        first,
        cohort.filter((item) => item.id !== first.id),
      ),
      "first_reviews",
    ),
    [],
  );
  assert.deepEqual(metricFacts(await hydrateReview(first, cohort, pull({ user: null })), "first_reviews"), []);
  const conflictingAuthor = pull({ user: { ...fixture.author, node_id: "U_SYNTHETIC_AUTHOR" } });
  const aliasedAuthor = review(947, {
    user: { ...fixture.merger, node_id: "U_SYNTHETIC_AUTHOR" },
    submitted_at: "2026-10-07T11:00:00Z",
  });
  assert.deepEqual(
    metricFacts(await hydrateReview(first, [first, aliasedAuthor], conflictingAuthor), "first_reviews"),
    [],
    "A later cohort entry cannot rebind the pull author's native identity",
  );
  for (const earlier of [
    review(947, { user: null, submitted_at: "2026-10-06T10:00:00Z" }),
    review(947, { user: { ...fixture.merger, type: "Unknown" }, submitted_at: "2026-10-06T10:00:00Z" }),
    review(947, { submitted_at: "2026-09-30T10:00:00Z" }),
    review(947, { submitted_at: "2026-10-09T10:00:00Z" }),
    review(947, { submitted_at: "2026-10-07T10:00:00.0001Z" }),
    review(947, { state: "PENDING", submitted_at: at }),
  ])
    assert.deepEqual(metricFacts(await hydrateReview(first, [...cohort, earlier]), "first_reviews"), []);
  const dismissed = review(948, { state: "DISMISSED", user: fixture.merger, submitted_at: "2026-10-06T10:00:00Z" });
  assert.deepEqual(
    metricFacts(await hydrateReview(first, [dismissed, first]), "first_reviews"),
    [],
    "A dismissed earlier submission does not turn a later review into historical first",
  );
  assert.deepEqual(metricFacts(await hydrateReview(dismissed, [dismissed, first]), "first_reviews"), []);
  const service = review(949, {
    user: { id: 606, node_id: "U_SYNTHETIC_SERVICE_606", type: "User" },
    submitted_at: "2026-10-06T10:00:00Z",
  });
  const classifications = {
    reviewedServiceAccounts: [
      {
        schemaVersion: "leaderboard-service-account/v1",
        classificationId: "synthetic-first-review-service",
        githubDatabaseId: 606,
        githubNodeId: "U_SYNTHETIC_SERVICE_606",
        source: "reviewed_configuration",
        evidenceIds: ["synthetic-classification-606"],
        reviewerActorId: "202",
        reviewedAt: "2026-10-01T00:00:00Z",
      },
    ],
    authorizedClassifierIds: ["202"],
  };
  const serviceExcluded = await hydrateReview(first, [service, first], pull(), classifications);
  assert.deepEqual(values(aggregate("first_reviews", [serviceExcluded])), [["303", 1]]);
  assert.ok(
    !serviceExcluded.actors.some((actor) => actor.id === "606"),
    "Sequence inspection does not add unrelated actors to the normalized output",
  );
  assert.deepEqual(
    metricFacts(await hydrateReview(service, [service, first], pull(), classifications), "first_reviews"),
    [],
  );
  assert.deepEqual(
    metricFacts(await hydrateReview(first, [service, first]), "first_reviews"),
    [],
    "A user-looking account is not classified by its appearance",
  );
  await assert.rejects(
    hydrateReview(first, [service, first], pull(), {
      ...classifications,
      reviewedServiceAccounts: [{ ...classifications.reviewedServiceAccounts[0], githubNodeId: "U_WRONG" }],
    }),
    /classification conflicts/,
  );
  assert.deepEqual(aggregate("first_reviews", [earlyOutput], {}, { from: "2026-10-07T10:00:00.001Z" }).rows, []);
  assert.deepEqual(
    metricFacts(
      normalize({
        family: "review",
        action: "first_submitted_review_verified",
        payload: { pull_request: pull(), review: first },
      }),
      "first_reviews",
    ),
    [],
    "An action string cannot replace a complete source sequence",
  );
});

test("the semantic inventory accounts for all 98 definitions and preserves exact existing semantic test references", async () => {
  assert.equal(inventory.synthetic, true);
  assert.equal(metricDefinitionsV1.length, 98);
  const covered = inventory.metrics.map((entry) => entry.id);
  const deferred = inventory.deferred.flatMap((group) => group.metric_ids);
  const existing = inventory.existing_evidence.map((entry) => entry.metric_id);
  const all = [...covered, ...existing, ...deferred];
  assert.equal(new Set(all).size, all.length, "Every metric must appear in exactly one disposition");
  assert.deepEqual(all.sort(), metricDefinitionsV1.map((metric) => metric.id).sort());
  assert.equal(new Set(inventory.cases.map((entry) => entry.id)).size, inventory.cases.length);
  assert.deepEqual([...registered].sort(), inventory.cases.map((entry) => entry.id).sort());
  for (const entry of inventory.metrics) {
    assert.ok(entry.case_ids.length && entry.remaining_scope.trim());
    for (const id of entry.case_ids) assert.ok(registered.has(id));
  }
  for (const entry of inventory.cases) {
    assert.ok(entry.inclusion.trim() && entry.exclusion.trim());
    assert.ok(inventory.metrics.some((metric) => metric.case_ids.includes(entry.id)));
  }
  for (const entry of inventory.deferred) assert.ok(entry.reason.trim() && entry.metric_ids.length);
  for (const entry of inventory.existing_evidence) {
    assert.match(entry.path, /^(?:apps|packages)\/[A-Za-z0-9_./-]+\.test\.(?:mjs|js)$/);
    assert.ok(!entry.path.split("/").includes(".."));
    const source = await readFile(new URL(`../../../${entry.path}`, import.meta.url), "utf8");
    assert.ok(
      entry.positive_test.trim() && source.includes(entry.positive_test),
      `${entry.metric_id}: missing positive test`,
    );
    assert.ok(
      entry.negative_test.trim() && source.includes(entry.negative_test),
      `${entry.metric_id}: missing exclusion test`,
    );
    assert.ok(entry.limitation.trim());
    if (entry.case_parameter) {
      assert.equal(entry.case_parameter, entry.metric_id);
      assert.ok(source.includes(entry.case_parameter), `${entry.metric_id}: missing parameterized source case`);
    }
  }
  const unsupported = inventory.deferred.find((entry) => entry.id === "unsupported-aggregation");
  assert.deepEqual(unsupported.metric_ids, ["net_lines"]);
  assert.throws(
    () =>
      aggregateMetric(
        { cutoff: scope.to },
        {
          metricId: "net_lines",
          version: "synthetic",
          definitionVersion: metricRegistryV1.policy_version,
          unit: getMetricDefinition("net_lines").definition.unit,
          aggregation: "sum",
        },
        scope,
      ),
    /signed net changes are unsupported/,
  );
});
