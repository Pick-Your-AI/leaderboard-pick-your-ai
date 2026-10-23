import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  normalizeGithubObservation,
  applyRecognitionReceipt,
  groupTriageTransitions,
} from "../../github/dist/index.js";
import { aggregateMetric, getMetricDefinition, getMetricGroupingPolicy, metricRegistryV1 } from "../dist/index.js";

// Deliberately synthetic adversarial scenarios. Actual batch histories are
// audited outside the repository and are never test data or public rankings.
const at = "2026-10-07T10:00:00Z",
  observedAt = "2026-10-08T10:00:00Z";
const repository = { id: 2, slug: "synthetic-owner/repository", visibility: "public" };
const user = { id: 202, node_id: "U_synthetic_triager", login: "synthetic-triager", type: "User" };
const bot = { id: 303, node_id: "B_synthetic_bot", login: "synthetic-bot", type: "Bot" };
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
const issue = (number = 1, author = user) => ({
  id: 1000 + number,
  node_id: `I_synthetic_${number}`,
  number,
  html_url: `https://github.com/${repository.slug}/issues/${number}`,
  created_at: at,
  updated_at: observedAt,
  user: author,
});
const observation = (id, patch = {}) => ({
  repository,
  proof: {
    verified: true,
    source: "github_rest",
    revision: at,
    eventId: `github:2:issue-event:${id}`,
    isSynthetic: true,
  },
  family: "triage",
  action: "labeled",
  occurredAt: at,
  observedAt,
  payload: { issue: issue(), actor: user, label: { id: 80 } },
  ...patch,
});
const frozen = (outputs, facts = [], actors = []) => ({
  datasetId: "synthetic-triage-fairness",
  cutoff: scope.to,
  backfillRevision: "synthetic/v1",
  repositoryIds: ["2"],
  actors: [...new Map([...outputs.flatMap((out) => out.actors), ...actors].map((actor) => [actor.id, actor])).values()],
  facts: [...outputs.flatMap((out) => out.facts), ...facts],
  coverage: [],
});
const policy = (metricId, patch = {}) => ({
  metricId,
  version: "synthetic-fairness/v1",
  definitionVersion: metricRegistryV1.policy_version,
  unit: getMetricDefinition(metricId).definition.unit,
  aggregation: "count",
  dateBasis: "acceptedAt",
  rankedStates: ["qualified"],
  roles: ["author", "resolver", "triager"],
  groupBy: "canonical",
  sources: ["github_rest"],
  minimumSamples: 1,
  rank: true,
  ...patch,
});
const grouping = getMetricGroupingPolicy("items_triaged");
const rawPolicy = policy("items_triaged", {
  dateBasis: grouping.date_basis,
  rankedStates: [grouping.state],
  roles: ["triager"],
  groupBy: grouping.group_by,
  groupingSeconds: grouping.grouping_seconds,
  groupingPolicyVersion: grouping.version,
});

test("3,000 self-triage and bot loop events remain raw and cannot change unrelated accepted boards", () => {
  const outputs = [],
    transitions = [];
  for (const actor of [user, bot])
    for (let item = 1; item <= 250; item++)
      for (let step = 0; step < 6; step++) {
        const action = step % 2 === 0 ? "labeled" : "unlabeled";
        const out = normalizeGithubObservation(
          observation(`${actor.id}-${item}-${step}`, {
            action,
            occurredAt: `2026-10-07T10:00:0${step}Z`,
            payload: { issue: issue(item, actor), actor, label: { id: 80 } },
          }),
        );
        outputs.push(out);
        const source = out.observations[0];
        transitions.push({
          id: source.id,
          artifactId: source.artifactId,
          actorId: source.actorId,
          facet: "label",
          targetId: "github:metadata:80",
          occurredAt: source.occurredAt,
          before: action === "labeled" ? "absent" : "present",
          after: action === "labeled" ? "present" : "absent",
        });
      }
  assert.equal(outputs.length, 3000);
  assert.deepEqual([...new Set(outputs.flatMap((out) => out.facts.map((fact) => fact.metricId)))].sort(), [
    "items_triaged",
    "labels_applied",
  ]);
  assert.ok(
    outputs.every((out) => out.facts.every((fact) => fact.state === "observed" && fact.acceptanceReceipt === null)),
  );
  const dataset = frozen([...outputs, ...outputs.slice(0, 10)]);
  assert.deepEqual(
    aggregateMetric(dataset, rawPolicy, scope).rows.map((row) => [row.actorId, row.value]),
    [["202", 500]],
  );
  assert.deepEqual(
    aggregateMetric(dataset, rawPolicy, { ...scope, actors: "automation" }).rows.map((row) => [row.actorId, row.value]),
    [["303", 500]],
  );
  assert.equal(
    dataset.actors.find((actor) => actor.id === "202").executionMode,
    "unknown",
    "User does not certify manual execution",
  );
  const grouped = groupTriageTransitions([...transitions].reverse().concat(transitions[0]), {
    version: "synthetic-loop/v1",
    intervalSeconds: 300,
    cooldownSeconds: 3600,
  });
  assert.equal(grouped.rawActions, 3000);
  assert.equal(grouped.sessions.length, 500);
  assert.ok(
    grouped.sessions.every(
      (session) => session.rawActions === 6 && session.reversalSuppressed && !session.qualifiedCandidate,
    ),
  );
  assert.equal(grouped.qualifiedOutcomes, 0);

  const actors = ["404", "505"].map((id) => ({
    id,
    login: `synthetic-contributor-${id}`,
    kind: "user",
    publicState: "visible",
  }));
  for (const metricId of ["pr_merged", "issue_resolution"]) {
    const accepted = actors.flatMap((actor, index) =>
      Array.from({ length: 14 + index }, (_, item) => ({
        id: `${metricId}-${actor.id}-${item}`,
        canonicalKey: `${metricId}-${actor.id}-${item}`,
        metricId,
        actorId: actor.id,
        artifactId: `synthetic-delivery-${actor.id}-${item}`,
        repoId: "2",
        role: metricId === "pr_merged" ? "author" : "resolver",
        state: "qualified",
        occurredAt: at,
        acceptedAt: observedAt,
        observedAt,
        revision: 0,
        correctionReceipt: null,
        acceptanceReceipt: "synthetic-independent-acceptance",
        acceptedBy: "synthetic-reviewer",
        subjectActorId: actor.id,
        eventContext: null,
        currentContext: null,
      })),
    );
    // Acceptance occurs inside the selected half-open interval.
    for (const fact of accepted) fact.acceptedAt = "2026-10-08T09:00:00Z";
    const before = aggregateMetric(frozen([], accepted, actors), policy(metricId), scope);
    const after = aggregateMetric(frozen(outputs, accepted, actors), policy(metricId), scope);
    assert.deepEqual(
      before.rows.map((row) => [row.actorId, row.value, row.rank]),
      [
        ["505", 15, 1],
        ["404", 14, 2],
      ],
    );
    assert.deepEqual(after.rows, before.rows, metricId);
    assert.equal(after.publicEnabled, false);
    assert.equal("totalScore" in after, false);
  }
});

test("self-triage does not authorize self-recognition or one accepted correction per batch effect", () => {
  const raw = normalizeGithubObservation(observation(1));
  const target = raw.facts.find((fact) => fact.metricId === "items_triaged");
  const receipt = {
    verified: true,
    id: "synthetic-correction",
    metricId: "labels_corrected",
    actorId: "202",
    reviewerId: "202",
    acceptedAt: "2026-10-08T09:00:00Z",
    decision: "accepted",
    targetFactId: target.id,
    evidenceIds: ["synthetic-correction-proof"],
  };
  assert.throws(() => applyRecognitionReceipt(raw, receipt, ["202"]), /Independent verified recognition/);
  assert.equal(aggregateMetric(frozen([raw]), policy("labels_corrected"), scope).rows.length, 0);
  const reviewed = applyRecognitionReceipt(
    raw,
    { ...receipt, reviewerId: "synthetic-independent-reviewer", changesetId: "synthetic-one-reviewed-correction" },
    ["synthetic-independent-reviewer"],
  );
  const replay = structuredClone(reviewed);
  for (const fact of replay.facts) {
    fact.id += "-reobserved";
    fact.observedAt = "2026-10-08T09:30:00Z";
  }
  const result = aggregateMetric(frozen([reviewed, replay]), policy("labels_corrected"), scope);
  assert.equal(result.rows[0].value, 1);
  assert.equal(result.rows[0].evidenceIds.length, 1);
  assert.ok(result.audit.some((entry) => entry.reason === "duplicate_observation"));
  assert.ok(
    raw.facts.every((fact) => fact.state === "observed"),
    "an accepted copy must not rewrite the original raw evidence",
  );
});

test("labels_corrected excludes raw label activity and every non-independent, unverified, rejected or out-of-lens receipt", () => {
  const raw = normalizeGithubObservation(observation(1));
  const target = raw.facts.find((fact) => fact.metricId === "items_triaged");
  const reviewerId = "synthetic-independent-reviewer";
  const receipt = {
    verified: true,
    id: "synthetic-labels-corrected-receipt",
    metricId: "labels_corrected",
    actorId: "202",
    reviewerId,
    acceptedAt: "2026-10-08T09:00:00Z",
    decision: "accepted",
    targetFactId: target.id,
    evidenceIds: ["synthetic-correction-proof"],
  };
  // Rows with a null value are actors with no counted unit.
  const board = (output, patch = {}, window = scope) =>
    aggregateMetric(frozen([output]), policy("labels_corrected", patch), window).rows.filter(
      (row) => row.value !== null,
    );
  // Raw label activity is observed triage only: it is never a correction, in any evidence lens.
  assert.deepEqual(
    raw.facts.map((fact) => [fact.metricId, fact.state]),
    [
      ["labels_applied", "observed"],
      ["items_triaged", "observed"],
    ],
  );
  assert.equal(board(raw).length, 0);
  assert.equal(board(raw, { rankedStates: ["observed"], dateBasis: "occurredAt" }).length, 0);

  // Control: a valid independent receipt is exactly one accepted correction for the triager.
  const accepted = applyRecognitionReceipt(raw, receipt, [reviewerId]);
  assert.deepEqual(
    board(accepted).map((row) => [row.actorId, row.value]),
    [["202", 1]],
  );
  // The same accepted correction is invisible to an observed lens and outside its accepted window.
  assert.equal(board(accepted, { rankedStates: ["observed"], dateBasis: "occurredAt" }).length, 0);
  assert.equal(board(accepted, {}, { ...scope, to: "2026-10-08T09:00:00Z" }).length, 0);
  assert.equal(board(accepted, {}, { ...scope, from: "2026-10-08T09:00:01Z" }).length, 0);

  // A rejection is retained as excluded evidence and contributes no unit.
  const rejected = applyRecognitionReceipt(raw, { ...receipt, decision: "rejected" }, [reviewerId]);
  assert.deepEqual(
    rejected.facts.filter((fact) => fact.metricId === "labels_corrected").map((fact) => fact.state),
    ["excluded"],
  );
  assert.equal(board(rejected).length, 0);

  // Receipts that are not verified, independent, authorized, on the actor's own target or evidenced create no fact.
  for (const [name, patch, reviewers] of [
    ["unverified", { verified: false }, [reviewerId]],
    ["self-reviewed", { reviewerId: "202" }, ["202"]],
    ["an unauthorized reviewer", {}, ["synthetic-other-reviewer"]],
    ["another actor's target", { actorId: "303" }, [reviewerId, "303"]],
    ["a missing target fact", { targetFactId: "synthetic-missing-fact" }, [reviewerId]],
    ["no evidence", { evidenceIds: [] }, [reviewerId]],
    ["a blank receipt identity", { id: " " }, [reviewerId]],
    ["an unrelated metric", { metricId: "repositories" }, [reviewerId]],
  ])
    assert.throws(
      () => applyRecognitionReceipt(raw, { ...receipt, ...patch }, reviewers),
      /Independent verified recognition/,
      name,
    );
  // A known participant who did not perform the triage cannot receive its correction either.
  const author = { id: 505, node_id: "U_synthetic_author", login: "synthetic-author", type: "User" };
  const shared = normalizeGithubObservation(
    observation(2, { payload: { issue: issue(2, author), actor: user, label: { id: 80 } } }),
  );
  assert.ok(
    shared.actors.some((actor) => actor.id === "505"),
    "The issue author is a known participant",
  );
  const sharedTarget = shared.facts.find((fact) => fact.metricId === "items_triaged");
  assert.equal(sharedTarget.actorId, "202");
  assert.throws(
    () => applyRecognitionReceipt(shared, { ...receipt, targetFactId: sharedTarget.id, actorId: "505" }, [reviewerId]),
    /Independent verified recognition/,
  );
  assert.ok(
    raw.facts.every((fact) => fact.state === "observed" && fact.metricId !== "labels_corrected"),
    "Rejected receipts leave the raw evidence untouched",
  );
});

test("public transfer receipts retain lineage without manufacturing issue creation or resolution", () => {
  const payload = {
    issue: issue(),
    actor: user,
    destination: {
      repositoryId: 3,
      slug: "synthetic-owner/destination",
      stableId: "I_synthetic_1",
      url: "https://github.com/synthetic-owner/destination/issues/8",
      visibility: "public",
      allowed: true,
    },
  };
  const original = normalizeGithubObservation(
    observation(1, { family: "issue", action: "snapshot", payload: { issue: issue() } }),
  );
  const transfer = normalizeGithubObservation(
    observation(2, { family: "relationship", action: "transferred", payload }),
  );
  assert.deepEqual(
    transfer.facts.map((fact) => [fact.metricId, fact.state]),
    [["issue_transfers", "observed"]],
  );
  assert.deepEqual(transfer.lineage[0].sourceIds, ["I_synthetic_1"]);
  assert.equal(transfer.lineage[0].targetId, "I_synthetic_1");
  const opened = policy("issues_opened", { rankedStates: ["observed"], dateBasis: "occurredAt", roles: ["reporter"] });
  assert.equal(aggregateMetric(frozen([original, transfer, transfer]), opened, scope).rows[0].value, 1);
  assert.equal(aggregateMetric(frozen([original, transfer]), policy("issue_resolution"), scope).rows.length, 0);
  for (const destination of [
    undefined,
    { ...payload.destination, allowed: false },
    { ...payload.destination, visibility: "private" },
    { ...payload.destination, visibility: "unknown" },
  ]) {
    const out = normalizeGithubObservation(
      observation(3, { family: "relationship", action: "transferred", payload: { ...payload, destination } }),
    );
    assert.deepEqual(out.facts, []);
    assert.deepEqual(out.suppressArtifactIds, ["I_synthetic_1"]);
    assert.ok(out.reasons.includes("transfer_destination_private_unknown_or_unapproved"));
  }
});

test("deleted edit history and a current body cannot manufacture clarification or editor credit", () => {
  for (const changes of [undefined, {}, { body: {} }, { body: { from: "Synthetic current body" } }]) {
    const out = normalizeGithubObservation(
      observation(1, {
        family: "body_edit",
        action: "edited",
        payload: { issue: { ...issue(), body: "Synthetic current body" }, actor: user, changes },
      }),
    );
    assert.deepEqual(out.facts, []);
    assert.ok(out.reasons.includes("edit_history_actor_or_diff_unverified"));
    assert.equal(aggregateMetric(frozen([out]), policy("issue_clarifications"), scope).rows.length, 0);
  }
  const known = normalizeGithubObservation(
    observation(2, {
      family: "body_edit",
      action: "edited",
      payload: {
        issue: { ...issue(), body: "Synthetic changed body" },
        actor: user,
        changes: { body: { from: "Synthetic prior body" } },
      },
    }),
  );
  assert.deepEqual(
    known.facts.map((fact) => [fact.metricId, fact.state]),
    [["title_scope_edits", "observed"]],
  );
  assert.equal(aggregateMetric(frozen([known]), policy("issue_clarifications"), scope).rows.length, 0);
});

test("restricted relationship targets and automatic references remain outside outcome boards", () => {
  for (const kind of ["parent_child", "blocked_by", "related", "closing", "reference", "duplicate"]) {
    const relationship = {
      kind,
      from: "I_synthetic_1",
      to: "I_synthetic_restricted",
      intentional: true,
      publicEndpointsVerified: false,
    };
    const out = normalizeGithubObservation(
      observation(1, {
        family: "relationship",
        action: "added",
        payload: { issue: issue(), actor: user, relationship },
      }),
    );
    assert.deepEqual(out.facts, []);
    assert.ok(out.reasons.includes("relationship_endpoint_visibility_unverified"));
    assert.equal(JSON.stringify(out).includes("I_synthetic_restricted"), false);
    assert.equal(aggregateMetric(frozen([out]), policy("issue_resolution"), scope).rows.length, 0);
    const automatic = normalizeGithubObservation(
      observation(2, {
        family: "relationship",
        action: "cross_referenced",
        payload: {
          issue: issue(),
          actor: user,
          relationship: { ...relationship, publicEndpointsVerified: true, intentional: false },
        },
      }),
    );
    assert.deepEqual(automatic.facts, []);
    assert.ok(automatic.reasons.includes("automatic_reference_or_relationship_actor_unverified"));
  }
});

test("the triage audit discloses observability for every LB-08 metric exactly once", async () => {
  const doc = await readFile(new URL("../../../docs/triage-fairness-audit.md", import.meta.url), "utf8");
  const documented = [...doc.matchAll(/^\| `([a-z_]+)` \|/gm)].map((match) => match[1]);
  const required = metricRegistryV1.metrics
    .filter((metric) => metric.backlog_work_packages.some((id) => id.startsWith("LB-08.")))
    .map((metric) => metric.id);
  assert.equal(new Set(documented).size, documented.length);
  assert.deepEqual(documented.sort(), required.sort());
});
