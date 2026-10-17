import assert from "node:assert/strict";
import { readFile, mkdtemp, mkdir, writeFile, rename, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import test from "node:test";
import { normalizeGithubObservation, applyRecognitionReceipt, groupTriageTransitions, parseDeclaredCoauthorTrailers,
  createGithubEvidenceNormalizer, GithubReadClient, classifyPhysicalDiff, readPinnedGitDiff } from "../dist/index.js";

const fixture = JSON.parse(await readFile(new URL("fixtures/engineering.json", import.meta.url), "utf8"));
const at = "2026-10-07T10:00:00Z", observedAt = "2026-10-08T10:00:00Z";
const pr = () => ({ ...structuredClone(fixture.pull_request), user: fixture.author, merged_by: fixture.merger });
const issue = () => ({ ...structuredClone(fixture.issue), user: fixture.author });
const envelope = (patch = {}) => ({
  repository: { id: 2, slug: "synthetic-owner/repository", visibility: "public", defaultBranch: "main" },
  proof: { verified: true, source: "github_webhook", revision: at, eventId: "synthetic-event-1", isSynthetic: true },
  family: "pull_request", action: "closed", occurredAt: at, observedAt,
  decisionCohort: { verified: true, asOf: observedAt, outcome: "merged", decisionAt: at },
  frozenCutoff: observedAt,
  payload: { repository: fixture.repository, pull_request: pr(), sender: fixture.merger }, ...patch,
});
const metrics = (out, id) => out.facts.filter(fact => fact.metricId === id);
const before = "b".repeat(40), after = "c".repeat(40);

test("PR authorship, merger operation and decided denominator remain separate stable units", () => {
  const out = normalizeGithubObservation(envelope());
  assert.equal(metrics(out, "pr_merged")[0].actorId, "101");
  assert.equal(metrics(out, "maintainer_merges")[0].actorId, "202");
  assert.equal(metrics(out, "pr_accepted_rate")[0].outcome, "merged");
  assert.equal(metrics(out, "pr_accepted_rate")[0].acceptedAt, "2026-10-07T10:00:00.000Z");
  assert.equal(out.isSynthetic, true);
  assert.ok(out.facts.every(fact => fact.state === "observed"));
  assert.ok(out.evidence.every(item => item.contribution.reasonCodes.includes("raw_observed_only")));
  const reopened = normalizeGithubObservation(envelope({ action: "reopened" }));
  assert.equal(metrics(out, "pr_merged")[0].id, metrics(reopened, "pr_merged")[0].id);
  const duplicate = normalizeGithubObservation(envelope({ proof: { verified: true, source: "github_rest", revision: at } }));
  assert.equal(metrics(out, "pr_opened")[0].id, metrics(duplicate, "pr_opened")[0].id);
});

test("closed-unmerged and pending PRs never become merged delivery", () => {
  const closed = pr(); closed.merged = false; closed.merged_at = null;
  const out = normalizeGithubObservation(envelope({ payload: { pull_request: closed }, decisionCohort: { verified: true, asOf: observedAt, outcome: "closed_unmerged", decisionAt: at } }));
  assert.equal(metrics(out, "pr_merged").length, 0);
  assert.equal(metrics(out, "pr_accepted_rate")[0].outcome, "closed_unmerged");
  closed.state = "open"; closed.closed_at = null;
  const pending = normalizeGithubObservation(envelope({ payload: { pull_request: closed }, decisionCohort: { verified: true, asOf: observedAt, outcome: "pending", decisionAt: null } }));
  assert.equal(metrics(pending, "pr_accepted_rate")[0].state, "pending");
  assert.equal(metrics(pending, "pr_accepted_rate")[0].acceptedAt, null);
  assert.equal(metrics(pending, "pr_ready").length, 0);
});

test("unknown actor/time/visibility never becomes named measured evidence", () => {
  const unknown = pr(); unknown.user = { login: "unverified" }; unknown.created_at = null;
  const out = normalizeGithubObservation(envelope({ payload: { pull_request: unknown }, occurredAt: null }));
  assert.equal(metrics(out, "pr_opened")[0].actorId, null);
  assert.equal(metrics(out, "pr_opened")[0].occurredAt, null);
  assert.equal(metrics(out, "pr_opened")[0].state, "unknown");
  const privateResult = normalizeGithubObservation(envelope({ repository: { id: 2, slug: "synthetic-owner/repository", visibility: "private" } }));
  assert.equal(privateResult.facts.length, 0);
  assert.deepEqual(privateResult.suppressArtifactIds, ["PR_synthetic_10"]);
  const hiddenPayload = normalizeGithubObservation(envelope({ payload: { repository: { ...fixture.repository, private: true }, pull_request: pr() } }));
  assert.equal(hiddenPayload.evidence.length, 0);
});

test("verified coauthors conserve the object and model trailers never create people or expose emails", () => {
  const parsed = parseDeclaredCoauthorTrailers("Co-authored-by: Verified Person\nCo-authored-by: Claude Opus 5.5\nCo-authored-by: Unknown Person", {
    verifiedPeople: [{ trailerName: "Verified Person", actor: fixture.reviewer, verificationReceipt: "synthetic-account-link" }],
    declaredModels: [{ trailerName: "Claude Opus 5.5", model: "Claude Opus", version: "5.5" }],
  });
  assert.equal(parsed.unresolvedCount, 1);
  assert.equal(parsed.coauthors.length, 1);
  const out = normalizeGithubObservation(envelope({ verifiedCoauthors: parsed.coauthors, assistance: parsed.assistance }));
  assert.equal(metrics(out, "pr_merged").length, 1);
  assert.equal(metrics(out, "pr_coauthored")[0].actorId, "303");
  assert.equal(new Set(out.participation.map(item => item.conservedUnit)).size, 1);
  assert.equal(out.assistance[0].model, "Claude Opus");
  assert.equal(out.actors.some(person => /Claude/.test(person.login ?? "")), false);
  assert.equal(JSON.stringify(out).includes("email"), false);
  const primaryOverlap = normalizeGithubObservation(envelope({ verifiedCoauthors: [
    { actor: fixture.author, verificationReceipt: "synthetic-primary-link" },
    { actor: fixture.reviewer, verificationReceipt: "synthetic-other-link" },
    { actor: fixture.reviewer, verificationReceipt: "synthetic-other-link" },
  ] }));
  assert.equal(metrics(primaryOverlap, "pr_coauthored").length, 1);
  assert.equal(primaryOverlap.participation.filter(item => item.actorId === "101").length, 1);
});

test("submitted COMMENTED review is raw feedback, distinct PR grouping excludes spam and dismissal is explicit", () => {
  const make = (reviewId, state = "COMMENTED") => normalizeGithubObservation(envelope({ family: "review", action: "submitted",
    reviewParticipation: { verified: true, firstSubmittedAt: at, roundFirstSubmittedAt: at },
    payload: { pull_request: pr(), review: { id: reviewId, node_id: `R_${reviewId}`, user: fixture.reviewer, state, submitted_at: at, created_at: at, commit_id: after } } }));
  const a = make(1), b = make(2, "APPROVED");
  assert.equal(metrics(a, "prs_reviewed")[0].artifactId, metrics(b, "prs_reviewed")[0].artifactId);
  assert.equal(new Set([...a.facts, ...b.facts].filter(item => item.metricId === "prs_reviewed").map(item => `${item.actorId}:${item.artifactId}`)).size, 1);
  assert.ok(a.facts.every(item => item.state === "observed"));
  const dismissed = make(1, "DISMISSED");
  assert.equal(dismissed.facts[0].state, "excluded");
  assert.equal(make(1, "PENDING").facts.length, 0);
});

test("current resolvedBy and draft snapshot do not fabricate historical transition/readiness", () => {
  const out = normalizeGithubObservation(envelope({ family: "thread_resolution", action: "snapshot", payload: { issue: issue(), resolvedBy: fixture.reviewer } }));
  assert.equal(out.facts.length, 0);
  assert.match(out.reasons.join(), /current_resolvedBy/);
  const resolution = normalizeGithubObservation(envelope({ family: "thread_resolution", action: "resolved_transition", payload: { issue: issue(), sender: fixture.reviewer } }));
  assert.equal(metrics(resolution, "review_threads_resolved")[0].actorId, "303");
  assert.equal(metrics(normalizeGithubObservation(envelope({ action: "snapshot" })), "pr_ready").length, 0);
  const wait = normalizeGithubObservation(envelope({ reviewCohort: { verified: true, firstReadyAt: null, firstSubmittedReviewAt: null } }));
  assert.equal(metrics(wait, "review_wait")[0].readyAt, null);
  assert.equal(metrics(wait, "review_wait")[0].firstReviewAt, null);
});

test("issue reporter, closer and implementing outcome never silently receive each other's credit", () => {
  const out = normalizeGithubObservation(envelope({ family: "issue", payload: { issue: issue(), sender: fixture.merger } }));
  assert.equal(metrics(out, "issues_opened")[0].actorId, "101");
  assert.equal(metrics(out, "issue_closure_stewardship")[0].actorId, "202");
  assert.equal(metrics(out, "issue_resolution").length, 0);
  assert.equal(metrics(out, "confirmed_bugs").length, 0);
  const comment = normalizeGithubObservation(envelope({ family: "comment", action: "created", payload: { id: 50, node_id: "IC_synthetic_50", user: fixture.reviewer,
    created_at: at, html_url: "https://github.com/synthetic-owner/repository/issues/20#issuecomment-50" } }));
  assert.equal(comment.facts[0].state, "pending");
  assert.equal(comment.evidence[0].artifact.kind, "other");
  assert.equal(comment.evidence[0].artifact.publicUrl, "https://github.com/synthetic-owner/repository/issues/20");
});

test("explicit revert lineage annotates original delivery without creating reverter merit or deleting history", () => {
  const input = envelope({ family: "revert", action: "reverted", lineage: [{ relation: "reverted_by", sourceIds: ["PR_synthetic_10"], targetId: "PR_synthetic_revert", evidenceIds: ["synthetic-revert-receipt"] }] });
  const out = normalizeGithubObservation(input);
  assert.equal(out.facts.length, 1);
  assert.equal(out.facts[0].metricId, "reverted_delivery");
  assert.equal(out.facts[0].actorId, "101");
  assert.equal(out.facts[0].state, "observed");
  assert.equal(normalizeGithubObservation({ ...input, lineage: [] }).facts.length, 0);
});

test("agent execution under a User preserves account kind without certifying manual execution", () => {
  const out = normalizeGithubObservation(envelope({ family: "triage", action: "labeled", payload: { issue: issue(), sender: fixture.merger,
    execution_mode: "automated", label: { id: 90 } } }));
  const sender = out.actors.find(actor => actor.id === "202");
  assert.equal(sender.kind, "user");
  assert.equal(sender.executionMode, "automated");
  assert.equal(metrics(out, "issue_resolution").length, 0);
  const removal = normalizeGithubObservation(envelope({ family: "triage", action: "unlabeled", payload: { issue: issue(), sender: fixture.merger, label: { id: 90 } } }));
  assert.equal(metrics(removal, "labels_applied").length, 0);
  assert.equal(metrics(removal, "items_triaged").length, 1);
  const unknownTarget = normalizeGithubObservation(envelope({ family: "triage", action: "labeled", payload: { issue: issue(), sender: fixture.merger } }));
  assert.equal(metrics(unknownTarget, "labels_applied")[0].state, "unknown");
});

test("recognition requires independently authorized receipt; COMMENTED feedback can qualify", () => {
  const raw = normalizeGithubObservation(envelope({ family: "review", action: "submitted", payload: { pull_request: pr(),
    review: { id: 1, user: fixture.reviewer, state: "COMMENTED", submitted_at: at, created_at: at, commit_id: after } } }));
  const target = metrics(raw, "review_feedback")[0];
  const receipt = { verified: true, id: "synthetic-acceptance", metricId: "review_feedback", actorId: "303", reviewerId: "202", acceptedAt: observedAt,
    decision: "accepted", targetFactId: target.id, evidenceIds: ["synthetic-accepted-review-outcome"] };
  const accepted = applyRecognitionReceipt(raw, receipt, ["202"]);
  assert.equal(metrics(accepted, "review_feedback").filter(item => item.state === "qualified").length, 1);
  assert.equal(metrics(accepted, "review_feedback").filter(item => item.state === "observed").length, 1);
  assert.throws(() => applyRecognitionReceipt(raw, { ...receipt, reviewerId: "303" }, ["303"]), /Independent/);
  assert.throws(() => applyRecognitionReceipt(raw, receipt, []), /Independent/);
  const rejected = applyRecognitionReceipt(raw, { ...receipt, decision: "rejected" }, ["202"]);
  assert.equal(rejected.facts.at(-1).state, "excluded");
});

test("four issue/Project event families remain distinct; current snapshots do not rank editors", () => {
  for (const [action, metric] of [["issue_field_changed", "issue_field_updates"], ["project_item_field_changed", "project_field_updates"],
    ["project_status_changed", "project_status_updates"], ["project_progress_published", "project_updates"]]) {
    const out = normalizeGithubObservation(envelope({ family: "field_change", action,
      payload: { issue: issue(), sender: fixture.merger, change: { before: "a", after: "b" } } }));
    assert.equal(out.facts.length, 1);
    assert.equal(out.facts[0].metricId, metric);
  }
  assert.equal(normalizeGithubObservation(envelope({ family: "project_snapshot", payload: { issue: issue(), sender: fixture.merger } })).facts.length, 0);
  assert.equal(normalizeGithubObservation(envelope({ family: "field_change", action: "unknown_subtype", payload: { issue: issue() } })).facts.length, 0);
});

test("label definition changes and milestone definitions do not multiply attached issue membership", () => {
  const metadata = { id: 90, node_id: "L_synthetic", html_url: "https://github.com/synthetic-owner/repository/labels/bug" };
  const taxonomy = normalizeGithubObservation(envelope({ family: "triage", action: "label_edited",
    payload: { label: metadata, sender: fixture.merger, change: { before: "bug", after: "defect" } } }));
  assert.equal(taxonomy.facts.length, 1);
  assert.equal(taxonomy.facts[0].metricId, "label_taxonomy");
  assert.equal(taxonomy.facts[0].artifactId, "L_synthetic");
  const membership = normalizeGithubObservation(envelope({ family: "triage", action: "labeled", payload: { issue: issue(), label: metadata, sender: fixture.merger } }));
  assert.equal(metrics(membership, "label_taxonomy").length, 0);
  assert.equal(metrics(membership, "labels_applied").length, 1);
  const secondLabel = normalizeGithubObservation(envelope({ family: "triage", action: "labeled", payload: { issue: issue(), label: { ...metadata, node_id: "L_synthetic_other" }, sender: fixture.merger } }));
  assert.notEqual(metrics(membership, "labels_applied")[0].id, metrics(secondLabel, "labels_applied")[0].id);
  const noop = normalizeGithubObservation(envelope({ family: "triage", action: "label_edited", payload: { label: metadata, change: { before: "bug", after: "bug" } } }));
  assert.equal(noop.facts.length, 0);
  const milestone = normalizeGithubObservation(envelope({ family: "triage", action: "milestone_closed", payload: { milestone: { ...metadata, node_id: "M_synthetic" }, sender: fixture.merger } }));
  assert.equal(metrics(milestone, "milestone_definitions").length, 1);
  assert.equal(metrics(milestone, "issue_resolution").length, 0);
});

test("triage duplicate receipts, toggles, no-op metadata and scripted batches do not create qualified outcomes", () => {
  const event = (id, minute, before, after) => ({ id, artifactId: "issue:1", actorId: "404", facet: "label", targetId: "label:bug",
    occurredAt: `2026-10-07T10:${String(minute).padStart(2, "0")}:00Z`, before, after });
  const events = [event("a", 0, "absent", "present"), event("b", 1, "present", "absent"), event("c", 20, "absent", "present"), event("d", 21, "present", "absent")];
  const grouped = groupTriageTransitions([...events, events[0]], { version: "synthetic/v1", intervalSeconds: 300, cooldownSeconds: 3600 });
  assert.equal(grouped.rawActions, 4);
  assert.equal(grouped.sessions.length, 2);
  assert.ok(grouped.sessions.every(session => session.reversalSuppressed && !session.qualifiedCandidate));
  assert.equal(grouped.sessions.filter(session => session.repeatedStateSuppressed).length, 1);
  assert.equal(grouped.qualifiedOutcomes, 0);
  const burst = Array.from({ length: 100 }, (_, index) => ({ ...events[0], id: `synthetic-batch-${index}`, artifactId: `synthetic-issue-${index}` }));
  assert.equal(groupTriageTransitions(burst, { version: "synthetic/v1", intervalSeconds: 300, cooldownSeconds: 3600 }).qualifiedOutcomes, 0);
});

test("relationship endpoint copies conserve one link and never reinterpret related links as blockers", () => {
  const payload = { issue: issue(), sender: fixture.merger, relationship: { kind: "related", from: "issue:a", to: "issue:b", intentional: true, publicEndpointsVerified: true } };
  const a = normalizeGithubObservation(envelope({ family: "relationship", action: "added", payload }));
  const b = normalizeGithubObservation(envelope({ family: "relationship", action: "added", payload: { ...payload, relationship: { ...payload.relationship, from: "issue:b", to: "issue:a" } } }));
  assert.equal(a.facts[0].id, b.facts[0].id);
  assert.equal(a.facts[0].metricId, "related_links");
  assert.equal(metrics(a, "blocker_links").length, 0);
  const automatic = normalizeGithubObservation(envelope({ family: "relationship", action: "cross_referenced", payload: { ...payload, relationship: { ...payload.relationship, intentional: false } } }));
  assert.equal(automatic.facts.length, 0);
  const restricted = normalizeGithubObservation(envelope({ family: "relationship", action: "added", payload: { ...payload, relationship: { ...payload.relationship, publicEndpointsVerified: false } } }));
  assert.equal(restricted.facts.length, 0);
  assert.match(restricted.reasons.join(), /visibility_unverified/);
});

test("transfer lineage preserves original object and suppresses private/unapproved destinations", () => {
  const destination = { repositoryId: 3, stableId: "I_synthetic_20", slug: "synthetic-owner/other", url: "https://github.com/synthetic-owner/other/issues/55", visibility: "public", allowed: true };
  const a = normalizeGithubObservation(envelope({ family: "relationship", action: "transferred", payload: { issue: issue(), sender: fixture.merger, destination } }));
  assert.equal(a.lineage[0].relation, "transferred_to");
  assert.equal(a.facts[0].metricId, "issue_transfers");
  assert.equal(metrics(a, "issues_opened").length, 0);
  const hidden = normalizeGithubObservation(envelope({ family: "relationship", action: "transferred", payload: { issue: issue(), sender: fixture.merger, destination: { ...destination, visibility: "private" } } }));
  assert.equal(hidden.facts.length, 0);
  assert.deepEqual(hidden.suppressArtifactIds, ["I_synthetic_20"]);
});

test("physical line classes exclude vendor/generated/locks/binary/imports and disclose net separately", () => {
  const out = classifyPhysicalDiff({ before, after, complete: true, files: [
    { path: "src/main.ts", additions: 10, deletions: 4 }, { path: "tests/main.test.ts", additions: 3, deletions: 0 }, { path: "docs/readme.md", additions: 2, deletions: 1 },
    ...["vendor/lib.js", "dist/out.js", "package-lock.json"].map(path => ({ path, additions: 1000, deletions: 1000 })),
    { path: "image.png", additions: 0, deletions: 0, binary: true }, { path: "src/import.ts", additions: 500, deletions: 0, imported: true },
    { path: "src/formatted.ts", additions: 10, deletions: 10, formattingOnly: true },
  ] });
  assert.equal(out.additions, 15); assert.equal(out.deletions, 5); assert.equal(out.changed, 20); assert.equal(out.net, 10); assert.equal(out.filesChanged, 3);
  assert.equal(classifyPhysicalDiff({ before, after, complete: false, files: [] }).changed, null);
  assert.throws(() => classifyPhysicalDiff({ before, after, complete: true, files: [{ path: "../secret", additions: 1, deletions: 0 }] }), /Unsafe/);
  for (const length of [41, 42, 63]) assert.throws(() => classifyPhysicalDiff({ before: "a".repeat(length), after, complete: true, files: [] }), /pinned/);
  assert.throws(() => classifyPhysicalDiff({ before, after, complete: true, files: [{ path: "src/main.ts", additions: Number.MAX_SAFE_INTEGER, deletions: 1 }] }), /safe integer/);
});

test("stacked branch merges keep PR participation while delivered LOC appears once at pinned default integration", () => {
  const baseIntegration = { before, after, canonicalChangeId: "synthetic-logical-stack", defaultBranch: "main", targetBranch: "research", commitShas: [after],
    diff: { before, after, complete: true, files: [{ path: "src/change.ts", additions: 10, deletions: 2 }] } };
  const intermediate = normalizeGithubObservation(envelope({ integration: baseIntegration }));
  assert.equal(metrics(intermediate, "pr_merged").length, 1);
  assert.equal(metrics(intermediate, "pr_lines_changed").length, 0);
  const integrated = normalizeGithubObservation(envelope({ integration: { ...baseIntegration, targetBranch: "main" } }));
  assert.equal(metrics(integrated, "pr_lines_changed")[0].quantity, 12);
  const sameIntegration = normalizeGithubObservation(envelope({ action: "reopened", integration: { ...baseIntegration, targetBranch: "main" } }));
  assert.equal(metrics(integrated, "pr_lines_changed")[0].id, metrics(sameIntegration, "pr_lines_changed")[0].id);
  assert.equal(metrics(normalizeGithubObservation(envelope({ integration: { ...baseIntegration, targetBranch: "main", diff: { ...baseIntegration.diff, complete: false } } })), "pr_lines_changed").length, 0);
  assert.equal(metrics(integrated, "net_lines").length, 0);
});

test("commit author/committer and verified lineage stay separate and integration is mandatory", () => {
  const payload = { sha: after, html_url: `https://github.com/synthetic-owner/repository/commit/${after}`, author: fixture.author, committer: fixture.merger,
    commit: { message: "source text is not identity" } };
  const noIntegration = normalizeGithubObservation(envelope({ family: "commit", payload }));
  assert.equal(noIntegration.facts.length, 0);
  assert.deepEqual(noIntegration.participation.map(item => item.role), ["author", "committer"]);
  const integrated = normalizeGithubObservation(envelope({ family: "commit", payload, integration: { before, after, canonicalChangeId: "one-change", targetBranch: "main", defaultBranch: "main", commitShas: [after] },
    verifiedCoauthors: [{ actor: fixture.author, verificationReceipt: "synthetic-primary-link" },
      { actor: fixture.reviewer, verificationReceipt: "synthetic-account-link" }, { actor: fixture.reviewer, verificationReceipt: "synthetic-account-link" }],
    lineage: [{ relation: "squash_of", sourceIds: ["original:a", "original:b"], targetId: after, evidenceIds: ["verified-pr-merge"] }] }));
  assert.equal(integrated.facts[0].actorId, "101");
  assert.equal(integrated.lineage[0].relation, "squash_of");
  assert.equal(integrated.participation.find(item => item.role === "coauthor").actorId, "303");
  assert.equal(integrated.participation.filter(item => item.role === "coauthor").length, 1);
});

test("release publication keeps automation sender separate from notes author; green CI is unsupported", () => {
  const release = { id: 60, node_id: "RE_synthetic", html_url: "https://github.com/synthetic-owner/repository/releases/tag/v1", author: fixture.author, draft: false, published_at: at };
  const out = normalizeGithubObservation(envelope({ family: "release", action: "published", payload: { release, sender: fixture.bot } }));
  assert.equal(out.facts[0].actorId, "404");
  assert.equal(out.facts[0].role, "automation");
  assert.equal(metrics(out, "maintenance").length, 0);
  assert.equal(metrics(out, "deployment_work").length, 0);
});

test("subjective maintenance, deployment, reliability and coordination stay receipt-based with accepted/rejected cases", () => {
  const raw = normalizeGithubObservation(envelope());
  const target = metrics(raw, "pr_merged")[0];
  for (const metricId of ["maintenance", "automation", "deployment_work", "incidents", "issue_resolution", "reproductions", "mentorship", "onboarding", "project_configuration", "issue_ordering"]) {
    for (const decision of ["accepted", "rejected"]) {
      const receipt = { verified: true, id: `synthetic-receipt-${metricId}-${decision}`, metricId, actorId: "101", reviewerId: "202", acceptedAt: observedAt,
        decision, targetFactId: target.id, evidenceIds: [`synthetic-evidence-${metricId}`], changesetId: `synthetic-changeset-${metricId}` };
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
  const client = new GithubReadClient({ apiOrigin: "https://api.synthetic.invalid", token: async () => undefined,
    checkpoints: { load: async key => memory.get(key), save: async (key, value) => { memory.set(key, structuredClone(value)); } },
    fetch: async url => { calls.push(url); return new Response(JSON.stringify(url.endsWith("/issues/20") ? issue() : fixture.repository)); },
  });
  const normalize = createGithubEvidenceNormalizer({ client, source: "synthetic-source", allowedRepositoryIds: [2], isSynthetic: true });
  const input = { repository: { id: 2, slug: "synthetic-owner/repository" }, family: "issues", factKey: "source-20", observedAt,
    policyVersion: "synthetic-policy/v1", fact: { subjectId: "20", sourceRevision: at, sourceUrl: fixture.issue.html_url,
      evidence: "current_state", actorId: null, occurredAt: null, state: "closed" } };
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
  const privateClient = new GithubReadClient({ apiOrigin: "https://api.synthetic.invalid", token: async () => undefined,
    checkpoints: { load: async () => undefined, save: async () => {} },
    fetch: async url => new Response(JSON.stringify(url.endsWith("/issues/20") ? issue() : { ...fixture.repository, private: true })),
  });
  const privateNormalize = createGithubEvidenceNormalizer({ client: privateClient, source: "synthetic-source", allowedRepositoryIds: [2], isSynthetic: true });
  const revoked = await privateNormalize(input);
  assert.equal(revoked.facts.length, 0);
  assert.deepEqual(revoked.suppressArtifactIds, ["I_synthetic_20"]);
});

test("bounded local Git fallback reads pinned changes including rename and excludes formatting-only churn", async t => {
  const directory = await mkdtemp(join(tmpdir(), "github-diff-test-"));
  t.after(async () => { assert.equal(dirname(resolve(directory)), resolve(tmpdir())); assert.match(basename(directory), /^github-diff-test-/); await rm(directory, { recursive: true, force: true }); });
  const git = args => execFileSync("git", ["-C", directory, "-c", "core.hooksPath=", "-c", "commit.gpgsign=false", "-c", "user.name=synthetic-fixture", "-c", "user.email=fixture.invalid", ...args], { encoding: "utf8", windowsHide: true }).trim();
  git(["init", "--quiet"]);
  await mkdir(join(directory, "src"));
  await writeFile(join(directory, "src", "main.ts"), "const value = 1;\n");
  await writeFile(join(directory, "src", "rename.ts"), "export const original = true;\n");
  git(["add", "."]); git(["commit", "--quiet", "-m", "synthetic baseline"]); const first = git(["rev-parse", "HEAD"]);
  await writeFile(join(directory, "src", "main.ts"), "const    value   =  1;\n");
  await rename(join(directory, "src", "rename.ts"), join(directory, "src", "renamed.ts"));
  git(["add", "."]); git(["commit", "--quiet", "-m", "synthetic formatting and rename"]); const second = git(["rev-parse", "HEAD"]);
  const diff = await readPinnedGitDiff({ repositoryPath: directory, before: first, after: second });
  assert.equal(diff.complete, true);
  assert.equal(diff.files.find(file => file.path === "src/main.ts").formattingOnly, true);
  assert.equal(diff.files.find(file => file.path === "src/renamed.ts").previousPath, "src/rename.ts");
  assert.equal(classifyPhysicalDiff(diff).changed, 0);
  assert.equal((await readPinnedGitDiff({ repositoryPath: directory, before: first, after: second, maxFiles: 1 })).complete, false);
  await assert.rejects(readPinnedGitDiff({ repositoryPath: directory, before: "--untrusted", after: second }), /Pinned/);
});

test("registry clocks conserve first readiness and merged coauthor participation rather than toggles", () => {
  const firstReadyAt = "2026-10-02T10:00:00Z";
  const first = normalizeGithubObservation(envelope({ action: "ready_for_review", occurredAt: firstReadyAt,
    reviewCohort: { verified: true, firstReadyAt, firstSubmittedReviewAt: null } }));
  const toggle = normalizeGithubObservation(envelope({ action: "ready_for_review", occurredAt: at,
    reviewCohort: { verified: true, firstReadyAt, firstSubmittedReviewAt: null } }));
  assert.equal(metrics(first, "pr_ready")[0].id, metrics(toggle, "pr_ready")[0].id);
  assert.equal(metrics(toggle, "pr_ready")[0].occurredAt, "2026-10-02T10:00:00.000Z");
  assert.equal(metrics(normalizeGithubObservation(envelope({ action: "ready_for_review" })), "pr_ready").length, 0);
  const unmerged = pr(); unmerged.merged = false; unmerged.merged_at = null; unmerged.closed_at = null; unmerged.state = "open";
  const pending = normalizeGithubObservation(envelope({ payload: { pull_request: unmerged },
    verifiedCoauthors: [{ actor: fixture.reviewer, verificationReceipt: "synthetic-verified-link" }] }));
  assert.equal(metrics(pending, "pr_coauthored")[0].state, "pending");
  assert.equal(metrics(pending, "pr_coauthored")[0].occurredAt, null);
});

test("review participation excludes self/bots and rounds conserve reviewer/PR/head with first-submission clocks", () => {
  const input = envelope({ family: "review", action: "submitted",
    reviewParticipation: { verified: true, firstSubmittedAt: at, roundFirstSubmittedAt: at },
    payload: { pull_request: pr(), review: { id: 91, user: fixture.reviewer, state: "APPROVED", submitted_at: at, created_at: at, commit_id: after } } });
  const a = normalizeGithubObservation(input);
  const repeated = normalizeGithubObservation({ ...input, payload: { ...input.payload, review: { ...input.payload.review, id: 92, submitted_at: observedAt, state: "CHANGES_REQUESTED" } } });
  assert.equal(metrics(a, "review_rounds")[0].id, metrics(repeated, "review_rounds")[0].id);
  assert.equal(metrics(a, "review_rounds")[0].occurredAt, metrics(repeated, "review_rounds")[0].occurredAt);
  assert.equal(metrics(a, "prs_reviewed")[0].id, metrics(repeated, "prs_reviewed")[0].id);
  for (const user of [fixture.author, fixture.bot]) {
    const out = normalizeGithubObservation({ ...input, payload: { ...input.payload, review: { ...input.payload.review, user } } });
    assert.equal(metrics(out, "prs_reviewed").length, 0);
  }
  const missingHead = normalizeGithubObservation({ ...input, payload: { ...input.payload, review: { ...input.payload.review, commit_id: null } } });
  assert.equal(metrics(missingHead, "review_rounds").length, 0);
  assert.equal(metrics(normalizeGithubObservation({ ...input, reviewParticipation: undefined }), "prs_reviewed").length, 0);
});

test("files_changed emits one canonical count unit per eligible path, never a quantity pretending to be count", () => {
  const out = normalizeGithubObservation(envelope({ integration: { before, after, canonicalChangeId: "synthetic-many-files", targetBranch: "main", defaultBranch: "main", commitShas: [after],
    diff: { before, after, complete: true, files: [{ path: "src/a.ts", additions: 2, deletions: 1 }, { path: "src/b.ts", additions: 3, deletions: 1 }, { path: "vendor/x.ts", additions: 100, deletions: 1 }] } } }));
  const files = metrics(out, "files_changed");
  assert.equal(files.length, 2);
  assert.equal(new Set(files.map(fact => fact.canonicalKey)).size, 2);
  assert.ok(files.every(fact => fact.quantity === undefined));
});

test("pending, unknown and observed facts retain independent canonical evidence classes through merge", () => {
  const unmerged = pr(); unmerged.merged = false; unmerged.merged_at = null; unmerged.closed_at = null; unmerged.state = "open";
  const coauthors = [{ actor: fixture.reviewer, verificationReceipt: "synthetic-link" }];
  const pending = normalizeGithubObservation(envelope({ payload: { pull_request: unmerged }, verifiedCoauthors: coauthors,
    decisionCohort: { verified: true, asOf: observedAt, outcome: "pending", decisionAt: null } }));
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
  assert.equal(metrics(normalizeGithubObservation(envelope({ frozenCutoff: "2026-10-06T10:00:00Z" })), "pr_accepted_rate").length, 0);
});
