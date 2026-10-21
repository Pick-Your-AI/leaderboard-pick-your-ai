import type { RankSnapshotHistory } from "./rank-comparison.js";
import type { ParticipationHistoryRead } from "./participation-history.js";
import { projectPhysicalContext } from "./physical-context.js";
import { projectWorkstreamHelp } from "./workstream-help.js";
import {
  canonicalPublicScope,
  publicProfilePresentationSchema,
  publicProfilePresentationMatches,
  safePublicGithubUrl,
  type PublicProfilePresentation,
  publicScopeKey,
  type PublicScope,
  type PublicWindowPeriod,
  publicDocumentationReasons,
  publicDocumentationRecognitionReasons,
  publicReproductionRecognitionReasons,
  publicMaintenanceClassificationReasons,
  matchesActorFilter,
  type ActorFilter,
  publicEvidenceMetadataSchema,
  type PublicEvidenceMetadata,
  publicProjectContextSchema,
  publicProjectContextMatches,
  type PublicProjectContext,
  actorSchema,
  artifactSchema,
  publicArtifactIdSchema,
  contributionSchema,
  metricResultSchema,
  pendingCountSchema,
  snapshotSchema,
  sourceEventSchema,
  rankingPresentationPolicySchema,
  physicalSnapshotContextSchema,
  physicalMetricIds,
  physicalContextLimits,
  type PhysicalSnapshotContext,
  type PublicPhysicalContext,
  type RankingPresentationPolicy,
  type Actor,
  type Artifact,
  type Contribution,
  type MetricResult,
  type MetricDefinition,
  type PendingCount,
  type Snapshot,
  type PublicWorkstreamHelp,
} from "@pick-your-ai/contracts";
import { metricRegistryV1, stableJSON } from "@pick-your-ai/metrics";
import { compareSourceInstants } from "./source-time.js";

export type { PublicScope } from "@pick-your-ai/contracts";
export interface PublicEvidence {
  evidenceMetadata?: PublicEvidenceMetadata;
  projectContext?: PublicProjectContext;
  artifact: Artifact;
  contribution: Contribution;
  occurredAt: string | null;
  sourceRevision: string | null;
  sourceRevisionUrl: string | null;
}
export interface PortfolioEvidence extends PublicEvidence {
  activityState: "observed" | "pending" | "accepted" | "unknown";
  observedAt: string | null;
  /** Provider-private native pending selection; the public projection always removes it. */
  decisionAsOf?: string;
}
export interface PublicActor {
  actorId: string;
  actor: Actor;
  state: "public" | "hidden" | "deleted" | "unlinked";
}
export interface PublicRow {
  actorId: string;
  result: MetricResult;
  evidenceIds: string[];
  pending?: PendingCount;
  physicalContext?: PublicPhysicalContext;
}
export interface PublicDiagnostic {
  pending?: PendingCount;
  metricId: string;
  actorId: string;
  numerator: number | null;
  denominator: number | null;
  sampleCount: number;
  censored: number;
  missingReadiness: number;
  p75: number | null;
}
export interface PublishedSnapshot {
  approvedPublic: true;
  scope: PublicScope;
  snapshot: Snapshot;
  actors: PublicActor[];
  rows: PublicRow[];
  evidence: PublicEvidence[];
  portfolioEvidence?: PortfolioEvidence[];
  /** Explicit reviewed help, dependent on this exact accepted portfolio and current controls. */
  reviewedWorkstreamHelp?: PublicWorkstreamHelp[];
  /** Exact pending policy-unit receipts, separate from accepted and portfolio evidence. */
  pendingEvidence?: PortfolioEvidence[];
  /** Provider-private original LOC receipts and merge provenance. Never serialize. */
  physicalContexts?: PhysicalSnapshotContext[];
  physicalEvidence?: PublicEvidence[];
  /** Approved per-metric direction; the API does not infer comparability or scoring. */
  ranking: { metricId: string; direction: "ascending" | "descending"; rank?: boolean }[];
  /** Captured with this snapshot; absent legacy policy must never be inferred. */
  rankingPresentationPolicy?: RankingPresentationPolicy;
  disabledMetrics?: { id: string; reason: string; policyVersion: string; policyLink: string | null }[];
  methodology?: { metricId: string; policyVersion: string; policySignature: string; policyLink: string | null }[];
  diagnostics?: PublicDiagnostic[];
}
/** Current receipts for an authorized repository, separate from frozen source coverage.
 * No source connectivity, historical completeness or publication success is implied.
 */
export interface PublicSourceHealth {
  scopeId: string;
  state: "reconciled" | "no_activity_in_window" | "collecting" | "degraded" | "unknown";
  lastAttemptAt: string | null;
  lastSuccessfulSync: string | null;
  reconciledThrough: string | null;
  /** Age of oldest unfinished retained supported webhook receipt, not delivery latency. */
  webhookLagSeconds: number | null;
  webhookState: "idle" | "pending" | "degraded" | "unknown";
}
/** Current controls must be read atomically even for a historical snapshot. */
export interface PublicRead {
  /** At most one actor's current opted-in text, never part of the frozen snapshot. */
  presentation?: PublicProfilePresentation | null;
  /** Must be scoped and read under the same current source authorization as selected. */
  currentSourceHealth?: PublicSourceHealth[];
  /** Applied only after current privacy projection; never a source authorization. */
  actorFilter?: ActorFilter;
  head: { snapshotId: string; revision: number; publishedAt: string };
  selected: PublishedSnapshot;
  controls: {
    version: string;
    suppressedActorIds: string[];
    suppressedArtifactIds: string[];
    /** Provider-private exact qualified units; absent for legacy correction controls. */
    suppressedContributionIds?: string[];
    revokedSnapshotIds: string[];
  };
}
export interface PublicComparisonSelection {
  snapshotId: string;
  scope: PublicScope;
}
/** Provider-private pairing. Never serialize this object or either history receipt. */
export interface PublicComparisonRead {
  current: PublicRead;
  previous: PublicRead | null;
  currentHistory: RankSnapshotHistory | null;
  previousHistory: RankSnapshotHistory | null;
}
/** Provider-private choices from one current authorization/source boundary. */
export interface PublicWindowsRead {
  scope: PublicScope;
  windows: { period: PublicWindowPeriod; read: PublicRead }[];
}
export interface PublicSnapshotSource {
  /** Optional single-actor read with the same current authorization/privacy fence.
   * A route ID is a selector only. Legacy sources may omit this capability.
   */
  readProfile?(
    scope: PublicScope,
    snapshotId: string | null,
    actorId: string,
    signal: AbortSignal,
  ): Promise<PublicRead | null>;
  /** Enumerate only explicitly labeled, currently confirmed publication choices. */
  readWindows?(scope: PublicScope, signal: AbortSignal): Promise<PublicWindowsRead | null>;
  /** Optional trusted server capability. Read the selected input and full approved
   * organization history under one protected admission/source-lock boundary and
   * a final current privacy fence. Receipt strings are not authorization. Public
   * requests cannot activate it. The pipeline exposes it only when protected host
   * code supplies its separate participationHistoryAuthority capability.
   */
  readParticipationHistory?(
    scope: PublicScope,
    snapshotId: string | null,
    actorId: string,
    signal: AbortSignal,
  ): Promise<ParticipationHistoryRead | null>;
  /** Pair under one authorization/source-lock boundary and final current privacy fence. */
  readComparison?(
    scope: PublicScope,
    snapshotId: string | null,
    previous: PublicComparisonSelection,
    signal: AbortSignal,
  ): Promise<PublicComparisonRead | null>;
  /** null means absent/unapproved/expired. Do not return raw ingestion replay documents.
   * Implementations must honor signal cancellation and enforce current controls.
   */
  read(scope: PublicScope, snapshotId: string | null, signal: AbortSignal): Promise<PublicRead | null>;
  /** Optional current diagnostics with the identical publication/privacy boundary.
   * Ordinary board and evidence reads need not scan the operational receipt stores.
   */
  readHealth?(scope: PublicScope, snapshotId: string | null, signal: AbortSignal): Promise<PublicRead | null>;
}
export const unavailableSource: PublicSnapshotSource = {
  async read() {
    return null;
  },
};

export class PublicReadError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

/** Narrow whole actor aggregates and every proof view before ranking or pagination.
 * User accounts may also have positively evidenced automated execution. The views
 * can overlap; neither account type nor unknown execution certifies manual work.
 * This requires an already validated projectRead result and does not mutate it.
 */
export function filterPublicActors(read: PublicRead, filter: ActorFilter): PublicRead {
  const actors = read.selected.actors.filter((entry) => matchesActorFilter(entry.actor, filter));
  const ids = new Set(actors.map((entry) => entry.actorId));
  const included = (entry: PublicEvidence) => ids.has(entry.contribution.actorId ?? "");
  return {
    ...read,
    actorFilter: filter,
    ...(read.presentation === undefined
      ? {}
      : { presentation: read.presentation && ids.has(read.presentation.actorId) ? read.presentation : null }),
    selected: {
      ...read.selected,
      actors,
      rows: read.selected.rows.filter((entry) => ids.has(entry.actorId)),
      evidence: read.selected.evidence.filter(included),
      ...(read.selected.portfolioEvidence === undefined
        ? {}
        : { portfolioEvidence: read.selected.portfolioEvidence.filter(included) }),
      ...(read.selected.reviewedWorkstreamHelp === undefined
        ? {}
        : {
            reviewedWorkstreamHelp: read.selected.reviewedWorkstreamHelp.filter((entry) =>
              ids.has(entry.statement.actorId),
            ),
          }),
      ...(read.selected.pendingEvidence === undefined
        ? {}
        : { pendingEvidence: read.selected.pendingEvidence.filter(included) }),
      ...(read.selected.diagnostics === undefined
        ? {}
        : { diagnostics: read.selected.diagnostics.filter((entry) => ids.has(entry.actorId)) }),
    },
  };
}
export function safePublicUrl(value: string | null | undefined): string | null {
  return safePublicGithubUrl(value);
}
const date = (value: string | null) => sourceEventSchema.shape.occurredAt.safeParse(value).success;
const id = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_.:-]{1,200}$/.test(value);

/** Validate before projection or pair comparison; return a copy without normalizing authority. */
export function readSuppressedContributionIds(controls: PublicRead["controls"]): string[] {
  if (!Object.hasOwn(controls, "suppressedContributionIds")) return [];
  const supplied = controls.suppressedContributionIds;
  if (!Array.isArray(supplied) || supplied.length > 20000)
    throw new PublicReadError(503, "public_projection_unavailable");
  // Materialize holes before validation, and require canonical IDs even where
  // a proof's contract parser can normalize surrounding whitespace.
  const values = [...supplied];
  if (!values.every((value) => id(value) && value.trim() === value) || new Set(values).size !== values.length)
    throw new PublicReadError(503, "public_projection_unavailable");
  return values;
}

/** Validate and construct a fresh allowlisted public object. Never serialize provider objects. */
export function projectRead(
  input: PublicRead,
  scope: PublicScope,
  pin: string | null,
  definitions: readonly MetricDefinition[] = metricRegistryV1.metrics,
): PublicRead {
  const reject = () => {
    throw new PublicReadError(503, "public_projection_unavailable");
  };
  if (!input || !input.selected || !input.controls || !input.head) return reject();
  const selected = input.selected;
  try {
    scope = canonicalPublicScope(scope);
    const providerScope = canonicalPublicScope(selected.scope);
    if (
      publicScopeKey(scope) !== publicScopeKey(providerScope) ||
      providerScope.schemaVersion !== selected.scope.schemaVersion
    )
      return reject();
  } catch {
    return reject();
  }
  if (
    selected.approvedPublic !== true ||
    !selected.scope ||
    !Array.isArray(selected.rows) ||
    selected.rows.length > 10000 ||
    !Array.isArray(selected.actors) ||
    selected.actors.length > 10000 ||
    !Array.isArray(selected.evidence) ||
    selected.evidence.length > 20000 ||
    (selected.portfolioEvidence !== undefined &&
      (!Array.isArray(selected.portfolioEvidence) ||
        selected.portfolioEvidence.length + selected.evidence.length > 20000)) ||
    (selected.pendingEvidence !== undefined && !Array.isArray(selected.pendingEvidence)) ||
    selected.evidence.length + (selected.portfolioEvidence?.length ?? 0) + (selected.pendingEvidence?.length ?? 0) >
      20000 ||
    (selected.physicalContexts !== undefined &&
      (!Array.isArray(selected.physicalContexts) || selected.physicalContexts.length > 10000)) ||
    (selected.physicalEvidence !== undefined &&
      (!Array.isArray(selected.physicalEvidence) || selected.physicalEvidence.length > 10000)) ||
    !Array.isArray(selected.ranking) ||
    selected.ranking.length > 98
  )
    return reject();
  const ranking = selected.ranking.map((entry) => {
    const definition = definitions.find((metric) => metric.id === entry.metricId)?.definition;
    const descriptive =
      definition?.display_policy === "spotlight" ||
      definition?.release_eligibility === "descriptive-only" ||
      ["ratio", "median_and_p75_of_elapsed_hours"].includes(definition?.aggregation ?? "");
    if (
      !id(entry.metricId) ||
      !["ascending", "descending"].includes(entry.direction) ||
      (entry.rank !== undefined && typeof entry.rank !== "boolean") ||
      (descriptive && entry.rank !== false)
    )
      return reject();
    return { metricId: entry.metricId, direction: entry.direction, rank: entry.rank !== false };
  });
  const rankingPresentationPolicy =
    selected.rankingPresentationPolicy === undefined
      ? undefined
      : rankingPresentationPolicySchema.parse(selected.rankingPresentationPolicy);
  if (
    (selected.disabledMetrics !== undefined &&
      (!Array.isArray(selected.disabledMetrics) || selected.disabledMetrics.length > 98)) ||
    (selected.methodology !== undefined && (!Array.isArray(selected.methodology) || selected.methodology.length > 98))
  )
    return reject();
  const disabledMetrics = (selected.disabledMetrics ?? []).map((entry) => {
    if (
      !id(entry.id) ||
      !id(entry.policyVersion) ||
      typeof entry.reason !== "string" ||
      !/^[a-z0-9_:-]{1,100}$/.test(entry.reason)
    )
      return reject();
    return {
      id: entry.id,
      reason: entry.reason,
      policyVersion: entry.policyVersion,
      policyLink: safePublicUrl(entry.policyLink),
    };
  });
  const methodology = (selected.methodology ?? []).map((entry) => {
    if (
      !id(entry.metricId) ||
      !id(entry.policyVersion) ||
      typeof entry.policySignature !== "string" ||
      !/^[a-f0-9]{64}$/.test(entry.policySignature)
    )
      return reject();
    return {
      metricId: entry.metricId,
      policyVersion: entry.policyVersion,
      policySignature: entry.policySignature,
      policyLink: safePublicUrl(entry.policyLink),
    };
  });
  if (
    new Set(disabledMetrics.map((entry) => entry.id)).size !== disabledMetrics.length ||
    new Set(methodology.map((entry) => entry.metricId)).size !== methodology.length
  )
    return reject();
  if (
    (selected.physicalContexts !== undefined || selected.physicalEvidence !== undefined) &&
    rankingPresentationPolicy === undefined
  )
    return reject();
  const physicalCandidates = new Map<string, PhysicalSnapshotContext>();
  const physicalReceipts = new Map<string, string>();
  const physicalReferenceLimit = 40000;
  let physicalReferences = 0;
  let physicalCopies = 0;
  for (const input of selected.physicalContexts ?? []) {
    // Bound input work before the closed schema clones a candidate. One source
    // receipt can legitimately appear in each of the four physical metrics.
    if (input?.state === "available") {
      if (!Array.isArray(input.samples) || input.samples.length > physicalContextLimits.units) return reject();
      for (const item of input.samples) {
        if (!Array.isArray(item?.receipt?.facts)) return reject();
        physicalCopies += item.receipt.facts.length;
        if (physicalCopies > physicalReferenceLimit * physicalMetricIds.length) return reject();
      }
    }
    const candidate = physicalSnapshotContextSchema.parse(input);
    const key = JSON.stringify([candidate.actorId, candidate.metricId]);
    if (physicalCandidates.has(key)) return reject();
    const samples = new Set<string>();
    if (candidate.state === "available")
      for (const item of candidate.samples) {
        const receipt = item.receipt;
        const source = JSON.stringify([receipt.repositoryId, receipt.canonicalIntegrationId, receipt.actorId]);
        if (samples.has(source)) return reject();
        samples.add(source);
        const serialized = stableJSON(item);
        const prior = physicalReceipts.get(source);
        // A mismatched actor receives no deduplication credit. The later source
        // projection still withholds that entire optional context as unknown.
        if (receipt.actorId !== candidate.actorId) physicalReferences += receipt.facts.length;
        else if (prior === undefined) {
          physicalReferences += receipt.facts.length;
          physicalReceipts.set(source, serialized);
        } else if (prior !== serialized) return reject();
        if (physicalReferences > physicalReferenceLimit) return reject();
      }
    physicalCandidates.set(key, candidate);
  }
  const disabled = new Set(disabledMetrics.map((entry) => entry.id));
  if (new Set(ranking.map((entry) => entry.metricId)).size !== ranking.length) return reject();
  const snapshot = snapshotSchema.parse(selected.snapshot);
  if (
    input.currentSourceHealth !== undefined &&
    (!Array.isArray(input.currentSourceHealth) || input.currentSourceHealth.length > 100)
  )
    return reject();
  const currentSourceHealth = input.currentSourceHealth?.map((entry) => {
    if (
      !entry ||
      !id(entry.scopeId) ||
      !snapshot.coverage.some(
        (coverage) => coverage.scopeId === entry.scopeId && coverage.source.startsWith("github_"),
      ) ||
      (scope.repository !== null && scope.repository !== entry.scopeId) ||
      !["reconciled", "no_activity_in_window", "collecting", "degraded", "unknown"].includes(entry.state) ||
      !["idle", "pending", "degraded", "unknown"].includes(entry.webhookState) ||
      ![entry.lastAttemptAt, entry.lastSuccessfulSync, entry.reconciledThrough].every(date) ||
      (entry.webhookLagSeconds !== null &&
        (!Number.isSafeInteger(entry.webhookLagSeconds) || entry.webhookLagSeconds < 0)) ||
      (entry.webhookState === "unknown" && entry.webhookLagSeconds !== null)
    )
      return reject();
    return {
      scopeId: entry.scopeId,
      state: entry.state,
      lastAttemptAt: entry.lastAttemptAt,
      lastSuccessfulSync: entry.lastSuccessfulSync,
      reconciledThrough: entry.reconciledThrough,
      webhookLagSeconds: entry.webhookLagSeconds,
      webhookState: entry.webhookState,
    };
  });
  if (
    currentSourceHealth &&
    new Set(currentSourceHealth.map((entry) => entry.scopeId)).size !== currentSourceHealth.length
  )
    return reject();
  const controls = input.controls;
  if (
    !id(controls.version) ||
    !id(snapshot.snapshotId) ||
    !id(input.head.snapshotId) ||
    !Number.isSafeInteger(input.head.revision) ||
    input.head.revision < snapshot.revision ||
    !date(input.head.publishedAt) ||
    input.head.publishedAt === null ||
    ![controls.suppressedActorIds, controls.revokedSnapshotIds].every(
      (list) => Array.isArray(list) && list.length <= 20000 && list.every(id),
    ) ||
    !Array.isArray(controls.suppressedArtifactIds) ||
    controls.suppressedArtifactIds.length > 20000 ||
    !controls.suppressedArtifactIds.every((value) => publicArtifactIdSchema.safeParse(value).success)
  )
    return reject();
  if (pin !== null && snapshot.snapshotId !== pin) return reject();
  if (pin === null && (snapshot.snapshotId !== input.head.snapshotId || snapshot.revision !== input.head.revision))
    return reject();
  if (controls.revokedSnapshotIds.includes(snapshot.snapshotId))
    throw new PublicReadError(410, "snapshot_revoked_refetch");
  const suppressedActors = new Set(controls.suppressedActorIds);
  const suppressedArtifacts = new Set(controls.suppressedArtifactIds);
  const suppressedContributions = new Set(readSuppressedContributionIds(controls));
  // Check the whole identity set before privacy filtering. Dropping a hidden or
  // unresolved duplicate first could expose a contradictory public copy.
  if (new Set(selected.actors.map((entry) => entry.actorId)).size !== selected.actors.length) return reject();
  const actors = selected.actors
    .map((entry) => {
      if (!id(entry.actorId) || !["public", "hidden", "deleted", "unlinked"].includes(entry.state)) return reject();
      const actor = actorSchema.parse(entry.actor);
      return { actorId: entry.actorId, actor, state: entry.state };
    })
    .filter(
      (entry) =>
        entry.state === "public" && entry.actor.identityState === "resolved" && !suppressedActors.has(entry.actorId),
    );
  let presentation: PublicProfilePresentation | null | undefined;
  if (Object.hasOwn(input, "presentation")) {
    const parsed = publicProfilePresentationSchema.nullable().safeParse(input.presentation);
    if (!parsed.success) return reject();
    presentation = parsed.data;
    if (presentation !== null) {
      const candidate = presentation;
      const visible = actors.find((entry) => entry.actorId === candidate.actorId);
      if (!visible) presentation = null;
      else if (!publicProfilePresentationMatches(candidate, visible.actorId, visible.actor)) return reject();
    }
  }
  const actorIds = new Set(actors.map((actor) => actor.actorId));
  // Every supplied copy must agree before any public response can be returned.
  // Contribution IDs and known artifact IDs are separate identity namespaces.
  const visibilityByContribution = new Map<string, Artifact["visibility"]>();
  const visibilityByArtifact = new Map<string, Artifact["visibility"]>();
  const checkVisibility = (
    seen: Map<string, Artifact["visibility"]>,
    key: string | null | undefined,
    visibility: Artifact["visibility"],
  ) => {
    if (key === null || key === undefined) return;
    const previous = seen.get(key);
    if (previous !== undefined && previous !== visibility) return reject();
    seen.set(key, visibility);
  };
  const identityByContribution = new Map<
    string,
    Pick<Contribution, "actorId" | "artifactId"> & { signature: string }
  >();
  const metadataByContribution = new Map<string, string>();
  const documentationClassificationByContribution = new Map<string, string>();
  const decisionPendingIds = (entries: PortfolioEvidence[]) => {
    const selected = new Set<string>();
    for (const entry of entries) {
      if (entry.decisionAsOf === undefined) continue;
      const contribution = contributionSchema.parse(entry.contribution);
      const coverage = snapshot.coverage.filter(
        (value) => value.scopeId === entry.artifact.repositoryId && value.source === "github_rest",
      );
      if (
        !date(entry.decisionAsOf) ||
        entry.activityState !== "pending" ||
        contribution.metricIds.length !== 1 ||
        contribution.metricIds[0] !== "pr_accepted_rate" ||
        contribution.roles.length !== 1 ||
        contribution.roles[0] !== "author" ||
        entry.occurredAt === null ||
        !date(entry.occurredAt) ||
        compareSourceInstants(entry.occurredAt, entry.decisionAsOf) >= 0 ||
        compareSourceInstants(entry.decisionAsOf, snapshot.generatedAt) > 0 ||
        (scope.end !== null && compareSourceInstants(entry.decisionAsOf, scope.end) !== 0) ||
        coverage.length === 0 ||
        coverage.some(
          (value) => value.windowEnd === null || compareSourceInstants(value.windowEnd, entry.decisionAsOf!) !== 0,
        )
      )
        return reject();
      selected.add(contribution.contributionId);
    }
    return selected;
  };
  const projectEvidence = (
    entries: PublicEvidence[],
    acceptedReproductions = false,
    privateMergeProvenance = false,
    pendingAtEnd: ReadonlySet<string> = new Set(),
  ) =>
    entries
      .map((entry) => {
        const artifact = artifactSchema.parse(entry.artifact);
        const parsed = contributionSchema.parse(entry.contribution);
        checkVisibility(visibilityByContribution, parsed.contributionId, artifact.visibility);
        checkVisibility(visibilityByArtifact, artifact.stableId, artifact.visibility);
        checkVisibility(visibilityByArtifact, parsed.artifactId, artifact.visibility);
        const classification = publicDocumentationReasons(parsed);
        const maintenance = publicMaintenanceClassificationReasons(parsed);
        const documentation = publicDocumentationRecognitionReasons(parsed);
        const documentationPurpose = documentation.filter((reason) => reason.startsWith("documentation_purpose:"));
        const activityState = (entry as Partial<PortfolioEvidence>).activityState;
        if (
          parsed.metricIds.includes("reproductions") &&
          acceptedReproductions &&
          activityState !== undefined &&
          activityState !== "accepted"
        )
          return reject();
        if (
          maintenance.length &&
          (parsed.qualification !== "eligible" || (activityState !== undefined && activityState !== "accepted"))
        )
          return reject();
        const reproduction = publicReproductionRecognitionReasons(
          parsed,
          acceptedReproductions || activityState === "accepted",
        );
        if (parsed.metricIds.includes("documentation") && classification.length > 0) {
          // Legacy copies can lack labels. Every present classification must
          // still agree, even if an unlabeled copy appears between two of them.
          const current = JSON.stringify(classification);
          const previous = documentationClassificationByContribution.get(parsed.contributionId);
          if (previous !== undefined && previous !== current) return reject();
          documentationClassificationByContribution.set(parsed.contributionId, current);
        }
        const publicMetricIds = parsed.metricIds.filter(
          (metricId) => !disabled.has(metricId) && ranking.some((policy) => policy.metricId === metricId),
        );
        const contribution = {
          ...parsed,
          ...(parsed.metricIds.some(
            (metric) =>
              metric === "documentation" ||
              metric === "localization" ||
              metric === "reproductions" ||
              metric === "maintenance",
          )
            ? {
                reasonCodes: [
                  ...parsed.reasonCodes.filter((reason) =>
                    [
                      "raw_observed_only",
                      "independent_recognition_receipt",
                      "public_observed_work",
                      "public_pending_work",
                      "public_accepted_work",
                      "public_unknown_work",
                    ].includes(reason),
                  ),
                  ...classification,
                  ...documentation,
                  ...reproduction,
                  ...maintenance,
                ],
              }
            : {}),
          // Private merge provenance passes the same current guards but never
          // becomes metric evidence or confers release on the pr_merged metric.
          metricIds: privateMergeProvenance ? [...parsed.metricIds] : publicMetricIds,
        };
        // One proof ID cannot change its fact, attribution or eligibility by collection.
        // Effective/source clocks and legacy reason labels are collection-specific;
        // compare parsed identities and public sets without rewriting their output order.
        const signature = JSON.stringify([
          contribution.canonicalEventId,
          [...new Set(contribution.roles)].sort(),
          contribution.qualification,
          [...new Set(publicMetricIds)].sort(),
        ]);
        const previousIdentity = identityByContribution.get(contribution.contributionId);
        if (
          previousIdentity !== undefined &&
          (previousIdentity.signature !== signature ||
            (previousIdentity.actorId !== null &&
              contribution.actorId !== null &&
              previousIdentity.actorId !== contribution.actorId) ||
            (previousIdentity.artifactId !== null &&
              contribution.artifactId !== null &&
              previousIdentity.artifactId !== contribution.artifactId))
        )
          return reject();
        // Missing attribution stays unknown and is filtered below; it cannot
        // erase a known identity before a later conflicting copy is checked.
        identityByContribution.set(contribution.contributionId, {
          signature,
          actorId: previousIdentity?.actorId ?? contribution.actorId,
          artifactId: previousIdentity?.artifactId ?? contribution.artifactId,
        });
        if (!date(entry.occurredAt) || (entry.sourceRevision !== null && !id(entry.sourceRevision))) return reject();
        const metadata =
          entry.evidenceMetadata === undefined ? undefined : publicEvidenceMetadataSchema.parse(entry.evidenceMetadata);
        const projectContext =
          entry.projectContext === undefined ? undefined : publicProjectContextSchema.parse(entry.projectContext);
        if (
          projectContext &&
          !publicProjectContextMatches(projectContext, artifact, contribution, scope.context ?? "event")
        )
          return reject();
        if (documentationPurpose.length) {
          const repository = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/[1-9][0-9]*$/.exec(
            artifact.publicUrl ?? "",
          )?.[1];
          if (
            parsed.qualification !== "eligible" ||
            parsed.roles.length !== 1 ||
            parsed.roles[0] !== "author" ||
            artifact.source !== "github" ||
            artifact.kind !== "pull_request" ||
            (activityState !== undefined && activityState !== "accepted") ||
            typeof entry.sourceRevision !== "string" ||
            !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(entry.sourceRevision) ||
            !repository ||
            entry.sourceRevisionUrl !== "https://github.com/" + repository + "/commit/" + entry.sourceRevision ||
            entry.occurredAt === null ||
            (metadata &&
              (metadata.activityState !== "accepted" ||
                metadata.sourceOccurredAt === null ||
                compareSourceInstants(metadata.sourceOccurredAt, entry.occurredAt) !== 0 ||
                metadata.acceptedAt === null ||
                compareSourceInstants(metadata.acceptedAt, entry.occurredAt) < 0))
          )
            return reject();
        }
        if ((reproduction.length > 0 || maintenance.length > 0) && metadata && metadata.activityState !== "accepted")
          return reject();
        // Absence is part of the metadata projection too: route preference must
        // not choose a legacy copy over a richer copy of the same contribution.
        // Locale units require identical labels on every copy. Earlier generic
        // documentation snapshots omitted path-policy reasons in portfolio proof,
        // so retain their readability without inventing missing classifications.
        const serialized = JSON.stringify({
          metadata: metadata ?? null,
          projectContext: projectContext ?? null,
          classification: parsed.metricIds.includes("localization") ? classification : null,
          reproduction: parsed.metricIds.includes("reproductions") ? reproduction : null,
          maintenance: maintenance.length ? maintenance : null,
          documentationPurpose: documentationPurpose.length
            ? {
                reasons: documentationPurpose,
                ...(documentationPurpose.length
                  ? {
                      classification,
                      sourceRevision: entry.sourceRevision,
                      sourceRevisionUrl: entry.sourceRevisionUrl,
                      occurredAt: entry.occurredAt,
                    }
                  : {}),
              }
            : null,
        });
        if (
          metadataByContribution.has(contribution.contributionId) &&
          metadataByContribution.get(contribution.contributionId) !== serialized
        )
          return reject();
        metadataByContribution.set(contribution.contributionId, serialized);
        const portfolio = entry as Partial<PortfolioEvidence>;
        if (
          metadata &&
          ((portfolio.activityState !== undefined && portfolio.activityState !== metadata.activityState) ||
            (portfolio.observedAt !== undefined && portfolio.observedAt !== metadata.observedAt) ||
            (metadata.acceptedAt !== null && contribution.qualification !== "eligible"))
        )
          return reject();
        return {
          ...(metadata === undefined ? {} : { evidenceMetadata: metadata }),
          ...(projectContext === undefined ? {} : { projectContext }),
          artifact,
          contribution,
          occurredAt: entry.occurredAt,
          sourceRevision: entry.sourceRevision,
          sourceRevisionUrl: safePublicUrl(entry.sourceRevisionUrl),
        };
      })
      .filter(
        (entry) =>
          entry.artifact.visibility === "public" &&
          safePublicUrl(entry.artifact.publicUrl) !== null &&
          !suppressedArtifacts.has(entry.artifact.stableId!) &&
          !suppressedContributions.has(entry.contribution.contributionId) &&
          entry.contribution.metricIds.length > 0 &&
          entry.contribution.qualification === "eligible" &&
          entry.contribution.artifactId === entry.artifact.stableId &&
          actorIds.has(entry.contribution.actorId ?? "") &&
          (!scope.roles?.length || scope.roles.some((role) => entry.contribution.roles.includes(role))) &&
          (scope.repository === null || entry.artifact.repositoryId === scope.repository) &&
          (scope.start === null ||
            pendingAtEnd.has(entry.contribution.contributionId) ||
            (entry.occurredAt !== null && compareSourceInstants(entry.occurredAt, scope.start) >= 0)) &&
          (scope.end === null || (entry.occurredAt !== null && compareSourceInstants(entry.occurredAt, scope.end) < 0)),
      );
  // Check parsed IDs before filtering: surrounding whitespace is normalized by
  // the contribution schema and must not disguise a duplicate primary proof.
  const primaryContributionIds = selected.evidence.map((entry) =>
    contributionSchema.shape.contributionId.parse(entry.contribution.contributionId),
  );
  if (new Set(primaryContributionIds).size !== selected.evidence.length) return reject();
  const evidence = projectEvidence(selected.evidence, true);
  const portfolioInput = selected.portfolioEvidence ?? [];
  const portfolioMetadata = new Map(
    portfolioInput.map((entry) => {
      if (
        !["observed", "pending", "accepted", "unknown"].includes(entry.activityState) ||
        !date(entry.observedAt) ||
        !id(entry.contribution.contributionId) ||
        entry.contribution.roles.includes("unknown")
      )
        return reject();
      return [entry.contribution.contributionId, { activityState: entry.activityState, observedAt: entry.observedAt }];
    }),
  );
  if (portfolioMetadata.size !== portfolioInput.length) return reject();
  const portfolioEvidence = projectEvidence(portfolioInput, false, false, decisionPendingIds(portfolioInput))
    .map((entry) => ({
      ...entry,
      ...portfolioMetadata.get(entry.contribution.contributionId)!,
      contribution: {
        ...entry.contribution,
        reasonCodes: [
          `public_${portfolioMetadata.get(entry.contribution.contributionId)!.activityState}_work`,
          ...publicDocumentationReasons(entry.contribution),
          ...(portfolioMetadata.get(entry.contribution.contributionId)!.activityState === "accepted"
            ? [
                ...publicDocumentationRecognitionReasons(entry.contribution),
                ...publicReproductionRecognitionReasons(entry.contribution, true),
                ...publicMaintenanceClassificationReasons(entry.contribution),
              ]
            : []),
        ],
      },
    }))
    .filter((entry) => entry.contribution.metricIds.length > 0);
  const pendingInput = selected.pendingEvidence ?? [];
  for (const entry of pendingInput) {
    if (
      entry.activityState !== "pending" ||
      entry.observedAt === null ||
      !date(entry.observedAt) ||
      entry.occurredAt === null ||
      entry.contribution.roles.includes("unknown")
    )
      return reject();
  }
  // Match projectEvidence's contract-normalized IDs before checking uniqueness
  // and retrieving clocks. Raw aliases must not duplicate proof or lose metadata.
  const pendingMetadata = new Map(
    pendingInput.map((entry) => [
      contributionSchema.shape.contributionId.parse(entry.contribution.contributionId),
      entry.observedAt,
    ]),
  );
  if (pendingMetadata.size !== pendingInput.length) return reject();
  const pendingEvidence = projectEvidence(pendingInput, false, false, decisionPendingIds(pendingInput)).map(
    (entry) => ({
      ...entry,
      activityState: "pending" as const,
      observedAt: pendingMetadata.get(entry.contribution.contributionId)!,
      contribution: {
        ...entry.contribution,
        reasonCodes: ["public_pending_work", ...publicDocumentationReasons(entry.contribution)],
      },
    }),
  );
  const physicalInput = selected.physicalEvidence ?? [];
  const physicalIds = physicalInput.map((entry) => {
    const contribution = contributionSchema.parse(entry.contribution);
    if (
      contribution.metricIds.length !== 1 ||
      contribution.metricIds[0] !== "pr_merged" ||
      contribution.roles.length !== 1 ||
      contribution.roles[0] !== "author"
    )
      return reject();
    return contribution.contributionId;
  });
  if (new Set(physicalIds).size !== physicalInput.length) return reject();
  const physicalDependencies = new Map(
    projectEvidence(physicalInput, false, true).map((entry) => [entry.contribution.contributionId, entry]),
  );
  const pendingEvidenceMap = new Map(pendingEvidence.map((entry) => [entry.contribution.contributionId, entry]));
  function pendingProjection(entry: PublicRow, result: MetricResult): PendingCount | undefined {
    if (entry.pending === undefined) return undefined; // Legacy is unknown, never inferred zero.
    const parsed = pendingCountSchema.parse(entry.pending);
    evidenceReferenceCount += parsed.evidenceIds.length;
    const unknown = { ...parsed, state: "unknown" as const, count: null, evidenceIds: [] };
    if (
      !parsed.evidenceIds.every((id) => {
        const evidence = pendingEvidenceMap.get(id);
        return (
          evidence?.contribution.actorId === entry.actorId && evidence.contribution.metricIds.includes(result.metricId)
        );
      })
    )
      return unknown;
    const coverage = result.coverage;
    const complete =
      scope.start !== null &&
      scope.end !== null &&
      coverage.state === "complete" &&
      coverage.knownStart !== null &&
      compareSourceInstants(coverage.knownStart, scope.start) <= 0 &&
      coverage.windowStart !== null &&
      compareSourceInstants(coverage.windowStart, scope.start) <= 0 &&
      coverage.windowEnd !== null &&
      compareSourceInstants(coverage.windowEnd, scope.end) >= 0 &&
      coverage.sourceWatermark !== null &&
      compareSourceInstants(coverage.sourceWatermark, scope.end) >= 0 &&
      compareSourceInstants(snapshot.generatedAt, scope.end) >= 0 &&
      coverage.missingPages === 0 &&
      coverage.permissionsMissing.length === 0 &&
      coverage.sourceErrors.length === 0;
    if (parsed.state === "measured" && !complete) return parsed.count === 0 ? unknown : { ...parsed, state: "partial" };
    return parsed;
  }
  const evidenceMap = new Map(evidence.map((entry) => [entry.contribution.contributionId, entry]));
  let evidenceReferenceCount = 0;
  const rows = selected.rows
    .map((entry) => {
      if (
        !id(entry.actorId) ||
        !Array.isArray(entry.evidenceIds) ||
        entry.evidenceIds.length > 10000 ||
        !entry.evidenceIds.every(id) ||
        new Set(entry.evidenceIds).size !== entry.evidenceIds.length
      )
        return reject();
      evidenceReferenceCount += entry.evidenceIds.length;
      const result = metricResultSchema.parse(entry.result);
      const pending = pendingProjection(entry, result);
      if (evidenceReferenceCount > 40000 || !ranking.some((entry) => entry.metricId === result.metricId))
        return reject();
      return {
        actorId: entry.actorId,
        result,
        evidenceIds: [...entry.evidenceIds],
        ...(pending === undefined ? {} : { pending }),
      };
    })
    .filter(
      (entry) =>
        !disabled.has(entry.result.metricId) &&
        actorIds.has(entry.actorId) &&
        // Remove affected aggregates entirely; subtracting evidence counts would corrupt ratios/weights.
        entry.evidenceIds.every((evidenceId) => {
          const evidence = evidenceMap.get(evidenceId);
          return (
            evidence?.contribution.actorId === entry.actorId &&
            evidence.contribution.metricIds.includes(entry.result.metricId)
          );
        }) &&
        (entry.result.value === undefined || entry.result.value === 0 || entry.evidenceIds.length > 0),
    );
  if (new Set(rows.map((row) => JSON.stringify([row.actorId, row.result.metricId]))).size !== rows.length)
    return reject();
  if (
    selected.diagnostics !== undefined &&
    (!Array.isArray(selected.diagnostics) || selected.diagnostics.length > 10000)
  )
    return reject();
  const rowByKey = new Map(rows.map((row) => [JSON.stringify([row.actorId, row.result.metricId]), row]));
  const visibleRows = new Set(rowByKey.keys());
  const retainedPendingIds = new Set(rows.flatMap((row) => row.pending?.evidenceIds ?? []));
  const diagnostics = (selected.diagnostics ?? [])
    .map((entry) => {
      if (entry.pending !== undefined) pendingCountSchema.parse(entry.pending);
      const pending = rowByKey.get(JSON.stringify([entry.actorId, entry.metricId]))?.pending;
      if (
        !id(entry.metricId) ||
        !id(entry.actorId) ||
        ![entry.sampleCount, entry.censored, entry.missingReadiness].every(
          (value) => Number.isSafeInteger(value) && value >= 0,
        ) ||
        ![entry.numerator, entry.denominator, entry.p75].every(
          (value) => value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0),
        )
      )
        return reject();
      return {
        metricId: entry.metricId,
        actorId: entry.actorId,
        numerator: entry.numerator,
        denominator: entry.denominator,
        sampleCount: entry.sampleCount,
        censored: entry.censored,
        missingReadiness: entry.missingReadiness,
        p75: entry.p75,
        // Use the projected row dependency, never an unchecked duplicate diagnostic count.
        ...(pending === undefined ? {} : { pending }),
      };
    })
    .filter((entry) => visibleRows.has(JSON.stringify([entry.actorId, entry.metricId])));
  if (new Set(diagnostics.map((entry) => JSON.stringify([entry.actorId, entry.metricId]))).size !== diagnostics.length)
    return reject();
  const reviewedWorkstreamHelp = projectWorkstreamHelp(selected, portfolioEvidence, scope);
  // Raw exception strings and permission details never enter the public projection.
  const coverage = (value: MetricResult["coverage"]) => ({
    ...value,
    permissionsMissing: value.permissionsMissing.length ? ["source_capability_unavailable"] : [],
    sourceErrors: value.sourceErrors.length ? ["source_collection_failed"] : [],
  });
  return {
    head: { snapshotId: input.head.snapshotId, revision: input.head.revision, publishedAt: input.head.publishedAt },
    ...(presentation === undefined ? {} : { presentation }),
    ...(currentSourceHealth === undefined ? {} : { currentSourceHealth }),
    controls: { version: controls.version, suppressedActorIds: [], suppressedArtifactIds: [], revokedSnapshotIds: [] },
    selected: {
      approvedPublic: true,
      scope: { ...scope },
      snapshot: { ...snapshot, coverage: snapshot.coverage.map(coverage), results: [] },
      actors,
      rows: rows.map((row) => {
        const physicalContext =
          rankingPresentationPolicy === undefined
            ? undefined
            : projectPhysicalContext({
                candidate: physicalCandidates.get(JSON.stringify([row.actorId, row.result.metricId])),
                row,
                evidence: evidenceMap,
                dependencies: physicalDependencies,
                snapshot,
                scope,
                methodology,
              });
        return {
          ...row,
          result: { ...row.result, coverage: coverage(row.result.coverage) },
          ...(physicalContext === undefined ? {} : { physicalContext }),
        };
      }),
      evidence,
      ...(selected.portfolioEvidence === undefined ? {} : { portfolioEvidence }),
      ...(reviewedWorkstreamHelp === undefined ? {} : { reviewedWorkstreamHelp }),
      ...(selected.pendingEvidence === undefined
        ? {}
        : {
            pendingEvidence: pendingEvidence.filter((entry) =>
              retainedPendingIds.has(entry.contribution.contributionId),
            ),
          }),
      ranking: ranking.filter((entry) => !disabled.has(entry.metricId)),
      ...(rankingPresentationPolicy === undefined ? {} : { rankingPresentationPolicy }),
      disabledMetrics,
      methodology,
      diagnostics,
    },
  };
}
