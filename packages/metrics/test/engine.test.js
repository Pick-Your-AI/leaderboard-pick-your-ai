import assert from "node:assert/strict";
import test from "node:test";
import { actorKindSchema, contributionRoleSchema } from "@pick-your-ai/contracts";
import {
  aggregateMetric, selectPortfolioFacts, comparePolicies, compareRankMovement, getMetricDefinition,
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

test("localization accepted units reject raw counts and preserve distinct accepted locale categories", () => {
  const configured = policy({ metricId: "localization", groupBy: "canonical", dateBasis: "occurredAt", rank: false });
  assert.throws(() => validateMetricPolicy({ ...configured, rankedStates: ["observed"] }), /independent acceptance/);
  assert.throws(() => validateMetricPolicy({ ...configured, groupBy: "actor_artifact" }), /canonical language/);
  assert.throws(() => validateMetricPolicy({ ...configured, dateBasis: "acceptedAt" }), /source merge clock/);
  const common = { metricId: "localization", artifactId: "synthetic-same-pr" };
  const raw = fact("raw-fr", { ...common, canonicalKey: "synthetic-fr", state: "observed", acceptedAt: null, acceptedBy: null, acceptanceReceipt: null });
  const other = fact("raw-de", { ...raw, id: "raw-de", canonicalKey: "synthetic-de" });
  const rawOnly = input([raw, other]);
  assert.ok(aggregateMetric(rawOnly, configured, scope()).rows.every((row) => row.value === null || row.value === 0));
  assert.equal(selectPortfolioFacts(rawOnly, configured, scope()).length, 2);
  const accepted = [fact("accepted-fr", { ...common, canonicalKey: "synthetic-accepted-fr" }), fact("accepted-de", { ...common, canonicalKey: "synthetic-accepted-de" })];
  const result = aggregateMetric(input([...rawOnly.facts, ...accepted]), configured, scope());
  assert.equal(result.rows[0].value, 2);
  assert.deepEqual(result.rows[0].evidenceIds, ["accepted-de", "accepted-fr"]);
  const mergedWindow = scope({ from: "2026-10-04T00:00:00Z", to: "2026-10-05T00:00:00Z" });
  const reviewedWindow = scope({ from: "2026-10-05T00:00:00Z", to: "2026-10-06T00:00:00Z" });
  assert.equal(aggregateMetric(input(accepted), configured, mergedWindow).rows[0].value, 2);
  assert.deepEqual(aggregateMetric(input(accepted), configured, reviewedWindow).rows, []);
  const selfReviewed = accepted.map((entry) => ({ ...entry, acceptedBy: entry.actorId }));
  assert.equal(aggregateMetric(input(selfReviewed), configured, scope()).rows.length, 0);
});

test("accepted counts reconcile to evidence while pending stays outside dense ranks", () => {
  const facts = Array.from({ length: 14 }, (_, n) => fact(`accepted-${n}`));
  facts.push(...Array.from({ length: 3 }, (_, n) => fact(`pending-${n}`, { state: "pending", acceptedAt: null })));
  const result = board(facts);
  assert.equal(result.rows[0].value, 14);
  assert.equal(result.rows[0].evidenceIds.length, 14);
  assert.equal(result.rows[0].pending, 3);
  assert.deepEqual(result.rows[0].pendingEvidence.map((fact) => fact.id), ["pending-0", "pending-1", "pending-2"]);
  assert.equal(result.audit.filter((entry) => entry.reason === "pending_not_ranked").length, 3);
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

test("unknown or unverified historic qualification cannot certify a newcomer", () => {
  const history = { originAt: "2026-01-01T00:00:00Z", reviewReceipt: "synthetic-history-review" };
  for (const patch of [{ state: "unknown" }, { acceptanceReceipt: null }, { acceptedBy: null }, { acceptedBy: "   " }, { acceptedBy: "a" }]) {
    const old = fact("historic", { occurredAt: "2026-02-01T00:00:00Z", acceptedAt: "2026-02-02T00:00:00Z", observedAt: "2026-02-03T00:00:00Z", ...patch });
    const rows = participationView(input([old, fact("current")]), policy(), scope(), history);
    assert.equal(rows[0].newcomer, null, JSON.stringify(patch));
    assert.equal(rows[0].historyCoverage, "incomplete");
  }
});

test("unknown qualification cannot disappear behind a repeated eligible unit", () => {
  const unknown = fact("unknown", { state: "unknown", artifactId: "same" });
  const eligible = fact("eligible", { artifactId: "same" });
  const result = board([unknown, eligible]);
  assert.equal(result.coverage, "incomplete");
  assert.equal(result.rows[0].state, "partial");
  assert.ok(result.audit.some(entry => entry.reason === "unknown_qualification"));
});

test("history origin must form a valid interval and cover the selected period", () => {
  const history = { originAt: "2026-12-01T00:00:00Z", reviewReceipt: "synthetic-review" };
  assert.throws(() => participationView(input([fact("current")]), policy(), scope(), history), /Window/);
  const rows = participationView(input([fact("current", { acceptedAt: "2026-10-20T00:00:00Z" })]), policy(), scope(), { ...history, originAt: "2026-10-10T00:00:00Z" });
  assert.equal(rows[0].newcomer, null);
  assert.equal(rows[0].historyCoverage, "incomplete");
});

test("automation is positive source evidence rather than any non-user account", () => {
  for (const kind of ["organization", "unknown"]) {
    const result = board([fact("a")], {}, { actors: "automation" }, { actors: [actor("a", { kind })] });
    assert.equal(result.rows.length, 0, kind);
  }
  for (const kind of ["bot", "github_app", "system"]) {
    assert.equal(board([fact("a")], {}, { actors: "automation" }, { actors: [actor("a", { kind })] }).rows[0].value, 1);
  }
  const automatedUser = { actors: [actor("a", { executionMode: "automated" })] };
  assert.equal(board([fact("a")], {}, { actors: "automation" }, automatedUser).rows[0].value, 1);
  assert.equal(board([fact("a")], {}, { actors: "user" }, automatedUser).rows[0].value, 1);
  assert.throws(() => board([fact("a")], {}, {}, { actors: [actor("a", { executionMode: "manual" })] }));
});

test("line measurements and their total require exact safe integers", () => {
  const metricId = "pr_lines_changed", p = { metricId, aggregation: "sum" };
  for (const quantity of [0.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => board([fact("a", { metricId, quantity })], p), /safe integer/);
  }
  assert.throws(() => board([fact("a", { metricId, quantity: Number.MAX_SAFE_INTEGER }), fact("b", { metricId, quantity: 1 })], p), /safe integer/);
  assert.equal(board([fact("a", { metricId, quantity: Number.MAX_SAFE_INTEGER })], p).rows[0].value, Number.MAX_SAFE_INTEGER);
});

test("same policy unit cannot select a convenient conflicting sum, outcome or duration", () => {
  for (const [metricId, aggregation, first, second] of [
    ["pr_lines_changed", "sum", { quantity: 2 }, { quantity: 700 }],
    ["pr_lines_changed", "sum", { quantity: 2 }, {}],
    ["pr_accepted_rate", "ratio", { outcome: "merged" }, { outcome: "closed_unmerged" }],
    ["review_wait", "duration", { readyAt: "2026-10-04T00:00:00Z", firstReviewAt: "2026-10-05T00:00:00Z" }, { readyAt: "2026-10-04T00:00:00Z", firstReviewAt: "2026-10-06T00:00:00Z" }],
  ]) {
    const facts = [fact("a", { metricId, artifactId: "same", ...first }), fact("b", { metricId, artifactId: "same", ...second })];
    const p = { metricId, aggregation, rank: false };
    const result = board(facts, p);
    assert.equal(result.rows.length, 0, metricId);
    assert.equal(result.coverage, "incomplete");
    assert.ok(result.audit.some(entry => entry.reason === "conflicting_policy_unit"));
    assert.deepEqual(board([...facts].reverse(), p), result);
    const identical = [facts[0], { ...facts[0], id: "duplicate", canonicalKey: "duplicate" }];
    assert.equal(board(identical, p).rows[0].sampleCount, 1);
  }
});

test("adjacent UTC windows around the DST fallback count each boundary action once", () => {
  const cutoff = "2026-11-02T00:00:00Z", boundary = "2026-11-01T06:00:00Z";
  const facts = [fact("before", { acceptedAt: "2026-11-01T05:59:59.999Z", observedAt: "2026-11-01T06:01:00Z" }), fact("boundary", { acceptedAt: boundary, observedAt: "2026-11-01T06:01:00Z" })];
  const frozen = { cutoff, coverage: [coverage({ windowEnd: cutoff })] };
  const before = board(facts, {}, { from: "2026-11-01T05:00:00Z", to: boundary }, frozen);
  const after = board(facts, {}, { from: boundary, to: "2026-11-01T07:00:00Z" }, frozen);
  assert.deepEqual(before.rows[0].evidenceIds, ["before"]);
  assert.deepEqual(after.rows[0].evidenceIds, ["boundary"]);
});


test("engine actor and role enums follow the versioned contracts", () => {
  for (const kind of actorKindSchema.options.filter(kind => kind !== "unknown")) {
    const id = kind === "service_account" ? "101" : "a";
    const serviceAccountClassification = kind === "service_account" ? {
      schemaVersion: "leaderboard-service-account/v1", classificationId: "synthetic-service-account",
      githubDatabaseId: 101, source: "reviewed_configuration", evidenceIds: ["synthetic-evidence"],
      reviewerActorId: "202", reviewedAt: from,
    } : undefined;
    assert.equal(board([fact("a", { actorId: id })], {}, { actors: "all" }, { actors: [actor(id, { kind, serviceAccountClassification })] }).rows.length, 1, kind);
  }
  for (const role of contributionRoleSchema.options.filter(role => role !== "unknown")) {
    assert.equal(board([fact("a", { role, subjectActorId: "synthetic-other" })], { roles: [role] }).rows.length, 1, role);
  }
});


test("equivalent timestamp encodings do not create conflicting duration evidence", () => {
  const metricId = "review_wait";
  const facts = [
    fact("a", { metricId, artifactId: "same", readyAt: "2026-10-04T00:00:00Z", firstReviewAt: "2026-10-05T00:00:00Z" }),
    fact("b", { metricId, artifactId: "same", readyAt: "2026-10-04T00:00:00.000Z", firstReviewAt: "2026-10-05T00:00:00.000Z" }),
  ];
  const result = board(facts, { metricId, aggregation: "duration", rank: false });
  assert.equal(result.rows[0].value, 24);
  assert.equal(result.coverage, "complete");
  assert.equal(result.rows[0].sampleCount, 1);
  assert.ok(!result.audit.some(entry => entry.reason === "conflicting_policy_unit"));
});


test("portfolio selection preserves observed and pending states independently of accepted ranking eligibility", () => {
  const facts = [fact("observed", {state: "observed", acceptedAt: null, acceptanceReceipt: null, acceptedBy: null}),
    fact("pending", {state: "pending", acceptedAt: null, acceptanceReceipt: null, acceptedBy: null}), fact("accepted"),
    fact("self-approved", {acceptedBy: "a"}), fact("unknown", {state: "unknown"}), fact("unlinked", {actorId: null})];
  const selected = selectPortfolioFacts(input(facts), policy(), scope());
  assert.deepEqual(selected.map((item) => [item.id, item.state]), [["accepted", "qualified"], ["observed", "observed"], ["pending", "pending"]]);
  assert.deepEqual(board(facts).rows[0].evidenceIds, ["accepted"]);
});

test("portfolio selection applies canonical correction, frozen observation, half-open date and workstream boundaries", () => {
  const original = fact("removed", {state: "observed", acceptedAt: null});
  const facts = [original, {...original, revision: 1, state: "excluded", correctionReceipt: "synthetic-correction"},
    fact("start", {occurredAt: from}), fact("end", {occurredAt: to}), fact("late", {observedAt: "2026-11-02T00:00:00Z"}),
    fact("other-workstream", {eventContext: {projects: [], workstreams: ["elsewhere"]}})];
  assert.deepEqual(selectPortfolioFacts(input(facts), policy(), scope({workstreams: ["w1"]})).map((item) => item.id), ["start"]);
});


test("same-ID historical corrections cannot masquerade as fresh rank progress", () => {
  const metricId = "pr_lines_changed", p = { metricId, aggregation: "sum" };
  const early = "2026-10-15T00:00:00Z";
  const a = fact("a", { metricId, quantity: 1 });
  const b = fact("b", { metricId, actorId: "b", quantity: 2 });
  const before = board([a, b], p, { to: early }, { cutoff: early });
  for (const patch of [
    { quantity: 3 },
    { actorId: "c", subjectActorId: "c" },
    { acceptedAt: "2026-10-06T10:00:00Z" },
    {}, // Even a no-op reviewed revision is historical correction, not new work.
  ]) {
    const correction = { ...a, ...patch, revision: 1, correctionReceipt: "synthetic-private-correction", observedAt: "2026-10-20T00:00:00Z" };
    const after = board([a, b, correction], p, { to: early });
    const movement = compareRankMovement(before, after);
    assert.ok(movement.length > 0);
    assert.ok(movement.every(row => row.state === "unavailable" && row.delta === null && row.reason === "corrected_or_removed_evidence"), JSON.stringify(patch));
    assert.ok(after.rows.every(row => row.evidence.every(item => !item.comparisonSignature.includes("synthetic-private-correction"))));
    assert.deepEqual(board([correction, b, a], p, { to: early }), after);
  }
});

test("movement signatures detect changed measurement even without a collector revision bump", () => {
  const metricId = "pr_lines_changed", p = { metricId, aggregation: "sum" };
  const a = fact("a", { metricId, quantity: 1 }), b = fact("b", { metricId, actorId: "b", quantity: 2 });
  const before = board([a, b], p);
  const after = board([{ ...a, quantity: 3 }, b], p);
  assert.equal(compareRankMovement(before, after)[0].reason, "corrected_or_removed_evidence");
});

test("fresh accepted activity remains comparable and timestamp spelling does not invent corrections", () => {
  const oldFacts = [fact("a"), fact("b", { actorId: "b" })];
  const nextCutoff = "2026-11-02T00:00:00Z";
  const before = board(oldFacts, {}, resolveMetricWindow("30d", to));
  const fresh = fact("fresh", { actorId: "b", acceptedAt: "2026-11-01T12:00:00Z", observedAt: "2026-11-01T12:01:00Z" });
  const after = board([...oldFacts.map(f => ({ ...f, acceptedAt: "2026-10-05T10:00:00.000Z" })), fresh], {}, resolveMetricWindow("30d", nextCutoff), { cutoff: nextCutoff, coverage: [coverage({ windowEnd: nextCutoff })] });
  assert.deepEqual(compareRankMovement(before, after).map(row => [row.actorId, row.state, row.delta]), [["b", "comparable", 0], ["a", "comparable", -1]]);
  const legacy = structuredClone(before);
  for (const row of legacy.rows) for (const evidence of row.evidence) delete evidence.comparisonSignature;
  assert.ok(compareRankMovement(legacy, after).every(row => row.reason === "insufficient_evidence_history" && row.delta === null));
});

test("pending provenance follows canonical deduplication, policy units, corrections and suppression", () => {
  const pending = fact("pending", { state: "pending", acceptedAt: null });
  const duplicate = { ...pending, id: "duplicate", observedAt: "2026-10-07T10:00:00Z" };
  const repeated = { ...pending, id: "repeated", canonicalKey: "different-observation" };
  const selected = board([pending, duplicate, repeated]).rows[0];
  assert.equal(selected.pending, 1);
  assert.equal(selected.pendingEvidence[0].id, "pending");
  assert.equal(selected.value, null);
  assert.equal(selected.rank, null);
  const accepted = { ...pending, id: "accepted", canonicalKey: "acceptance-action", state: "qualified", acceptedAt: "2026-10-08T10:00:00Z" };
  assert.equal(board([pending, accepted]).rows[0].pending, 0);
  assert.deepEqual(board([pending, accepted]).rows[0].pendingEvidence, []);
  const reversed = { ...pending, revision: 1, state: "excluded", correctionReceipt: "synthetic-correction", observedAt: "2026-10-09T00:00:00Z" };
  assert.equal(board([pending, reversed]).rows.length, 0);
  assert.equal(board([pending], {}, {}, { actors: [actor("a", { publicState: "suppressed" })] }).rows.length, 0);
});


test("ratio pending provenance stays outside decided numerator and denominator evidence", () => {
  const result = board([
    fact("merged", { metricId: "pr_accepted_rate", state: "observed", outcome: "merged" }),
    fact("open", { metricId: "pr_accepted_rate", state: "observed", outcome: "pending", acceptedAt: null }),
  ], { metricId: "pr_accepted_rate", aggregation: "ratio", rankedStates: ["observed"], rank: false });
  assert.equal(result.rows[0].denominator, 1);
  assert.equal(result.rows[0].pending, 1);
  assert.deepEqual(result.rows[0].evidenceIds, ["merged"]);
  assert.deepEqual(result.rows[0].pendingEvidence.map((fact) => fact.id), ["open"]);
});

test("every valid nonselected evidence class has a durable exclusion reason", () => {
  const facts = [fact("accepted"), fact("raw", { state: "observed" }), fact("editorial", { state: "reviewed" }), fact("pending", { state: "pending", acceptedAt: null })];
  const result = board(facts);
  assert.equal(result.rows[0].value, 1);
  assert.equal(result.rows[0].pending, 1);
  assert.deepEqual(result.audit.filter((entry) => entry.reason === "evidence_class_not_ranked").flatMap((entry) => entry.factIds).sort(), ["editorial", "raw"]);
  assert.deepEqual([...new Set(result.audit.flatMap((entry) => entry.factIds))].sort(), facts.map((fact) => fact.id).sort());
});

test("future observations and unknown ratio outcomes remain explicitly accounted for", () => {
  const facts = [fact("future", { observedAt: "2026-12-01T00:00:00Z" }), fact("current")];
  assert.ok(board(facts).audit.some((entry) => entry.reason === "observation_after_cutoff" && entry.factIds.includes("future")));
  const ratio = board([fact("unknown", { metricId: "pr_accepted_rate" }), fact("merged", { metricId: "pr_accepted_rate", outcome: "merged" })], { metricId: "pr_accepted_rate", aggregation: "ratio", rank: false });
  assert.deepEqual([ratio.rows[0].numerator, ratio.rows[0].denominator], [1, 1]);
  assert.ok(ratio.audit.some((entry) => entry.reason === "unknown_ratio_outcome" && entry.factIds.includes("unknown")));
});
