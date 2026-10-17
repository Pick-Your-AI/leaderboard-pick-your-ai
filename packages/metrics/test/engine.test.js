import assert from "node:assert/strict";
import test from "node:test";
import {
  aggregateMetric, comparePolicies, compareRankMovement, getMetricDefinition,
  participationView, planPolicyRelease, resolveMetricWindow, stableJSON, validateMetricPolicy,
} from "../dist/index.js";

const from = "2026-10-01T00:00:00Z", to = "2026-11-01T00:00:00Z";
const scope = (patch = {}) => ({ timezone: "UTC", from, to, repos: [], projects: [], workstreams: [], roles: [], actors: "user", context: "event", ...patch });
const policy = (patch = {}) => {
  const metricId = patch.metricId ?? "pr_merged";
  return { metricId, version: "synthetic-policy/v1", definitionVersion: "synthetic-definition/v1", unit: getMetricDefinition(metricId)?.definition.unit ?? "unknown", aggregation: "count", dateBasis: "acceptedAt", rankedStates: ["qualified"], roles: ["author"], groupBy: "actor_artifact", sources: ["github_rest"], minimumSamples: 1, rank: true, ...patch };
};
const actor = (id, patch = {}) => ({ id, login: `synthetic-${id}`, kind: "user", publicState: "visible", ...patch });
const fact = (id, patch = {}) => ({ id, canonicalKey: `synthetic-action-${id}`, metricId: "pr_merged", actorId: "a", artifactId: `synthetic-artifact-${id}`, repoId: "synthetic-repo", role: "author", state: "qualified", occurredAt: "2026-10-04T10:00:00Z", acceptedAt: "2026-10-05T10:00:00Z", observedAt: "2026-10-06T10:00:00Z", revision: 0, correctionReceipt: null, acceptanceReceipt: "synthetic-acceptance", acceptedBy: "synthetic-independent-reviewer", subjectActorId: "a", eventContext: { projects: ["p1", "p2"], workstreams: ["w1"] }, currentContext: { projects: ["p3"], workstreams: ["w2"] }, ...patch });
const coverage = (patch = {}) => ({ schemaVersion: "leaderboard/v1", state: "complete", source: "github_rest", scopeId: "synthetic-repo", windowStart: "2026-01-01T00:00:00Z", windowEnd: to, knownStart: "2026-01-01T00:00:00Z", lastSuccessfulSync: to, sourceWatermark: to, missingPages: 0, permissionsMissing: [], sourceErrors: [], ...patch });
const input = (facts = [], patch = {}) => ({ datasetId: "synthetic-frozen-dataset", cutoff: to, backfillRevision: "synthetic-backfill-1", repositoryIds: ["synthetic-repo"], actors: [actor("a"), actor("b"), actor("c")], facts, coverage: [coverage()], ...patch });
const board = (facts, policyPatch = {}, scopePatch = {}, inputPatch = {}) => aggregateMetric(input(facts, inputPatch), policy(policyPatch), scope(scopePatch));

test("accepted counts reconcile to evidence while pending stays outside dense ranks", () => {
  const facts = Array.from({ length: 14 }, (_, n) => fact(`accepted-${n}`));
  facts.push(...Array.from({ length: 3 }, (_, n) => fact(`pending-${n}`, { state: "pending", acceptedAt: null })));
  const result = board(facts);
  assert.equal(result.rows[0].value, 14);
  assert.equal(result.rows[0].evidenceIds.length, 14);
  assert.equal(result.rows[0].pending, 3);
  assert.equal(result.publicEnabled, false);
  assert.equal(result.policyVersion, "synthetic-policy/v1");
  assert.equal("totalScore" in result, false);
});

test("adapter duplicates and overlapping Project selections count an action once", () => {
  const a = fact("a"); const duplicate = { ...a, id: "second-adapter", observedAt: "2026-10-07T10:00:00Z" };
  const result = board([duplicate, a], {}, { projects: ["p1", "p2", "p1"] });
  assert.equal(result.rows[0].value, 1);
  assert.equal(result.audit[0].reason, "duplicate_observation");
  assert.deepEqual(result.scope.projects, ["p1", "p2"]);
});

test("conflicting canonical actors and unkeyed records remain ambiguous, never invented", () => {
  const a = fact("a");
  const result = board([a, { ...a, id: "conflict", actorId: "b" }, fact("unkeyed", { canonicalKey: null })]);
  assert.equal(result.rows.length, 0);
  assert.deepEqual(result.audit.map(item => item.reason).sort(), ["ambiguous_canonical_action", "unknown_canonical_identity"]);
  assert.equal(result.coverage, "incomplete");
});

test("reviewed correction revisions reverse counts and replay historical cutoffs", () => {
  const original = fact("a");
  const correction = { ...original, revision: 1, state: "excluded", correctionReceipt: "synthetic-reviewed-correction", observedAt: "2026-10-20T10:00:00Z" };
  assert.equal(board([original, correction]).rows.length, 0);
  const before = board([correction, original], {}, { to: "2026-10-15T00:00:00Z" }, { cutoff: "2026-10-15T00:00:00Z" });
  assert.equal(before.rows[0].value, 1);
  assert.equal(original.state, "qualified");
});

test("unreviewed and conflicting revisions cannot silently overwrite evidence", () => {
  const original = fact("a");
  const unreviewed = { ...original, revision: 2, state: "excluded" };
  assert.equal(board([original, unreviewed]).rows[0].state, "partial");
  assert.equal(board([original, { ...original, actorId: "b" }]).rows.length, 0);
});

test("qualification and self-approval need independent acceptance evidence", () => {
  const result = board([fact("a", { acceptedBy: "a" }), fact("b", { acceptanceReceipt: null }), fact("c", { acceptedBy: null })]);
  assert.equal(result.rows.length, 0);
  assert.equal(result.audit.length, 3);
  const selfReview = board([fact("r", { role: "reviewer", subjectActorId: "a" })], { roles: ["reviewer"] });
  assert.equal(selfReview.rows.length, 0);
});

test("suppression, unknown actors, automation and roles preserve identity boundaries", () => {
  const facts = [fact("user"), fact("bot", { actorId: "b", role: "automation" }), fact("hidden", { actorId: "c" }), fact("unknown", { actorId: null })];
  const actors = [actor("a"), actor("b", { kind: "bot" }), actor("c", { publicState: "suppressed" })];
  assert.deepEqual(board(facts, { roles: ["author", "automation"] }, {}, { actors }).rows.map(row => row.actorId), ["a"]);
  assert.deepEqual(board(facts, { roles: ["author", "automation"] }, { actors: "automation" }, { actors }).rows.map(row => row.actorId), ["b"]);
  assert.equal(board([fact("a", { actorId: "unresolved" })]).rows.length, 0);
});

test("deleted actors retain neutral IDs while renamed logins preserve historical credit", () => {
  assert.equal(board([fact("a")], {}, {}, { actors: [actor("a", { login: "synthetic-renamed" })] }).rows[0].actorId, "a");
  assert.equal(board([fact("a")], {}, {}, { actors: [actor("a", { publicState: "deleted" })] }).rows[0].login, null);
});

test("half-open event and acceptance clocks include each boundary exactly once", () => {
  const facts = [fact("start", { acceptedAt: from }), fact("end", { acceptedAt: to }), fact("old", { acceptedAt: "2026-09-30T23:59:59Z" }), fact("missing", { acceptedAt: null })];
  const result = board(facts);
  assert.equal(result.rows[0].value, 1);
  assert.deepEqual(result.rows[0].evidenceIds, ["start"]);
  assert.equal(result.rows[0].state, "partial");
  assert.equal(board([fact("by-event", { acceptedAt: from, occurredAt: "2026-09-01T00:00:00Z" })], { dateBasis: "occurredAt" }).rows.length, 0);
});

test("rolling, calendar and custom UTC windows are exact across DST transitions", () => {
  const cutoff = "2026-11-02T12:00:00Z";
  assert.equal(resolveMetricWindow(undefined, cutoff).from, "2026-10-03T12:00:00.000Z");
  assert.equal(resolveMetricWindow("7d", cutoff).from, "2026-10-26T12:00:00.000Z");
  assert.equal(resolveMetricWindow("90d", cutoff).from, "2026-08-04T12:00:00.000Z");
  assert.equal(resolveMetricWindow("quarter", cutoff).from, "2026-10-01T00:00:00.000Z");
  assert.equal(resolveMetricWindow("month", cutoff).from, "2026-11-01T00:00:00.000Z");
  assert.equal(resolveMetricWindow("year", cutoff).from, "2026-01-01T00:00:00.000Z");
  assert.equal(resolveMetricWindow("all", cutoff).from, null);
  assert.throws(() => resolveMetricWindow("custom", cutoff, { from: "2026-11-01T00:00:00-04:00", to: cutoff }), /UTC/);
  assert.throws(() => resolveMetricWindow("custom", cutoff, { from: to, to: from }));
  assert.throws(() => resolveMetricWindow("month", "2026-02-30T00:00:00Z"));
});

test("historic Project/workstream context remains distinct from present membership", () => {
  assert.equal(board([fact("a")], {}, { projects: ["p3"], context: "event" }).rows.length, 0);
  assert.equal(board([fact("a")], {}, { projects: ["p3"], context: "current" }).rows[0].value, 1);
  assert.equal(board([fact("a", { eventContext: null })], {}, { workstreams: ["w1"] }).audit[0].reason, "unknown_membership_context");
  assert.equal(board([fact("a")], {}, { projects: ["p1"], workstreams: ["w2"] }).rows.length, 0);
});

test("sum metrics reconcile eligible quantities, preserve unknowns and reject invalid values", () => {
  const metricId = "pr_lines_changed", p = { metricId, aggregation: "sum" };
  const result = board([fact("a", { metricId, quantity: 5 }), fact("b", { metricId, quantity: 9 })], p);
  assert.equal(result.rows[0].value, 14);
  assert.equal(result.unit, "eligible text lines changed");
  assert.equal(board([fact("a", { metricId })], p).rows[0].value, null);
  assert.throws(() => board([fact("a", { metricId, quantity: NaN })], p));
  assert.throws(() => board([fact("a", { metricId, quantity: -1 })], p));
});

test("zero requires complete source coverage throughout the selected window", () => {
  const f = fact("zero", { metricId: "pr_lines_changed", quantity: 0 });
  const p = { metricId: "pr_lines_changed", aggregation: "sum" };
  assert.equal(board([f], p).rows[0].state, "zero");
  for (const c of [coverage({ state: "unknown" }), coverage({ windowEnd: "2026-10-15T00:00:00Z" }), coverage({ knownStart: "2026-10-15T00:00:00Z" }), coverage({ missingPages: 1 })]) {
    assert.equal(board([f], p, {}, { coverage: [c] }).rows[0].value, null);
  }
  assert.equal(board([f], p, { from: null }).rows[0].value, null);
  assert.equal(board([f], p, { repos: ["synthetic-repo", "missing-repo"] }).coverage, "incomplete");
});

test("dense ties and codepoint ordering do not confer superior alphabetical rank", () => {
  const result = board([fact("a"), fact("b", { actorId: "b" }), fact("c", { actorId: "c" }), fact("d", { actorId: "c" })]);
  assert.deepEqual(result.rows.map(row => [row.actorId, row.value, row.rank, row.tied]), [["c", 2, 1, false], ["a", 1, 2, true], ["b", 1, 2, true]]);
});

test("review spam and repeated raw-state intervals follow the explicit aggregation policy", () => {
  const sameArtifact = [fact("a", { artifactId: "one" }), fact("b", { artifactId: "one" })];
  assert.equal(board(sameArtifact).rows[0].value, 1);
  const p = { metricId: "labels_applied", dateBasis: "occurredAt", rankedStates: ["observed"], roles: ["triager"], groupBy: "actor_artifact_state_interval", groupingSeconds: 3600 };
  const f = fact("label", { metricId: "labels_applied", role: "triager", state: "observed", rawState: "label:bug:applied", artifactId: "one" });
  assert.equal(board([f, { ...f, id: "toggle", canonicalKey: "toggle", occurredAt: "2026-10-04T10:30:00Z" }], p).rows[0].value, 1);
  assert.equal(board([f, { ...f, id: "next", canonicalKey: "next", occurredAt: "2026-10-04T11:30:00Z" }], p).rows[0].value, 2);
  assert.throws(() => board([f], { ...p, groupingSeconds: undefined }));
});

test("decided-in-window ratios disclose numerator, denominator, pending and minimum sample", () => {
  const metricId = "pr_accepted_rate";
  const p = { metricId, aggregation: "ratio", rank: false, minimumSamples: 2 };
  const result = board([fact("m", { metricId, outcome: "merged" }), fact("c", { metricId, outcome: "closed_unmerged" }), fact("pending", { metricId, state: "pending", acceptedAt: null, outcome: "pending" })], p);
  const row = result.rows[0];
  assert.equal(row.value, 0.5); assert.equal(row.numerator, 1); assert.equal(row.denominator, 2); assert.equal(row.pending, 1); assert.equal(row.rank, null);
  assert.equal(board([fact("m", { metricId, outcome: "merged" })], p).rows[0].state, "insufficient_sample");
  assert.throws(() => board([], { ...p, rank: true }), /Descriptive/);
  assert.throws(() => board([], { ...p, dateBasis: "occurredAt" }), /decision time/);
});

test("review wait reports distribution, missing readiness and unresolved censoring without ranks", () => {
  const metricId = "review_wait", p = { metricId, aggregation: "duration", rank: false };
  const f = (id, patch = {}) => fact(id, { metricId, readyAt: "2026-10-05T10:00:00Z", firstReviewAt: "2026-10-05T12:00:00Z", ...patch });
  const row = board([f("a"), f("b", { firstReviewAt: "2026-10-05T14:00:00Z" }), f("c", { firstReviewAt: null }), f("d", { readyAt: null }), f("future", { firstReviewAt: "2026-11-02T10:00:00Z" })], p).rows[0];
  assert.deepEqual(row.samples, [2, 4]); assert.equal(row.value, 3); assert.equal(row.p75, 4); assert.equal(row.sampleCount, 2); assert.equal(row.censored, 2); assert.equal(row.missingReadiness, 1); assert.equal(row.rank, null);
});

test("rank movement compares explicit compatible periods and refuses mixed policy, gaps and backfill", () => {
  const oldScope = { ...resolveMetricWindow("30d", to) };
  const nextCutoff = "2026-11-02T00:00:00Z";
  const nextScope = { ...resolveMetricWindow("30d", nextCutoff) };
  const oldFacts = [fact("a"), fact("b", { actorId: "b" })];
  const newFact = fact("c", { actorId: "b", acceptedAt: "2026-11-01T12:00:00Z", observedAt: "2026-11-01T12:01:00Z" });
  const before = board(oldFacts, {}, oldScope);
  const after = board([...oldFacts, newFact], {}, nextScope, { cutoff: nextCutoff, coverage: [coverage({ windowEnd: nextCutoff })] });
  assert.equal(compareRankMovement(before, after).find(row => row.actorId === "b").delta, 0);
  assert.equal(compareRankMovement(before, after).find(row => row.actorId === "a").delta, -1);
  for (const [patch, expected] of [[{ policyVersion: "v2" }, "mixed_policy_versions"], [{ backfillRevision: "backfill-2" }, "backfill_or_reconciliation"], [{ coverage: "incomplete" }, "insufficient_history"], [{ scope: scope({ from: "2026-09-01T00:00:00Z" }) }, "different_scope_or_window"]]) assert.equal(compareRankMovement(before, { ...after, ...patch })[0].reason, expected);
  const entrant = board([...oldFacts, { ...newFact, actorId: "c" }], {}, nextScope, { cutoff: nextCutoff, coverage: [coverage({ windowEnd: nextCutoff })] });
  assert.equal(compareRankMovement(before, entrant).find(row => row.actorId === "c").state, "new_entrant");
  const late = board([...oldFacts, fact("late", { actorId: "b" })], {}, nextScope, { cutoff: nextCutoff, coverage: [coverage({ windowEnd: nextCutoff })] });
  assert.equal(compareRankMovement(before, late)[0].reason, "late_history");
});

test("replay and recalculation are deterministic, reversible, and disclose inclusion changes", () => {
  const facts = [fact("a", { artifactId: "one" }), fact("b", { artifactId: "one" })];
  const frozen = input(facts), original = stableJSON(frozen);
  const oldPolicy = policy({ groupBy: "canonical" }), nextPolicy = policy({ version: "synthetic-policy/v2" });
  assert.equal(stableJSON(aggregateMetric(frozen, oldPolicy, scope())), stableJSON(aggregateMetric(input([...facts].reverse()), oldPolicy, scope())));
  const change = comparePolicies(frozen, oldPolicy, nextPolicy, scope());
  assert.equal(change.changes[0].beforeValue, 2); assert.equal(change.changes[0].afterValue, 1); assert.deepEqual(change.changes[0].excluded, ["b"]); assert.equal(change.approvalRequired, true);
  const rollback = comparePolicies(frozen, nextPolicy, oldPolicy, scope());
  assert.equal(rollback.changes[0].afterValue, 2);
  assert.equal(stableJSON(frozen), original);
});

test("newcomers remain unknown with incomplete organization history; active weeks show denominator", () => {
  const facts = [fact("a"), fact("b", { acceptedAt: "2026-10-20T10:00:00Z" })];
  const results = participationView(input(facts), policy(), scope());
  assert.equal(results[0].newcomer, null); assert.equal(results[0].historyCoverage, "incomplete"); assert.equal(results[0].activeWeeks.length, 2); assert.equal(results[0].denominatorWeeks, 5); assert.equal(results[0].ranked, false);
  const known = participationView(input(facts), policy(), scope(), { originAt: "2026-01-01T00:00:00Z", reviewReceipt: "synthetic-history-review" });
  assert.equal(known[0].newcomer, true);
  const older = fact("old", { occurredAt: "2026-02-01T10:00:00Z", acceptedAt: "2026-02-02T10:00:00Z", observedAt: "2026-02-03T10:00:00Z" });
  assert.equal(participationView(input([older, ...facts]), policy(), scope(), { originAt: "2026-01-01T00:00:00Z", reviewReceipt: "synthetic-history-review" })[0].newcomer, false);
});

test("malformed policies, times, cutoffs and identities fail closed", () => {
  assert.throws(() => validateMetricPolicy(policy({ metricId: "universal_score" })), /Unknown metric/);
  assert.throws(() => validateMetricPolicy(policy({ unit: "points" })), /Unit/);
  assert.throws(() => board([], { version: "" }));
  assert.throws(() => board([], { minimumSamples: 0 }));
  assert.throws(() => board([], {}, { timezone: "America/New_York" }));
  assert.throws(() => board([], {}, { to: "2026-12-01T00:00:00Z" }));
  assert.throws(() => board([fact("a", { occurredAt: "2026-02-30T00:00:00Z" })]));
  assert.throws(() => board([], {}, {}, { actors: [actor("a"), actor("a")] }));
});


test("late observed historic work cannot manufacture a newcomer", () => {
  const old = fact("historic", { acceptedAt: "2026-02-01T10:00:00Z", observedAt: "2026-10-10T10:00:00Z" });
  const result = participationView(input([old, fact("current")]), policy(), scope(), { originAt: "2026-01-01T00:00:00Z", reviewReceipt: "synthetic-review" });
  assert.equal(result[0].newcomer, false);
  assert.equal(result[0].firstContributionId, "historic");
});

test("review-wait cohorts use readiness time but observe reviews through the frozen cutoff", () => {
  const metricId = "review_wait", cutoff = "2026-11-04T00:00:00Z";
  const f = fact("late-review", { metricId, readyAt: "2026-10-31T12:00:00Z", firstReviewAt: "2026-11-02T12:00:00Z", observedAt: "2026-11-03T00:00:00Z" });
  const result = board([f], { metricId, aggregation: "duration", rank: false }, {}, { cutoff });
  assert.equal(result.rows[0].value, 48);
  assert.equal(result.rows[0].censored, 0);
});

test("candidate policies cannot mix observed, qualified and reviewed evidence classes", () => {
  assert.throws(() => validateMetricPolicy(policy({ rankedStates: ["observed", "qualified"] })), /one evidence class/);
});

test("permutation invariance covers corrections, duplicate receipts and exclusions", () => {
  const a = fact("a"), b = fact("b", { actorId: "b" });
  const facts = [a, { ...a, id: "adapter-copy" }, b, { ...b, state: "excluded", revision: 1, correctionReceipt: "synthetic-correction" }];
  const expected = stableJSON(board(facts));
  for (let shift = 0; shift < facts.length; shift++) assert.equal(stableJSON(board([...facts.slice(shift), ...facts.slice(0, shift)].reverse())), expected);
});


test("policy release manifests require designated approval and notes, including rollback", () => {
  const frozen = input([fact("a")]), old = policy(), next = policy({ version: "synthetic-policy/v2" });
  const comparison = comparePolicies(frozen, old, next, scope());
  const decision = { approverId: "synthetic-owner", designatedApproverIds: ["synthetic-owner"], approvalReceipt: "synthetic-approval", releaseNotes: "Synthetic candidate policy review." };
  assert.throws(() => planPolicyRelease(comparison, { ...decision, approverId: "unapproved" }), /Designated/);
  assert.throws(() => planPolicyRelease(comparison, { ...decision, releaseNotes: "" }), /Release notes/);
  assert.equal(planPolicyRelease(comparison, decision).targetVersion, next.version);
  assert.equal(planPolicyRelease(comparePolicies(frozen, next, old, scope()), decision).targetVersion, old.version);
  assert.equal(planPolicyRelease(comparison, decision).publicEnabled, false);
  assert.throws(() => comparePolicies(frozen, old, { ...old, groupBy: "canonical" }, scope()), /new policy version/);
});


test("uncertain older normalization cannot certify complete newcomer history", () => {
  const old = fact("historic", { canonicalKey: null, acceptedAt: "2026-02-01T10:00:00Z", observedAt: "2026-02-02T10:00:00Z" });
  const rows = participationView(input([old, fact("current")]), policy(), scope(), { originAt: "2026-01-01T00:00:00Z", reviewReceipt: "synthetic-review" });
  assert.equal(rows[0].newcomer, null);
  assert.equal(rows[0].historyCoverage, "incomplete");
});

test("policy aggregation cannot silently reinterpret count units or signed net changes", () => {
  assert.throws(() => board([fact("count", { quantity: 999 })], { aggregation: "sum" }), /registry semantics/);
  assert.throws(() => board([], { metricId: "net_lines", aggregation: "sum", rank: false }), /signed net changes/);
});
