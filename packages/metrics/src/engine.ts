import {
  actorKindSchema,
  compareSourceInstants,
  contributionRoleSchema,
  coverageSchema,
  executionModeSchema,
  isPullRequestMergeTargetBranch,
  pullRequestDecisionInstantSchema,
  serviceAccountClassificationSchema,
  supportsPullRequestMergeTarget,
  validatePullRequestMergeTarget,
  type PrMergeTarget,
  type ServiceAccountClassification,
  type Actor,
  type Contribution,
  type Coverage,
  type RelationshipPair,
  relationshipPairNormalizationVersion,
  relationshipPairSchema,
} from "@pick-your-ai/contracts";
import { getMetricDefinition } from "./v1/index.js";
import { getMetricGroupingPolicy } from "./ui.js";
import {
  conserveRelationshipPairs,
  relationshipPairMetricIds,
  relationshipPairMembership,
} from "./relationship-pairs.js";

export type EvidenceState = "observed" | "qualified" | "reviewed" | "pending" | "excluded" | "unknown";
export type Role = Contribution["roles"][number];
export interface MetricFact {
  id: string;
  /** Same source action across adapters has the same explicit canonical key. */
  canonicalKey: string | null;
  metricId: string;
  actorId: string | null;
  artifactId: string | null;
  repoId: string;
  role: Role;
  state: EvidenceState;
  occurredAt: string | null;
  acceptedAt: string | null;
  observedAt: string;
  revision: number;
  /** Nonzero revisions require a reviewed correction receipt; inputs remain immutable. */
  correctionReceipt: string | null;
  acceptanceReceipt: string | null;
  acceptedBy: string | null;
  subjectActorId: string | null;
  eventContext: {
    projects: string[];
    workstreams: string[];
    workstreamsKnown?: boolean;
    projectScope?: string[];
    workstreamScope?: string[];
  } | null;
  currentContext: {
    projects: string[];
    workstreams: string[];
    workstreamsKnown?: boolean;
    projectScope?: string[];
    workstreamScope?: string[];
  } | null;
  quantity?: number;
  /** Literal source state, never an inferred classification. */
  rawState?: string;
  outcome?: "merged" | "closed_unmerged" | "pending";
  /** Private native-decision selection bound to this exact exclusive reporting end. */
  decisionAsOf?: string;
  readyAt?: string | null;
  firstReviewAt?: string | null;
  /** Exact observed locale fact whose accepted representation replaces current portfolio display. */
  recognitionSourceFactId?: string;
  /** Private projection of a source-verified historical merged event, never the current REST base. */
  mergeTarget?: PrMergeTarget;
  /** Private, source-validated pair identity; never inferred from public text. */
  relationshipPair?: RelationshipPair;
  /** Private inclusion identity; the public projection exposes only selected evidence. */
  releaseInclusion?: {
    version: "release-inclusion-units/v1";
    releaseId: number;
    releaseNodeId: string;
    pullRequestNodeId: string;
    mergeCommitSha: string;
    releaseCommitSha: string;
    publishedAt: string;
    proofHash: string;
  };
}
export interface EngineActor {
  id: string;
  login: string | null;
  kind: Actor["kind"];
  /** Preserve source bindings when available so combined observations cannot alias one node. */
  githubDatabaseId?: number;
  githubNodeId?: string;
  /** Literal source evidence only; omission means unknown, never manual work. */
  executionMode?: Actor["executionMode"];
  /** Internal source-validated classification, never a public profile or a manual-execution claim. */
  serviceAccountClassification?: ServiceAccountClassification;
  publicState: "visible" | "deleted" | "suppressed";
}
export interface MetricPolicy {
  metricId: string;
  version: string;
  definitionVersion: string;
  unit: string;
  aggregation: "count" | "sum" | "ratio" | "duration";
  dateBasis: "occurredAt" | "acceptedAt";
  rankedStates: ("observed" | "qualified" | "reviewed")[];
  roles: Role[];
  groupBy: "canonical" | "actor_artifact" | "actor_artifact_state_interval" | "actor_artifact_interval";
  /** Required for interval grouping. No interval is silently chosen. */
  groupingSeconds?: number;
  /** Registry policy pin is required for raw triage grouping. */
  groupingPolicyVersion?: string;
  sources: Coverage["source"][];
  minimumSamples: number;
  rank: boolean;
}
export type MetricPeriod = "7d" | "30d" | "90d" | "all" | "month" | "quarter" | "year" | "custom";
export interface MetricScope {
  period?: MetricPeriod;
  timezone: "UTC";
  from: string | null;
  to: string;
  repos: string[];
  /** Exact historical merge target; supported only for explicit single-repository merged-PR views. */
  branch?: string;
  projects: string[];
  workstreams: string[];
  roles: Role[];
  actors: "user" | "automation" | "all";
  context: "event" | "current";
}
export interface FrozenInput {
  datasetId: string;
  cutoff: string;
  /** Changed by the collector for imports/reconciliation, not ordinary live progress. */
  backfillRevision: string;
  repositoryIds: string[];
  actors: readonly EngineActor[];
  facts: readonly MetricFact[];
  coverage: readonly Coverage[];
}
export interface AuditEntry {
  factIds: string[];
  actorId: string | null;
  reason: string;
}
export interface AggregateRow {
  actorId: string;
  login: string | null;
  value: number | null;
  state: "measured" | "partial" | "zero" | "unknown" | "insufficient_sample";
  pending: number;
  /** Exact prepared policy units, after correction and duplicate selection. */
  pendingEvidence: MetricFact[];
  numerator: number | null;
  denominator: number | null;
  sampleCount: number;
  samples: number[];
  p75: number | null;
  censored: number;
  missingReadiness: number;
  evidenceIds: string[];
  evidence: {
    id: string;
    effectiveAt: string | null;
    observedAt: string;
    /** Internal comparison only; contains no acceptance/correction receipt or source content.
     * Older persisted aggregates omit this and cannot establish comparable history.
     */
    comparisonSignature?: string;
  }[];
  rank: number | null;
  tied: boolean;
}
export interface MetricAggregate {
  metricId: string;
  policyVersion: string;
  policySignature: string;
  definitionVersion: string;
  unit: string;
  aggregation: MetricPolicy["aggregation"];
  /** The engine computes candidates. It never authorizes public release. */
  publicEnabled: false;
  scope: MetricScope;
  datasetId: string;
  cutoff: string;
  backfillRevision: string;
  coverage: "complete" | "incomplete";
  rows: AggregateRow[];
  /** Internal review receipts, excluded from any public projection. */
  audit: AuditEntry[];
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const unique = (values: readonly string[]) => [...new Set(values)].sort(compare);
const key = (...parts: unknown[]) => JSON.stringify(parts);
const knownRoles: readonly string[] = contributionRoleSchema.options;
const knownKinds: readonly string[] = actorKindSchema.options;
const knownSources = ["github_webhook", "github_rest", "github_graphql", "reviewed_receipt"];
function required(value: string, name: string): void {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
}
function instant(value: string): number {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value))
    throw new Error("Expected an explicit UTC instant");
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 19) !== value.slice(0, 19))
    throw new Error("Invalid UTC instant");
  return ms;
}
function compareInstants(a: string | null, b: string | null): number {
  if (a === null || b === null) return a === b ? 0 : a === null ? -1 : 1;
  // prepare validates the applicable clock profile before these ordering steps.
  return compareSourceInstants(a, b);
}
function validateFactInstant(fact: MetricFact, value: string): void {
  if (fact.decisionAsOf === undefined) instant(value);
  else pullRequestDecisionInstantSchema.parse(value);
}
function comparisonInstant(fact: MetricFact, value: string | null | undefined): number | string | null {
  if (value == null) return null;
  if (fact.decisionAsOf === undefined) return instant(value);
  // Canonicalize equivalent UTC spellings without discarding native precision.
  const fraction = value.match(/\.(\d+)/)?.[1] ?? "";
  return `${value.slice(0, 19)}.${fraction.padEnd(9, "0")}Z`;
}
function number(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be finite and nonnegative`);
  return value;
}
function canonicalScope(scope: MetricScope): MetricScope {
  if (scope.timezone !== "UTC") throw new Error("Only explicit UTC scopes are supported");
  if (scope.from !== null && instant(scope.from) >= instant(scope.to))
    throw new Error("Window must be half-open with from < to");
  instant(scope.to);
  if (!["event", "current"].includes(scope.context) || !["user", "automation", "all"].includes(scope.actors))
    throw new Error("Invalid filter semantics");
  if (scope.period && scope.period !== "custom") {
    const expected = resolveMetricWindow(scope.period, scope.to);
    if ((scope.from === null ? null : instant(scope.from)) !== (expected.from === null ? null : instant(expected.from)))
      throw new Error("Preset bounds must match their explicit UTC period");
  }
  if (scope.roles.some((role) => !knownRoles.includes(role))) throw new Error("Unknown role filter");
  for (const id of [...scope.repos, ...scope.projects, ...scope.workstreams]) required(id, "Scope ID");
  if (scope.branch !== undefined && (!isPullRequestMergeTargetBranch(scope.branch) || unique(scope.repos).length !== 1))
    throw new Error("Merge-target filtering requires a valid branch and one explicit repository");
  return {
    ...scope,
    repos: unique(scope.repos),
    projects: unique(scope.projects),
    workstreams: unique(scope.workstreams),
    roles: unique(scope.roles) as Role[],
  };
}
export function validateMetricPolicy(policy: MetricPolicy): void {
  const metric = getMetricDefinition(policy.metricId);
  if (!metric) throw new Error("Unknown metric ID");
  required(policy.version, "Policy version");
  required(policy.definitionVersion, "Definition version");
  const implementedAggregation: Record<string, MetricPolicy["aggregation"]> = {
    count_distinct_eligible_units: "count",
    sum_eligible_line_units: "sum",
    ratio: "ratio",
    median_and_p75_of_elapsed_hours: "duration",
  };
  const expectedAggregation = implementedAggregation[metric.definition.aggregation];
  if (!expectedAggregation || policy.aggregation !== expectedAggregation)
    throw new Error("Aggregation must match implemented registry semantics; signed net changes are unsupported");
  if (metric.definition.unit !== policy.unit) throw new Error("Unit must match the versioned registry");
  if (!["count", "sum", "ratio", "duration"].includes(policy.aggregation)) throw new Error("Unsupported aggregation");
  if (!["occurredAt", "acceptedAt"].includes(policy.dateBasis)) throw new Error("Unsupported date basis");
  if (
    policy.rankedStates.length !== 1 ||
    policy.rankedStates.some((state) => !["observed", "qualified", "reviewed"].includes(state))
  )
    throw new Error("Exactly one evidence class is required; observed, qualified and reviewed values stay separate");
  if (
    policy.metricId === "localization" &&
    (policy.rankedStates[0] === "observed" || policy.groupBy !== "canonical" || policy.dateBasis !== "occurredAt")
  )
    throw new Error(
      "Localization accepted units require independent acceptance, canonical language/category grouping and the source merge clock",
    );
  if (
    policy.metricId === "release_changes" &&
    (policy.dateBasis !== "occurredAt" ||
      policy.groupBy !== "canonical" ||
      policy.rankedStates[0] !== "qualified" ||
      policy.roles.length !== 1 ||
      policy.roles[0] !== "author" ||
      policy.groupingPolicyVersion !== "release-inclusion-units/v1")
  )
    throw new Error(
      "Release inclusion requires its publication clock, qualified authors and versioned canonical units",
    );
  if (
    policy.metricId === "helpful_feedback" &&
    (policy.aggregation !== "count" ||
      policy.dateBasis !== "acceptedAt" ||
      policy.groupBy !== "canonical" ||
      policy.rankedStates[0] !== "qualified" ||
      policy.roles.length !== 1 ||
      policy.roles[0] !== "author" ||
      policy.groupingPolicyVersion !== "accepted-feedback-threads/v1")
  )
    throw new Error("Helpful feedback requires independent acceptance and versioned canonical author/thread units");
  if (
    policy.metricId === "project_items_curated" &&
    (policy.dateBasis !== "occurredAt" ||
      policy.groupBy !== "canonical" ||
      policy.rankedStates[0] !== "observed" ||
      policy.roles.length !== 1 ||
      policy.roles[0] !== "triager" ||
      policy.groupingSeconds !== undefined)
  )
    throw new Error(
      "Project curation requires the source clock, observed triager role and canonical native operations",
    );
  if (
    relationshipPairMetricIds.has(policy.metricId) &&
    (policy.dateBasis !== "occurredAt" ||
      policy.groupBy !== "canonical" ||
      policy.rankedStates[0] !== "observed" ||
      policy.roles.length !== 1 ||
      policy.roles[0] !== "triager" ||
      policy.groupingPolicyVersion !== relationshipPairNormalizationVersion ||
      policy.groupingSeconds !== undefined)
  )
    throw new Error("Relationship pairs require the source clock, observed triager role and versioned canonical units");
  if (
    !policy.roles.length ||
    policy.roles.some((role) => !knownRoles.includes(role) || role === "unknown") ||
    !policy.sources.length ||
    policy.sources.some((source) => !knownSources.includes(source))
  )
    throw new Error("Explicit roles and known sources are required");
  if (!Number.isSafeInteger(policy.minimumSamples) || policy.minimumSamples < 1)
    throw new Error("Minimum sample size must be a positive integer");
  if (
    !["canonical", "actor_artifact", "actor_artifact_state_interval", "actor_artifact_interval"].includes(
      policy.groupBy,
    )
  )
    throw new Error("Explicit grouping policy required");
  if (
    ["actor_artifact_state_interval", "actor_artifact_interval"].includes(policy.groupBy) &&
    (!Number.isSafeInteger(policy.groupingSeconds) || policy.groupingSeconds! < 1)
  )
    throw new Error("State grouping requires an explicit positive interval");
  const grouping = getMetricGroupingPolicy(policy.metricId);
  if (policy.groupBy === "actor_artifact_interval" && grouping?.group_by !== "actor_artifact_interval")
    throw new Error("Daily groups require their exact versioned grouping policy");
  const supportedGroupingSelection =
    !grouping ||
    (policy.dateBasis === grouping.date_basis && policy.rankedStates[0] === grouping.state) ||
    ("receipt_lenses" in grouping &&
      grouping.receipt_lenses.some(
        (pair) => pair.state === policy.rankedStates[0] && pair.date_basis === policy.dateBasis,
      ));
  if (
    grouping &&
    (policy.groupingPolicyVersion !== grouping.version ||
      policy.groupBy !== grouping.group_by ||
      policy.groupingSeconds !== grouping.grouping_seconds ||
      !supportedGroupingSelection ||
      policy.roles.length !== 1 ||
      policy.roles[0] !== "triager")
  )
    throw new Error(
      "Triage requires the exact versioned grouping policy, supported evidence/clock pair and triager role",
    );
  if (policy.aggregation === "ratio" && policy.dateBasis !== "acceptedAt")
    throw new Error("PR ratios use decision time, supplied as acceptedAt for merged and closed-unmerged decisions");
  if (
    policy.rank &&
    (policy.aggregation === "ratio" ||
      policy.aggregation === "duration" ||
      metric.definition.display_policy === "spotlight" ||
      metric.definition.release_eligibility === "descriptive-only")
  )
    throw new Error("Descriptive metrics cannot rank contributors");
  if (policy.aggregation === "ratio" && policy.metricId !== "pr_accepted_rate")
    throw new Error("Only decided-PR ratios have an implemented denominator");
  if (policy.aggregation === "duration" && policy.metricId !== "review_wait")
    throw new Error("Only ready-to-first-review durations are implemented");
  if (
    ["pr_accepted_rate", "review_wait"].includes(policy.metricId) &&
    policy.aggregation !== (policy.metricId === "review_wait" ? "duration" : "ratio")
  )
    throw new Error("Diagnostic aggregation must match its metric");
}

export function resolveMetricWindow(
  preset: MetricPeriod = "30d",
  cutoff: string,
  custom?: { from: string; to: string },
): { timezone: "UTC"; period: MetricPeriod; from: string | null; to: string } {
  const end = instant(cutoff),
    date = new Date(end);
  let start: number | null;
  if (["7d", "30d", "90d"].includes(preset)) start = end - Number.parseInt(preset, 10) * 86400000;
  else if (preset === "all") start = null;
  else if (preset === "month" || preset === "quarter" || preset === "year") {
    const month =
      preset === "year" ? 0 : preset === "quarter" ? Math.floor(date.getUTCMonth() / 3) * 3 : date.getUTCMonth();
    // Preserve the validated year: Date.UTC remaps years 0–99 to 1900–1999.
    date.setUTCMonth(month, 1);
    date.setUTCHours(0, 0, 0, 0);
    start = date.getTime();
  } else if (preset === "custom" && custom) {
    start = instant(custom.from);
    const to = instant(custom.to);
    if (start >= to || to > end) throw new Error("Custom window must precede cutoff and have from < to");
    return { timezone: "UTC", period: preset, from: new Date(start).toISOString(), to: new Date(to).toISOString() };
  } else throw new Error("Unknown or incomplete window preset");
  return {
    timezone: "UTC",
    period: preset,
    from: start === null ? null : new Date(start).toISOString(),
    to: new Date(end).toISOString(),
  };
}

/** Necessary source coverage only; qualification and release authority remain separate. */
export function hasCompleteSourceCoverage(input: FrozenInput, policy: MetricPolicy, scope: MetricScope): boolean {
  if (scope.from === null) return false; // Known history is not proof of complete all-time history.
  // Source coverage retains its contract clocks; metric scopes remain normalized UTC.
  instant(scope.from);
  instant(scope.to);
  const repos = scope.repos.length ? scope.repos : input.repositoryIds;
  if (!repos.length) return false;
  return repos.every(
    (repo) =>
      input.repositoryIds.includes(repo) &&
      policy.sources.every((source) =>
        input.coverage.some(
          (item) =>
            item.scopeId === repo &&
            item.source === source &&
            item.state === "complete" &&
            coverageSchema.safeParse(item).success &&
            item.windowStart !== null &&
            compareSourceInstants(item.windowStart, scope.from!) <= 0 &&
            item.windowEnd !== null &&
            compareSourceInstants(item.windowEnd, scope.to) >= 0 &&
            typeof item.sourceWatermark === "string" &&
            compareSourceInstants(item.sourceWatermark, scope.to) >= 0 &&
            item.knownStart !== null &&
            compareSourceInstants(item.knownStart, scope.from!) <= 0 &&
            item.missingPages === 0 &&
            item.permissionsMissing.length === 0 &&
            item.sourceErrors.length === 0,
        ),
      ),
  );
}

interface Prepared {
  facts: MetricFact[];
  audit: AuditEntry[];
}
// Qualification uncertainty is not source completeness. Keep this explicit:
// matching words such as "unknown" missed missing independent acceptance.
const uncertaintyReasons = new Set([
  "unreviewed_revision",
  "conflicting_revision",
  "ambiguous_canonical_action",
  "unknown_canonical_identity",
  "unknown_actor",
  "unknown_membership_context",
  "missing_independent_acceptance",
  "release_inclusion_unverified",
  "unknown_acceptance_time",
  "unknown_effective_time",
  "unknown_artifact_identity",
  "unknown_raw_state_or_time",
  "unknown_qualification",
  "conflicting_policy_unit",
  "unknown_merge_target",
  "conflicting_merge_target",
  "relationship_pair_unverified",
  "relationship_pair_repository_unavailable",
  "ambiguous_relationship_pair",
  "ambiguous_relationship_event",
]);
const hasUncertainty = (prepared: Prepared) => prepared.audit.some((entry) => uncertaintyReasons.has(entry.reason));
function validMembershipIdentifiers(ids: readonly unknown[]): boolean {
  const seen = new Set<string>();
  for (let index = 0; index < ids.length; index++) {
    if (!Object.hasOwn(ids, index)) return false;
    const id = ids[index];
    if (typeof id !== "string" || !id.trim() || seen.has(id)) return false;
    seen.add(id);
  }
  return true;
}

/** Source authority/digest verification belongs to the asynchronous normalizer and retained-capture join.
 * The synchronous engine requires that projection to bind the exact selected fact, not merely a hash-shaped string.
 */
function boundMergeTarget(fact: MetricFact): PrMergeTarget | null {
  let target: PrMergeTarget;
  try {
    target = validatePullRequestMergeTarget(fact.mergeTarget);
  } catch {
    return null;
  }
  const role = fact.metricId === "pr_merged" ? "author" : fact.metricId === "maintainer_merges" ? "merger" : "coauthor";
  if (
    !supportsPullRequestMergeTarget(fact.metricId) ||
    target.repositoryId !== fact.repoId ||
    target.pullRequestId !== fact.artifactId ||
    fact.role !== role ||
    !["observed", "qualified", "reviewed"].includes(fact.state) ||
    (fact.outcome !== undefined && fact.outcome !== "merged") ||
    fact.occurredAt === null ||
    instant(target.mergedAt) !== instant(fact.occurredAt) ||
    instant(target.mergedAt) > instant(fact.observedAt) ||
    (fact.metricId === "pr_coauthored" && (fact.subjectActorId === null || fact.subjectActorId === fact.actorId))
  )
    return null;
  return target;
}

function prepare(
  input: FrozenInput,
  policy: MetricPolicy,
  scope: MetricScope,
  conserveReleaseWork = true,
  requireKnownWorkstreams = false,
): Prepared {
  if (scope.branch !== undefined && !supportsPullRequestMergeTarget(policy.metricId))
    throw new Error("Merge-target filtering is unsupported for this metric");
  const cutoff = instant(input.cutoff);
  if (instant(scope.to) > cutoff) throw new Error("Scope cannot exceed the frozen cutoff");
  required(input.datasetId, "Dataset ID");
  required(input.backfillRevision, "Backfill revision");
  if (new Set(input.actors.map((actor) => actor.id)).size !== input.actors.length)
    throw new Error("Actor IDs must be unique");
  const actorNodes = new Map<string, string>();
  for (const actor of input.actors) {
    required(actor.id, "Actor ID");
    if (
      actor.githubDatabaseId !== undefined &&
      (!Number.isSafeInteger(actor.githubDatabaseId) ||
        actor.githubDatabaseId <= 0 ||
        String(actor.githubDatabaseId) !== actor.id)
    )
      throw new Error("Actor database identity must match its canonical ID");
    if (actor.githubNodeId !== undefined) {
      required(actor.githubNodeId, "Actor node ID");
      const previous = actorNodes.get(actor.githubNodeId);
      if (previous !== undefined && previous !== actor.id) throw new Error("Conflicting actor node identity bindings");
      actorNodes.set(actor.githubNodeId, actor.id);
    }
    if (!knownKinds.includes(actor.kind) || !["visible", "deleted", "suppressed"].includes(actor.publicState))
      throw new Error("Unknown actor semantics");
    if (actor.executionMode !== undefined) executionModeSchema.parse(actor.executionMode);
    if (actor.kind === "service_account" || actor.serviceAccountClassification !== undefined) {
      const classification = serviceAccountClassificationSchema.parse(actor.serviceAccountClassification);
      if (
        actor.kind !== "service_account" ||
        String(classification.githubDatabaseId) !== actor.id ||
        (classification.githubNodeId !== undefined && classification.githubNodeId !== actor.githubNodeId) ||
        compareSourceInstants(classification.reviewedAt, input.cutoff) > 0
      )
        throw new Error("Service-account evidence must match the actor and frozen cutoff");
    }
  }
  for (const repo of input.repositoryIds) required(repo, "Allowed repository ID");
  const actors = new Map(input.actors.map((actor) => [actor.id, actor]));
  const audit: AuditEntry[] = [];
  const rejectedRelationshipEvents: MetricFact[] = [];
  const reject = (facts: MetricFact[], reason: string) => {
    if (
      [
        "unreviewed_revision",
        "conflicting_revision",
        "unknown_canonical_identity",
        "ambiguous_canonical_action",
      ].includes(reason)
    )
      for (const fact of facts) rejectedRelationshipEvents.push(fact);
    audit.push({
      factIds: unique(facts.map((fact) => fact.id)),
      actorId:
        relationshipPairMetricIds.has(policy.metricId) && !facts.every((fact) => fact.actorId === facts[0]?.actorId)
          ? null
          : (facts[0]?.actorId ?? null),
      reason,
    });
  };
  const versions = new Map<string, MetricFact[]>();
  const pairPolicy = relationshipPairMetricIds.has(policy.metricId);
  const requestedFactIds = new Set(
    input.facts.filter((fact) => fact.metricId === policy.metricId).map((fact) => fact.id),
  );
  const relatedNativeEvents = new Set(
    pairPolicy
      ? input.facts
          .filter((fact) => fact.metricId === policy.metricId)
          .flatMap((fact) => {
            const pair = relationshipPairSchema.safeParse(fact.relationshipPair);
            return pair.success ? [pair.data.eventId] : [];
          })
      : [],
  );
  for (const fact of input.facts) {
    if (fact.metricId !== policy.metricId) {
      if (!pairPolicy || !relationshipPairMetricIds.has(fact.metricId)) continue;
      const pair = relationshipPairSchema.safeParse(fact.relationshipPair);
      if (!pair.success || !relatedNativeEvents.has(pair.data.eventId)) continue;
    }
    for (const context of [fact.eventContext, fact.currentContext]) {
      if (context == null) continue;
      if (
        !context ||
        !Array.isArray(context.projects) ||
        !Array.isArray(context.workstreams) ||
        (context.workstreamsKnown !== undefined && typeof context.workstreamsKnown !== "boolean") ||
        (context.projectScope !== undefined && !Array.isArray(context.projectScope)) ||
        (context.workstreamScope !== undefined && !Array.isArray(context.workstreamScope)) ||
        [context.projects, context.workstreams, context.projectScope ?? [], context.workstreamScope ?? []].some(
          (ids) => !validMembershipIdentifiers(ids),
        ) ||
        (context.projectScope !== undefined && context.projects.some((id) => !context.projectScope!.includes(id))) ||
        (context.workstreamScope !== undefined &&
          context.workstreams.some((id) => !context.workstreamScope!.includes(id)))
      )
        throw new Error("Invalid membership context");
    }
    required(fact.id, "Fact ID");
    required(fact.repoId, "Repository ID");
    if (
      !["observed", "qualified", "reviewed", "pending", "excluded", "unknown"].includes(fact.state) ||
      !knownRoles.includes(fact.role)
    )
      throw new Error("Unknown fact semantics");
    if (fact.decisionAsOf !== undefined) pullRequestDecisionInstantSchema.parse(fact.decisionAsOf);
    validateFactInstant(fact, fact.observedAt);
    if (compareSourceInstants(fact.observedAt, input.cutoff) > 0) {
      reject([fact], "observation_after_cutoff");
      continue;
    }
    if (!Number.isSafeInteger(fact.revision) || fact.revision < 0) throw new Error("Invalid fact revision");
    if (fact.revision > 0 && !fact.correctionReceipt?.trim()) {
      reject([fact], "unreviewed_revision");
      continue;
    }
    for (const at of [fact.occurredAt, fact.acceptedAt, fact.readyAt, fact.firstReviewAt])
      if (at != null) validateFactInstant(fact, at);
    if (fact.decisionAsOf !== undefined) {
      if (
        fact.metricId !== "pr_accepted_rate" ||
        fact.role !== "author" ||
        !["merged", "closed_unmerged", "pending"].includes(fact.outcome ?? "") ||
        compareSourceInstants(fact.decisionAsOf, scope.to) !== 0 ||
        compareSourceInstants(fact.decisionAsOf, input.cutoff) > 0
      )
        throw new Error("Decision selection must match the reporting window");
      if (
        (fact.outcome === "pending" &&
          ((fact.revision === 0 && fact.state !== "pending") || fact.acceptedAt !== null)) ||
        (fact.outcome !== "pending" &&
          (fact.acceptedAt === null ||
            fact.occurredAt === null ||
            compareSourceInstants(fact.acceptedAt, fact.occurredAt) !== 0))
      )
        throw new Error("Invalid decision selection state");
    }
    if (fact.quantity !== undefined) number(fact.quantity, "Quantity");
    if (policy.aggregation === "sum" && fact.quantity !== undefined && !Number.isSafeInteger(fact.quantity))
      throw new Error("Line quantities require exact safe integers");
    if (!fact.canonicalKey?.trim()) {
      reject([fact], "unknown_canonical_identity");
      continue;
    }
    const bucket = versions.get(fact.id) ?? [];
    bucket.push(fact);
    versions.set(fact.id, bucket);
  }
  const current: MetricFact[] = [];
  const comparisonFact = (fact: MetricFact) => {
    const { mergeTarget, ...legacy } = fact;
    // An optional source extension cannot change any unfiltered legacy comparison.
    if (scope.branch === undefined || mergeTarget === undefined) return legacy;
    try {
      // Separate captures can prove the same event without changing its semantic identity.
      const { proofHash, ...target } = validatePullRequestMergeTarget(mergeTarget);
      return { ...legacy, mergeTarget: target };
    } catch {
      return { ...legacy, mergeTarget };
    }
  };
  for (const bucket of versions.values()) {
    const revision = bucket.reduce((maximum, fact) => Math.max(maximum, fact.revision), -Infinity);
    const latest = bucket.filter((fact) => fact.revision === revision);
    // The same source fact can be observed again without changing its revision.
    // Observation time describes collection, not a competing semantic fact.
    const semantic = (fact: MetricFact) => {
      const { observedAt, ...rest } = comparisonFact(fact);
      return stableJSON(
        pairPolicy
          ? {
              ...rest,
              eventContext: relationshipPairMembership(fact.eventContext),
              currentContext: relationshipPairMembership(fact.currentContext),
            }
          : rest,
      );
    };
    if (new Set(latest.map(semantic)).size !== 1) {
      reject(latest, "conflicting_revision");
      continue;
    }
    current.push(
      latest.sort((a, b) => compareInstants(a.observedAt, b.observedAt) || compare(a.observedAt, b.observedAt))[0]!,
    );
  }
  const targetIdentities = new Map<string, Set<string>>();
  if (scope.branch !== undefined) {
    for (const fact of current) {
      if (!scope.repos.includes(fact.repoId)) continue;
      const target = boundMergeTarget(fact);
      if (!target) continue;
      const { proofHash, ...identity } = target;
      const unit = key(fact.repoId, fact.artifactId);
      const identities = targetIdentities.get(unit) ?? new Set<string>();
      identities.add(stableJSON(identity));
      targetIdentities.set(unit, identities);
    }
  }
  const canonical = new Map<string, MetricFact[]>();
  for (const fact of current) {
    // Select the current correction before admission. An unproved latest
    // membership must never restore a lower revision that previously counted.
    if (policy.metricId === "release_changes") {
      const inclusion = fact.releaseInclusion;
      const sha = (value: unknown) => typeof value === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
      if (
        !inclusion ||
        typeof inclusion !== "object" ||
        Array.isArray(inclusion) ||
        Object.keys(inclusion).sort().join(",") !==
          "mergeCommitSha,proofHash,publishedAt,pullRequestNodeId,releaseCommitSha,releaseId,releaseNodeId,version" ||
        inclusion.version !== "release-inclusion-units/v1" ||
        !Number.isSafeInteger(inclusion.releaseId) ||
        inclusion.releaseId < 1 ||
        typeof inclusion.releaseNodeId !== "string" ||
        !/^[A-Za-z0-9_+=/\-]{1,256}$/.test(inclusion.releaseNodeId) ||
        inclusion.pullRequestNodeId !== fact.artifactId ||
        !fact.artifactId ||
        fact.role !== "author" ||
        !sha(inclusion.mergeCommitSha) ||
        !sha(inclusion.releaseCommitSha) ||
        inclusion.mergeCommitSha.length !== inclusion.releaseCommitSha.length ||
        typeof inclusion.proofHash !== "string" ||
        !/^[a-f0-9]{64}$/.test(inclusion.proofHash) ||
        inclusion.publishedAt !== fact.occurredAt ||
        !fact.occurredAt ||
        !fact.acceptedAt ||
        instant(fact.occurredAt) > instant(fact.acceptedAt)
      ) {
        reject([fact], "release_inclusion_unverified");
        continue;
      }
    }
    const bucket = canonical.get(fact.canonicalKey!) ?? [];
    bucket.push(fact);
    canonical.set(fact.canonicalKey!, bucket);
  }
  const eventFacts: MetricFact[] = [];
  for (const bucket of canonical.values()) {
    // Adapter receipts may differ; semantic fields must agree, including corrections.
    const semantic = (fact: MetricFact) => {
      const { id, observedAt, ...rest } = comparisonFact(fact);
      return stableJSON(
        pairPolicy
          ? {
              ...rest,
              eventContext: relationshipPairMembership(fact.eventContext),
              currentContext: relationshipPairMembership(fact.currentContext),
            }
          : rest,
      );
    };
    if (new Set(bucket.map(semantic)).size !== 1) {
      reject(bucket, "ambiguous_canonical_action");
      continue;
    }
    const fact = [...bucket].sort((a, b) => compareInstants(a.observedAt, b.observedAt) || compare(a.id, b.id))[0]!;
    if (bucket.length > 1)
      reject(
        bucket.filter((item) => item !== fact),
        "duplicate_observation",
      );
    eventFacts.push(fact);
  }
  const conserved = pairPolicy
    ? conserveRelationshipPairs(
        eventFacts,
        rejectedRelationshipEvents,
        input.repositoryIds,
        [...versions.values()].flat(),
      )
    : { facts: eventFacts, audit: [] };
  for (const entry of conserved.audit) audit.push(entry);
  const facts: MetricFact[] = [];
  for (const fact of conserved.facts) {
    if (fact.metricId !== policy.metricId) continue;
    const actor = fact.actorId === null ? undefined : actors.get(fact.actorId);
    let reason: string | null = null;
    if (!actor || actor.kind === "unknown") reason = "unknown_actor";
    else if (actor.publicState === "suppressed") reason = "suppressed";
    else if (!input.repositoryIds.includes(fact.repoId)) reason = "repository_not_allowed";
    else if (scope.repos.length && !scope.repos.includes(fact.repoId)) reason = "repository_filter";
    else if (scope.actors === "user" && actor.kind !== "user") reason = "actor_filter";
    else if (
      scope.actors === "automation" &&
      !["bot", "github_app", "service_account", "system"].includes(actor.kind) &&
      actor.executionMode !== "automated"
    )
      reason = "actor_filter";
    else if (!policy.roles.includes(fact.role) || (scope.roles.length && !scope.roles.includes(fact.role)))
      reason = "role_filter";
    else if (fact.state === "excluded") reason = "excluded_by_policy_or_correction";
    else if (fact.state === "unknown") reason = "unknown_qualification";
    const context = scope.context === "event" ? fact.eventContext : fact.currentContext;
    if (!reason && (scope.projects.length || scope.workstreams.length)) {
      if (!context) reason = "unknown_membership_context";
      else if (scope.projects.length && !scope.projects.some((id) => context.projects.includes(id)))
        reason =
          context.projectScope && scope.projects.some((id) => !context.projectScope!.includes(id))
            ? "unknown_membership_context"
            : "project_filter";
      else if (scope.workstreams.length && !scope.workstreams.some((id) => context.workstreams.includes(id)))
        reason =
          context.workstreamsKnown === false ||
          (requireKnownWorkstreams && context.workstreamsKnown !== true) ||
          (context.workstreamScope !== undefined &&
            scope.workstreams.some((id) => !context.workstreamScope!.includes(id)))
            ? "unknown_membership_context"
            : "workstream_filter";
    }
    if (
      !reason &&
      ["qualified", "reviewed"].includes(fact.state) &&
      (!fact.acceptanceReceipt?.trim() ||
        !fact.acceptedBy?.trim() ||
        fact.acceptedBy === fact.actorId ||
        (fact.subjectActorId === fact.actorId && fact.role === "reviewer"))
    )
      reason = "missing_independent_acceptance";
    if (!reason && ["qualified", "reviewed"].includes(fact.state) && fact.acceptedAt === null)
      reason = "unknown_acceptance_time";
    const at =
      policy.aggregation === "duration"
        ? fact.readyAt
        : fact.state === "pending" || (policy.aggregation === "ratio" && fact.outcome === "pending")
          ? fact.occurredAt
          : fact[policy.dateBasis];
    if (!reason && at == null && policy.aggregation !== "duration") reason = "unknown_effective_time";
    if (!reason && at != null) {
      const selectedDecision = fact.decisionAsOf !== undefined;
      const pendingAtEnd = selectedDecision && fact.outcome === "pending";
      const beforeStart =
        scope.from !== null &&
        (selectedDecision ? compareSourceInstants(at, scope.from) < 0 : instant(at) < instant(scope.from));
      const afterEnd = selectedDecision ? compareSourceInstants(at, scope.to) >= 0 : instant(at) >= instant(scope.to);
      if ((!pendingAtEnd && beforeStart) || afterEnd) reason = "outside_window";
    }
    if (
      !reason &&
      fact.acceptedAt !== null &&
      compareSourceInstants(fact.acceptedAt, input.cutoff) > 0 &&
      ["qualified", "reviewed"].includes(fact.state)
    )
      reason = "acceptance_after_cutoff";
    if (!reason && scope.branch !== undefined) {
      const target = boundMergeTarget(fact);
      if (!target) reason = "unknown_merge_target";
      else if ((targetIdentities.get(key(fact.repoId, fact.artifactId))?.size ?? 0) > 1)
        reason = "conflicting_merge_target";
      else if (target.branch !== scope.branch) reason = "branch_filter";
    }
    if (reason) {
      reject([fact], reason);
      continue;
    }
    facts.push(fact);
  }
  const grouped = new Map<string, MetricFact[]>();
  for (const fact of facts) {
    let group = fact.canonicalKey!;
    if (policy.metricId === "release_changes") {
      // Filter and correction selection above must precede lifetime conservation.
      // A prior release outside this window or context cannot hide current work.
      group =
        conserveReleaseWork && scope.from === null
          ? key("release-inclusion-units/v1", fact.repoId, fact.artifactId, fact.actorId)
          : key(
              "release-inclusion-units/v1",
              fact.repoId,
              fact.releaseInclusion!.releaseNodeId,
              fact.artifactId,
              fact.actorId,
            );
    }
    if (policy.groupBy !== "canonical") {
      if (!fact.artifactId) {
        reject([fact], "unknown_artifact_identity");
        continue;
      }
      group = key(fact.actorId, fact.artifactId);
      if (policy.groupBy === "actor_artifact_state_interval") {
        if (!fact.rawState || !fact.occurredAt) {
          reject([fact], "unknown_raw_state_or_time");
          continue;
        }
        group = key(
          fact.actorId,
          fact.artifactId,
          fact.rawState,
          // Integer-second buckets intentionally discard subsecond position,
          // after precise admission and window selection have completed.
          Math.floor(Date.parse(fact.occurredAt) / (policy.groupingSeconds! * 1000)),
        );
      } else if (policy.groupBy === "actor_artifact_interval") {
        // A versioned daily unit shares its facets, not repositories, actors
        // or metric kinds. Use the same explicitly selected clock as the
        // window filter; observation/replay time never supplies a missing date.
        const at = fact.state === "pending" ? fact.occurredAt : fact[policy.dateBasis];
        if (!at) {
          reject([fact], "unknown_effective_time");
          continue;
        }
        group = key(
          fact.metricId,
          fact.repoId,
          fact.actorId,
          fact.artifactId,
          Math.floor(Date.parse(at) / (policy.groupingSeconds! * 1000)),
        );
      }
    }
    const bucket = grouped.get(group) ?? [];
    bucket.push(fact);
    grouped.set(group, bucket);
  }
  const retained: MetricFact[] = [];
  for (const bucket of grouped.values()) {
    // Repeated observations can share a policy unit; they cannot supply
    // contradictory arithmetic evidence and silently win by ID ordering.
    const eligible = bucket.filter((fact) => policy.rankedStates.includes(fact.state as never));
    const measurement = (fact: MetricFact) =>
      policy.aggregation === "sum"
        ? [fact.quantity]
        : policy.aggregation === "ratio"
          ? [fact.outcome]
          : [
              fact.readyAt == null ? fact.readyAt : instant(fact.readyAt),
              fact.firstReviewAt == null ? fact.firstReviewAt : instant(fact.firstReviewAt),
            ];
    if (policy.aggregation !== "count" && new Set(eligible.map((fact) => stableJSON(measurement(fact)))).size > 1) {
      reject(bucket, "conflicting_policy_unit");
      continue;
    }
    // Qualified evidence takes precedence over pending work for the same unit.
    const ordered = bucket.sort(
      (a, b) =>
        Number(!policy.rankedStates.includes(a.state as never)) -
          Number(!policy.rankedStates.includes(b.state as never)) ||
        compareInstants(a.occurredAt ?? null, b.occurredAt ?? null) ||
        compare(a.id, b.id),
    );
    retained.push(ordered[0]!);
    if (ordered.length > 1) reject(ordered.slice(1), "repeated_policy_unit");
  }
  return {
    facts: retained.sort((a, b) => compare(a.id, b.id)),
    audit: audit
      .filter((entry) => !pairPolicy || entry.factIds.some((id) => requestedFactIds.has(id)))
      .map((entry) =>
        pairPolicy ? { ...entry, factIds: entry.factIds.filter((id) => requestedFactIds.has(id)) } : entry,
      )
      .sort((a, b) => compare(key(a.reason, a.factIds), key(b.reason, b.factIds))),
  };
}

/** Public portfolio selection is descriptive, never a new ranking or score.
 * Reuse correction, identity, authorization, context and independent acceptance checks.
 * Use actual occurrence time and retain canonical actions, including unaccepted work.
 */
export function selectPortfolioFacts(
  input: FrozenInput,
  policy: MetricPolicy,
  requestedScope: MetricScope,
): MetricFact[] {
  validateMetricPolicy(policy);
  const scope = canonicalScope(requestedScope);
  const selected = prepare(
    input,
    {
      ...policy,
      aggregation: "count",
      dateBasis: "occurredAt",
      groupBy: "canonical",
      rankedStates: ["qualified", "reviewed", "observed"],
      rank: false,
    },
    scope,
    false,
  ).facts.filter((fact) => fact.role !== "unknown" && fact.occurredAt !== null);
  const observed = new Map(selected.filter((fact) => fact.state === "observed").map((fact) => [fact.id, fact]));
  const acceptedSources = new Set<string>();
  for (const fact of selected) {
    if (
      fact.metricId !== "localization" ||
      !["qualified", "reviewed"].includes(fact.state) ||
      !fact.recognitionSourceFactId
    )
      continue;
    const source = observed.get(fact.recognitionSourceFactId);
    if (
      source?.metricId === "localization" &&
      source.actorId === fact.actorId &&
      source.artifactId === fact.artifactId &&
      source.repoId === fact.repoId &&
      source.role === fact.role &&
      source.rawState === fact.rawState &&
      source.occurredAt === fact.occurredAt
    )
      // Recollection changes no source unit. Its first observation may precede
      // the later observation from which an independently accepted copy arose.
      acceptedSources.add(source.id);
  }
  // Keep both immutable facts for audit and recomputation, but expose one current
  // locale activity unit. An unaccepted or unrelated language remains observed.
  return selected.filter((fact) => !acceptedSources.has(fact.id));
}

/** Private accepted source units for descriptive event-time derivations.
 * Preserve the selected source policy's evidence class, roles and per-unit
 * quantity admission; this selector does not calculate source totals.
 * Breadth uses source occurrence time, never a later acceptance or
 * current association. Canonical source units avoid collapsing distinct event
 * contexts through an unrelated source board's interval grouping.
 */
export function selectAcceptedActivityFacts(
  input: FrozenInput,
  policy: MetricPolicy,
  requestedScope: MetricScope,
): { facts: MetricFact[]; audit: AuditEntry[]; complete: boolean; scope: MetricScope } {
  validateMetricPolicy(policy);
  const metric = getMetricDefinition(policy.metricId)!;
  if (
    policy.rankedStates[0] === "observed" ||
    !["count", "sum"].includes(policy.aggregation) ||
    policy.groupBy !== "canonical" ||
    metric.family === "breadth"
  )
    throw new Error("Accepted activity requires an explicit qualified or reviewed canonical source policy");
  const scope = canonicalScope(requestedScope);
  if (scope.context !== "event") throw new Error("Activity breadth requires event-time context");
  // Breadth retains each release-time source unit and its historical mapping.
  // Lifetime PR-work conservation belongs to the release total, not this selector.
  // Breadth treats omitted historical mapping markers as unknown, including
  // negative filter matches. Existing board/portfolio legacy-marker handling is unchanged.
  const prepared = prepare(input, { ...policy, dateBasis: "occurredAt" }, scope, false, true);
  const facts: MetricFact[] = [];
  for (const fact of prepared.facts) {
    const reason = !policy.rankedStates.includes(fact.state as never)
      ? "source_evidence_class_not_accepted"
      : !fact.artifactId?.trim()
        ? "unknown_artifact_identity"
        : policy.aggregation === "sum" && fact.quantity === undefined
          ? "unknown_source_quantity"
          : null;
    if (reason) prepared.audit.push({ factIds: [fact.id], actorId: fact.actorId, reason });
    else facts.push(fact);
  }
  return {
    facts,
    audit: prepared.audit.sort((a, b) => compare(key(a.reason, a.factIds), key(b.reason, b.factIds))),
    complete:
      hasCompleteSourceCoverage(input, policy, scope) &&
      !hasUncertainty(prepared) &&
      !prepared.audit.some((entry) => entry.reason === "unknown_source_quantity"),
    scope,
  };
}

/** Private collaboration admission over all retained acceptance history before the
 * selected end. Pair formation applies the requested start after both proofs are
 * known; source occurrence time is never substituted for acceptance time.
 */
export function selectAcceptedCollaborationFacts(
  input: FrozenInput,
  policy: MetricPolicy,
  requestedScope: MetricScope,
): { scope: MetricScope; facts: MetricFact[]; audit: AuditEntry[] } {
  for (const values of [
    policy.roles,
    policy.sources,
    policy.rankedStates,
    requestedScope.roles,
    requestedScope.repos,
    requestedScope.projects,
    requestedScope.workstreams,
  ]) {
    if (!Array.isArray(values)) throw new Error("Collaboration policy and scope lists must be arrays");
    for (let index = 0; index < values.length; index++)
      if (!Object.hasOwn(values, index)) throw new Error("Collaboration policy and scope lists must be dense");
  }
  validateMetricPolicy(policy);
  const scope = canonicalScope(requestedScope);
  if (scope.actors !== "user" || scope.context !== "event")
    throw new Error("Collaborations require the user and event-context selection");
  if (
    policy.aggregation !== "count" ||
    policy.groupBy !== "canonical" ||
    !["qualified", "reviewed"].includes(policy.rankedStates[0]!)
  )
    throw new Error("Collaborations require accepted canonical count source policies");
  const prepared = prepare(
    input,
    { ...policy, dateBasis: "acceptedAt", rank: false },
    { ...scope, from: null, period: "all" },
    false,
  );
  const actors = new Map(input.actors.map((actor) => [actor.id, actor]));
  const facts: MetricFact[] = [];
  const audit = [...prepared.audit];
  for (const fact of prepared.facts) {
    const actor = fact.actorId === null ? undefined : actors.get(fact.actorId);
    let reason: string | null = null;
    if (fact.state !== policy.rankedStates[0]) reason = "collaboration_evidence_class";
    else if (actor?.kind !== "user" || actor.publicState !== "visible" || actor.executionMode === "automated")
      reason = "collaboration_actor_unavailable";
    else if (!["author", "coauthor", "reviewer"].includes(fact.role)) reason = "collaboration_role_ineligible";
    else if (typeof fact.occurredAt !== "string") reason = "collaboration_source_time_unknown";
    else if (compareSourceInstants(fact.acceptedAt!, fact.occurredAt) < 0)
      reason = "collaboration_acceptance_before_source";
    else if (compareSourceInstants(fact.observedAt, fact.occurredAt) < 0)
      reason = "collaboration_observation_before_source";
    else if (typeof fact.artifactId !== "string" || !fact.artifactId.trim())
      reason = "collaboration_artifact_identity_unknown";
    if (reason) audit.push({ factIds: [fact.id], actorId: fact.actorId, reason });
    else facts.push(fact);
  }
  return { scope, facts, audit };
}

export function aggregateMetric(
  input: FrozenInput,
  policy: MetricPolicy,
  requestedScope: MetricScope,
): MetricAggregate {
  validateMetricPolicy(policy);
  const scope = canonicalScope(requestedScope);
  const prepared = prepare(input, policy, scope);
  const complete = hasCompleteSourceCoverage(input, policy, scope) && !hasUncertainty(prepared);
  const actorsById = new Map(input.actors.map((actor) => [actor.id, actor]));
  const byActor = new Map<string, MetricFact[]>();
  for (const fact of prepared.facts) {
    const bucket = byActor.get(fact.actorId!) ?? [];
    bucket.push(fact);
    byActor.set(fact.actorId!, bucket);
  }
  const rows: AggregateRow[] = [];
  for (const [actorId, facts] of byActor) {
    const actor = actorsById.get(actorId)!;
    const eligible = facts.filter((fact) => policy.rankedStates.includes(fact.state as never));
    const pendingEvidence = facts.filter(
      (fact) =>
        fact.state === "pending" ||
        (policy.aggregation === "ratio" &&
          policy.rankedStates.includes(fact.state as never) &&
          fact.outcome === "pending"),
    );
    const pending = pendingEvidence.length;
    const unknown = facts.some(
      (fact) => fact.state === "unknown" || (policy.aggregation === "ratio" && fact.outcome === undefined),
    );
    const row: AggregateRow = {
      actorId,
      login: actor.publicState === "deleted" ? null : actor.login,
      value: null,
      state: "unknown",
      pending,
      pendingEvidence,
      numerator: null,
      denominator: null,
      sampleCount: 0,
      samples: [],
      p75: null,
      censored: 0,
      missingReadiness: 0,
      evidenceIds: [],
      evidence: [],
      rank: null,
      tied: false,
    };
    const valueEvidence =
      policy.aggregation === "ratio"
        ? eligible.filter((fact) => fact.outcome === "merged" || fact.outcome === "closed_unmerged")
        : eligible;
    row.evidenceIds = valueEvidence.map((fact) => fact.id);
    row.evidence = valueEvidence.map((fact) => ({
      id: fact.id,
      effectiveAt: policy.aggregation === "duration" ? (fact.readyAt ?? null) : fact[policy.dateBasis],
      observedAt: fact.observedAt,
      comparisonSignature: stableJSON([
        fact.actorId,
        fact.revision,
        fact.role,
        fact.state,
        comparisonInstant(fact, fact[policy.dateBasis]),
        fact.quantity ?? null,
        fact.outcome ?? null,
        comparisonInstant(fact, fact.readyAt),
        comparisonInstant(fact, fact.firstReviewAt),
      ]),
    }));
    if (policy.aggregation === "count" || policy.aggregation === "sum") {
      const missing = policy.aggregation === "sum" && eligible.some((fact) => fact.quantity === undefined);
      row.sampleCount = eligible.length;
      if (!missing && eligible.length > 0)
        row.value = number(
          policy.aggregation === "count" ? eligible.length : eligible.reduce((sum, fact) => sum + fact.quantity!, 0),
          "Aggregate",
        );
      if (policy.aggregation === "sum" && row.value !== null && !Number.isSafeInteger(row.value))
        throw new Error("Line aggregates require exact safe integers");
    } else if (policy.aggregation === "ratio") {
      const decided = eligible.filter((fact) => fact.outcome === "merged" || fact.outcome === "closed_unmerged");
      row.numerator = decided.filter((fact) => fact.outcome === "merged").length;
      row.denominator = decided.length;
      row.sampleCount = decided.length;
      if (decided.length >= policy.minimumSamples) row.value = row.numerator / row.denominator;
      else row.state = "insufficient_sample";
    } else {
      for (const fact of eligible) {
        if (fact.readyAt == null) {
          row.missingReadiness++;
          continue;
        }
        if (fact.firstReviewAt == null || instant(fact.firstReviewAt) > instant(input.cutoff)) {
          row.censored++;
          continue;
        }
        if (instant(fact.firstReviewAt) < instant(fact.readyAt)) {
          row.missingReadiness++;
          continue;
        }
        row.samples.push((instant(fact.firstReviewAt) - instant(fact.readyAt)) / 3600000);
      }
      row.samples.sort((a, b) => a - b);
      row.sampleCount = row.samples.length;
      if (row.samples.length >= policy.minimumSamples) {
        const n = row.samples.length,
          middle = Math.floor(n / 2);
        row.value = n % 2 ? row.samples[middle]! : (row.samples[middle - 1]! + row.samples[middle]!) / 2;
        row.p75 = row.samples[Math.ceil(n * 0.75) - 1]!;
      } else row.state = "insufficient_sample";
    }
    if (row.value !== null) {
      if (row.value === 0 && (!complete || unknown)) row.value = null;
      else row.state = complete && !unknown ? (row.value === 0 ? "zero" : "measured") : "partial";
    }
    rows.push(row);
  }
  rows.sort(
    (a, b) =>
      (policy.rank ? (b.value ?? -1) - (a.value ?? -1) : 0) ||
      compare(a.login ?? a.actorId, b.login ?? b.actorId) ||
      compare(a.actorId, b.actorId),
  );
  let rank = 0,
    previous: number | null = null;
  const rankCounts = new Map<number, number>();
  for (const row of rows) {
    if (!policy.rank || row.value === null) continue;
    if (previous !== row.value) rank++;
    row.rank = rank;
    previous = row.value;
    rankCounts.set(rank, (rankCounts.get(rank) ?? 0) + 1);
  }
  for (const row of rows) row.tied = row.rank !== null && (rankCounts.get(row.rank) ?? 0) > 1;
  const audit = [
    ...prepared.audit,
    ...prepared.facts
      .filter((fact) => fact.state !== "pending" && !policy.rankedStates.includes(fact.state as never))
      .map((fact) => ({ factIds: [fact.id], actorId: fact.actorId, reason: "evidence_class_not_ranked" })),
    ...prepared.facts
      .filter(
        (fact) =>
          policy.aggregation === "ratio" &&
          policy.rankedStates.includes(fact.state as never) &&
          !["merged", "closed_unmerged", "pending"].includes(fact.outcome ?? ""),
      )
      .map((fact) => ({ factIds: [fact.id], actorId: fact.actorId, reason: "unknown_ratio_outcome" })),
    ...rows.flatMap((row) =>
      row.pendingEvidence.map((fact) => ({ factIds: [fact.id], actorId: row.actorId, reason: "pending_not_ranked" })),
    ),
    ...rows.flatMap((row) =>
      row.evidenceIds.map((id) => ({
        factIds: [id],
        actorId: row.actorId,
        reason: `included_${policy.aggregation}_${policy.rankedStates[0]}`,
      })),
    ),
  ].sort((a, b) => compare(key(a.reason, a.factIds), key(b.reason, b.factIds)));
  return {
    metricId: policy.metricId,
    policyVersion: policy.version,
    policySignature: stableJSON(policy),
    definitionVersion: policy.definitionVersion,
    unit: policy.unit,
    aggregation: policy.aggregation,
    publicEnabled: false,
    scope,
    datasetId: input.datasetId,
    cutoff: input.cutoff,
    backfillRevision: input.backfillRevision,
    coverage: complete ? "complete" : "incomplete",
    rows,
    audit,
  };
}

/** Stable JSON for replay receipts; object field order cannot change comparisons. */
export function stableJSON(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJSON).join(",")}]`;
  return `{${Object.keys(value)
    .sort(compare)
    .map((name) => `${JSON.stringify(name)}:${stableJSON((value as Record<string, unknown>)[name])}`)
    .join(",")}}`;
}

/** Minimum immutable history used for movement, excluding audit/provider records. */
export type RankComparisonInput = Pick<
  MetricAggregate,
  | "metricId"
  | "policyVersion"
  | "policySignature"
  | "definitionVersion"
  | "unit"
  | "aggregation"
  | "scope"
  | "cutoff"
  | "backfillRevision"
  | "coverage"
> & { rows: Pick<AggregateRow, "actorId" | "value" | "rank" | "evidence">[] };
function compatibleScopes(before: RankComparisonInput, after: RankComparisonInput): boolean {
  if (stableJSON(before.scope) === stableJSON(after.scope)) return true;
  const { from: beforeFrom, to: beforeTo, ...beforeFilters } = before.scope;
  const { from: afterFrom, to: afterTo, ...afterFilters } = after.scope;
  if (
    stableJSON(beforeFilters) !== stableJSON(afterFilters) ||
    !before.scope.period ||
    before.scope.period === "custom"
  )
    return false;
  // A collection can observe facts after its event-window boundary. Retain that
  // clock separately; it must cover, rather than equal, the selected window.
  if (instant(beforeTo) > instant(before.cutoff) || instant(afterTo) > instant(after.cutoff)) return false;
  if (["month", "quarter", "year"].includes(before.scope.period)) return beforeFrom === afterFrom;
  return true; // Validated rolling/all-time bounds of the same named preset.
}

export function compareRankMovement(
  before: RankComparisonInput,
  after: RankComparisonInput,
): {
  actorId: string;
  state: "comparable" | "new_entrant" | "unavailable";
  delta: number | null;
  reason: string | null;
}[] {
  const reason =
    before.metricId !== after.metricId || before.unit !== after.unit || before.aggregation !== after.aggregation
      ? "different_metric"
      : before.policySignature !== after.policySignature ||
          before.policyVersion !== after.policyVersion ||
          before.definitionVersion !== after.definitionVersion
        ? "mixed_policy_versions"
        : !compatibleScopes(before, after)
          ? "different_scope_or_window"
          : before.coverage !== "complete" || after.coverage !== "complete"
            ? "insufficient_history"
            : before.backfillRevision !== after.backfillRevision
              ? "backfill_or_reconciliation"
              : instant(before.cutoff) > instant(after.cutoff)
                ? "reversed_snapshots"
                : instant(before.scope.to) > instant(after.scope.to)
                  ? "reversed_snapshots"
                  : null;
  const beforeEvidence = new Map(before.rows.flatMap((row) => row.evidence.map((item) => [item.id, item] as const)));
  const afterEvidence = new Map(after.rows.flatMap((row) => row.evidence.map((item) => [item.id, item] as const)));
  const compareEvidenceTime = (at: string, boundary: string, metric: RankComparisonInput) => {
    if (metric.metricId === "pr_accepted_rate" && metric.aggregation === "ratio") {
      pullRequestDecisionInstantSchema.parse(at);
      instant(boundary);
      return compareSourceInstants(at, boundary);
    }
    return instant(at) - instant(boundary);
  };
  const lateHistory = [...afterEvidence.values()].some(
    (item) =>
      !beforeEvidence.has(item.id) &&
      item.effectiveAt !== null &&
      compareEvidenceTime(item.effectiveAt, before.scope.to, after) < 0,
  );
  const missingComparisonHistory = [...beforeEvidence.values(), ...afterEvidence.values()].some(
    (item) => !item.comparisonSignature,
  );
  const corrected = [...beforeEvidence.values()].some((item) => {
    const next = afterEvidence.get(item.id);
    if (next) return item.comparisonSignature !== next.comparisonSignature;
    return (
      after.scope.from === null ||
      item.effectiveAt === null ||
      compareEvidenceTime(item.effectiveAt, after.scope.from, before) >= 0
    );
  });
  const beforeRows = new Map<string, RankComparisonInput["rows"][number]>();
  // Preserve the first matching row used by the previous lookup, including for
  // callers that have not independently validated actor uniqueness.
  for (const row of before.rows) if (!beforeRows.has(row.actorId)) beforeRows.set(row.actorId, row);
  return after.rows.map((row) => {
    const previous = beforeRows.get(row.actorId);
    if (reason || missingComparisonHistory || lateHistory || corrected || row.rank === null || previous?.rank === null)
      return {
        actorId: row.actorId,
        state: "unavailable",
        delta: null,
        reason:
          reason ??
          (missingComparisonHistory
            ? "insufficient_evidence_history"
            : lateHistory
              ? "late_history"
              : corrected
                ? "corrected_or_removed_evidence"
                : "unranked_metric"),
      };
    if (!previous) return { actorId: row.actorId, state: "new_entrant", delta: null, reason: null };
    return { actorId: row.actorId, state: "comparable", delta: previous.rank! - row.rank, reason: null };
  });
}

export function comparePolicies(
  input: FrozenInput,
  beforePolicy: MetricPolicy,
  afterPolicy: MetricPolicy,
  scope: MetricScope,
) {
  if (beforePolicy.metricId !== afterPolicy.metricId)
    throw new Error("Recalculation requires the same metric on one frozen dataset");
  if (beforePolicy.version === afterPolicy.version && stableJSON(beforePolicy) !== stableJSON(afterPolicy))
    throw new Error("Changed policy semantics require a new policy version");
  const before = aggregateMetric(input, beforePolicy, scope),
    after = aggregateMetric(input, afterPolicy, scope);
  const beforeByActor = new Map(before.rows.map((row) => [row.actorId, row]));
  const afterByActor = new Map(after.rows.map((row) => [row.actorId, row]));
  const changes = unique([...beforeByActor.keys(), ...afterByActor.keys()])
    .map((actorId) => {
      const old = beforeByActor.get(actorId),
        next = afterByActor.get(actorId);
      const beforeEvidence = new Set(old?.evidenceIds ?? []);
      const afterEvidence = new Set(next?.evidenceIds ?? []);
      return {
        actorId,
        beforeValue: old?.value ?? null,
        afterValue: next?.value ?? null,
        beforeRank: old?.rank ?? null,
        afterRank: next?.rank ?? null,
        included: (next?.evidenceIds ?? []).filter((id) => !beforeEvidence.has(id)),
        excluded: (old?.evidenceIds ?? []).filter((id) => !afterEvidence.has(id)),
      };
    })
    .filter(
      (change) =>
        stableJSON([change.beforeValue, change.beforeRank]) !== stableJSON([change.afterValue, change.afterRank]) ||
        change.included.length ||
        change.excluded.length,
    );
  return {
    datasetId: input.datasetId,
    cutoff: input.cutoff,
    before,
    after,
    changes,
    approvalRequired: true as const,
    releaseNotesRequired: true as const,
  };
}

/** Pure release manifest validation. The caller must authenticate the approver and persist it atomically. */
export function planPolicyRelease(
  comparison: ReturnType<typeof comparePolicies>,
  decision: {
    approverId: string;
    designatedApproverIds: readonly string[];
    approvalReceipt: string;
    releaseNotes: string;
  },
) {
  required(decision.approverId, "Approver ID");
  required(decision.approvalReceipt, "Approval receipt");
  required(decision.releaseNotes, "Release notes");
  if (!decision.designatedApproverIds.includes(decision.approverId)) throw new Error("Designated approval is required");
  return {
    metricId: comparison.after.metricId,
    datasetId: comparison.datasetId,
    cutoff: comparison.cutoff,
    previousVersion: comparison.before.policyVersion,
    targetVersion: comparison.after.policyVersion,
    previousSignature: comparison.before.policySignature,
    targetSignature: comparison.after.policySignature,
    approverId: decision.approverId,
    approvalReceipt: decision.approvalReceipt,
    releaseNotes: decision.releaseNotes,
    publicEnabled: false as const,
  };
}

export function participationView(
  input: FrozenInput,
  policy: MetricPolicy,
  requestedScope: MetricScope,
  history?: { originAt: string; reviewReceipt: string },
) {
  validateMetricPolicy(policy);
  const scope = canonicalScope(requestedScope);
  // Newcomer discovery uses policy-eligible organization history, independent of selected lenses.
  const { branch, ...historySelection } = scope;
  const historyScope = canonicalScope({
    ...historySelection,
    period: "custom",
    from: history?.originAt ?? null,
    repos: [],
    projects: [],
    workstreams: [],
    roles: [],
  });
  if (history) {
    instant(history.originAt);
    required(history.reviewReceipt, "History origin review receipt");
  }
  const historical = prepare(input, policy, historyScope);
  const all = historical.facts.filter((fact) => policy.rankedStates.includes(fact.state as never));
  const current = prepare(input, policy, scope).facts.filter((fact) =>
    policy.rankedStates.includes(fact.state as never),
  );
  const complete =
    Boolean(history) &&
    (scope.from === null || instant(history!.originAt) <= instant(scope.from)) &&
    hasCompleteSourceCoverage(input, policy, historyScope) &&
    !hasUncertainty(historical);
  const monday = (at: string) => {
    // Already-validated timestamps are reduced only to a calendar-week bucket.
    const date = new Date(at);
    date.setUTCHours(0, 0, 0, 0);
    date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
    return date.toISOString();
  };
  const weeks = new Set<string>();
  if (scope.from !== null)
    for (let at = instant(monday(scope.from)); at < instant(scope.to); at += 604800000)
      weeks.add(new Date(at).toISOString());
  const indexByActor = (facts: MetricFact[]) => {
    const indexed = new Map<string, MetricFact[]>();
    for (const fact of facts) {
      const actorId = fact.actorId!;
      const bucket = indexed.get(actorId) ?? [];
      bucket.push(fact);
      indexed.set(actorId, bucket);
    }
    return indexed;
  };
  const historyByActor = indexByActor(all);
  const currentByActor = indexByActor(current);
  return unique([...currentByActor.keys()]).map((actorId) => {
    const historyFacts = (historyByActor.get(actorId) ?? []).sort(
      (a, b) => compareInstants(a[policy.dateBasis], b[policy.dateBasis]) || compare(a.id, b.id),
    );
    const first = historyFacts[0];
    const activeWeeks = unique(
      currentByActor
        .get(actorId)!
        .flatMap((fact) => (fact[policy.dateBasis] === null ? [] : [monday(fact[policy.dateBasis]!)])),
    );
    return {
      actorId,
      firstObservedAt: first?.observedAt ?? null,
      firstContributionAt: first?.[policy.dateBasis] ?? null,
      firstContributionId: first?.id ?? null,
      newcomer:
        !complete || !first || scope.from === null
          ? null
          : compareSourceInstants(first[policy.dateBasis]!, scope.from) >= 0 &&
            compareSourceInstants(first[policy.dateBasis]!, scope.to) < 0,
      historyCoverage: complete ? "complete_known_history" : "incomplete",
      caveat:
        "First observed qualifying contribution in reviewed known history; not employment start or proof of no earlier work.",
      activeWeeks,
      denominatorWeeks: scope.from === null ? null : weeks.size,
      ranked: false as const,
    };
  });
}
