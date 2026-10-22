import { syntheticRepositoryClient, syntheticCheckpointStore } from "./synthetic-client.mjs";
import assert from "node:assert/strict";
import { readFile, mkdtemp, mkdir, writeFile, rename, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import test from "node:test";
import {
  normalizeGithubObservation,
  githubReviewRevision,
  githubDiscussionRevision,
  applyRecognitionReceipt,
  groupTriageTransitions,
  parseDeclaredCoauthorTrailers,
  createGithubEvidenceNormalizer,
  GithubReadClient,
  classifyPhysicalDiff,
  readPinnedGitDiff,
} from "../dist/index.js";

const fixture = JSON.parse(await readFile(new URL("fixtures/engineering.json", import.meta.url), "utf8"));
const at = "2026-10-07T10:00:00Z",
  observedAt = "2026-10-08T10:00:00Z";
const pr = () => ({ ...structuredClone(fixture.pull_request), user: fixture.author, merged_by: fixture.merger });
const issue = () => ({ ...structuredClone(fixture.issue), user: fixture.author });
const envelope = (patch = {}) => ({
  repository: { id: 2, slug: "synthetic-owner/repository", visibility: "public", defaultBranch: "main" },
  proof: { verified: true, source: "github_webhook", revision: at, eventId: "synthetic-event-1", isSynthetic: true },
  family: "pull_request",
  action: "closed",
  occurredAt: at,
  observedAt,
  decisionCohort: { verified: true, asOf: observedAt, outcome: "merged", decisionAt: at },
  frozenCutoff: observedAt,
  payload: { repository: fixture.repository, pull_request: pr(), sender: fixture.merger },
  ...patch,
});
const metrics = (out, id) => out.facts.filter((fact) => fact.metricId === id);
const before = "b".repeat(40),
  after = "c".repeat(40);

test("PR authorship, merger operation and decided denominator remain separate stable units", () => {
  const out = normalizeGithubObservation(envelope());
  assert.equal(metrics(out, "pr_merged")[0].actorId, "101");
  assert.equal(metrics(out, "maintainer_merges")[0].actorId, "202");
  assert.equal(metrics(out, "pr_accepted_rate")[0].outcome, "merged");
  assert.equal(metrics(out, "pr_accepted_rate")[0].acceptedAt, "2026-10-07T10:00:00.000Z");
  assert.equal(out.isSynthetic, true);
  assert.ok(out.facts.every((fact) => fact.state === "observed"));
  assert.ok(out.evidence.every((item) => item.contribution.reasonCodes.includes("raw_observed_only")));
  const reopened = normalizeGithubObservation(envelope({ action: "reopened" }));
  assert.equal(metrics(out, "pr_merged")[0].id, metrics(reopened, "pr_merged")[0].id);
  const duplicate = normalizeGithubObservation(
    envelope({ proof: { verified: true, source: "github_rest", revision: at } }),
  );
  assert.equal(metrics(out, "pr_opened")[0].id, metrics(duplicate, "pr_opened")[0].id);
});

test("closed-unmerged and pending PRs never become merged delivery", () => {
  const closed = pr();
  closed.merged = false;
  closed.merged_at = null;
  const out = normalizeGithubObservation(
    envelope({
      payload: { pull_request: closed },
      decisionCohort: { verified: true, asOf: observedAt, outcome: "closed_unmerged", decisionAt: at },
    }),
  );
  assert.equal(metrics(out, "pr_merged").length, 0);
  assert.equal(metrics(out, "pr_accepted_rate")[0].outcome, "closed_unmerged");
  closed.state = "open";
  closed.closed_at = null;
  const pending = normalizeGithubObservation(
    envelope({
      payload: { pull_request: closed },
      decisionCohort: { verified: true, asOf: observedAt, outcome: "pending", decisionAt: null },
    }),
  );
  assert.equal(metrics(pending, "pr_accepted_rate")[0].state, "pending");
  assert.equal(metrics(pending, "pr_accepted_rate")[0].acceptedAt, null);
  assert.equal(metrics(pending, "pr_ready").length, 0);
});

test("unknown actor/time/visibility never becomes named measured evidence", () => {
  const unknown = pr();
  unknown.user = { login: "unverified" };
  unknown.created_at = null;
  const out = normalizeGithubObservation(envelope({ payload: { pull_request: unknown }, occurredAt: null }));
  assert.equal(metrics(out, "pr_opened")[0].actorId, null);
  assert.equal(metrics(out, "pr_opened")[0].occurredAt, null);
  assert.equal(metrics(out, "pr_opened")[0].state, "unknown");
  const privateResult = normalizeGithubObservation(
    envelope({ repository: { id: 2, slug: "synthetic-owner/repository", visibility: "private" } }),
  );
  assert.equal(privateResult.facts.length, 0);
  assert.deepEqual(privateResult.suppressArtifactIds, ["PR_synthetic_10"]);
  const hiddenPayload = normalizeGithubObservation(
    envelope({ payload: { repository: { ...fixture.repository, private: true }, pull_request: pr() } }),
  );
  assert.equal(hiddenPayload.evidence.length, 0);
});

test("verified coauthors conserve the object and model trailers never create people or expose emails", () => {
  const parsed = parseDeclaredCoauthorTrailers(
    "Co-authored-by: Verified Person\nCo-authored-by: Claude Opus 5.5\nCo-authored-by: Unknown Person",
    {
      verifiedPeople: [
        { trailerName: "Verified Person", actor: fixture.reviewer, verificationReceipt: "synthetic-account-link" },
      ],
      declaredModels: [{ trailerName: "Claude Opus 5.5", model: "Claude Opus", version: "5.5" }],
    },
  );
  assert.equal(parsed.unresolvedCount, 1);
  assert.equal(parsed.coauthors.length, 1);
  const out = normalizeGithubObservation(
    envelope({ verifiedCoauthors: parsed.coauthors, assistance: parsed.assistance }),
  );
  assert.equal(metrics(out, "pr_merged").length, 1);
  assert.equal(metrics(out, "pr_coauthored")[0].actorId, "303");
  assert.equal(new Set(out.participation.map((item) => item.conservedUnit)).size, 1);
  assert.equal(out.assistance[0].model, "Claude Opus");
  assert.equal(
    out.actors.some((person) => /Claude/.test(person.login ?? "")),
    false,
  );
  assert.equal(JSON.stringify(out).includes("email"), false);
  const primaryOverlap = normalizeGithubObservation(
    envelope({
      verifiedCoauthors: [
        { actor: fixture.author, verificationReceipt: "synthetic-primary-link" },
        { actor: fixture.reviewer, verificationReceipt: "synthetic-other-link" },
        { actor: fixture.reviewer, verificationReceipt: "synthetic-other-link" },
      ],
    }),
  );
  assert.equal(metrics(primaryOverlap, "pr_coauthored").length, 1);
  assert.equal(primaryOverlap.participation.filter((item) => item.actorId === "101").length, 1);
});

test("submitted COMMENTED review is raw feedback, distinct PR grouping excludes spam and dismissal is explicit", () => {
  const make = (reviewId, state = "COMMENTED") =>
    normalizeGithubObservation(
      envelope({
        family: "review",
        action: "submitted",
        reviewParticipation: { verified: true, firstSubmittedAt: at, roundFirstSubmittedAt: at },
        payload: {
          pull_request: pr(),
          review: {
            id: reviewId,
            node_id: `R_${reviewId}`,
            user: fixture.reviewer,
            state,
            submitted_at: at,
            created_at: at,
            commit_id: after,
          },
        },
      }),
    );
  const a = make(1),
    b = make(2, "APPROVED");
  assert.equal(metrics(a, "prs_reviewed")[0].artifactId, metrics(b, "prs_reviewed")[0].artifactId);
  assert.equal(
    new Set(
      [...a.facts, ...b.facts]
        .filter((item) => item.metricId === "prs_reviewed")
        .map((item) => `${item.actorId}:${item.artifactId}`),
    ).size,
    1,
  );
  assert.ok(a.facts.every((item) => item.state === "observed"));
  const dismissed = make(1, "DISMISSED");
  assert.equal(dismissed.facts[0].state, "excluded");
  assert.equal(make(1, "PENDING").facts.length, 0);
});

test("current resolvedBy and draft snapshot do not fabricate historical transition/readiness", () => {
  const out = normalizeGithubObservation(
    envelope({
      family: "thread_resolution",
      action: "snapshot",
      payload: { issue: issue(), resolvedBy: fixture.reviewer },
    }),
  );
  assert.equal(out.facts.length, 0);
  assert.match(out.reasons.join(), /current_resolvedBy/);
  const resolution = normalizeGithubObservation(
    envelope({
      family: "thread_resolution",
      action: "resolved_transition",
      payload: { issue: issue(), sender: fixture.reviewer },
    }),
  );
  assert.equal(metrics(resolution, "review_threads_resolved")[0].actorId, "303");
  assert.equal(metrics(normalizeGithubObservation(envelope({ action: "snapshot" })), "pr_ready").length, 0);
  const wait = normalizeGithubObservation(
    envelope({ reviewCohort: { verified: true, firstReadyAt: null, firstSubmittedReviewAt: null } }),
  );
  assert.equal(metrics(wait, "review_wait")[0].readyAt, null);
  assert.equal(metrics(wait, "review_wait")[0].firstReviewAt, null);
});

test("issue reporter, closer and implementing outcome never silently receive each other's credit", () => {
  const out = normalizeGithubObservation(
    envelope({ family: "issue", payload: { issue: issue(), sender: fixture.merger } }),
  );
  assert.equal(metrics(out, "issues_opened")[0].actorId, "101");
  assert.equal(metrics(out, "issue_closure_stewardship")[0].actorId, "202");
  assert.equal(metrics(out, "issue_resolution").length, 0);
  assert.equal(metrics(out, "confirmed_bugs").length, 0);
  const comment = normalizeGithubObservation(
    envelope({
      family: "comment",
      action: "created",
      payload: {
        id: 50,
        node_id: "IC_synthetic_50",
        user: fixture.reviewer,
        created_at: at,
        html_url: "https://github.com/synthetic-owner/repository/issues/20#issuecomment-50",
      },
    }),
  );
  assert.equal(comment.facts[0].state, "pending");
  assert.equal(comment.evidence[0].artifact.kind, "other");
  assert.equal(comment.evidence[0].artifact.publicUrl, "https://github.com/synthetic-owner/repository/issues/20");
});

test("explicit revert lineage annotates original delivery without creating reverter merit or deleting history", () => {
  const input = envelope({
    family: "revert",
    action: "reverted",
    lineage: [
      {
        relation: "reverted_by",
        sourceIds: ["PR_synthetic_10"],
        targetId: "PR_synthetic_revert",
        evidenceIds: ["synthetic-revert-receipt"],
      },
    ],
  });
  const out = normalizeGithubObservation(input);
  assert.equal(out.facts.length, 1);
  assert.equal(out.facts[0].metricId, "reverted_delivery");
  assert.equal(out.facts[0].actorId, "101");
  assert.equal(out.facts[0].state, "observed");
  assert.equal(normalizeGithubObservation({ ...input, lineage: [] }).facts.length, 0);
});

test("reverted_delivery excludes inferred, unproven or mismatched revert lineage and never credits the reverter", () => {
  const lineage = {
    relation: "reverted_by",
    sourceIds: ["PR_synthetic_10"],
    targetId: "PR_synthetic_revert",
    evidenceIds: ["synthetic-revert-receipt"],
  };
  const revert = (patch = {}) =>
    normalizeGithubObservation(envelope({ family: "revert", action: "reverted", ...patch }));
  // Control: valid lineage is one annotation for the original author, not for the sender (the reverter's lens).
  const control = revert({ lineage: [lineage] });
  assert.deepEqual(
    control.facts.map((fact) => [fact.metricId, fact.actorId, fact.state]),
    [["reverted_delivery", "101", "observed"]],
  );
  assert.ok(control.facts.every((fact) => fact.actorId !== "202"));
  const noEvent = { verified: true, source: "github_webhook", revision: at, isSynthetic: true };
  for (const [name, out] of [
    ["lineage is absent", revert()],
    ["lineage is empty", revert({ lineage: [] })],
    ["the relation is not reverted_by", revert({ lineage: [{ ...lineage, relation: "squash_of" }] })],
    [
      "the lineage describes a different original",
      revert({ lineage: [{ ...lineage, sourceIds: ["PR_synthetic_other"] }] }),
    ],
    ["the lineage names no evidence", revert({ lineage: [{ ...lineage, evidenceIds: [] }] })],
    ["the observation has no native event proof", revert({ lineage: [lineage], proof: noEvent })],
  ]) {
    assert.deepEqual(out.facts, [], name);
    assert.deepEqual(out.reasons, ["revert_requires_explicit_source_lineage"], name);
  }
  // Revert lineage on an ordinary pull request observation cannot create the annotation.
  assert.deepEqual(metrics(normalizeGithubObservation(envelope({ lineage: [lineage] })), "reverted_delivery"), []);
  // An unknown original author is unknown, not the reverter.
  const ghost = revert({
    lineage: [lineage],
    payload: { repository: fixture.repository, pull_request: { ...pr(), user: null }, sender: fixture.merger },
  });
  assert.deepEqual(
    metrics(ghost, "reverted_delivery").map((fact) => [fact.actorId, fact.state]),
    [[null, "unknown"]],
  );
  // Private repositories emit nothing.
  const hidden = revert({
    lineage: [lineage],
    repository: { id: 2, slug: "synthetic-owner/repository", visibility: "private", defaultBranch: "main" },
  });
  assert.deepEqual(hidden.facts, []);
});

test("agent execution under a User preserves account kind without certifying manual execution", () => {
  const out = normalizeGithubObservation(
    envelope({
      family: "triage",
      action: "labeled",
      payload: { issue: issue(), sender: fixture.merger, execution_mode: "automated", label: { id: 90 } },
    }),
  );
  const sender = out.actors.find((actor) => actor.id === "202");
  assert.equal(sender.kind, "user");
  assert.equal(sender.executionMode, "automated");
  assert.equal(metrics(out, "issue_resolution").length, 0);
  const removal = normalizeGithubObservation(
    envelope({
      family: "triage",
      action: "unlabeled",
      payload: { issue: issue(), sender: fixture.merger, label: { id: 90 } },
    }),
  );
  assert.equal(metrics(removal, "labels_applied").length, 0);
  assert.equal(metrics(removal, "items_triaged").length, 1);
  const unknownTarget = normalizeGithubObservation(
    envelope({ family: "triage", action: "labeled", payload: { issue: issue(), sender: fixture.merger } }),
  );
  assert.equal(metrics(unknownTarget, "labels_applied")[0].state, "unknown");
});

test("label and milestone definition transitions require their own target identity", () => {
  for (const action of [
    "label_created",
    "label_edited",
    "label_deleted",
    "label_archived",
    "label_unarchived",
    "milestone_created",
    "milestone_edited",
    "milestone_closed",
    "milestone_reopened",
    "milestone_deleted",
  ]) {
    const targetField = action.startsWith("label_") ? "label" : "milestone";
    const otherField = targetField === "label" ? "milestone" : "label";
    const out = normalizeGithubObservation(
      envelope({
        family: "triage",
        action,
        payload: { issue: issue(), sender: fixture.merger, [otherField]: { id: 90 } },
      }),
    );
    // An attached issue and the opposite definition kind cannot supply this
    // definition's artifact identity, even for an unknown fact.
    assert.equal(out.facts.length, 0, action);
    assert.equal(out.evidence.length, 0, action);
    assert.equal(out.observations.length, 0, action);
    assert.ok(out.reasons.includes("missing_public_artifact_identity"), action);
    const ownId = `SYNTHETIC_${targetField}_DEFINITION`;
    const owned = normalizeGithubObservation(
      envelope({
        family: "triage",
        action,
        payload: {
          issue: issue(),
          sender: fixture.merger,
          [otherField]: { id: 90 },
          [targetField]: {
            id: 90,
            node_id: ownId,
            html_url: `https://github.com/synthetic-owner/repository/${targetField === "label" ? "labels/bug" : "milestone/1"}`,
          },
        },
      }),
    );
    assert.equal(owned.facts.length, 1, action);
    assert.equal(owned.facts[0].state, "observed", action);
    assert.equal(owned.facts[0].artifactId, ownId, action);
    assert.equal(owned.evidence[0].artifact.stableId, ownId, action);
  }
});

test("one User occupying author, automated sender and merger roles retains positive execution evidence", () => {
  const out = normalizeGithubObservation(
    envelope({
      payload: {
        pull_request: { ...pr(), merged_by: fixture.author },
        sender: fixture.author,
        execution_mode: "automated",
      },
    }),
  );
  assert.equal(out.actors.length, 1);
  assert.equal(out.actors[0].id, "101");
  assert.equal(out.actors[0].kind, "user");
  assert.equal(out.actors[0].executionMode, "automated");
  assert.equal(metrics(out, "pr_merged")[0].actorId, "101");
  assert.equal(metrics(out, "pr_merged")[0].role, "author");
  assert.equal(metrics(out, "maintainer_merges")[0].actorId, "101");
  assert.equal(metrics(out, "maintainer_merges")[0].role, "merger");
});

test("recognition requires independently authorized receipt; COMMENTED feedback can qualify", () => {
  const raw = normalizeGithubObservation(
    envelope({
      family: "review",
      action: "submitted",
      payload: {
        pull_request: pr(),
        review: {
          id: 1,
          user: fixture.reviewer,
          state: "COMMENTED",
          submitted_at: at,
          created_at: at,
          commit_id: after,
        },
      },
    }),
  );
  const target = metrics(raw, "review_feedback")[0];
  const receipt = {
    verified: true,
    id: "synthetic-acceptance",
    metricId: "review_feedback",
    actorId: "303",
    reviewerId: "202",
    acceptedAt: observedAt,
    decision: "accepted",
    targetFactId: target.id,
    evidenceIds: ["synthetic-accepted-review-outcome"],
  };
  const accepted = applyRecognitionReceipt(raw, receipt, ["202"]);
  assert.equal(metrics(accepted, "review_feedback").filter((item) => item.state === "qualified").length, 1);
  assert.equal(metrics(accepted, "review_feedback").filter((item) => item.state === "observed").length, 1);
  assert.throws(() => applyRecognitionReceipt(raw, { ...receipt, reviewerId: "303" }, ["303"]), /Independent/);
  assert.throws(() => applyRecognitionReceipt(raw, receipt, []), /Independent/);
  const rejected = applyRecognitionReceipt(raw, { ...receipt, decision: "rejected" }, ["202"]);
  assert.equal(rejected.facts.at(-1).state, "excluded");
});

test("four issue/Project event families remain distinct; current snapshots do not rank editors", () => {
  for (const [action, metric] of [
    ["issue_field_changed", "issue_field_updates"],
    ["project_item_field_changed", "project_field_updates"],
    ["project_status_changed", "project_status_updates"],
    ["project_progress_published", "project_updates"],
  ]) {
    const out = normalizeGithubObservation(
      envelope({
        family: "field_change",
        action,
        payload: { issue: issue(), sender: fixture.merger, change: { before: "a", after: "b" } },
      }),
    );
    assert.equal(out.facts.length, 1);
    assert.equal(out.facts[0].metricId, metric);
  }
  assert.equal(
    normalizeGithubObservation(
      envelope({ family: "project_snapshot", payload: { issue: issue(), sender: fixture.merger } }),
    ).facts.length,
    0,
  );
  assert.equal(
    normalizeGithubObservation(
      envelope({ family: "field_change", action: "unknown_subtype", payload: { issue: issue() } }),
    ).facts.length,
    0,
  );
});

test("label definition changes and milestone definitions do not multiply attached issue membership", () => {
  const metadata = {
    id: 90,
    node_id: "L_synthetic",
    html_url: "https://github.com/synthetic-owner/repository/labels/bug",
  };
  const taxonomy = normalizeGithubObservation(
    envelope({
      family: "triage",
      action: "label_edited",
      payload: { label: metadata, sender: fixture.merger, change: { before: "bug", after: "defect" } },
    }),
  );
  assert.equal(taxonomy.facts.length, 1);
  assert.equal(taxonomy.facts[0].metricId, "label_taxonomy");
  assert.equal(taxonomy.facts[0].artifactId, "L_synthetic");
  const membership = normalizeGithubObservation(
    envelope({
      family: "triage",
      action: "labeled",
      payload: { issue: issue(), label: metadata, sender: fixture.merger },
    }),
  );
  assert.equal(metrics(membership, "label_taxonomy").length, 0);
  assert.equal(metrics(membership, "labels_applied").length, 1);
  const secondLabel = normalizeGithubObservation(
    envelope({
      family: "triage",
      action: "labeled",
      payload: { issue: issue(), label: { ...metadata, node_id: "L_synthetic_other" }, sender: fixture.merger },
    }),
  );
  assert.notEqual(metrics(membership, "labels_applied")[0].id, metrics(secondLabel, "labels_applied")[0].id);
  const noop = normalizeGithubObservation(
    envelope({
      family: "triage",
      action: "label_edited",
      payload: { label: metadata, change: { before: "bug", after: "bug" } },
    }),
  );
  assert.equal(noop.facts.length, 0);
  const milestone = normalizeGithubObservation(
    envelope({
      family: "triage",
      action: "milestone_closed",
      payload: { milestone: { ...metadata, node_id: "M_synthetic" }, sender: fixture.merger },
    }),
  );
  assert.equal(metrics(milestone, "milestone_definitions").length, 1);
  assert.equal(metrics(milestone, "issue_resolution").length, 0);
});

test("triage duplicate receipts, toggles, no-op metadata and scripted batches do not create qualified outcomes", () => {
  const event = (id, minute, before, after) => ({
    id,
    artifactId: "issue:1",
    actorId: "404",
    facet: "label",
    targetId: "label:bug",
    occurredAt: `2026-10-07T10:${String(minute).padStart(2, "0")}:00Z`,
    before,
    after,
  });
  const events = [
    event("a", 0, "absent", "present"),
    event("b", 1, "present", "absent"),
    event("c", 20, "absent", "present"),
    event("d", 21, "present", "absent"),
  ];
  const grouped = groupTriageTransitions([...events, events[0]], {
    version: "synthetic/v1",
    intervalSeconds: 300,
    cooldownSeconds: 3600,
  });
  assert.equal(grouped.rawActions, 4);
  assert.equal(grouped.sessions.length, 2);
  assert.ok(grouped.sessions.every((session) => session.reversalSuppressed && !session.qualifiedCandidate));
  assert.equal(grouped.sessions.filter((session) => session.repeatedStateSuppressed).length, 1);
  assert.equal(grouped.qualifiedOutcomes, 0);
  const burst = Array.from({ length: 100 }, (_, index) => ({
    ...events[0],
    id: `synthetic-batch-${index}`,
    artifactId: `synthetic-issue-${index}`,
  }));
  assert.equal(
    groupTriageTransitions(burst, { version: "synthetic/v1", intervalSeconds: 300, cooldownSeconds: 3600 })
      .qualifiedOutcomes,
    0,
  );
});

test("relationship endpoint copies conserve one link and never reinterpret related links as blockers", () => {
  const payload = {
    issue: issue(),
    sender: fixture.merger,
    relationship: { kind: "related", from: "issue:a", to: "issue:b", intentional: true, publicEndpointsVerified: true },
  };
  const a = normalizeGithubObservation(envelope({ family: "relationship", action: "added", payload }));
  const b = normalizeGithubObservation(
    envelope({
      family: "relationship",
      action: "added",
      payload: { ...payload, relationship: { ...payload.relationship, from: "issue:b", to: "issue:a" } },
    }),
  );
  assert.equal(a.facts[0].id, b.facts[0].id);
  assert.equal(a.facts[0].metricId, "related_links");
  assert.equal(metrics(a, "blocker_links").length, 0);
  const automatic = normalizeGithubObservation(
    envelope({
      family: "relationship",
      action: "cross_referenced",
      payload: { ...payload, relationship: { ...payload.relationship, intentional: false } },
    }),
  );
  assert.equal(automatic.facts.length, 0);
  const restricted = normalizeGithubObservation(
    envelope({
      family: "relationship",
      action: "added",
      payload: { ...payload, relationship: { ...payload.relationship, publicEndpointsVerified: false } },
    }),
  );
  assert.equal(restricted.facts.length, 0);
  assert.match(restricted.reasons.join(), /visibility_unverified/);
});

test("related_links excludes automatic, unproven, unverified and other-kind relationships and never credits a non-actor", () => {
  const relationship = {
    kind: "related",
    from: "issue:a",
    to: "issue:b",
    intentional: true,
    publicEndpointsVerified: true,
  };
  const link = (patch = {}, envelopePatch = {}) =>
    normalizeGithubObservation(
      envelope({
        family: "relationship",
        action: "added",
        payload: { issue: issue(), sender: fixture.merger, relationship: { ...relationship, ...patch } },
        ...envelopePatch,
      }),
    );
  // Control: the identical payload is one observed unit for the sender.
  assert.deepEqual(
    link().facts.map((fact) => [fact.metricId, fact.actorId, fact.state]),
    [["related_links", "202", "observed"]],
  );
  for (const [name, patch, reason] of [
    ["an automatic reference", { intentional: false }, "automatic_reference_or_relationship_actor_unverified"],
    [
      "a string rather than a true intent flag",
      { intentional: "true" },
      "automatic_reference_or_relationship_actor_unverified",
    ],
    ["a blank source endpoint", { from: " " }, "automatic_reference_or_relationship_actor_unverified"],
    ["a missing target endpoint", { to: undefined }, "automatic_reference_or_relationship_actor_unverified"],
    ["an unsupported relationship kind", { kind: "mentions" }, "automatic_reference_or_relationship_actor_unverified"],
    ["unverified public endpoints", { publicEndpointsVerified: false }, "relationship_endpoint_visibility_unverified"],
  ]) {
    const out = link(patch);
    assert.deepEqual(out.facts, [], name);
    assert.deepEqual(out.reasons, [reason], name);
  }
  // Without a native event identity the relationship cannot be tied to one action.
  const noEvent = link({}, { proof: { verified: true, source: "github_webhook", revision: at, isSynthetic: true } });
  assert.deepEqual(noEvent.facts, []);
  assert.deepEqual(noEvent.reasons, ["automatic_reference_or_relationship_actor_unverified"]);
  // Other link kinds feed their own metrics only; a related link is never a blocker or duplicate and vice versa.
  const blocker = link({ kind: "blocked_by" });
  assert.deepEqual(metrics(blocker, "related_links"), []);
  assert.deepEqual(
    blocker.facts.map((fact) => fact.metricId),
    ["blocker_links"],
  );
  const duplicate = link({ kind: "duplicate" });
  assert.deepEqual(metrics(duplicate, "related_links"), []);
  assert.deepEqual(
    duplicate.facts.map((fact) => fact.metricId),
    ["duplicate_resolution"],
  );
  // A missing sender is an unknown actor and is not replaced by the issue author.
  const ghost = normalizeGithubObservation(
    envelope({
      family: "relationship",
      action: "added",
      payload: { issue: issue(), sender: null, relationship },
    }),
  );
  assert.deepEqual(
    metrics(ghost, "related_links").map((fact) => [fact.actorId, fact.state]),
    [[null, "unknown"]],
  );
  assert.ok(ghost.reasons.includes("unknown_actor"));
  // Private repositories emit nothing.
  assert.deepEqual(
    link(
      {},
      { repository: { id: 2, slug: "synthetic-owner/repository", visibility: "private", defaultBranch: "main" } },
    ).facts,
    [],
  );
});

test("transfer lineage preserves original object and suppresses private/unapproved destinations", () => {
  const destination = {
    repositoryId: 3,
    stableId: "I_synthetic_20",
    slug: "synthetic-owner/other",
    url: "https://github.com/synthetic-owner/other/issues/55",
    visibility: "public",
    allowed: true,
  };
  const a = normalizeGithubObservation(
    envelope({
      family: "relationship",
      action: "transferred",
      payload: { issue: issue(), sender: fixture.merger, destination },
    }),
  );
  assert.equal(a.lineage[0].relation, "transferred_to");
  assert.equal(a.facts[0].metricId, "issue_transfers");
  assert.equal(metrics(a, "issues_opened").length, 0);
  const hidden = normalizeGithubObservation(
    envelope({
      family: "relationship",
      action: "transferred",
      payload: { issue: issue(), sender: fixture.merger, destination: { ...destination, visibility: "private" } },
    }),
  );
  assert.equal(hidden.facts.length, 0);
  assert.deepEqual(hidden.suppressArtifactIds, ["I_synthetic_20"]);
});

test("physical line classes exclude vendor/generated/locks/binary/imports and disclose net separately", () => {
  const out = classifyPhysicalDiff({
    before,
    after,
    complete: true,
    files: [
      { path: "src/main.ts", additions: 10, deletions: 4 },
      { path: "tests/main.test.ts", additions: 3, deletions: 0 },
      { path: "docs/readme.md", additions: 2, deletions: 1 },
      ...["vendor/lib.js", "dist/out.js", "package-lock.json"].map((path) => ({
        path,
        additions: 1000,
        deletions: 1000,
      })),
      { path: "image.png", additions: 0, deletions: 0, binary: true },
      { path: "src/import.ts", additions: 500, deletions: 0, imported: true },
      { path: "src/formatted.ts", additions: 10, deletions: 10, formattingOnly: true },
    ],
  });
  assert.equal(out.additions, 15);
  assert.equal(out.deletions, 5);
  assert.equal(out.changed, 20);
  assert.equal(out.net, 10);
  assert.equal(out.filesChanged, 3);
  assert.equal(classifyPhysicalDiff({ before, after, complete: false, files: [] }).changed, null);
  assert.throws(
    () =>
      classifyPhysicalDiff({
        before,
        after,
        complete: true,
        files: [{ path: "../secret", additions: 1, deletions: 0 }],
      }),
    /Unsafe/,
  );
  for (const length of [41, 42, 63])
    assert.throws(
      () => classifyPhysicalDiff({ before: "a".repeat(length), after, complete: true, files: [] }),
      /pinned/,
    );
  assert.throws(
    () =>
      classifyPhysicalDiff({
        before,
        after,
        complete: true,
        files: [{ path: "src/main.ts", additions: Number.MAX_SAFE_INTEGER, deletions: 1 }],
      }),
    /safe integer/,
  );
});

// Shared by the pr_lines_added and pr_lines_removed exclusion cases. Every excluded file class carries large
// additions and deletions so that any leak into either quantity is visible in an exact value.
function lineIntegration(files, patch = {}, diffPatch = {}) {
  return {
    before,
    after,
    canonicalChangeId: "synthetic-line-change",
    defaultBranch: "main",
    targetBranch: "main",
    commitShas: [after],
    diff: { before, after, complete: true, files, ...diffPatch },
    ...patch,
  };
}
const eligibleLineFiles = [
  { path: "src/main.ts", additions: 10, deletions: 4 },
  { path: "tests/main.test.ts", additions: 3, deletions: 0 },
  { path: "docs/readme.md", additions: 2, deletions: 1 },
];
const excludedLineFiles = [
  { path: "vendor/lib.js", additions: 1000, deletions: 900 },
  { path: "dist/out.js", additions: 1000, deletions: 900 },
  { path: "package-lock.json", additions: 1000, deletions: 900 },
  { path: "image.png", additions: 1000, deletions: 900, binary: true },
  { path: "src/import.ts", additions: 1000, deletions: 900, imported: true },
  { path: "src/formatted.ts", additions: 1000, deletions: 900, formattingOnly: true },
];
function lineMetricExclusions(metricId, field, eligibleTotal) {
  const lineUnits = (patch = {}, integration = lineIntegration(eligibleLineFiles)) =>
    metrics(normalizeGithubObservation(envelope({ integration, ...patch })), metricId);
  // Control: the eligible classes alone give the exact total, credited to the PR author, not the merger.
  assert.deepEqual(
    lineUnits().map((fact) => [fact.actorId, fact.state, fact.quantity]),
    [["101", "observed", eligibleTotal]],
  );
  // Every excluded class, alone or alongside eligible files, adds exactly nothing.
  const mixed = lineUnits({}, lineIntegration([...eligibleLineFiles, ...excludedLineFiles]));
  assert.deepEqual(
    mixed.map((fact) => fact.quantity),
    [eligibleTotal],
  );
  for (const excluded of excludedLineFiles) {
    const alone = lineUnits({}, lineIntegration([excluded]));
    assert.deepEqual(
      alone.map((fact) => [fact.actorId, fact.state, fact.quantity]),
      [["101", "observed", 0]],
      `${excluded.path} must contribute no ${field}`,
    );
  }
  // Without a complete, pinned, default-branch integration there is no unit at all, however large the diff.
  const unverified = [
    ["a non-default target branch", lineIntegration(eligibleLineFiles, { targetBranch: "research" })],
    [
      "a different default branch than the repository",
      lineIntegration(eligibleLineFiles, { defaultBranch: "trunk", targetBranch: "trunk" }),
    ],
    ["a diff pinned to another start commit", lineIntegration(eligibleLineFiles, {}, { before: "e".repeat(40) })],
    ["a diff pinned to another end commit", lineIntegration(eligibleLineFiles, {}, { after: "d".repeat(40) })],
    ["a blank canonical change", lineIntegration(eligibleLineFiles, { canonicalChangeId: " " })],
    ["an incomplete or truncated diff", lineIntegration(eligibleLineFiles, {}, { complete: false })],
  ];
  for (const [name, integration] of unverified) assert.deepEqual(lineUnits({}, integration), [], name);
  // No integration is not a zero-line integration.
  assert.deepEqual(metrics(normalizeGithubObservation(envelope()), metricId), []);
  // Private repositories emit nothing; an unknown PR author is unknown, never the merger.
  assert.deepEqual(
    lineUnits({
      repository: { id: 2, slug: "synthetic-owner/repository", visibility: "private", defaultBranch: "main" },
    }),
    [],
  );
  assert.deepEqual(
    lineUnits({
      payload: { repository: fixture.repository, pull_request: { ...pr(), user: null }, sender: fixture.merger },
    }).map((fact) => [fact.actorId, fact.state, fact.quantity]),
    [[null, "unknown", eligibleTotal]],
  );
}
test("pr_lines_added excludes ineligible file classes and unverified integrations, and never credits the merger", () => {
  lineMetricExclusions("pr_lines_added", "additions", 15);
});
test("pr_lines_removed excludes ineligible file classes and unverified integrations, and never credits the merger", () => {
  lineMetricExclusions("pr_lines_removed", "deletions", 5);
});

test("stacked branch merges keep PR participation while delivered LOC appears once at pinned default integration", () => {
  const baseIntegration = {
    before,
    after,
    canonicalChangeId: "synthetic-logical-stack",
    defaultBranch: "main",
    targetBranch: "research",
    commitShas: [after],
    diff: { before, after, complete: true, files: [{ path: "src/change.ts", additions: 10, deletions: 2 }] },
  };
  const intermediate = normalizeGithubObservation(envelope({ integration: baseIntegration }));
  assert.equal(metrics(intermediate, "pr_merged").length, 1);
  assert.equal(metrics(intermediate, "pr_lines_changed").length, 0);
  const integrated = normalizeGithubObservation(
    envelope({ integration: { ...baseIntegration, targetBranch: "main" } }),
  );
  assert.equal(metrics(integrated, "pr_lines_changed")[0].quantity, 12);
  const sameIntegration = normalizeGithubObservation(
    envelope({ action: "reopened", integration: { ...baseIntegration, targetBranch: "main" } }),
  );
  assert.equal(metrics(integrated, "pr_lines_changed")[0].id, metrics(sameIntegration, "pr_lines_changed")[0].id);
  assert.equal(
    metrics(
      normalizeGithubObservation(
        envelope({
          integration: { ...baseIntegration, targetBranch: "main", diff: { ...baseIntegration.diff, complete: false } },
        }),
      ),
      "pr_lines_changed",
    ).length,
    0,
  );
  assert.equal(metrics(integrated, "net_lines").length, 0);
});

test("commit author/committer and verified lineage stay separate and integration is mandatory", () => {
  const payload = {
    sha: after,
    html_url: `https://github.com/synthetic-owner/repository/commit/${after}`,
    author: fixture.author,
    committer: fixture.merger,
    commit: { message: "source text is not identity" },
  };
  const noIntegration = normalizeGithubObservation(envelope({ family: "commit", payload }));
  assert.equal(noIntegration.facts.length, 0);
  assert.deepEqual(
    noIntegration.participation.map((item) => item.role),
    ["author", "committer"],
  );
  const integrated = normalizeGithubObservation(
    envelope({
      family: "commit",
      payload,
      integration: {
        before,
        after,
        canonicalChangeId: "one-change",
        targetBranch: "main",
        defaultBranch: "main",
        commitShas: [after],
      },
      verifiedCoauthors: [
        { actor: fixture.author, verificationReceipt: "synthetic-primary-link" },
        { actor: fixture.reviewer, verificationReceipt: "synthetic-account-link" },
        { actor: fixture.reviewer, verificationReceipt: "synthetic-account-link" },
      ],
      lineage: [
        {
          relation: "squash_of",
          sourceIds: ["original:a", "original:b"],
          targetId: after,
          evidenceIds: ["verified-pr-merge"],
        },
      ],
    }),
  );
  assert.equal(integrated.facts[0].actorId, "101");
  assert.equal(integrated.lineage[0].relation, "squash_of");
  assert.equal(integrated.participation.find((item) => item.role === "coauthor").actorId, "303");
  assert.equal(integrated.participation.filter((item) => item.role === "coauthor").length, 1);
});

test("commits_integrated excludes commits without verified default-branch integration and never credits the committer or a coauthor", () => {
  const payload = {
    sha: after,
    html_url: `https://github.com/synthetic-owner/repository/commit/${after}`,
    author: fixture.author,
    committer: fixture.merger,
    commit: { message: "source text is not identity" },
  };
  const integration = {
    before,
    after,
    canonicalChangeId: "one-change",
    targetBranch: "main",
    defaultBranch: "main",
    commitShas: [after],
  };
  // Control: this same payload with a verified integration is the one unit. The committer and coauthor keep
  // their participation roles, but only the commit author owns the integrated unit.
  const control = normalizeGithubObservation(
    envelope({
      family: "commit",
      payload,
      integration,
      verifiedCoauthors: [{ actor: fixture.reviewer, verificationReceipt: "synthetic-account-link" }],
    }),
  );
  assert.deepEqual(
    metrics(control, "commits_integrated").map((fact) => [fact.actorId, fact.state, fact.role]),
    [["101", "observed", "author"]],
  );
  assert.equal(metrics(control, "direct_changes").length, 0, "A non-direct integration is not a direct change");
  assert.deepEqual(control.participation.map((item) => [item.role, item.actorId]).sort(), [
    ["author", "101"],
    ["coauthor", "303"],
    ["committer", "202"],
  ]);
  const unverified = [
    ["no integration at all", undefined],
    ["a non-default target branch", { ...integration, targetBranch: "research" }],
    [
      "a default branch that differs from the repository",
      { ...integration, defaultBranch: "trunk", targetBranch: "trunk" },
    ],
    ["an integration that does not list this commit", { ...integration, commitShas: [before] }],
  ];
  for (const [name, candidate] of unverified) {
    const out = normalizeGithubObservation(envelope({ family: "commit", payload, integration: candidate }));
    assert.deepEqual(metrics(out, "commits_integrated"), [], name);
    assert.ok(out.reasons.includes("default_branch_integration_unverified"), name);
  }
  // A short or non-hex identifier is not a pinned commit, even if an integration lists the same string.
  const unpinned = normalizeGithubObservation(
    envelope({
      family: "commit",
      payload: { ...payload, sha: "abc123" },
      integration: { ...integration, commitShas: ["abc123"] },
    }),
  );
  assert.deepEqual(metrics(unpinned, "commits_integrated"), []);
  // An integration on another artifact family cannot manufacture a commit unit.
  assert.deepEqual(metrics(normalizeGithubObservation(envelope({ integration })), "commits_integrated"), []);
  // An integrated commit with an unknown author is never reassigned to the committer.
  const ghost = normalizeGithubObservation(
    envelope({ family: "commit", payload: { ...payload, author: null }, integration }),
  );
  assert.deepEqual(
    metrics(ghost, "commits_integrated").map((fact) => [fact.actorId, fact.state]),
    [[null, "unknown"]],
  );
  assert.ok(ghost.reasons.includes("unknown_actor"));
  // Private repositories emit nothing.
  const hidden = normalizeGithubObservation(
    envelope({
      repository: { id: 2, slug: "synthetic-owner/repository", visibility: "private", defaultBranch: "main" },
      family: "commit",
      payload,
      integration,
    }),
  );
  assert.deepEqual(hidden.facts, []);
});

test("release publication keeps automation sender separate from notes author", () => {
  const release = {
    id: 60,
    node_id: "RE_synthetic",
    html_url: "https://github.com/synthetic-owner/repository/releases/tag/v1",
    author: fixture.author,
    draft: false,
    published_at: at,
  };
  const out = normalizeGithubObservation(
    envelope({ family: "release", action: "published", payload: { release, sender: fixture.bot } }),
  );
  assert.equal(out.facts[0].actorId, "404");
  assert.equal(out.facts[0].role, "automation");
  assert.equal(metrics(out, "maintenance").length, 0);
  assert.equal(metrics(out, "deployment_work").length, 0);
});

test("default collection normalization excludes a successful workflow completion", async () => {
  const transportRequests = [];
  let acceptanceCalls = 0;
  const client = new GithubReadClient({
    apiOrigin: "https://api.synthetic.invalid",
    token: async () => undefined,
    checkpoints: syntheticCheckpointStore(),
    fetch: async (url) => {
      transportRequests.push(String(url));
      throw new Error("Unsupported CI evidence must not be fetched");
    },
  });
  const normalize = createGithubEvidenceNormalizer({
    client,
    source: "synthetic-source",
    allowedRepositoryIds: [2],
    isSynthetic: true,
    acceptance: async () => {
      acceptanceCalls++;
      return [];
    },
  });
  // Exercise the existing string-family collection boundary without inventing
  // a workflow GithubEvidenceEnvelope or supplying trusted event enrichment.
  const input = {
    repository: { id: 2, slug: "synthetic-owner/repository" },
    family: "workflow_run",
    factKey: "synthetic-successful-workflow-901",
    observedAt,
    policyVersion: "synthetic-policy/v1",
    fact: {
      subjectId: "901",
      sourceRevision: at,
      sourceUrl: "https://github.com/synthetic-owner/repository/actions/runs/901",
      evidence: "observed_transition",
      actorId: "404",
      occurredAt: at,
      state: "success",
    },
  };
  const original = structuredClone(input);
  const out = await normalize(input);
  assert.deepEqual(out.facts, []);
  assert.deepEqual(out.evidence, []);
  assert.deepEqual(out.actors, []);
  assert.deepEqual(out.reasons, ["source_family_requires_exact_event_enrichment"]);
  assert.equal(out.isSynthetic, true);
  assert.deepEqual(transportRequests, []);
  assert.equal(acceptanceCalls, 0);
  assert.deepEqual(input, original);
});

test("subjective maintenance, deployment, reliability and coordination stay receipt-based with accepted/rejected cases", () => {
  const raw = normalizeGithubObservation(envelope());
  const target = metrics(raw, "pr_merged")[0];
  for (const metricId of [
    "maintenance",
    "automation",
    "deployment_work",
    "incidents",
    "issue_resolution",
    "reproductions",
    "mentorship",
    "onboarding",
    "project_configuration",
  ]) {
    for (const decision of ["accepted", "rejected"]) {
      const receipt = {
        verified: true,
        id: `synthetic-receipt-${metricId}-${decision}`,
        metricId,
        actorId: "101",
        reviewerId: "202",
        acceptedAt: observedAt,
        decision,
        targetFactId: target.id,
        evidenceIds: [`synthetic-evidence-${metricId}`],
        changesetId: `synthetic-changeset-${metricId}`,
      };
      const out = applyRecognitionReceipt(raw, receipt, ["202"]);
      assert.equal(metrics(out, metricId).length, 1);
      assert.equal(metrics(out, metricId)[0].state, decision === "accepted" ? "qualified" : "excluded");
      assert.equal(metrics(raw, metricId).length, 0);
    }
  }
});

test("pipeline wrapper hydrates only matching public object/revision and preserves source labels", async () => {
  const calls = [];
  const memory = new Map();
  const client = new GithubReadClient({
    apiOrigin: "https://api.synthetic.invalid",
    token: async () => undefined,
    checkpoints: syntheticCheckpointStore(memory),
    fetch: async (url) => {
      calls.push(url);
      return new Response(JSON.stringify(url.endsWith("/issues/20") ? issue() : fixture.repository));
    },
  });
  const normalize = createGithubEvidenceNormalizer({
    client,
    source: "synthetic-source",
    allowedRepositoryIds: [2],
    isSynthetic: true,
  });
  const input = {
    repository: { id: 2, slug: "synthetic-owner/repository" },
    family: "issues",
    factKey: "source-20",
    observedAt,
    policyVersion: "synthetic-policy/v1",
    fact: {
      subjectId: "20",
      sourceRevision: at,
      sourceUrl: fixture.issue.html_url,
      evidence: "current_state",
      actorId: null,
      occurredAt: null,
      state: "closed",
    },
  };
  const out = await normalize(input);
  assert.equal(metrics(out, "issues_opened")[0].actorId, "101");
  assert.equal(metrics(out, "issue_closure_stewardship").length, 0);
  assert.equal(out.isSynthetic, true);
  assert.equal(calls.length, 2);
  const mismatch = await normalize({ ...input, fact: { ...input.fact, subjectId: "999" } });
  assert.equal(mismatch.facts.length, 0);
  const stale = await normalize({ ...input, fact: { ...input.fact, sourceRevision: "unproven" } });
  assert.equal(stale.facts.length, 0);
  const unapproved = await normalize({ ...input, repository: { ...input.repository, id: 999 } });
  assert.match(unapproved.reasons[0], /not_authorized/);
  const privateClient = new GithubReadClient({
    apiOrigin: "https://api.synthetic.invalid",
    token: async () => undefined,
    checkpoints: syntheticCheckpointStore(),
    fetch: async (url) =>
      new Response(JSON.stringify(url.endsWith("/issues/20") ? issue() : { ...fixture.repository, private: true })),
  });
  const privateNormalize = createGithubEvidenceNormalizer({
    client: privateClient,
    source: "synthetic-source",
    allowedRepositoryIds: [2],
    isSynthetic: true,
  });
  const revoked = await privateNormalize(input);
  assert.equal(revoked.facts.length, 0);
  assert.deepEqual(revoked.suppressArtifactIds, ["I_synthetic_20"]);
});

test("bounded local Git fallback reads pinned changes including rename and excludes formatting-only churn", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "github-diff-test-"));
  t.after(async () => {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.match(basename(directory), /^github-diff-test-/);
    await rm(directory, { recursive: true, force: true });
  });
  const git = (args) =>
    execFileSync(
      "git",
      [
        "-C",
        directory,
        "-c",
        "core.hooksPath=",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "user.name=synthetic-fixture",
        "-c",
        "user.email=fixture.invalid",
        ...args,
      ],
      { encoding: "utf8", windowsHide: true },
    ).trim();
  git(["init", "--quiet"]);
  await mkdir(join(directory, "src"));
  await writeFile(join(directory, "src", "main.ts"), "const value = 1;\n");
  await writeFile(join(directory, "src", "rename.ts"), "export const original = true;\n");
  git(["add", "."]);
  git(["commit", "--quiet", "-m", "synthetic baseline"]);
  const first = git(["rev-parse", "HEAD"]);
  await writeFile(join(directory, "src", "main.ts"), "const    value   =  1;\n");
  await rename(join(directory, "src", "rename.ts"), join(directory, "src", "renamed.ts"));
  git(["add", "."]);
  git(["commit", "--quiet", "-m", "synthetic formatting and rename"]);
  const second = git(["rev-parse", "HEAD"]);
  const diff = await readPinnedGitDiff({ repositoryPath: directory, before: first, after: second });
  assert.equal(diff.complete, true);
  assert.equal(diff.files.find((file) => file.path === "src/main.ts").formattingOnly, true);
  assert.equal(diff.files.find((file) => file.path === "src/renamed.ts").previousPath, "src/rename.ts");
  assert.equal(classifyPhysicalDiff(diff).changed, 0);
  assert.equal(
    (await readPinnedGitDiff({ repositoryPath: directory, before: first, after: second, maxFiles: 1 })).complete,
    false,
  );
  await assert.rejects(
    readPinnedGitDiff({ repositoryPath: directory, before: "--untrusted", after: second }),
    /Pinned/,
  );
});

test("registry clocks conserve first readiness and merged coauthor participation rather than toggles", () => {
  const firstReadyAt = "2026-10-02T10:00:00Z";
  const first = normalizeGithubObservation(
    envelope({
      action: "ready_for_review",
      occurredAt: firstReadyAt,
      reviewCohort: { verified: true, firstReadyAt, firstSubmittedReviewAt: null },
    }),
  );
  const toggle = normalizeGithubObservation(
    envelope({
      action: "ready_for_review",
      occurredAt: at,
      reviewCohort: { verified: true, firstReadyAt, firstSubmittedReviewAt: null },
    }),
  );
  assert.equal(metrics(first, "pr_ready")[0].id, metrics(toggle, "pr_ready")[0].id);
  assert.equal(metrics(toggle, "pr_ready")[0].occurredAt, "2026-10-02T10:00:00.000Z");
  assert.equal(metrics(normalizeGithubObservation(envelope({ action: "ready_for_review" })), "pr_ready").length, 0);
  const unmerged = pr();
  unmerged.merged = false;
  unmerged.merged_at = null;
  unmerged.closed_at = null;
  unmerged.state = "open";
  const pending = normalizeGithubObservation(
    envelope({
      payload: { pull_request: unmerged },
      verifiedCoauthors: [{ actor: fixture.reviewer, verificationReceipt: "synthetic-verified-link" }],
    }),
  );
  assert.equal(metrics(pending, "pr_coauthored")[0].state, "pending");
  assert.equal(metrics(pending, "pr_coauthored")[0].occurredAt, null);
});

test("review participation excludes self/bots and rounds conserve reviewer/PR/head with first-submission clocks", () => {
  const input = envelope({
    family: "review",
    action: "submitted",
    reviewParticipation: { verified: true, firstSubmittedAt: at, roundFirstSubmittedAt: at },
    payload: {
      pull_request: pr(),
      review: { id: 91, user: fixture.reviewer, state: "APPROVED", submitted_at: at, created_at: at, commit_id: after },
    },
  });
  const a = normalizeGithubObservation(input);
  const repeated = normalizeGithubObservation({
    ...input,
    payload: {
      ...input.payload,
      review: { ...input.payload.review, id: 92, submitted_at: observedAt, state: "CHANGES_REQUESTED" },
    },
  });
  assert.equal(metrics(a, "review_rounds")[0].id, metrics(repeated, "review_rounds")[0].id);
  assert.equal(metrics(a, "review_rounds")[0].occurredAt, metrics(repeated, "review_rounds")[0].occurredAt);
  assert.equal(metrics(a, "prs_reviewed")[0].id, metrics(repeated, "prs_reviewed")[0].id);
  for (const user of [fixture.author, fixture.bot]) {
    const out = normalizeGithubObservation({
      ...input,
      payload: { ...input.payload, review: { ...input.payload.review, user } },
    });
    assert.equal(metrics(out, "prs_reviewed").length, 0);
  }
  const missingHead = normalizeGithubObservation({
    ...input,
    payload: { ...input.payload, review: { ...input.payload.review, commit_id: null } },
  });
  assert.equal(metrics(missingHead, "review_rounds").length, 0);
  assert.equal(
    metrics(normalizeGithubObservation({ ...input, reviewParticipation: undefined }), "prs_reviewed").length,
    0,
  );
});

test("files_changed emits one canonical count unit per eligible path, never a quantity pretending to be count", () => {
  const out = normalizeGithubObservation(
    envelope({
      integration: {
        before,
        after,
        canonicalChangeId: "synthetic-many-files",
        targetBranch: "main",
        defaultBranch: "main",
        commitShas: [after],
        diff: {
          before,
          after,
          complete: true,
          files: [
            { path: "src/a.ts", additions: 2, deletions: 1 },
            { path: "src/b.ts", additions: 3, deletions: 1 },
            { path: "vendor/x.ts", additions: 100, deletions: 1 },
          ],
        },
      },
    }),
  );
  const files = metrics(out, "files_changed");
  assert.equal(files.length, 2);
  assert.equal(new Set(files.map((fact) => fact.canonicalKey)).size, 2);
  assert.ok(files.every((fact) => fact.quantity === undefined));
});

test("pending, unknown and observed facts retain independent canonical evidence classes through merge", () => {
  const unmerged = pr();
  unmerged.merged = false;
  unmerged.merged_at = null;
  unmerged.closed_at = null;
  unmerged.state = "open";
  const coauthors = [{ actor: fixture.reviewer, verificationReceipt: "synthetic-link" }];
  const pending = normalizeGithubObservation(
    envelope({
      payload: { pull_request: unmerged },
      verifiedCoauthors: coauthors,
      decisionCohort: { verified: true, asOf: observedAt, outcome: "pending", decisionAt: null },
    }),
  );
  const merged = normalizeGithubObservation(envelope({ verifiedCoauthors: coauthors }));
  for (const metric of ["pr_coauthored", "pr_accepted_rate"]) {
    assert.notEqual(metrics(pending, metric)[0].canonicalKey, metrics(merged, metric)[0].canonicalKey);
    assert.notEqual(metrics(pending, metric)[0].id, metrics(merged, metric)[0].id);
  }
  const unknown = normalizeGithubObservation(envelope({ payload: { pull_request: { ...pr(), user: null } } }));
  assert.notEqual(metrics(unknown, "pr_merged")[0].canonicalKey, metrics(merged, "pr_merged")[0].canonicalKey);
  const unselected = normalizeGithubObservation(envelope({ decisionCohort: undefined }));
  assert.equal(metrics(unselected, "pr_accepted_rate").length, 0);
  assert.match(unselected.reasons.join(), /selected_as_of_history/);
  assert.equal(unselected.decisions[0].outcome, "merged");
  assert.equal(
    metrics(normalizeGithubObservation(envelope({ frozenCutoff: "2026-10-06T10:00:00Z" })), "pr_accepted_rate").length,
    0,
  );
});

test("public labels are bounded as-collected text and actions describe each credited fact rather than its envelope", () => {
  const payload = pr();
  payload.title = '<img src=x onerror="alert(1)">\n' + "x".repeat(300);
  payload.body = "PRIVATE BODY";
  const out = normalizeGithubObservation(envelope({ action: "snapshot", payload: { pull_request: payload } }));
  const opening = out.evidence.find((entry) => entry.contribution.metricIds.includes("pr_opened"));
  const merge = out.evidence.find((entry) => entry.contribution.metricIds.includes("pr_merged"));
  assert.equal(opening.evidenceMetadata.sourceAction, "artifact_created");
  assert.equal(merge.evidenceMetadata.sourceAction, "pull_request_merged");
  assert.equal(opening.evidenceMetadata.artifactTitle.value.length, 200);
  assert.equal(opening.evidenceMetadata.artifactTitle.basis, "as_collected");
  assert.equal(opening.evidenceMetadata.artifactTitle.collectedAt, new Date(observedAt).toISOString());
  assert.equal(opening.evidenceMetadata.sourceOccurredAt, opening.occurredAt);
  assert.equal(opening.evidenceMetadata.acceptedAt, null);
  assert.deepEqual(opening.evidenceMetadata.history, { coverage: "not_supplied", records: [] });
  assert.equal(JSON.stringify(out.evidence).includes("PRIVATE BODY"), false);
  const issueOut = normalizeGithubObservation(
    envelope({ family: "issue", action: "closed", payload: { issue: issue(), sender: fixture.merger } }),
  );
  assert.equal(
    issueOut.evidence.find((entry) => entry.contribution.metricIds.includes("issues_opened")).evidenceMetadata
      .sourceAction,
    "artifact_created",
  );
  assert.equal(
    issueOut.evidence.find((entry) => entry.contribution.metricIds.includes("issue_closure_stewardship"))
      .evidenceMetadata.sourceAction,
    "issue_closed",
  );
});

test("only independently accepted recognition exposes an acceptance clock and no private receipt identifier", () => {
  const closed = { ...pr(), merged: false, merged_at: null };
  const raw = normalizeGithubObservation(
    envelope({
      payload: { pull_request: closed },
      decisionCohort: { verified: true, asOf: observedAt, outcome: "closed_unmerged", decisionAt: at },
    }),
  );
  const decision = raw.evidence.find((entry) => entry.contribution.metricIds.includes("pr_accepted_rate"));
  assert.equal(metrics(raw, "pr_accepted_rate")[0].acceptedAt, new Date(at).toISOString());
  assert.equal(decision.evidenceMetadata.acceptedAt, null);
  assert.equal(decision.evidenceMetadata.sourceAction, "pull_request_closed_unmerged");
  const target = raw.facts.find((fact) => fact.metricId === "pr_opened");
  const receipt = {
    id: "private-review-receipt",
    verified: true,
    metricId: "pr_opened",
    actorId: target.actorId,
    reviewerId: "202",
    acceptedAt: observedAt,
    decision: "accepted",
    targetFactId: target.id,
    evidenceIds: ["private-supporting-evidence"],
  };
  const accepted = applyRecognitionReceipt(raw, receipt, ["202"]).evidence.at(-1);
  assert.equal(accepted.evidenceMetadata.acceptedAt, new Date(observedAt).toISOString());
  assert.equal(accepted.evidenceMetadata.sourceAction, "recognition_accepted");
  assert.equal(accepted.evidenceMetadata.sourceOccurredAt, target.occurredAt);
  assert.equal(accepted.evidenceMetadata.activityState, "accepted");
  assert.doesNotMatch(JSON.stringify(accepted), /private-review-receipt|private-supporting-evidence/);
  const rejected = applyRecognitionReceipt(raw, { ...receipt, decision: "rejected" }, ["202"]).evidence.at(-1);
  assert.equal(rejected.evidenceMetadata.acceptedAt, null);
  assert.throws(() => applyRecognitionReceipt(raw, { ...receipt, reviewerId: target.actorId }, [target.actorId]));
});

test("revision and correction records require explicit minimized public host input; payload history never qualifies", () => {
  const history = {
    coverage: "partial",
    records: [
      {
        kind: "source_revision",
        revision: "a".repeat(40),
        occurredAt: null,
        publicUrl: `https://github.com/synthetic-owner/repository/commit/${"a".repeat(40)}`,
      },
      {
        kind: "correction",
        occurredAt: at,
        publicUrl: "https://github.com/synthetic-owner/repository/issues/1#issuecomment-2",
      },
    ],
  };
  const input = envelope({ publicHistory: { approvedPublic: true, history } });
  const out = normalizeGithubObservation(input);
  assert.deepEqual(out.evidence[0].evidenceMetadata.history, history);
  history.records[1].publicUrl = "https://evil.invalid/private";
  assert.throws(() => normalizeGithubObservation(input));
  const payloadHistory = normalizeGithubObservation(
    envelope({
      payload: {
        pull_request: { ...pr(), history: { coverage: "complete", records: [] }, correctionReceipt: "private" },
      },
    }),
  );
  assert.deepEqual(payloadHistory.evidence[0].evidenceMetadata.history, { coverage: "not_supplied", records: [] });
  assert.throws(() =>
    normalizeGithubObservation(
      envelope({ publicHistory: { approvedPublic: true, history: { coverage: "complete", records: [] } } }),
    ),
  );
});

test("an unresolved readiness cohort does not claim a proven readiness action", () => {
  const out = normalizeGithubObservation(
    envelope({ reviewCohort: { verified: true, firstReadyAt: null, firstSubmittedReviewAt: at } }),
  );
  const wait = out.evidence.find((entry) => entry.contribution.metricIds.includes("review_wait"));
  assert.equal(wait.evidenceMetadata.sourceAction, "unknown");
  assert.equal(wait.evidenceMetadata.sourceOccurredAt, null);
});

test("review hydration proves first participation only from a complete consistent cohort", async () => {
  const review = {
    id: 51,
    user: fixture.reviewer,
    state: "APPROVED",
    commit_id: "a".repeat(40),
    submitted_at: at,
    html_url: `${fixture.pull_request.html_url}#pullrequestreview-51`,
  };
  const earlier = {
    ...review,
    id: 50,
    state: "COMMENTED",
    submitted_at: "2026-10-02T10:00:00Z",
    html_url: `${fixture.pull_request.html_url}#pullrequestreview-50`,
  };
  const input = {
    repository: { id: 2, slug: "synthetic-owner/repository" },
    family: "reviews",
    factKey: "synthetic-review",
    observedAt,
    policyVersion: "synthetic/v1",
    fact: {
      subjectId: "51",
      sourceRevision: githubReviewRevision(review),
      sourceUrl: review.html_url,
      evidence: "current_state",
      actorId: null,
      occurredAt: null,
      state: "present",
    },
  };
  let cohort = [review, earlier];
  const client = syntheticRepositoryClient(2, {
    rest: async (_source, path) =>
      path.endsWith("reviews/51") ? review : path.endsWith("pulls/10") ? pr() : fixture.repository,
    scanRest: async () => cohort,
  });
  const normalize = createGithubEvidenceNormalizer({
    client,
    source: "synthetic",
    allowedRepositoryIds: [2],
    isSynthetic: true,
  });
  const out = await normalize(input);
  assert.equal(metrics(out, "prs_reviewed").length, 1);
  assert.equal(metrics(out, "prs_reviewed")[0].occurredAt, "2026-10-02T10:00:00.000Z");
  assert.equal(metrics(out, "review_rounds").length, 1);
  assert.equal(metrics(out, "first_reviews").length, 0);
  for (const invalid of [
    [review, earlier, earlier],
    [review, { ...earlier, submitted_at: null }],
    [review, { ...earlier, user: null }],
    [review, { ...earlier, commit_id: null }],
    [{ ...review, commit_id: "b".repeat(40) }],
  ]) {
    cohort = invalid;
    const result = await normalize(input);
    assert.equal(metrics(result, "prs_reviewed").length, 0);
    assert.equal(metrics(result, "review_rounds").length, 0);
  }
  client.scanRest = async () => {
    throw Error("page budget exceeded");
  };
  await assert.rejects(normalize(input), /page budget exceeded/);
});

test("Discussion authors and answer selectors remain distinct with explicit selected-revision proof", () => {
  const discussion = {
    id: "D_synthetic",
    url: "https://github.com/synthetic-owner/repository/discussions/4",
    createdAt: at,
    updatedAt: at,
    author: fixture.author,
    answerChosenAt: at,
    answerChosenBy: fixture.merger,
    answer: { id: "DC_synthetic", createdAt: at, isAnswer: true, author: fixture.reviewer },
  };
  const base = envelope({ family: "discussion", action: "snapshot", payload: discussion });
  const unselected = normalizeGithubObservation(base);
  assert.equal(metrics(unselected, "discussions_started")[0].actorId, "101");
  assert.equal(metrics(unselected, "discussion_answers").length, 0);
  const selected = normalizeGithubObservation({ ...base, discussionAnswerSelection: { verified: true } });
  const answer = metrics(selected, "discussion_answers")[0];
  assert.equal(answer.actorId, "303");
  assert.equal(answer.acceptedBy, "202");
  assert.equal(answer.state, "observed");
  assert.equal(metrics(selected, "helpful_feedback").length, 0);
  const removed = normalizeGithubObservation({
    ...base,
    payload: { ...discussion, answer: null },
    discussionAnswerSelection: { verified: true },
  });
  assert.equal(metrics(removed, "discussion_answers").length, 0);
});

test("Discussion hydration validates capability, public identity and exact revision", async () => {
  let repo = {
    databaseId: 2,
    isPrivate: false,
    hasDiscussionsEnabled: true,
    discussion: {
      id: "D_synthetic",
      url: "https://github.com/synthetic-owner/repository/discussions/4",
      createdAt: at,
      updatedAt: at,
      author: fixture.author,
      answer: null,
    },
  };
  const normalize = createGithubEvidenceNormalizer({
    client: syntheticRepositoryClient(2, {
      rest: async () => fixture.repository,
      graphql: async () => ({ repository: repo }),
    }),
    source: "synthetic",
    allowedRepositoryIds: [2],
    isSynthetic: true,
  });
  const input = {
    repository: { id: 2, slug: "synthetic-owner/repository" },
    family: "discussions",
    factKey: "synthetic-discussion",
    observedAt,
    policyVersion: "synthetic/v1",
    fact: {
      subjectId: "D_synthetic",
      sourceRevision: githubDiscussionRevision(repo.discussion),
      sourceUrl: repo.discussion.url,
      evidence: "current_state",
      actorId: null,
      occurredAt: null,
      state: "present",
    },
  };
  const normalized = await normalize(input);
  assert.equal(metrics(normalized, "discussions_started").length, 1);
  assert.equal(normalized.observations[0].source, "github_graphql");
  repo = { ...repo, hasDiscussionsEnabled: false };
  assert.match((await normalize(input)).reasons[0], /unavailable/);
  repo = {
    ...repo,
    hasDiscussionsEnabled: true,
    discussion: { ...repo.discussion, updatedAt: "2026-10-09T00:00:00Z" },
  };
  assert.match((await normalize(input)).reasons[0], /revision_unverified/);
});

test("discussions_started excludes unavailable, stale or private Discussions and never borrows a clock or an answer author's credit", async () => {
  const created = {
    id: "D_synthetic",
    url: "https://github.com/synthetic-owner/repository/discussions/4",
    createdAt: at,
    updatedAt: "2026-10-07T11:00:00Z",
    author: fixture.author,
  };
  const snapshot = (payload, patch = {}) =>
    normalizeGithubObservation(envelope({ family: "discussion", action: "snapshot", payload, ...patch }));
  // Control: a created Discussion is one unit at its creation clock, not its update clock.
  assert.deepEqual(
    metrics(snapshot(created), "discussions_started").map((fact) => [fact.actorId, fact.state, fact.occurredAt]),
    [["101", "observed", "2026-10-07T10:00:00.000Z"]],
  );
  // A selected answer credits only the answer's own metric; its author and selector start nothing.
  const answered = snapshot(
    {
      ...created,
      answerChosenAt: at,
      answerChosenBy: fixture.merger,
      answer: { id: "DC_synthetic", createdAt: at, isAnswer: true, author: fixture.reviewer },
    },
    { discussionAnswerSelection: { verified: true } },
  );
  assert.deepEqual(
    metrics(answered, "discussions_started").map((fact) => fact.actorId),
    ["101"],
  );
  // A missing or unsupported creation clock is unknown; the update, observation and collection times are not borrowed.
  for (const createdAt of [undefined, null, "", "2026-10-07", "2026-10-07T10:00:00"]) {
    const out = snapshot({ ...created, createdAt });
    assert.deepEqual(
      metrics(out, "discussions_started").map((fact) => [fact.state, fact.occurredAt]),
      [["unknown", null]],
      String(createdAt),
    );
    assert.ok(out.reasons.includes("unknown_event_time"));
  }
  // A missing author is unknown and is not replaced by the sender.
  const ghost = snapshot({ ...created, author: null });
  assert.deepEqual(
    metrics(ghost, "discussions_started").map((fact) => [fact.actorId, fact.state]),
    [[null, "unknown"]],
  );
  assert.ok(ghost.reasons.includes("unknown_actor"));
  // Private repositories emit nothing, and an unverified observation is rejected outright.
  const hidden = snapshot(created, {
    repository: { id: 2, slug: "synthetic-owner/repository", visibility: "private", defaultBranch: "main" },
  });
  assert.deepEqual(hidden.facts, []);
  assert.throws(
    () => snapshot(created, { proof: { verified: false, source: "github_webhook", revision: at, isSynthetic: true } }),
    /Verified repository\/source envelope is required/,
  );

  // Collected Discussions: unavailable, private and stale-revision hydration produce no unit.
  let repo = {
    databaseId: 2,
    isPrivate: false,
    hasDiscussionsEnabled: true,
    discussion: { ...created, answer: null },
  };
  const hydrate = createGithubEvidenceNormalizer({
    client: syntheticRepositoryClient(2, {
      rest: async () => fixture.repository,
      graphql: async () => ({ repository: repo }),
    }),
    source: "synthetic",
    allowedRepositoryIds: [2],
    isSynthetic: true,
  });
  const input = {
    repository: { id: 2, slug: "synthetic-owner/repository" },
    family: "discussions",
    factKey: "synthetic-discussion-exclusion",
    observedAt,
    policyVersion: "synthetic/v1",
    fact: {
      subjectId: "D_synthetic",
      sourceRevision: githubDiscussionRevision(repo.discussion),
      sourceUrl: repo.discussion.url,
      evidence: "current_state",
      actorId: null,
      occurredAt: null,
      state: "present",
    },
  };
  const hydrated = await hydrate(input);
  assert.deepEqual(
    metrics(hydrated, "discussions_started").map((fact) => [fact.actorId, fact.state]),
    [["101", "observed"]],
  );
  for (const [name, patch] of [
    ["Discussions disabled", { hasDiscussionsEnabled: false }],
    ["a private repository", { isPrivate: true }],
    ["a missing Discussion", { discussion: null }],
  ]) {
    repo = {
      ...structuredClone(repo),
      hasDiscussionsEnabled: true,
      isPrivate: false,
      discussion: { ...created, answer: null },
      ...patch,
    };
    const out = await hydrate(input);
    assert.deepEqual(out.facts, [], name);
    assert.deepEqual(out.reasons, ["discussion_public_source_unavailable"], name);
  }
  repo = {
    ...repo,
    isPrivate: false,
    hasDiscussionsEnabled: true,
    discussion: { ...created, answer: null, updatedAt: "2026-10-09T00:00:00Z" },
  };
  const stale = await hydrate(input);
  assert.deepEqual(stale.facts, []);
  assert.match(stale.reasons[0], /revision_unverified/);
});

test("mutable review and Discussion revisions include retractions and selection changes", () => {
  const review = { id: 1, state: "APPROVED", submitted_at: at, body: "synthetic", user: fixture.reviewer };
  assert.notEqual(githubReviewRevision(review), githubReviewRevision({ ...review, state: "DISMISSED" }));
  assert.notEqual(githubReviewRevision(review), githubReviewRevision({ ...review, body: "edited synthetic" }));
  const discussion = {
    id: "D_synthetic",
    updatedAt: at,
    answerChosenAt: at,
    answer: { id: "A1", isAnswer: true, author: fixture.author },
    answerChosenBy: fixture.merger,
  };
  assert.notEqual(githubDiscussionRevision(discussion), githubDiscussionRevision({ ...discussion, answer: null }));
  assert.notEqual(
    githubDiscussionRevision(discussion),
    githubDiscussionRevision({ ...discussion, answer: { ...discussion.answer, id: "A2" } }),
  );
});

test("repository issue-event hydration preserves actor clocks without inferring metadata identity", async () => {
  const event = {
    id: 901,
    event: "assigned",
    created_at: at,
    actor: fixture.merger,
    assignee: fixture.reviewer,
    issue: issue(),
  };
  const { githubTimelineRevision } = await import("../dist/index.js");
  const normalize = createGithubEvidenceNormalizer({
    client: syntheticRepositoryClient(2, {
      rest: async (_source, endpoint) => (endpoint.includes("/events/") ? event : fixture.repository),
    }),
    source: "synthetic",
    allowedRepositoryIds: [2],
    isSynthetic: true,
  });
  const input = {
    repository: { id: 2, slug: "synthetic-owner/repository" },
    family: "timelines",
    factKey: "synthetic-event",
    observedAt,
    policyVersion: "synthetic/v1",
    fact: {
      subjectId: "901",
      sourceRevision: githubTimelineRevision(event),
      sourceUrl: event.issue.html_url,
      evidence: "observed_transition",
      actorId: "202",
      occurredAt: at,
      state: "present",
    },
  };
  const out = await normalize(input);
  assert.equal(metrics(out, "assignments_coordinated")[0].actorId, "202");
  assert.equal(metrics(out, "assignments_coordinated")[0].occurredAt, "2026-10-07T10:00:00.000Z");
  assert.equal(metrics(out, "assignments_coordinated")[0].state, "observed");
  const wrongSubject = await normalize({
    ...input,
    fact: { ...input.fact, sourceUrl: "https://github.com/synthetic-owner/repository/issues/21" },
  });
  assert.match(wrongSubject.reasons[0], /timeline_subject_scope_unverified/);
  event.actor = null;
  const unknown = await normalize({ ...input, fact: { ...input.fact, sourceRevision: githubTimelineRevision(event) } });
  assert.equal(metrics(unknown, "assignments_coordinated")[0].actorId, null);
  assert.equal(metrics(unknown, "assignments_coordinated")[0].state, "unknown");
});

test("native issue events in the same second remain distinct while replays deduplicate", () => {
  const input = envelope({
    family: "triage",
    action: "assigned",
    payload: { issue: issue(), actor: fixture.merger, assignee: fixture.reviewer },
    proof: {
      verified: true,
      source: "github_rest",
      revision: at,
      eventId: "github:2:issue-event:901",
      isSynthetic: true,
    },
  });
  const first = normalizeGithubObservation(input);
  const replay = normalizeGithubObservation(input);
  const next = normalizeGithubObservation({ ...input, proof: { ...input.proof, eventId: "github:2:issue-event:903" } });
  assert.equal(metrics(first, "assignments_coordinated")[0].id, metrics(replay, "assignments_coordinated")[0].id);
  assert.notEqual(metrics(first, "assignments_coordinated")[0].id, metrics(next, "assignments_coordinated")[0].id);
});

const documentationPolicy = {
  repositoryId: 2,
  version: "docs-v1",
  documentationPaths: ["docs/"],
  researchPaths: ["docs/research/"],
  generatedPaths: ["docs/reference/"],
  importedPaths: ["docs/imports/"],
};
const documentationEnvelope = (files) =>
  envelope({
    payload: { repository: fixture.repository, pull_request: { ...pr(), merge_commit_sha: after } },
    integration: {
      before,
      after,
      targetBranch: "main",
      defaultBranch: "main",
      canonicalChangeId: "doc-change",
      commitShas: [after],
      diff: { before, after, complete: true, files },
    },
  });

test("documentation counts one merged PR/category with pinned evidence, never lines or accepted quality", () => {
  const value = documentationEnvelope([
    { path: "docs/guide.md", additions: 10, deletions: 1 },
    { path: "docs/example.md", additions: 1000, deletions: 0 },
  ]);
  const out = normalizeGithubObservation(value, documentationPolicy);
  const docs = metrics(out, "documentation");
  assert.equal(docs.length, 1);
  assert.equal(docs[0].actorId, "101");
  assert.equal(docs[0].role, "author");
  assert.equal(docs[0].state, "observed");
  assert.equal(docs[0].acceptedAt, null);
  assert.equal(docs[0].quantity, undefined);
  const evidence = out.evidence.find((entry) => entry.contribution.contributionId === docs[0].id);
  assert.equal(evidence.sourceRevision, after);
  assert.equal(evidence.sourceRevisionUrl, `https://github.com/synthetic-owner/repository/commit/${after}`);
  value.integration.diff.files[0].additions = 100000;
  assert.equal(metrics(normalizeGithubObservation(value, documentationPolicy), "documentation")[0].id, docs[0].id);
  assert.deepEqual(metrics(normalizeGithubObservation(value), "documentation"), []);
  const accepted = applyRecognitionReceipt(
    out,
    {
      id: "synthetic-review",
      verified: true,
      metricId: "documentation",
      actorId: "101",
      reviewerId: "303",
      acceptedAt: observedAt,
      decision: "accepted",
      targetFactId: docs[0].id,
      evidenceIds: [docs[0].id],
    },
    ["303"],
  );
  assert.equal(metrics(accepted, "documentation").filter((f) => f.state === "qualified").length, 1);
  assert.equal(docs[0].state, "observed");
});

test("documentation excludes generated/imported/research/formatting and incomplete or mismatched integrations", () => {
  for (const file of [
    { path: "docs/auto.md", generated: true },
    { path: "docs/renamed.md", previousPath: "generated/guide.md" },
    { path: "docs/renamed.md", previousPath: "vendor/guide.md" },
    { path: "docs/renamed.md", previousPath: "package-lock.json" },
    { path: "docs/copy.md", imported: true },
    { path: "docs/research/note.md" },
    { path: "docs/reference/api.md" },
    { path: "docs/imports/tutorial.md" },
    { path: "docs/format.md", formattingOnly: true },
    { path: "docs/copy.md", previousPath: "docs/research/note.md" },
  ]) {
    const out = normalizeGithubObservation(
      documentationEnvelope([{ additions: 1, deletions: 0, ...file }]),
      documentationPolicy,
    );
    assert.deepEqual(metrics(out, "documentation"), []);
    assert.ok(out.reasons.some((reason) => reason.startsWith("documentation_excluded_")));
  }
  for (const mutate of [
    (v) => {
      delete v.integration.defaultBranch;
      delete v.integration.targetBranch;
      delete v.repository.defaultBranch;
      delete v.payload.pull_request.base.ref;
    },
    (v) => (v.integration.diff.complete = false),
    (v) => (v.payload.pull_request.merged = false),
    (v) => (v.payload.pull_request.merge_commit_sha = before),
    (v) => (v.integration.targetBranch = "feature"),
    (v) => (v.repository.defaultBranch = "other"),
    (v) => (v.integration.diff.after = before),
  ]) {
    const value = documentationEnvelope([{ path: "docs/guide.md", additions: 1, deletions: 0 }]);
    mutate(value);
    assert.deepEqual(metrics(normalizeGithubObservation(value, documentationPolicy), "documentation"), []);
  }
  assert.throws(() =>
    normalizeGithubObservation(documentationEnvelope([]), { ...documentationPolicy, documentationPaths: ["../docs/"] }),
  );
});

test("configured documentation enrichment stays disabled without policy and binds collection revision", async () => {
  const value = documentationEnvelope([{ path: "docs/guide.md", additions: 0, deletions: 2 }]);
  const input = {
    repository: { id: 2, slug: "synthetic-owner/repository" },
    family: "pull_requests",
    factKey: "synthetic-doc",
    fact: { subjectId: "PR_synthetic_10", sourceUrl: fixture.pull_request.html_url, sourceRevision: at },
    observedAt,
    policyVersion: "source-v1",
  };
  const options = {
    client: syntheticRepositoryClient(2, {}),
    source: "synthetic-source",
    allowedRepositoryIds: [2],
    isSynthetic: true,
    enrich: async () => value,
  };
  assert.deepEqual(metrics(await createGithubEvidenceNormalizer(options)(input), "documentation"), []);
  const enabled = createGithubEvidenceNormalizer({ ...options, documentationPolicies: [documentationPolicy] });
  assert.equal(metrics(await enabled(input), "documentation").length, 1);
  value.proof.revision = "another-revision";
  assert.deepEqual(metrics(await enabled(input), "documentation"), []);
  assert.throws(() =>
    createGithubEvidenceNormalizer({ ...options, documentationPolicies: [documentationPolicy, documentationPolicy] }),
  );
});
