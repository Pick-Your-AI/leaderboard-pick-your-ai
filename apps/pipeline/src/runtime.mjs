import {
  publicMaintenanceClassificationReasons,
  documentationPurposeVersion,
  discussionFeedbackContentVersion,
  publicProfilePresentationVersion,
  publicProfilePresentationSchema,
  publicProfilePresentationMatches,
} from "@pick-your-ai/contracts";
import {
  createDiscussionFeedbackAuthority,
  DiscussionFeedbackStore,
  privateDiscussionFeedbackMetadata,
} from "./discussion-feedback-store.mjs";
import { validatePublicationPeriods, publicScopeFromTemplate } from "./publication-windows.mjs";
import {
  resolveDiscoverablePublicationWindows,
  approvedDiscoverablePublicationScope,
} from "./publication-window-aliases.mjs";
import { createPublicationWindowIndex } from "./publication-window-index.mjs";
import {
  migratePipeline as migrateScopeStorage,
  assertPipelineStorage,
  pipelineKeySQL,
  publicationMonitorIdentity,
} from "./scope-storage.mjs";
import { retainedRankHistory } from "./rank-history.mjs";
import {
  decisionHistoryRepositories,
  pullRequestDecisionGenerationVersion,
  parseDecisionGenerationCapture,
  parseDecisionProjection,
  readDecisionGenerations,
  readDecisionFrozenInput,
  migrateDecisionHistoryRuns,
} from "./pull-request-decision-history.mjs";
import {
  projectDecidedPullRequests,
  decisionProjectionBinding,
  assertDecisionProjection,
} from "./pull-request-decided-projection.mjs";
import { readImportedHistory } from "./reconciliation-history.mjs";
import {
  copyParticipationHistoryJSON,
  createParticipationHistoryAuthority,
  validateParticipationHistoryAdmission,
  assembleParticipationHistory,
} from "./participation-history.mjs";
import {
  validateReconciliationPolicy,
  reconciliationContextDigest,
  prepareReconciliationPlan,
} from "./reconciliation-plan.mjs";
import { readReconciliationProgress, leastReconciliationTime } from "./reconciliation-progress.mjs";
import { recognitionFingerprint, materializeRecognition } from "./recognition-adapter.mjs";
import { selectWorkstreamHelp, validateWorkstreamHelpBindings } from "./workstream-help.mjs";
import { PolicyComparisonStore } from "../../controls/src/policy-comparison.mjs";
import { AggregateExplanationStore } from "./aggregate-explanations.mjs";
import { assertPipelineSourcesNotRetired } from "./derived-retirement.mjs";
import { issueArtifactId, issueTransferClosure, expandIssueTransferSuppressions } from "./issue-transfer-privacy.mjs";
import {
  issueTransferMetadataVersion,
  migrateIssueTransferMetadata,
  privateIssueTransferMetadata,
  retainIssueTransferIndex,
  assertIssueTransferCapture,
  validateIssueTransferCapture,
} from "./issue-transfer-store.mjs";
import {
  lockIssueTransferSources,
  readIssueTransferAuthority,
  issueTransferCorrectionExempt,
} from "./issue-transfer-authority.mjs";
import { conserveIssueCreations, projectIssueCreationCorrections } from "./issue-transfers.mjs";
import {
  readRelationshipPairAuthority,
  readCapturedRelationshipPairAuthority,
  relationshipPairCalculationDocument,
  expandRelationshipPairSuppressions,
} from "./relationship-pair-authority.mjs";
import { ControlError, requireThat } from "../../controls/src/store.mjs";
import { materializeEvidenceMetadata, selectEvidenceMetadata } from "./evidence-metadata.mjs";
import { createPublicProjectContextProjector } from "./public-project-context.mjs";
import { createWebhookDispatcher } from "./webhook-dispatch.mjs";
import { createMetadataEnrichment } from "./metadata-enrichment.mjs";
import {
  createGithubCollectionSource,
  isProjectSourceScopeFailure,
  isIssueFieldSourceScopeFailure,
} from "./github-source.mjs";
import { githubCommentsContext, expandedGithubCommentsRun, startGithubCommentsRun } from "./comments-inventory.mjs";
import {
  githubContentEditsContext,
  createGithubContentEditAdmission,
  startGithubContentEditRun,
} from "./content-edit-inventory.mjs";
import { normalizationDocumentVersion, privateAttribution } from "./private-attribution.mjs";
import { retainPhysicalContext } from "./physical-context.mjs";
import {
  mergeTargetNormalizationVersion,
  mergeTargetGenerationSignature,
  validateMergeTargetGeneration,
  readMergeTargetNormalization,
  assertMergeTargetFacts,
  captureMergeTargetAuthorization,
  mergeTargetAuthorization,
} from "./pull-request-merge-target.mjs";
import { capturePhysicalSources, selectPhysicalContexts } from "./physical-selection.mjs";
import {
  defaultDeliveryNormalizationVersion,
  fieldChangeNormalizationVersion,
  triageMetadataNormalizationVersion,
  discussionSourceNormalizationVersion,
  githubSnapshotRevision,
  reviewSourceNormalizationVersion,
  relationshipPairNormalizationVersion,
} from "@pick-your-ai/github";
import {
  isRelationshipPairMetric,
  hasRelationshipPairClaims,
  hasRelationshipPairMarker,
} from "./relationship-pair-generation.mjs";
import {
  canonicalProjectWorkstreamMappings,
  normalizedProjectContext,
  applyCurrentProjectContexts,
} from "./project-context.mjs";
import { readCurrentSourceHealth } from "./source-health.mjs";
import { readOperatorHealth } from "./operator-health.mjs";
import { createOperatorPublicationVerifier } from "./operator-publication.mjs";
import { ScanContinuationStore, ScanSupersededError, scanContinuationSchema } from "./scan-continuation.mjs";
import { createHash } from "node:crypto";
import { types } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { materializeReversionEffectiveness, reversionProjection } from "./reversion-effectiveness.mjs";
import {
  readCorrectionState,
  correctionStateQuery,
  correctionStateFromRows,
  reversionCapture,
  assertReversionCapture,
  applyReviewedReversion,
  addReversionNotices,
} from "./reversion-store.mjs";

const fail = (code) => {
  throw new Error(code);
};
const required = (value, code) => (typeof value === "string" && value.trim() ? value : fail(code));
const canonical = (value) =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(",")}]`
    : value !== null && typeof value === "object"
      ? `{${Object.keys(value)
          .sort()
          .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
          .join(",")}}`
      : JSON.stringify(value);
const digest = (value) => createHash("sha256").update(canonical(value)).digest("hex");
const policyDigest = (value) => createHash("sha256").update(value).digest("hex");
const copy = (value) => structuredClone(value);
// The physical diff adapter can emit these facts from any enriched source
// family. A family-only cache or retained-view check would miss that path.
const defaultDeliveryMetrics = new Set([
  "commits_integrated",
  "direct_changes",
  "pr_lines_added",
  "pr_lines_removed",
  "pr_lines_changed",
  "files_changed",
]);
const hasDefaultDeliveryClaims = (document) =>
  Array.isArray(document?.facts) && document.facts.some((fact) => defaultDeliveryMetrics.has(fact?.metricId));
// Enrichment can supply a field-change envelope from any collected family.
// Match actual claims as well as the two native field-history readers.
const fieldChangeMetrics = new Set([
  "issue_field_updates",
  "project_field_updates",
  "project_status_updates",
  "project_updates",
]);
const hasFieldChangeClaims = (document) =>
  Array.isArray(document?.facts) && document.facts.some((fact) => fieldChangeMetrics.has(fact?.metricId));
// A trusted enrichment can supply triage metadata from any collected family.
// Keep affected facts distinct from an explicitly corrected empty result.
const triageMetadataMetrics = new Set([
  "labels_applied",
  "items_triaged",
  "assignments_coordinated",
  "milestones_curated",
  "label_taxonomy",
  "milestone_definitions",
  "public_moderation",
]);
const hasTriageMetadataClaims = (document) =>
  Array.isArray(document?.facts) && document.facts.some((fact) => triageMetadataMetrics.has(fact?.metricId));
const hasTriageMetadataOutput = (document) =>
  hasTriageMetadataClaims(document) ||
  (Array.isArray(document?.reasons) && document.reasons.includes("no_op_metadata_change"));
// Private preview records retain labels only. Provider bindings stay in the
// restricted normalization store and are restored transiently before engine use.
const previewActor = ({ id, login, kind, publicState, executionMode }) => ({
  id,
  login,
  kind,
  publicState,
  ...(executionMode === undefined ? {} : { executionMode }),
});
// Provider identity and reviewed classification must agree across observations.
// A newer verified label can replace an older login; execution evidence still
// accumulates. Publication and frozen replay use the identical source bindings.
const joinActorExecutionEvidence = (previous, actor, serialize, previousSource, source, allowRenames) => {
  const modes = [previous?.executionMode, actor.executionMode];
  if (modes.some((mode) => mode !== undefined && mode !== "unknown" && mode !== "automated")) return null;
  if (!previous) return copy(actor);
  const { executionMode: previousMode, login: previousLogin, ...previousMetadata } = previous;
  const { executionMode: actorMode, login, ...actorMetadata } = actor;
  if (serialize(previousMetadata) !== serialize(actorMetadata)) return null;
  let joined = copy(previous);
  if (previousLogin !== login) {
    if (
      !allowRenames ||
      previous.publicState !== "visible" ||
      actor.publicState !== "visible" ||
      typeof previousLogin !== "string" ||
      typeof login !== "string" ||
      !Number.isSafeInteger(actor.githubDatabaseId) ||
      actor.githubDatabaseId < 1 ||
      String(actor.githubDatabaseId) !== actor.id ||
      typeof actor.githubNodeId !== "string" ||
      !actor.githubNodeId ||
      previousSource.observedAt === source.observedAt
    )
      return null;
    if (source.observedAt > previousSource.observedAt) joined = copy(actor);
  }
  if (previousMode === "automated" || actorMode === "automated") joined.executionMode = "automated";
  else if (previousMode === "unknown" || actorMode === "unknown") joined.executionMode = "unknown";
  return joined;
};
const sourceActorEvidence = (allowRenames = true) => ({
  actors: new Map(),
  latest: new Map(),
  logins: new Map(),
  allowRenames,
  hasRenames: false,
});
function retainSourceActor(evidence, actor, source, serialize, contracts) {
  // Cached and frozen documents keep the source observation's original cutoff.
  // Check every retained copy before joining actors; a later engine cutoff or
  // another valid copy cannot authorize a review that this source did not know.
  if (actor.kind === "service_account" || actor.serviceAccountClassification !== undefined) {
    const classification = contracts.serviceAccountClassificationSchema.safeParse(actor.serviceAccountClassification);
    if (
      !classification.success ||
      !(contracts.compareSourceInstants(classification.data.reviewedAt, source.observedAt) <= 0)
    )
      return false;
  }
  // Conflicting aliases within one run or at one observation time are ambiguous,
  // regardless of row order or an intervening observation from a later run.
  const keys = [JSON.stringify([actor.id, "run", source.runId]), JSON.stringify([actor.id, "time", source.observedAt])];
  if (keys.some((key) => evidence.logins.has(key) && evidence.logins.get(key) !== actor.login)) return false;
  const previousSource = evidence.latest.get(actor.id);
  const previous = evidence.actors.get(actor.id);
  const joined = joinActorExecutionEvidence(previous, actor, serialize, previousSource, source, evidence.allowRenames);
  if (!joined) return false;
  if (previous && previous.login !== actor.login) evidence.hasRenames = true;
  for (const key of keys) evidence.logins.set(key, actor.login);
  evidence.actors.set(actor.id, joined);
  if (!previousSource || source.observedAt > previousSource.observedAt) evidence.latest.set(actor.id, source);
  return true;
}
const sourceBinding = (row) => ({
  factKey: row.fact_key,
  observedAt: new Date(row.observed_at).toISOString(),
  runId: row.first_run_id,
});
const utc = (value) => {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) ||
    new Date(value).toISOString() !== value
  )
    fail("invalid_pipeline_time");
  return value;
};

// Derived artifacts retain their own immutable identity, while revocation follows
// every authoritative source observation that supplied them. Dependencies are
// private and append-only across classification changes and cache replacements.
const sourceSuppressionQuery = `SELECT subject_id
  FROM leaderboard_ingestion.object_suppressions WHERE repository_id=ANY($1::bigint[])
  UNION SELECT dependency.artifact_id FROM leaderboard_pipeline.source_artifacts AS dependency
  JOIN leaderboard_ingestion.source_facts AS fact USING(fact_key)
  JOIN leaderboard_ingestion.object_suppressions AS removed
    ON removed.repository_id=fact.repository_id AND removed.subject_id=fact.subject_id
  WHERE fact.repository_id=ANY($1::bigint[])`;
const sourceSuppressions = async (tx, repositoryIds) =>
  (await tx.query(sourceSuppressionQuery, [repositoryIds])).rows.map((row) => row.subject_id);
const issueTransferRemovals = (authority, corrections) => {
  const correctionArtifacts = corrections.legacy.map((row) => row.artifact_id);
  const correctionSeeds = correctionArtifacts.length
    ? [
        ...correctionArtifacts,
        ...expandIssueTransferSuppressions(authority.transfers, {
          artifactIds: correctionArtifacts.filter(issueArtifactId),
        }),
      ]
    : [];
  const direct = [
    ...authority.removed,
    ...correctionSeeds,
    ...expandRelationshipPairSuppressions(authority, correctionSeeds),
  ];
  return [
    ...new Set([
      ...direct,
      ...expandIssueTransferSuppressions(authority.transfers, { artifactIds: direct.filter(issueArtifactId) }),
    ]),
  ].sort();
};
async function retainSourceArtifacts(tx, factKey, document) {
  const artifactIds = [...new Set(document.facts.map((fact) => fact.artifactId))];
  if (artifactIds.some((id) => typeof id !== "string" || !/^[A-Za-z0-9_=.:-]{1,200}$/.test(id)))
    fail("invalid_source_artifact_dependency");
  await tx.query(
    `INSERT INTO leaderboard_pipeline.source_artifacts(fact_key,artifact_id)
     SELECT $1,artifact_id FROM unnest($2::text[]) AS artifact_id ON CONFLICT DO NOTHING`,
    [factKey, artifactIds],
  );
}

/** Preserve the versioned storage migration before initializing worker metadata. */
export async function migratePipeline(db) {
  await migrateScopeStorage(db);
  await migrateIssueTransferMetadata(db);
  await migrateDecisionHistoryRuns(db);
  // Keep the continuation schema outside the retained v2 migration fingerprint.
  // Serialize first-time creation independently after that migration commits.
  await db.transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('leaderboard-pipeline-scan-migration',0))");
    await tx.query(scanContinuationSchema);
  });
}

/** Host-neutral composition. Authorization and source verification default to denial. */
export async function createPipeline(options) {
  const { components: c, db, controlsStore } = options;
  if (
    !c?.ingestion?.CollectionStore ||
    !c?.metrics?.aggregateMetric ||
    !c?.contracts?.canonicalPublicScope ||
    !c?.contracts?.publicScopeKey ||
    !c?.service?.createService ||
    !controlsStore?.read ||
    !controlsStore?.transaction ||
    !db?.transaction
  )
    fail("pipeline_components_required");
  await assertPipelineStorage(db);
  const scopeKey = c.contracts.publicScopeKey;
  const dataMode = options.dataMode ?? "public";
  if (!["public", "synthetic"].includes(dataMode)) fail("invalid_pipeline_data_mode");
  const diagnosticOptions = options.operatorDiagnostics;
  if (
    diagnosticOptions !== undefined &&
    (!diagnosticOptions ||
      typeof diagnosticOptions !== "object" ||
      Array.isArray(diagnosticOptions) ||
      Object.keys(diagnosticOptions).some((key) => !["freshnessBudgetSeconds", "configurationCurrent"].includes(key)) ||
      !Number.isSafeInteger(diagnosticOptions.freshnessBudgetSeconds) ||
      diagnosticOptions.freshnessBudgetSeconds < 1 ||
      diagnosticOptions.freshnessBudgetSeconds > 86400 ||
      typeof diagnosticOptions.configurationCurrent !== "function" ||
      typeof c.ingestion.OperatorInbox !== "function" ||
      typeof c.ingestion.parseDispatchOperation !== "function")
  )
    fail("invalid_operator_diagnostics_options");
  const assertDataMode = (value) => {
    if (dataMode === "synthetic") return;
    const serialized = JSON.stringify(value);
    if (value?.isSynthetic === true || /synthetic[_.:-]|synthetic\.example/i.test(serialized))
      fail("synthetic_data_forbidden_in_public_runtime");
  };
  const configured = options.config ?? { version: "unconfigured", repositories: [], policies: [], scopes: [] };
  // Admit the optional protected extension before copying host configuration.
  validateWorkstreamHelpBindings(configured.recognitionBindings ?? []);
  const config = copy(configured);
  const decisionRepositoryIds = decisionHistoryRepositories(
    options.pullRequestDecisionRepositoryIds,
    config.repositories,
  );
  const decisionSourceId = options.sourceId;
  const decisionClock = options.decisionHistoryNow ?? (() => new Date().toISOString());
  const selectedGithubClient = options.githubClient;
  const selectedCustomSource = options.source;
  if (
    decisionRepositoryIds.length &&
    (selectedCustomSource != null || !selectedGithubClient || typeof decisionClock !== "function")
  )
    fail("decision_history_builtin_source_required");
  const feedbackAuthority = createDiscussionFeedbackAuthority(
    config,
    dataMode,
    options.discussionFeedbackAuthorityEpoch,
  );
  for (const binding of config.recognitionBindings ?? [])
    if (
      binding.metricId === "helpful_feedback" &&
      !feedbackAuthority.repositoryIds.includes(Number(binding.repositoryId))
    )
      fail("helpful_feedback_source_not_enrolled");
  const feedbackAuthorityHash = () => (feedbackAuthority.enabled ? digest(feedbackAuthority.capture()) : null);
  const feedbackInScope = (scope) =>
    repositoriesFor(scope).some((repo) => feedbackAuthority.repositoryIds.includes(repo.id));
  const feedbackStore = new DiscussionFeedbackStore(db, feedbackAuthority, () => {
    restrictConfiguration(controlsStore.read());
  });
  // Discovery only: validate scopes at the approved run/read boundary below.
  // Invalid scope configuration must not change the existing construction lifecycle.
  const mergeTargetRepositoryIds = [
    ...new Set(
      config.repositories
        .filter(
          (repo) =>
            Array.isArray(config.scopes) &&
            config.scopes.some((scope) => scope?.branch !== undefined && scope.repository === String(repo.id)),
        )
        .map((repo) => repo.id),
    ),
  ].sort((a, b) => a - b);
  const policiesForScope = (scope) =>
    scope.branch === undefined
      ? config.policies
      : config.policies.filter((item) => c.contracts.supportsPullRequestMergeTarget(item.policy.metricId));
  const reconciliationPolicy = validateReconciliationPolicy(config.reconciliation);
  const projectWorkstreamMappings = canonicalProjectWorkstreamMappings(
    config,
    c.github?.validateProjectWorkstreamMapping,
  );
  if (config.researchPolicies?.length) {
    const recordPolicies = config.policies.filter((entry) => entry.policy.metricId === "decision_records");
    if (
      recordPolicies.some(
        ({ policy }) =>
          policy.aggregation !== "count" ||
          policy.dateBasis !== "occurredAt" ||
          policy.groupBy !== "actor_artifact" ||
          !policy.rankedStates?.length ||
          policy.rankedStates.some((state) => !["qualified", "reviewed"].includes(state)),
      )
    )
      fail("research_record_metric_policy_incompatible");
  }
  const classificationPolicies = {
    documentation: config.documentationPolicies ?? [],
    research: config.researchPolicies ?? [],
  };
  // A changed path/provenance policy must not reuse a normalization produced
  // under the previous classification, even when metric arithmetic is unchanged.
  const policySignatures = Array.isArray(config.policies) ? config.policies.map((item) => item?.signature) : [];
  const normalizationPolicySignature = digest(
    classificationPolicies.documentation.length || classificationPolicies.research.length
      ? ["current-state-selection-v2", dataMode, policySignatures, classificationPolicies]
      : ["current-state-selection-v1", dataMode, policySignatures],
  );
  const attributionNormalizationSignature = digest([normalizationDocumentVersion, normalizationPolicySignature]);
  // Earlier documentation projections lacked locale units, merge-clock bounds,
  // or substantive rename origins. Recompute every configured docs source.
  const documentationNormalizationSignature = classificationPolicies.documentation.length
    ? digest(["documentation-locales/v2", attributionNormalizationSignature])
    : attributionNormalizationSignature;
  const verifiedMergeNormalizationSignature = digest([
    "verified-default-branch-merge-pins/v1",
    documentationNormalizationSignature,
  ]);
  // Retained Project history still participates after active collection stops.
  // Keep its new semantics in a distinct cache generation for every configuration,
  // so reprocessing cannot overwrite an earlier frozen normalization dependency.
  const previousProjectNormalizationSignature = digest([
    "project-membership-context/v1",
    verifiedMergeNormalizationSignature,
    projectWorkstreamMappings,
  ]);
  const projectNormalizationSignature = digest([
    "project-membership-context/v2",
    verifiedMergeNormalizationSignature,
    projectWorkstreamMappings,
  ]);
  // Every active source rule receives fresh output. The selected release and
  // authored-notes wrappers also bind the transfer-aware Project generation.
  const transferAdmissionSignature = (signature) => digest(["github-issue-transfer-admission/v1", signature]);
  const transferNormalizationSignature = digest([
    issueTransferMetadataVersion,
    transferAdmissionSignature(projectNormalizationSignature),
  ]);
  const releaseNormalizationSignature = (signature) =>
    config.releaseInclusionTargets?.length
      ? digest([
          dataMode === "public" ? "github-release-inclusion/v2" : "github-release-inclusion/v1",
          signature,
          config.releaseInclusionTargets,
        ])
      : signature;
  const selectedDocumentationPurpose = classificationPolicies.documentation.some(
    (policy) => policy.releaseNotesPaths !== undefined,
  );
  const purposeNormalizationSignature = (signature) =>
    selectedDocumentationPurpose ? digest([documentationPurposeVersion, signature]) : signature;
  const normalizationSignature = purposeNormalizationSignature(
    releaseNormalizationSignature(transferNormalizationSignature),
  );
  // Preserve both accepted histories under this exact configuration. These
  // keys authorize frozen evidence and delivery hints, never current facts.
  const previousNormalizationSignatures = [
    ...new Set([
      previousProjectNormalizationSignature,
      transferAdmissionSignature(previousProjectNormalizationSignature),
      projectNormalizationSignature,
      transferAdmissionSignature(projectNormalizationSignature),
      transferNormalizationSignature,
      releaseNormalizationSignature(previousProjectNormalizationSignature),
      releaseNormalizationSignature(projectNormalizationSignature),
      purposeNormalizationSignature(releaseNormalizationSignature(projectNormalizationSignature)),
    ]),
  ].filter((signature) => signature !== normalizationSignature);
  // Corrected typed-history actor admission must not reuse an old User cache
  // or overwrite the document hash bound by an earlier frozen comparison.
  // Wrap the complete source generation; unrelated families keep their keys.
  const typedHistorySignature = (signature) => digest(["typed-history-actor-classification/v1", signature]);
  const typedHistoryNormalizationSignature = typedHistorySignature(normalizationSignature);
  // Retain both actual preceding typed-history formats: the original Project
  // wrapper and the complete release/purpose wrapper before transfer admission.
  const previousTypedHistoryNormalizationSignatures = [
    ...new Set(
      [
        projectNormalizationSignature,
        purposeNormalizationSignature(releaseNormalizationSignature(projectNormalizationSignature)),
      ].map(typedHistorySignature),
    ),
  ].filter((signature) => signature !== typedHistoryNormalizationSignature);
  // Family-specific source rules have separate immutable cache generations.
  const reviewNormalizationSignature = digest([reviewSourceNormalizationVersion, normalizationSignature]);
  // Obsolete review semantics cannot authorize a publication. Their validated
  // plain/default keys still carry migration hints when fresh v3 output is empty.
  const previousReviewNormalizationSignatures = ["review-source-identity/v1", "review-source-identity/v2"].flatMap(
    (version) =>
      [normalizationSignature, ...previousNormalizationSignatures].map((signature) => digest([version, signature])),
  );
  const discussionNormalizationSignature = digest([
    ...(feedbackAuthority.enabled ? [discussionFeedbackContentVersion] : []),
    discussionSourceNormalizationVersion,
    normalizationSignature,
  ]);
  const defaultDeliverySignature = (signature) => digest([defaultDeliveryNormalizationVersion, signature]);
  const relationshipPairSignature = (signature) => digest([relationshipPairNormalizationVersion, signature]);
  // Preserve every preceding document hash. The outer wrapper includes the
  // complete family, policy, and optional default-delivery generation.
  const fieldChangeSignature = (signature) => digest([fieldChangeNormalizationVersion, signature]);
  const triageMetadataSignature = (signature) => digest([triageMetadataNormalizationVersion, signature]);
  // Each independent semantic generation keeps one immutable wrapper order:
  // pair(triage(field(default(family)))). Absent flags preserve every earlier key.
  const normalizationGenerations = (base) =>
    [false, true].flatMap((relationshipPair) =>
      [false, true].flatMap((triageMetadata) =>
        [false, true].flatMap((fieldChange) =>
          [false, true].map((defaultDelivery) => {
            let signature = defaultDelivery ? defaultDeliverySignature(base) : base;
            if (fieldChange) signature = fieldChangeSignature(signature);
            if (triageMetadata) signature = triageMetadataSignature(signature);
            if (relationshipPair) signature = relationshipPairSignature(signature);
            return { signature, defaultDelivery, fieldChange, triageMetadata, relationshipPair };
          }),
        ),
      ),
    );
  const frozenNormalizationSignatures = [
    defaultDeliverySignature(typedHistoryNormalizationSignature),
    typedHistoryNormalizationSignature,
    ...previousTypedHistoryNormalizationSignatures.flatMap((signature) => [
      signature,
      defaultDeliverySignature(signature),
    ]),
    defaultDeliverySignature(normalizationSignature),
    defaultDeliverySignature(reviewNormalizationSignature),
    defaultDeliverySignature(discussionNormalizationSignature),
    discussionNormalizationSignature,
    reviewNormalizationSignature,
    normalizationSignature,
    ...previousNormalizationSignatures.flatMap((signature) =>
      [
        signature,
        digest([reviewSourceNormalizationVersion, signature]),
        digest([discussionSourceNormalizationVersion, signature]),
      ].flatMap((familySignature) => [familySignature, defaultDeliverySignature(familySignature)]),
    ),
    verifiedMergeNormalizationSignature,
    documentationNormalizationSignature,
    attributionNormalizationSignature,
    normalizationPolicySignature,
  ];
  if (classificationPolicies.documentation.length) {
    const previousDocumentationSignature = digest(["documentation-locales/v1", attributionNormalizationSignature]);
    // Both historical locale formats bind the complete active classification.
    // Retain the earlier verified-merge wrapper without reclassifying old rows.
    frozenNormalizationSignatures.push(
      previousDocumentationSignature,
      digest(["verified-default-branch-merge-pins/v1", previousDocumentationSignature]),
    );
  }
  // The standalone locale adapter already bound every documentation rule. Its
  // cache can authorize historical identities only when no research policy is
  // omitted from that format; unclassified legacy keys cannot supply the gap.
  if (!classificationPolicies.research.length)
    frozenNormalizationSignatures.push(
      digest([
        normalizationDocumentVersion,
        digest(["current-state-selection-v1", dataMode, policySignatures]),
        classificationPolicies.documentation,
      ]),
    );
  // A preceding field generation still binds its exact frozen identities and
  // empty corrected markers after the family or classification policy changes.
  frozenNormalizationSignatures.push(...frozenNormalizationSignatures.map(fieldChangeSignature));
  // Preserve the existing triage keys after field wrapping, never field(triage).
  frozenNormalizationSignatures.push(
    ...[
      normalizationSignature,
      typedHistoryNormalizationSignature,
      reviewNormalizationSignature,
      discussionNormalizationSignature,
    ].flatMap((signature) => [
      triageMetadataSignature(signature),
      triageMetadataSignature(defaultDeliverySignature(signature)),
      triageMetadataSignature(fieldChangeSignature(signature)),
      triageMetadataSignature(fieldChangeSignature(defaultDeliverySignature(signature))),
    ]),
  );
  // Pair conservation is an outer generation: it never changes the preceding
  // family or delivery key. Old rows remain available for exact frozen binding,
  // but affected old semantics cannot authorize a current result.
  const relationshipPairNormalizationSignatures = new Set(frozenNormalizationSignatures.map(relationshipPairSignature));
  const identityNormalizationSignatures = [
    ...new Set([...frozenNormalizationSignatures, ...relationshipPairNormalizationSignatures]),
  ];
  const mergeTargetBaseSignatures = [...new Set([normalizationSignature, ...previousNormalizationSignatures])];
  const mergeTargetWrappers = () => [
    { version: fieldChangeNormalizationVersion, signature: fieldChangeSignature },
    { version: relationshipPairNormalizationVersion, signature: relationshipPairSignature },
    { version: triageMetadataNormalizationVersion, signature: triageMetadataSignature },
  ];
  async function validateMergeTargetRow(row, cutoff = null, current = true) {
    const marker = row.document.pullRequestMergeTargetNormalization;
    const repository = config.repositories.find((entry) => entry.id === Number(row.repository_id));
    if (
      row.family !== "pull_requests" ||
      !repository ||
      !mergeTargetRepositoryIds.includes(repository.id) ||
      !(current ? [normalizationSignature] : mergeTargetBaseSignatures).includes(marker?.baseSignature)
    )
      fail("merge_target_source_scope_mismatch");
    validateMergeTargetGeneration(
      row.document,
      row.policy_signature,
      marker.baseSignature,
      digest,
      defaultDeliverySignature,
      ...mergeTargetWrappers(),
    );
    return readMergeTargetNormalization(row.document, row, repository, cutoff);
  }
  const currentPairGenerationsFor = (family, document = null, policySignature = undefined) => {
    let base =
      family === "reviews"
        ? reviewNormalizationSignature
        : family === "discussions"
          ? discussionNormalizationSignature
          : ["relationships", "project_history", "issue_field_history"].includes(family)
            ? typedHistoryNormalizationSignature
            : normalizationSignature;
    const marker = document?.pullRequestMergeTargetNormalization;
    if (marker !== undefined) {
      if (
        family !== "pull_requests" ||
        marker?.schemaVersion !== mergeTargetNormalizationVersion ||
        marker.baseSignature !== normalizationSignature
      )
        return [];
      base = mergeTargetGenerationSignature(base, marker.generation, digest);
    }
    const generations = normalizationGenerations(base).filter((generation) => generation.relationshipPair);
    // Static pair dependencies must retain every semantic marker required by
    // their admitted key, even when corrected triage output contains no facts.
    if (
      generations.some((generation) => generation.signature === policySignature && generation.triageMetadata) &&
      document?.triageMetadataNormalizationVersion !== triageMetadataNormalizationVersion
    )
      fail("relationship_pair_normalization_obsolete");
    return generations.map((generation) => generation.signature);
  };
  const currentPairSignatures = [
    ...new Set(
      ["reviews", "discussions", "relationships", "issues"].flatMap((family) => currentPairGenerationsFor(family)),
    ),
  ];
  const pairAuthorityOptions = {
    repositories: config.repositories,
    dataMode,
    generationsFor: currentPairGenerationsFor,
    signatures: currentPairSignatures,
    mergeTarget: {
      repositoryIds: mergeTargetRepositoryIds,
      version: mergeTargetNormalizationVersion,
      baseSignature: normalizationSignature,
      validate: validateMergeTargetRow,
    },
  };
  async function readSourceAuthority(tx, request) {
    const transfer = await readIssueTransferAuthority(tx, request);
    return readRelationshipPairAuthority(tx, { ...pairAuthorityOptions, ...request, transfer });
  }
  const capturedPairAuthority = (tx, authorization, transfer, repositoryIds, historyBudget = false) =>
    readCapturedRelationshipPairAuthority(tx, authorization.relationshipPairEvidence, {
      ...pairAuthorityOptions,
      transfer,
      sources: authorization.sources,
      repositoryIds,
      historyBudget,
    });
  const verifyConfig = options.verifyConfiguration ?? (async () => false);
  const discoveryAuthorityBinding = Object.freeze({
    configurationHash: policyDigest(c.metrics.stableJSON(config)),
    configurationVersion: config.version,
    dataMode,
  });
  const participationAuthority = createParticipationHistoryAuthority(options.participationHistoryAuthority);
  function drainDiscoveryPromise(value, seen = new WeakSet()) {
    // Reject foreign thenables without inspecting their properties. Constructor
    // and species behavior of native promises remains trusted host code.
    if (!types.isPromise(value) || seen.has(value)) return;
    seen.add(value);
    try {
      void Promise.prototype.then.call(
        value,
        () => undefined,
        (reason) => drainDiscoveryPromise(reason, seen),
      );
    } catch {}
  }
  function discoveryEpoch() {
    try {
      const value = options.configurationAuthorityEpoch?.(discoveryAuthorityBinding);
      if (typeof value === "string" && value.length >= 1 && value.length <= 100 && !/[^A-Za-z0-9_.:-]/.test(value))
        return value;
      drainDiscoveryPromise(value);
    } catch (error) {
      drainDiscoveryPromise(error);
    }
    return null;
  }
  const authorizeCorrection = options.authorizeCorrection ?? (async () => false);
  const now = options.now ?? (() => new Date().toISOString());
  // Only bounded named templates need whole-second producer event cutoffs.
  // Fresh scan/dispatch bindings sample this clock; stored retry cutoffs and
  // the independent source/observation clocks retain their original precision.
  const implicitPublicationCutoff = () => {
    const cutoff = utc(now());
    return config.scopes.some((scope) => ["7d", "30d", "90d", "month", "quarter", "year"].includes(scope.period))
      ? `${cutoff.slice(0, 19)}.000Z`
      : cutoff;
  };
  const policyComparisons = new PolicyComparisonStore(controlsStore, c.metrics, { now: () => Date.parse(utc(now())) });
  const aggregateExplanations = new AggregateExplanationStore(controlsStore);
  const computationVersion = `${dataMode}-pipeline-${digest(Array.isArray(config.policies) ? config.policies.map((item) => item?.signature) : []).slice(0, 16)}`;
  const currentControlsVersion = (controls, overlay, access, removed, corrections, cutoff) =>
    `controls-${controls.revision}-${overlay.revision}-${digest([
      config.version,
      access.map((row) => [String(row.repository_id), String(row.generation)]),
      [...removed].sort(),
      ...(corrections.decisions.length ? [reversionCapture(corrections, cutoff)] : []),
    ]).slice(0, 16)}`;
  const explanationBinding = (scope, publication) => ({
    scopeKey: scopeKey(scope),
    revision: publication.revision,
    computationVersion,
    configurationHash: digest(config),
  });
  async function readNormalizationEvidence(tx, authorization, historyBudget = false) {
    const binding = authorization.identityEvidence;
    if (binding === undefined) return null;
    requireThat(
      binding?.schemaVersion === "pipeline-identity-evidence/v1" &&
        Array.isArray(binding.normalizationHashes) &&
        binding.normalizationHashes.length <= 10000 &&
        binding.normalizationHashes.every((hash) => typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash)) &&
        new Set(binding.normalizationHashes).size === binding.normalizationHashes.length,
      409,
      "Frozen identity evidence binding unavailable",
    );
    const normalizationSources = binding.normalizationSources;
    const hashes = new Set(binding.normalizationHashes);
    requireThat(
      normalizationSources === undefined ||
        (Array.isArray(normalizationSources) &&
          normalizationSources.length <= 10000 &&
          normalizationSources.every(
            (entry) =>
              entry !== null &&
              typeof entry === "object" &&
              typeof entry.factKey === "string" &&
              /^[a-f0-9]{64}$/.test(entry.factKey) &&
              hashes.has(entry.documentHash) &&
              (entry.relationshipPairFactHashes === undefined ||
                (Array.isArray(entry.relationshipPairFactHashes) &&
                  entry.relationshipPairFactHashes.length > 0 &&
                  entry.relationshipPairFactHashes.length <= 10000 &&
                  entry.relationshipPairFactHashes.every(
                    (hash) => typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash),
                  ) &&
                  new Set(entry.relationshipPairFactHashes).size === entry.relationshipPairFactHashes.length)),
          ) &&
          new Set(normalizationSources.map((entry) => entry.factKey)).size === normalizationSources.length &&
          new Set(normalizationSources.map((entry) => entry.documentHash)).size === hashes.size),
      409,
      "Frozen identity source binding unavailable",
    );
    const normalizationQuery = `SELECT n.document,n.document_hash,n.policy_signature,f.fact_key,f.observed_at,f.first_run_id,f.family,
          f.repository_id,f.document - 'pullRequestDecisionHistory' AS source_document FROM leaderboard_pipeline.normalizations AS n
       JOIN leaderboard_ingestion.source_facts AS f ON f.fact_key=n.fact_key
       WHERE n.document_hash=ANY($1::text[]) AND (n.policy_signature=ANY($2::text[])
         OR (n.document->'pullRequestMergeTargetNormalization'->>'schemaVersion'=$6
           AND n.document->'pullRequestMergeTargetNormalization'->>'baseSignature'=$7))
         AND f.repository_id=ANY($3::bigint[])
         AND ($4::jsonb IS NULL OR EXISTS (
           SELECT 1 FROM jsonb_to_recordset($4::jsonb) AS bound(fact_key text,document_hash text)
           WHERE bound.fact_key=f.fact_key AND bound.document_hash=n.document_hash
         )) LIMIT $5 FOR SHARE OF n`;
    const rows = (
      await tx.query(
        historyBudget
          ? `WITH retained AS MATERIALIZED (${normalizationQuery}),
            bounded AS MATERIALIZED (
              SELECT retained.*,CASE WHEN document ? 'pullRequestMergeTargetNormalization' THEN
                jsonb_build_object('subjectId',source_document->'subjectId','sourceUrl',source_document->'sourceUrl',
                  'sourceRevision',source_document->'sourceRevision') END AS source_binding
              FROM retained
            ), footprint AS (
              SELECT count(*) AS records,COALESCE(sum(octet_length(document::text)+
                COALESCE(octet_length(source_binding::text),0)+octet_length(policy_signature)),0) AS bytes FROM bounded
            )
            SELECT CASE WHEN footprint.records<=10000 AND footprint.bytes<=8000000 THEN bounded.document END AS document,
              bounded.document_hash,bounded.fact_key,bounded.observed_at,bounded.first_run_id,bounded.family,
              bounded.repository_id,
              CASE WHEN footprint.records<=10000 AND footprint.bytes<=8000000 THEN bounded.policy_signature END AS policy_signature,
              CASE WHEN footprint.records<=10000 AND footprint.bytes<=8000000 THEN bounded.source_binding END AS source_document,
              footprint.records AS history_records,footprint.bytes AS history_bytes
            FROM bounded CROSS JOIN footprint`
          : normalizationQuery,
        [
          binding.normalizationHashes,
          // Legacy documents still bind historical frozen actor evidence;
          // only signatures covering every current source classification are eligible.
          identityNormalizationSignatures,
          authorization.sources.map((source) => source.repositoryId),
          normalizationSources === undefined
            ? null
            : JSON.stringify(
                normalizationSources.map((entry) => ({
                  fact_key: entry.factKey,
                  document_hash: entry.documentHash,
                })),
              ),
          historyBudget ? 10001 : 10000 * identityNormalizationSignatures.length + 1,
          mergeTargetNormalizationVersion,
          normalizationSignature,
        ],
      )
    ).rows;
    if (historyBudget) {
      if (
        rows.some(
          (row) =>
            row.document === null || Number(row.history_records) > 10000 || Number(row.history_bytes) > 8_000_000,
        )
      )
        fail("participation_history_normalization_budget_exceeded");
      for (const row of rows) row.document = copyParticipationHistoryJSON(row.document);
    }
    requireThat(
      new Set(rows.map((row) => JSON.stringify([row.fact_key, row.document_hash]))).size <= 10000 &&
        new Set(rows.map((row) => row.document_hash)).size === binding.normalizationHashes.length &&
        (normalizationSources === undefined ||
          new Set(rows.map((row) => row.fact_key)).size === normalizationSources.length),
      409,
      "Frozen identity evidence unavailable",
    );
    requireThat(
      rows.every((row) => digest(row.document) === row.document_hash),
      409,
      "Frozen identity evidence integrity failure",
    );
    const projections = new Map((normalizationSources ?? []).map((entry) => [entry.factKey, entry]));
    const capturedProjections = new Map(
      (authorization.relationshipPairEvidence?.bindings ?? []).map((entry) => [
        JSON.stringify([entry.factKey, entry.documentHash, entry.policySignature]),
        new Set(entry.factHashes),
      ]),
    );
    const projectedSources = new Set();
    const retained = rows.flatMap((row) => {
      const selected = projections.get(row.fact_key)?.relationshipPairFactHashes;
      if (selected === undefined) return [row];
      const captured = capturedProjections.get(JSON.stringify([row.fact_key, row.document_hash, row.policy_signature]));
      // Historical wrappers may retain identical bytes. Only the independently
      // verified current capture can authorize a dependency's actor projection.
      if (captured === undefined) return [];
      requireThat(
        selected.every((hash) => captured.has(hash)),
        409,
        "Frozen relationship pair projection unavailable",
      );
      const key = JSON.stringify([row.fact_key, row.document_hash]);
      if (projectedSources.has(key)) return [];
      const projected = { ...row, relationshipPairFactHashes: selected };
      relationshipPairCalculationDocument(projected);
      projectedSources.add(key);
      return [projected];
    });
    requireThat(
      (normalizationSources ?? []).every(
        (entry) =>
          entry.relationshipPairFactHashes === undefined ||
          projectedSources.has(JSON.stringify([entry.factKey, entry.documentHash])),
      ),
      409,
      "Frozen relationship pair projection unavailable",
    );
    const mergeAuthorization = captureMergeTargetAuthorization(authorization).mergeTargetEvidence;
    for (const row of retained) {
      if (row.document.pullRequestMergeTargetNormalization === undefined) {
        if (
          mergeAuthorization &&
          row.family === "pull_requests" &&
          String(row.repository_id) === mergeAuthorization.repositoryId
        )
          fail("merge_target_frozen_normalization_unavailable");
        continue;
      }
      await validateMergeTargetRow(row, mergeAuthorization?.cutoff ?? null);
    }
    return retained;
  }
  const reviewEvidenceCurrent = (row) =>
    row.family !== "reviews" ||
    (digest(row.document) === row.document_hash &&
      row.document.reviewSourceNormalizationVersion === reviewSourceNormalizationVersion);
  const assertReviewNormalizer = () => {
    // Bind compatibility to the callbacks actually retained at construction.
    // Their host declaration remains live across normalization and publication.
    if (
      ((providedNormalizer !== undefined && providedNormalizer !== null) || providedEnrichment
        ? options.reviewSourceNormalizationVersion
        : c.github?.reviewSourceNormalizationVersion) !== reviewSourceNormalizationVersion
    )
      fail("review_normalizer_version_unverified");
  };
  const discussionEvidenceCurrent = (row) =>
    row.family !== "discussions" ||
    (digest(row.document) === row.document_hash &&
      row.document.discussionSourceNormalizationVersion === discussionSourceNormalizationVersion &&
      (row.document.discussionFeedbackSources === undefined ||
        row.document.discussionFeedbackNormalizationVersion === discussionFeedbackContentVersion));
  const assertDiscussionNormalizer = () => {
    // Compatibility belongs to the callbacks selected at construction, while
    // their declaration must remain current through new publication admission.
    if (
      ((providedNormalizer !== undefined && providedNormalizer !== null) || providedEnrichment
        ? options.discussionSourceNormalizationVersion
        : c.github?.discussionSourceNormalizationVersion) !== discussionSourceNormalizationVersion
    )
      fail("discussion_normalizer_version_unverified");
  };
  const defaultDeliveryEvidenceCurrent = (row) =>
    !hasDefaultDeliveryClaims(row.document) ||
    (digest(row.document) === row.document_hash &&
      row.document.defaultDeliveryNormalizationVersion === defaultDeliveryNormalizationVersion);
  const relationshipPairComponentsCurrent = () =>
    c.contracts?.relationshipPairNormalizationVersion === relationshipPairNormalizationVersion &&
    c.metrics?.relationshipPairNormalizationVersion === relationshipPairNormalizationVersion;
  const relationshipPairGenerationCurrent = (row) =>
    relationshipPairNormalizationSignatures.has(row.policy_signature) ||
    (row.document.pullRequestMergeTargetNormalization !== undefined &&
      currentPairGenerationsFor(row.family, row.document).includes(row.policy_signature));
  const relationshipPairEvidenceCurrent = (row) =>
    (!hasRelationshipPairClaims(row.document) &&
      !hasRelationshipPairMarker(row.document) &&
      !relationshipPairGenerationCurrent(row)) ||
    (relationshipPairComponentsCurrent() &&
      digest(row.document) === row.document_hash &&
      relationshipPairGenerationCurrent(row) &&
      row.document.relationshipPairNormalizationVersion === relationshipPairNormalizationVersion);
  const assertRelationshipPairNormalizer = () => {
    if (!relationshipPairComponentsCurrent()) fail("relationship_pair_engine_version_unverified");
    if (
      (providedNormalizer === undefined || providedNormalizer === null
        ? c.github?.relationshipPairNormalizationVersion
        : options.relationshipPairNormalizationVersion) !== relationshipPairNormalizationVersion
    )
      fail("relationship_pair_normalizer_version_unverified");
  };
  const assertMergeTargetNormalizer = () => {
    // Compatibility follows the callback actually selected at construction.
    // Its declaration remains live across awaits and the visibility commit.
    if (
      mergeTargetRepositoryIds.length &&
      (providedNormalizer === undefined || providedNormalizer === null
        ? c.github?.pullRequestMergeTargetNormalizationVersion
        : options.pullRequestMergeTargetNormalizationVersion) !== mergeTargetNormalizationVersion
    )
      fail("merge_target_normalizer_version_unverified");
  };
  const fieldChangeEvidenceCurrent = (row) =>
    !hasFieldChangeClaims(row.document) ||
    (digest(row.document) === row.document_hash &&
      row.document.fieldChangeNormalizationVersion === fieldChangeNormalizationVersion);
  const assertFieldChangeNormalizer = () => {
    // An enrichment callback still uses the loaded built-in comparator. Only
    // a replacement normalizer can explicitly declare its own compatibility.
    if (
      (providedNormalizer === undefined || providedNormalizer === null
        ? c.github?.fieldChangeNormalizationVersion
        : options.fieldChangeNormalizationVersion) !== fieldChangeNormalizationVersion
    )
      fail("field_change_normalizer_version_unverified");
  };
  const triageMetadataEvidenceCurrent = (row) =>
    !hasTriageMetadataClaims(row.document) ||
    (digest(row.document) === row.document_hash &&
      row.document.triageMetadataNormalizationVersion === triageMetadataNormalizationVersion);
  const assertTriageMetadataNormalizer = () => {
    // Enrichment still executes the loaded comparator. Bind a replacement's
    // live declaration to the callback selected once at construction.
    if (
      (providedNormalizer === undefined || providedNormalizer === null
        ? c.github?.triageMetadataNormalizationVersion
        : options.triageMetadataNormalizationVersion) !== triageMetadataNormalizationVersion
    )
      fail("triage_metadata_normalizer_version_unverified");
  };
  const assertDiscussionFeedbackNormalizer = () => {
    // Retain the callbacks actually selected at construction, while reading
    // their declared compatibility at every later publication boundary.
    if (
      ((providedNormalizer !== undefined && providedNormalizer !== null) || providedEnrichment) &&
      options.discussionFeedbackNormalizationVersion !== discussionFeedbackContentVersion
    )
      fail("discussion_feedback_normalizer_version_unverified");
  };
  const assertDefaultDeliveryNormalizer = () => {
    // Enrichment still passes through the loaded built-in normalizer. A host
    // option cannot bless an older component; a replacement normalizer must
    // explicitly take responsibility for the current source semantics.
    if (
      (providedNormalizer === undefined || providedNormalizer === null
        ? c.github?.defaultDeliveryNormalizationVersion
        : options.defaultDeliveryNormalizationVersion) !== defaultDeliveryNormalizationVersion
    )
      fail("default_delivery_normalizer_version_unverified");
  };
  async function legacyInputHasFamily(tx, authorization, family, cutoff = null) {
    return (
      (
        await tx.query(
          `SELECT 1 FROM leaderboard_ingestion.source_facts
         WHERE repository_id=ANY($1::bigint[]) AND family=$2
           AND ($3::timestamptz IS NULL OR observed_at <= $3) LIMIT 1`,
          [authorization.sources.map((source) => source.repositoryId), family, cutoff],
        )
      ).rows.length !== 0
    );
  }
  // The caller holds the existing repository access locks. Source facts can
  // only be erased after retirement, which is incompatible with those locks
  // and a public source. Unrelated retained views keep their frozen-read rules.
  async function readDecisionPublicationReceipt(tx, operationKey, captureEnabled) {
    const row = (
      await tx.query(
        `SELECT CASE WHEN NOT $2::boolean OR octet_length(document::text)<=8000000 THEN document END AS document,
          document_hash,octet_length(document::text) AS document_bytes
        FROM leaderboard_pipeline.receipts WHERE operation_hash=${pipelineKeySQL("$1")} AND operation_key=$1
          AND kind='snapshot_published'`,
        [operationKey, captureEnabled],
      )
    ).rows[0];
    if (captureEnabled && row) {
      if (
        !Number.isSafeInteger(Number(row.document_bytes)) ||
        Number(row.document_bytes) < 0 ||
        Number(row.document_bytes) > 8_000_000 ||
        row.document === null
      )
        fail("decision_history_frozen_input_budget_exceeded");
      row.document = copyParticipationHistoryJSON(row.document);
    }
    return row;
  }

  // A private capture is optional for legacy publications. When present, use
  // only the construction-selected builtin and its INSERT-bound selected runs.
  function decisionReadFence(capture) {
    if (
      collectionSource !== defaultSource ||
      defaultSource === null ||
      capture.source !== decisionSourceId ||
      capture.runs.some((run) => !decisionRepositoryIds.includes(run.repositoryId))
    )
      fail("decision_history_builtin_source_required");
    const state = controlsStore.read();
    const revision = restrictConfiguration(state).revision;
    const recognition = recognitionBindings.length ? recognitionFingerprint(state, recognitionBindings) : null;
    const feedback = feedbackAuthority.capture();
    return () => {
      const current = controlsStore.read();
      if (
        restrictConfiguration(current).revision !== revision ||
        (recognitionBindings.length && recognitionFingerprint(current, recognitionBindings) !== recognition)
      )
        fail("decision_history_authorization_changed");
      feedbackAuthority.assert(feedback);
    };
  }

  async function retainedDecisionEvidence(tx, authorization, cutoff = null) {
    if (authorization.pullRequestDecisionEvidence === undefined) {
      if (authorization.pullRequestDecisionProjection !== undefined) fail("decision_history_projection_invalid");
      return null;
    }
    const capture = parseDecisionGenerationCapture(authorization.pullRequestDecisionEvidence);
    const projection =
      authorization.pullRequestDecisionProjection === undefined
        ? null
        : parseDecisionProjection(authorization.pullRequestDecisionProjection, capture);
    if (
      (cutoff !== null && capture.observationCutoff !== cutoff) ||
      capture.runs.some(
        (run) =>
          !authorization.sources.some(
            (source) => source.repositoryId === String(run.repositoryId) && source.generation === run.accessGeneration,
          ),
      )
    )
      fail("decision_history_capture_binding_changed");
    const assertCurrent = decisionReadFence(capture);
    const restored = await readDecisionGenerations(tx, {
      selectedRuns: capture.runs.map((run) => ({ repositoryId: run.repositoryId, runId: run.runId })),
      repositories: config.repositories,
      source: decisionSourceId,
      asOf: capture.asOf,
      observationCutoff: capture.observationCutoff,
      dataMode,
      assertAuthorized: assertCurrent,
      expected: capture,
      selectionAsOf: projection?.asOf ?? capture.asOf,
    });
    assertCurrent();
    return { ...restored, projection, assertCurrent };
  }

  async function publicationNormalizationBinding(
    tx,
    scope,
    publication,
    explanation,
    { maxFrozenBytes = null, historyBudget = false } = {},
  ) {
    if (maxFrozenBytes !== null && (!Number.isSafeInteger(maxFrozenBytes) || maxFrozenBytes < 0))
      fail("invalid_publication_proof_budget");
    const authorization = explanation.authorization;
    const decision = await retainedDecisionEvidence(tx, authorization, explanation.cutoff);
    if (decision !== null) maxFrozenBytes = maxFrozenBytes === null ? 8_000_000 : Math.min(maxFrozenBytes, 8_000_000);
    const needsMergeTarget = scope.branch !== undefined;
    if (
      canonical(captureMergeTargetAuthorization(authorization)) !==
      canonical(mergeTargetAuthorization(scope, explanation.cutoff))
    )
      fail("public_merge_target_authority_mismatch");
    const selectedIds = repositoriesFor(scope).map((repo) => String(repo.id));
    await feedbackStore.assertCapture(tx, selectedIds.map(Number), authorization.discussionFeedbackEvidence);
    await feedbackStore.originals(
      tx,
      controlsStore.read(),
      recognitionBindings.filter((binding) => selectedIds.includes(binding.repositoryId)),
    );
    const transferAuthority = await readSourceAuthority(tx, {
      repositories: config.repositories,
      repositoryIds: selectedIds,
      dataMode,
      historyBudget,
    });
    if (authorization.issueTransferEvidence !== undefined) {
      assertIssueTransferCapture(authorization.issueTransferEvidence, transferAuthority.rows, selectedIds);
    } else if (transferAuthority.transfers.length || transferAuthority.repositoryIds.length !== selectedIds.length) {
      return { obsolete: "issue_transfer" };
    }
    // The integrity-checked explanation records all policy-matching input
    // references. Its actual delivery claims also cover enriched non-PR sources.
    const defaultDelivery = explanation.references.some((entry) => defaultDeliveryMetrics.has(entry.metricId));
    const relationshipPair =
      explanation.references.some((entry) => isRelationshipPairMetric(entry.metricId)) ||
      hasRelationshipPairMarker(publication) ||
      hasRelationshipPairMarker(controlsStore.read().pipelinePublications?.[publication.snapshotId]);
    if (relationshipPair && authorization.relationshipPairEvidence === undefined)
      return { obsolete: "relationship_pair" };
    if (authorization.relationshipPairEvidence !== undefined) {
      const pairAuthority = await capturedPairAuthority(
        tx,
        authorization,
        transferAuthority,
        selectedIds,
        historyBudget,
      );
      if (!pairAuthority.available || !pairAuthority.sourcesCurrent) return { obsolete: "relationship_pair" };
    }
    const fieldChange = explanation.references.some((entry) => fieldChangeMetrics.has(entry.metricId));
    const triageMetadata = explanation.references.some((entry) => triageMetadataMetrics.has(entry.metricId));
    const needsReview = await legacyInputHasFamily(tx, authorization, "reviews", explanation.cutoff);
    const needsDiscussion = await legacyInputHasFamily(tx, authorization, "discussions", explanation.cutoff);
    const kind = relationshipPair
      ? "relationship_pair"
      : triageMetadata
        ? "triage_metadata"
        : fieldChange
          ? "field_change"
          : defaultDelivery
            ? "default_delivery"
            : needsReview
              ? "review"
              : needsDiscussion
                ? "discussion"
                : "review";
    if (
      authorization.issueTransferEvidence === undefined &&
      canonical(authorization.sources.map((entry) => entry.repositoryId).sort()) !==
        canonical(
          repositoriesFor(scope)
            .map((entry) => String(entry.id))
            .sort(),
        )
    )
      fail(`public_${kind}_source_scope_mismatch`);
    if (
      !needsMergeTarget &&
      !needsReview &&
      !needsDiscussion &&
      !defaultDelivery &&
      !relationshipPair &&
      !fieldChange &&
      !triageMetadata &&
      decision === null &&
      authorization.issueTransferEvidence === undefined
    )
      return {
        review: false,
        discussion: false,
        defaultDelivery: false,
        relationshipPair: false,
        fieldChange: false,
        triageMetadata: false,
      };
    // An empty transfer capture adds no family normalization requirement to an
    // ordinary historical publication. Its exact frozen transfer content still
    // binds the snapshot below. Newly discovered proof or dependencies retain
    // the full evidence path, as do all review/Discussion/delivery inputs.
    const ordinaryEmptyTransfer =
      !needsMergeTarget &&
      !needsReview &&
      !needsDiscussion &&
      !defaultDelivery &&
      !relationshipPair &&
      !fieldChange &&
      !triageMetadata &&
      decision === null &&
      authorization.issueTransferEvidence?.bindings.length === 0 &&
      transferAuthority.rows.length === 0 &&
      canonical([...transferAuthority.repositoryIds].sort()) === canonical([...selectedIds].sort());
    const rows = ordinaryEmptyTransfer ? [] : await readNormalizationEvidence(tx, authorization, historyBudget);
    if (rows === null) return { obsolete: kind };
    if (needsReview && !rows.every(reviewEvidenceCurrent)) return { obsolete: "review" };
    if (needsDiscussion && !rows.every(discussionEvidenceCurrent)) return { obsolete: "discussion" };
    if (
      defaultDelivery &&
      (!rows.some((row) => hasDefaultDeliveryClaims(row.document)) || !rows.every(defaultDeliveryEvidenceCurrent))
    )
      return { obsolete: "default_delivery" };
    if (
      relationshipPair &&
      (!rows.some(
        (row) =>
          hasRelationshipPairClaims(row.document) ||
          hasRelationshipPairMarker(row.document) ||
          relationshipPairGenerationCurrent(row),
      ) ||
        !rows.every(relationshipPairEvidenceCurrent))
    )
      return { obsolete: "relationship_pair" };
    if (
      fieldChange &&
      (!rows.some((row) => hasFieldChangeClaims(row.document)) || !rows.every(fieldChangeEvidenceCurrent))
    )
      return { obsolete: "field_change" };
    if (
      triageMetadata &&
      (!rows.some((row) => hasTriageMetadataClaims(row.document)) || !rows.every(triageMetadataEvidenceCurrent))
    )
      return { obsolete: "triage_metadata" };
    const review = rows.some((row) => row.family === "reviews");
    const discussion = rows.some((row) => row.family === "discussions");
    if (
      !needsMergeTarget &&
      !review &&
      !discussion &&
      !defaultDelivery &&
      !relationshipPair &&
      !fieldChange &&
      !triageMetadata &&
      decision === null &&
      authorization.issueTransferEvidence === undefined
    )
      return {
        review: false,
        discussion: false,
        defaultDelivery: false,
        relationshipPair: false,
        fieldChange: false,
        triageMetadata: false,
      };
    const retained = (
      await tx.query(
        `SELECT CASE WHEN $2::bigint IS NULL OR octet_length(document::text)<=$2 THEN document END AS document,
        document_hash,octet_length(document::text) AS document_bytes
        FROM leaderboard_pipeline.frozen_inputs WHERE snapshot_id=$1`,
        [publication.snapshotId, maxFrozenBytes],
      )
    ).rows[0];
    if (
      maxFrozenBytes !== null &&
      retained &&
      (!Number.isSafeInteger(Number(retained.document_bytes)) ||
        Number(retained.document_bytes) < 0 ||
        Number(retained.document_bytes) > maxFrozenBytes)
    )
      fail("operator_publication_proof_budget_exceeded");
    if ((historyBudget || decision !== null) && retained)
      retained.document = copyParticipationHistoryJSON(retained.document);
    if (
      !retained ||
      digest(retained.document) !== retained.document_hash ||
      scopeKey(retained.document.scope) !== scopeKey(scope) ||
      retained.document.frozen?.datasetId !== explanation.datasetId ||
      retained.document.frozen?.cutoff !== explanation.cutoff ||
      retained.document.frozen?.backfillRevision !== explanation.backfillRevision ||
      retained.document.identityAuthorization?.configurationHash !== digest(config) ||
      retained.document.identityAuthorization?.dataMode !== dataMode ||
      canonical(retained.document.identityAuthorization?.sources) !== canonical(authorization.sources) ||
      (!ordinaryEmptyTransfer &&
        canonical(retained.document.identityAuthorization?.identityEvidence) !==
          canonical(authorization.identityEvidence)) ||
      canonical(retained.document.identityAuthorization?.issueTransferEvidence) !==
        canonical(authorization.issueTransferEvidence) ||
      canonical(retained.document.identityAuthorization?.discussionFeedbackEvidence) !==
        canonical(authorization.discussionFeedbackEvidence) ||
      canonical(retained.document.identityAuthorization?.relationshipPairEvidence) !==
        canonical(authorization.relationshipPairEvidence) ||
      canonical(retained.document.identityAuthorization?.pullRequestDecisionEvidence) !==
        canonical(authorization.pullRequestDecisionEvidence) ||
      canonical(retained.document.identityAuthorization?.pullRequestDecisionProjection) !==
        canonical(authorization.pullRequestDecisionProjection) ||
      canonical(captureMergeTargetAuthorization(retained.document.identityAuthorization ?? {})) !==
        canonical(mergeTargetAuthorization(scope, explanation.cutoff)) ||
      (needsMergeTarget && retained.document.engineScope?.branch !== scope.branch) ||
      (authorization.issueTransferEvidence !== undefined &&
        (canonical([...retained.document.frozen.repositoryIds].sort()) !==
          canonical(authorization.sources.map((source) => source.repositoryId).sort()) ||
          canonical([...retained.document.engineScope.repos].sort()) !== canonical([...selectedIds].sort())))
    )
      fail(`public_${kind}_frozen_input_integrity_error`);
    if (!decision?.projection && retained.document.frozen.facts.some((fact) => fact.decisionAsOf !== undefined))
      fail("decision_history_projection_binding_changed");
    if (decision?.projection) {
      if (retained.document.engineScope?.to !== decision.projection.asOf)
        fail("decision_history_projection_binding_changed");
      assertDecisionProjection(retained.document.frozen, decision, rows, decision.projection);
    }
    decision?.assertCurrent();
    return {
      review,
      discussion,
      defaultDelivery,
      fieldChange,
      triageMetadata,
      discussionFeedbackContent: authorization.discussionFeedbackEvidence?.length
        ? { discussionFeedbackEvidenceHash: digest(authorization.discussionFeedbackEvidence) }
        : {},
      relationshipPair,
      ...(authorization.issueTransferEvidence === undefined
        ? {}
        : {
            frozenInputBytes: Number(retained.document_bytes),
            issueTransferContent: {
              repositoryIds: retained.document.frozen.repositoryIds.map(Number),
              issueTransferEvidenceHash: digest(retained.document.identityAuthorization.issueTransferEvidence),
              ...(authorization.relationshipPairEvidence === undefined
                ? {}
                : {
                    relationshipPairEvidenceHash: digest(
                      retained.document.identityAuthorization.relationshipPairEvidence,
                    ),
                  }),
            },
          }),
    };
  }
  // Source read locks span the final reviewer reauthentication and synchronous
  // private result transaction. No source/network permission is granted here.
  async function withAuthorizedComparisonInputs(authorizations, work, transaction, historyBudget = false) {
    const comparisonFeedbackAuthority = feedbackAuthority.capture();
    const decisionFences = [];
    requireThat(
      authorizations.every(
        (authorization) => authorization.configurationHash === digest(config) && authorization.dataMode === dataMode,
      ),
      409,
      "Frozen input configuration changed",
    );
    const read = async (tx) => {
      requireThat(await approved(tx), 409, "Frozen input authorization unavailable");
      const sources = authorizations.flatMap((authorization) => authorization.sources);
      const ids = [...new Set(sources.map((source) => source.repositoryId))];
      const access = await lockIssueTransferSources(tx, config.repositories);
      const transferAuthorities = [];
      const selectedIds = new Set();
      for (const authorization of authorizations) {
        const saved = authorization.issueTransferEvidence;
        if (saved !== undefined) validateIssueTransferCapture(saved);
        const selected = saved?.selectedRepositoryIds ?? authorization.sources.map((source) => source.repositoryId);
        await feedbackStore.assertCapture(tx, selected.map(Number), authorization.discussionFeedbackEvidence);
        await feedbackStore.originals(
          tx,
          controlsStore.read(),
          recognitionBindings.filter((binding) => selected.includes(binding.repositoryId)),
        );
        selected.forEach((id) => selectedIds.add(id));
        const current = await readSourceAuthority(tx, {
          repositories: config.repositories,
          repositoryIds: selected,
          artifactIds: saved?.artifactIds ?? [],
          dataMode,
          historyBudget,
        });
        if (saved !== undefined) assertIssueTransferCapture(saved, current.rows, selected);
        else
          requireThat(
            !current.transfers.length && current.repositoryIds.length === selected.length,
            409,
            "Frozen issue transfer normalization obsolete",
          );
        requireThat(current.selectedPublic, 409, "Frozen input source authorization changed");
        if (authorization.relationshipPairEvidence !== undefined) {
          const pairAuthority = await capturedPairAuthority(tx, authorization, current, selected, historyBudget);
          requireThat(
            pairAuthority.available && pairAuthority.sourcesCurrent,
            409,
            "Frozen relationship pair source authorization changed",
          );
          pairAuthority.requiredIds.forEach((id) => selectedIds.add(id));
        }
        transferAuthorities.push(current);
      }
      requireThat(
        access.filter((row) => ids.includes(String(row.repository_id))).length === ids.length &&
          sources.every((source) =>
            access.some(
              (row) =>
                String(row.repository_id) === source.repositoryId &&
                (!selectedIds.has(source.repositoryId) || row.state === "public") &&
                String(row.generation) === source.generation,
            ),
          ),
        409,
        "Frozen input source authorization changed",
      );
      const restoredActors = new Map();
      const restoredMergeTargets = new Map();
      const restoredDecisions = new Map();
      for (const authorization of authorizations) {
        const decision = await retainedDecisionEvidence(tx, authorization);
        if (decision !== null) decisionFences.push(decision.assertCurrent);
        const binding = authorization.identityEvidence;
        const rows = await readNormalizationEvidence(tx, authorization, historyBudget);
        if (rows === null) {
          requireThat(
            !(await legacyInputHasFamily(tx, authorization, "reviews")),
            409,
            "Frozen review evidence unavailable",
          );
          requireThat(
            !(await legacyInputHasFamily(tx, authorization, "discussions")),
            409,
            "Frozen Discussion evidence unavailable",
          );
          // Authorization without an evidence binding cannot prove that the
          // complete legacy capture was free of enriched delivery claims.
          // Replaying and recapturing creates an independently verifiable input.
          requireThat(false, 409, "Frozen normalization evidence unavailable");
        }
        requireThat(rows.every(reviewEvidenceCurrent), 409, "Frozen review normalization obsolete");
        requireThat(rows.every(discussionEvidenceCurrent), 409, "Frozen Discussion normalization obsolete");
        requireThat(rows.every(defaultDeliveryEvidenceCurrent), 409, "Frozen default delivery normalization obsolete");
        requireThat(
          rows.every(relationshipPairEvidenceCurrent),
          409,
          "Frozen relationship pair normalization obsolete",
        );
        requireThat(
          !rows.some((row) => hasRelationshipPairClaims(row.document) || hasRelationshipPairMarker(row.document)) ||
            authorization.relationshipPairEvidence !== undefined,
          409,
          "Frozen relationship pair source binding unavailable",
        );
        requireThat(rows.every(fieldChangeEvidenceCurrent), 409, "Frozen field change normalization obsolete");
        requireThat(rows.every(triageMetadataEvidenceCurrent), 409, "Frozen triage metadata normalization obsolete");
        if (authorization.mergeTargetEvidence !== undefined)
          restoredMergeTargets.set(
            digest(authorization),
            rows.flatMap((row) => row.document.pullRequestMergeTargets ?? []),
          );
        const normalizationSources = binding.normalizationSources;
        // Hash-only legacy captures did not bind source ordering. They retain
        // their identical-label rule rather than gaining unproven rename history.
        const identity = sourceActorEvidence(normalizationSources !== undefined);
        for (const row of rows) {
          requireThat(
            digest(row.document) === row.document_hash &&
              row.document.isSynthetic === (dataMode === "synthetic") &&
              Array.isArray(row.document.actors),
            409,
            "Frozen identity evidence integrity failure",
          );
          assertDataMode(row.document);
          for (const actor of relationshipPairCalculationDocument(row).actors) {
            requireThat(
              retainSourceActor(identity, actor, sourceBinding(row), canonical, c.contracts),
              409,
              "Frozen identity evidence conflict",
            );
          }
        }
        restoredActors.set(digest(authorization), identity.actors);
        if (decision?.projection) restoredDecisions.set(digest(authorization), { decision, rows });
      }
      const removed = [...new Set(transferAuthorities.flatMap((authority) => authority.removed))];
      const corrections = await readCorrectionState(tx, [
        ...new Set([...ids, ...transferAuthorities.flatMap((authority) => authority.repositoryIds)]),
      ]);
      for (const authorization of authorizations)
        assertReversionCapture(
          authorization,
          await readCorrectionState(
            tx,
            authorization.sources.map((source) => Number(source.repositoryId)),
          ),
          utc(now()),
        );
      const correctionArtifacts = corrections.legacy
        .filter((correction) =>
          authorizations.some((authorization) => !issueTransferCorrectionExempt(authorization, correction)),
        )
        .map((correction) => correction.artifact_id);
      const correctionSeeds = correctionArtifacts.length
        ? [
            ...correctionArtifacts,
            ...expandIssueTransferSuppressions(
              transferAuthorities.flatMap((authority) => authority.transfers),
              { artifactIds: correctionArtifacts.filter(issueArtifactId) },
            ),
          ]
        : [];
      removed.push(
        ...correctionSeeds,
        ...transferAuthorities.flatMap((authority) => expandRelationshipPairSuppressions(authority, correctionSeeds)),
      );
      removed.push(
        ...expandIssueTransferSuppressions(
          transferAuthorities.flatMap((authority) => authority.transfers),
          { artifactIds: removed.filter(issueArtifactId) },
        ),
      );
      return work(
        [...new Set(removed)],
        {
          refreshApproval: () => approved(tx),
          restoreInput(input, authorization) {
            if (
              authorization.pullRequestDecisionEvidence !== undefined &&
              parseDecisionGenerationCapture(authorization.pullRequestDecisionEvidence).observationCutoff !==
                input.cutoff
            )
              fail("decision_history_capture_binding_changed");
            decisionFences.forEach((assertCurrent) => assertCurrent());
            const retainedDecision = restoredDecisions.get(digest(authorization));
            if (!retainedDecision && input.facts.some((fact) => fact.decisionAsOf !== undefined))
              fail("decision_history_projection_binding_changed");
            if (retainedDecision)
              assertDecisionProjection(
                input,
                retainedDecision.decision,
                retainedDecision.rows,
                retainedDecision.decision.projection,
              );
            if (authorization.identityEvidence === undefined) return input;
            if (authorization.mergeTargetEvidence !== undefined) {
              const captures = restoredMergeTargets.get(digest(authorization));
              requireThat(captures, 409, "Frozen merge-target authority unavailable");
              assertMergeTargetFacts(input.facts, captures, { complete: false });
            }
            const actors = restoredActors.get(digest(authorization));
            requireThat(actors, 409, "Frozen identity evidence unavailable");
            return {
              ...input,
              actors: input.actors.map((actor) => {
                const source = actors.get(actor.id);
                requireThat(
                  source && canonical(previewActor({ ...source, publicState: actor.publicState })) === canonical(actor),
                  409,
                  "Frozen actor identity changed",
                );
                return {
                  ...actor,
                  ...(source.githubDatabaseId === undefined ? {} : { githubDatabaseId: source.githubDatabaseId }),
                  ...(source.githubNodeId === undefined ? {} : { githubNodeId: source.githubNodeId }),
                  ...(source.serviceAccountClassification === undefined
                    ? {}
                    : { serviceAccountClassification: copy(source.serviceAccountClassification) }),
                };
              }),
            };
          },
          isCurrent(session) {
            // The host must atomically read its authoritative roster/configuration
            // cache. Two independently awaited checks cannot establish this fence.
            if (typeof options.policyComparisonAuthorityCurrent !== "function") return false;
            try {
              feedbackAuthority.assert(comparisonFeedbackAuthority);
              decisionFences.forEach((assertCurrent) => assertCurrent());
            } catch {
              return false;
            }
            const current = options.policyComparisonAuthorityCurrent({
              configurationHash: digest(config),
              actorId: session.actorId,
              roleVersion: session.roleVersion,
            });
            if (current && typeof current.then === "function") void Promise.resolve(current).catch(() => undefined);
            try {
              feedbackAuthority.assert(comparisonFeedbackAuthority);
              decisionFences.forEach((assertCurrent) => assertCurrent());
            } catch {
              return false;
            }
            return current === true;
          },
        },
        tx,
      );
    };
    const result = await (transaction ? read(transaction) : db.transaction(read));
    decisionFences.forEach((assertCurrent) => assertCurrent());
    return result;
  }
  const contentEditAdmission = createGithubContentEditAdmission();
  const defaultSource = selectedGithubClient
    ? createGithubCollectionSource({
        client: selectedGithubClient,
        sourceId: decisionSourceId,
        pullRequestDecisionRepositoryIds: decisionRepositoryIds,
        decisionHistoryNow: decisionClock,
        repositories: config.repositories,
        isSynthetic: dataMode === "synthetic",
        assertAuthorized: () => assertRunConfiguration(),
        onUnavailable: (repo, reason) => denyRepository(repo, reason, utc(now())),
        includePullRequestReviewComments: ({ runId }) => expandedGithubCommentsRun(runId),
        includeContentEditMetadata: (request) => contentEditAdmission.allows(request),
        includeCommentEditMetadata: (request) => contentEditAdmission.allowsComments(request),
        ...(feedbackAuthority.enabled
          ? { discussionFeedback: { authority: feedbackAuthority, store: feedbackStore } }
          : {}),
        async useRestSnapshotRevisions({ repositoryId, family }) {
          if (reconciliationPolicy) return true;
          // Keep immutable observation identities after an approved policy change
          // removes scheduling. This is retained format compatibility, not source
          // authority or coverage: current selection can still see older retained
          // generations, and native fact keys can refer to an earlier observation.
          const retained = await db.query(
            `SELECT 1 FROM leaderboard_ingestion.source_facts
             WHERE repository_id=$1 AND family=$2 AND source_revision LIKE 'gh-rest-%' LIMIT 1`,
            [repositoryId, family],
          );
          return retained.rows.length > 0;
        },
      })
    : null;
  const collectionSource = selectedCustomSource ?? defaultSource;
  const readCollectionPage = collectionSource?.readPage;
  const defaultCommentsInventory =
    defaultSource !== null &&
    collectionSource === defaultSource &&
    config.repositories.some((repository) => repository.families.includes("comments"));
  const defaultContentEditInventory =
    defaultSource !== null &&
    collectionSource === defaultSource &&
    config.repositories.some((repository) => repository.families.includes("content_edits"));
  const probeSource = options.probeRepository ?? defaultSource?.probeRepository;
  const scanContinuations = new ScanContinuationStore(db);
  const guardedSource = {
    assertAuthorized() {
      assertRunConfiguration();
    },
    async readPage(request) {
      // The controls overlay can change while an earlier probe/page is pending.
      // Recheck before collection and reject results that lost authorization.
      assertRunConfiguration();
      const page = decisionRepositoryIds.length
        ? await readCollectionPage.call(collectionSource, request)
        : await collectionSource.readPage(request);
      assertRunConfiguration();
      assertDataMode(page);
      return page;
    },
  };
  if (decisionRepositoryIds.length) Object.freeze(guardedSource);
  const collection = new c.ingestion.CollectionStore(
    db,
    decisionRepositoryIds.length
      ? { sourceId: decisionSourceId, dataMode, repositoryIds: decisionRepositoryIds, source: guardedSource }
      : undefined,
  );
  const configurationOverlay = (state) =>
    options.configurationOverlay?.(state) ??
    c.controls.configurationOverlay?.(state) ?? {
      revision: 0,
      allowedRepositoryIds: null,
      allowedRepositories: null,
      allowedProjectIds: null,
      disabledMetricIds: [],
      disabledMetrics: [],
    };
  const projectDeniedRepositories = new Set();
  const projectDenialKey = (repo) => `project-scope-denial:${repo.id}:${digest(config.version)}`;
  const issueFieldDeniedRepositories = new Set();
  const issueFieldDenialKey = (repo) => `issue-field-scope-denial:${repo.id}:${digest(config.version)}`;
  const sourceDenialScopes = [
    {
      reason: "project_scope_unavailable",
      kind: "project_scope_denial",
      key: projectDenialKey,
      denied: projectDeniedRepositories,
    },
    {
      reason: "issue_field_scope_unavailable",
      kind: "issue_field_scope_denial",
      key: issueFieldDenialKey,
      denied: issueFieldDeniedRepositories,
    },
  ];
  const restrictConfiguration = (state) => {
    const overlay = configurationOverlay(state);
    if (
      config.repositories.some(
        (repo) =>
          issueFieldDeniedRepositories.has(repo.id) ||
          (state.pipelineSourceDenials?.[repo.id]?.configurationVersion === config.version &&
            state.pipelineSourceDenials[repo.id].reason === "issue_field_scope_unavailable"),
      )
    )
      fail("issue_field_source_scope_requires_reapproval");
    if (
      config.repositories.some(
        (repo) =>
          projectDeniedRepositories.has(repo.id) ||
          state.pipelineSourceDenials?.[repo.id]?.configurationVersion === config.version,
      )
    )
      fail("project_source_scope_requires_reapproval");
    if (
      overlay.allowedRepositoryIds !== null &&
      config.repositories.some((repo) => !overlay.allowedRepositoryIds.includes(String(repo.id)))
    )
      fail("active_configuration_revoked_source");
    // Activated controls may narrow any part of the independently verified baseline.
    // A stale runtime must be rebuilt against that scope, not silently keep old grants.
    if (state.configuration?.active || overlay.allowedRepositories != null || overlay.allowedProjectIds != null) {
      if (!Array.isArray(overlay.allowedRepositories) || !Array.isArray(overlay.allowedProjectIds))
        fail("active_configuration_source_scope_unavailable");
      for (const repo of config.repositories) {
        const active = overlay.allowedRepositories.find((entry) => entry.id === String(repo.id));
        if (!active || active.installationId !== String(repo.installationId) || active.slug !== repo.slug)
          fail("active_configuration_repository_binding_changed");
        if (
          !Array.isArray(active.capabilities) ||
          repo.families.some((family) => !active.capabilities.includes(family))
        )
          fail("active_configuration_revoked_capability");
        if (
          repo.allowedProjectIds !== undefined &&
          (!Array.isArray(repo.allowedProjectIds) ||
            repo.allowedProjectIds.some((id) => !overlay.allowedProjectIds.includes(id)))
        )
          fail("active_configuration_revoked_project");
      }
    }
    return overlay;
  };
  // Runs are serialized. A reactivation must start a fresh run rather than
  // accepting a response begun under an earlier controls configuration.
  const recognitionBindings = copy(config.recognitionBindings ?? []);
  let runRecognitionFingerprint = null;
  let runConfigurationRevision = null;
  let runFeedbackAuthority = null;
  const assertConfigurationCurrent = () => {
    const state = controlsStore.read();
    const overlay = restrictConfiguration(state);
    if (recognitionBindings.length && recognitionFingerprint(state, recognitionBindings) !== runRecognitionFingerprint)
      fail("recognition_changed_during_run");
    if (overlay.revision !== runConfigurationRevision) fail("active_configuration_changed");
    if (feedbackAuthority.enabled) feedbackAuthority.assert(runFeedbackAuthority);
  };
  const assertRunConfiguration = () => {
    assertConfigurationCurrent();
    assertMergeTargetNormalizer();
  };
  const scanContext = (mode, sources, revision, fingerprint) => ({
    key: digest(["bounded-scan/v1", config, dataMode, mode]),
    contextHash: digest(
      githubContentEditsContext(
        githubCommentsContext(
          [
            revision,
            recognitionBindings.length ? fingerprint : null,
            sources,
            ...(decisionRepositoryIds.length
              ? [pullRequestDecisionGenerationVersion, decisionSourceId, decisionRepositoryIds]
              : []),
            ...(feedbackAuthority.enabled ? [discussionFeedbackContentVersion, feedbackAuthority.capture()] : []),
            // Selected release proofs use the PR delivery generation. Retire an older
            // frozen scan before collecting a newly required normalization generation.
            ...(dataMode === "public" && (config.releaseInclusionTargets?.length || selectedDocumentationPurpose)
              ? [defaultDeliverySignature(normalizationSignature)]
              : []),
          ],
          defaultCommentsInventory,
        ),
        defaultContentEditInventory,
        true,
      ),
    ),
  });
  async function reconciliationState(tx, repositories, asOf, { untilCutoff = asOf, scan = null } = {}) {
    const state = controlsStore.read();
    const revision = restrictConfiguration(state).revision;
    const fingerprint = recognitionFingerprint(state, recognitionBindings);
    // The plan context binds the complete configuration, even for a single-repo
    // public or private read. Never derive another context from a scope subset.
    const access = (
      await tx.query(
        "SELECT repository_id,installation_id,state,generation FROM leaderboard_ingestion.repository_access WHERE repository_id=ANY($1::bigint[]) ORDER BY repository_id FOR SHARE",
        [config.repositories.map((repo) => repo.id)],
      )
    ).rows;
    if (
      access.length !== config.repositories.length ||
      access.some(
        (row) =>
          row.state !== "public" ||
          String(row.installation_id) !==
            String(config.repositories.find((repo) => String(repo.id) === String(row.repository_id))?.installationId),
      )
    )
      fail("reconciliation_source_context_unavailable");
    const sources = access.map((row) => ({
      repositoryId: Number(row.repository_id),
      generation: String(row.generation),
    }));
    const identity = scanContext("reconcile", sources, revision, fingerprint);
    if (scan && (scan.key !== identity.key || scan.contextHash !== identity.contextHash))
      fail("reconciliation_source_context_changed");
    const progress = await readReconciliationProgress(tx, repositories, asOf, {
      contextDigest: reconciliationContextDigest(identity),
      untilCutoff,
    });
    const confirmCurrent = () => {
      try {
        const current = controlsStore.read();
        return (
          restrictConfiguration(current).revision === revision &&
          (!recognitionBindings.length || recognitionFingerprint(current, recognitionBindings) === fingerprint)
        );
      } catch {
        return false;
      }
    };
    if (!confirmCurrent()) fail("reconciliation_source_context_changed");
    return { progress, sources, confirmCurrent };
  }
  const inbox = new c.ingestion.InboxStore(db);
  const outbox = new c.ingestion.OutboxStore(db);
  if (options.webhookDispatch !== undefined && typeof options.webhookDispatch !== "boolean")
    fail("invalid_webhook_dispatch_option");
  if (options.webhookDispatch && dataMode !== "synthetic") fail("public_webhook_dispatch_not_approved");
  // Capture the same provider choice used by the callback. Host option changes
  // cannot turn a retained replacement callback into the loaded builtin.
  const providedNormalizer = options.normalizer;
  const providedEnrichment =
    (providedNormalizer === undefined || providedNormalizer === null) &&
    options.githubClient &&
    c.github.createGithubEvidenceNormalizer
      ? options.githubEnrich
      : undefined;
  const normalizer =
    providedNormalizer ??
    (options.githubClient && c.github.createGithubEvidenceNormalizer
      ? c.github.createGithubEvidenceNormalizer({
          client: options.githubClient,
          source: options.sourceId,
          allowedRepositoryIds: config.repositories.map((repo) => repo.id),
          isSynthetic: dataMode === "synthetic",
          assertAuthorized: () => assertRunConfiguration(),
          verifyDiscussionFeedbackSource: (input) => feedbackStore.verifyInput(input),
          documentationPolicies: config.documentationPolicies ?? [],
          researchPolicies: config.researchPolicies ?? [],
          releaseInclusionTargets: config.releaseInclusionTargets ?? [],
          ...(mergeTargetRepositoryIds.length ? { pullRequestMergeTargetRepositoryIds: mergeTargetRepositoryIds } : {}),
          now: () => utc(now()),
          projectWorkstreamMappings,
          ...(providedEnrichment ? { enrich: providedEnrichment } : {}),
        })
      : null);
  let stopped = false;
  let stopping = null;
  let runner = null;
  let controller = null;
  let webhookServer = null;
  let workerController = null;
  let workerPromise = null;
  let outboxController = null;
  let outboxPromise = null;
  let enrichmentController = null;
  let enrichmentPromise = null;
  let controlsServer = null;
  let authorized = false;
  let operation = Promise.resolve();
  const monitorSource = (repositoryId) => `repository:${repositoryId}`;
  const monitorSuccess = (source, stage, started, revision = null) => {
    try {
      options.monitor?.success({ source, stage, latencyMs: performance.now() - started, revision });
    } catch {
      /* telemetry cannot change durable outcomes */
    }
  };
  const monitorFailure = (source, stage, code) => {
    try {
      void Promise.resolve(
        options.monitor?.failure({ source, stage, code, traceId: digest([source, stage, code, now()]).slice(0, 32) }),
      ).catch(() => undefined);
    } catch {
      /* no raw errors or unapproved destination */
    }
  };
  // One publisher in this runtime; SQL advisory locks protect separate runtimes.
  const serialize = (work) => {
    const pending = operation.then(work);
    operation = pending.catch(() => undefined);
    return pending;
  };
  async function approved(transaction = db) {
    const capturedFeedbackAuthority = feedbackAuthority.capture();
    authorized = Boolean(await verifyConfig(copy(config)));
    if (!authorized) return false;
    assertDataMode(config);
    for (const scope of sourceDenialScopes) {
      // Each fixed source class retains its exact receipt kind and bounded key
      // lookup. In particular, the existing Project query and keys stay intact.
      const persistedDenials = await transaction.query(
        `SELECT receipt.operation_key
      FROM unnest($1::text[]) AS requested(operation_key)
      JOIN leaderboard_pipeline.receipts AS receipt
        ON receipt.operation_hash=pg_catalog.sha256(pg_catalog.convert_to(requested.operation_key,'UTF8'))
        AND receipt.operation_key=requested.operation_key
      WHERE receipt.kind='${scope.kind}'`,
        [config.repositories.map(scope.key)],
      );
      for (const repo of config.repositories)
        if (persistedDenials.rows.some((row) => row.operation_key === scope.key(repo))) scope.denied.add(repo.id);
    }
    restrictConfiguration(controlsStore.read());
    required(config.version, "config_version_required");
    required(config.organization, "organization_required");
    required(config.approvalReceipt, "config_approval_required");
    if (
      !Array.isArray(config.repositories) ||
      !Array.isArray(config.policies) ||
      !Array.isArray(config.scopes) ||
      config.repositories.length === 0 ||
      config.policies.length === 0 ||
      config.scopes.length === 0
    )
      fail("empty_pipeline_configuration");
    if (config.repositories.length > 100 || config.policies.length > 98 || config.scopes.length > 100)
      fail("pipeline_scope_budget_exceeded");
    if (
      new Set(config.repositories.map((repo) => repo.id)).size !== config.repositories.length ||
      new Set(config.policies.map((item) => item.policy.metricId)).size !== config.policies.length
    )
      fail("duplicate_pipeline_configuration");
    for (const repo of config.repositories) {
      if (
        !Number.isSafeInteger(repo.id) ||
        repo.id < 1 ||
        !Number.isSafeInteger(repo.installationId) ||
        repo.installationId < 1 ||
        !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo.slug) ||
        !Array.isArray(repo.families) ||
        !repo.families.length ||
        repo.families.some((family) => !c.ingestion.sourceFamilies.includes(family))
      )
        fail("invalid_repository_configuration");
      required(repo.approvalReceipt, "repository_approval_required");
    }
    for (const item of config.policies) {
      c.metrics.validateMetricPolicy(item.policy);
      required(item.approvalReceipt, "metric_approval_required");
      if (item.signature !== c.metrics.stableJSON(item.policy)) fail("unapproved_metric_policy_signature");
      if (["files_changed", "review_rounds"].includes(item.policy.metricId) && item.policy.groupBy !== "canonical")
        fail("metric_requires_conserved_path_or_head_units");
      if (item.policy.metricId === "pr_accepted_rate" && item.policy.groupBy !== "actor_artifact")
        fail("decision_ratio_requires_one_artifact_denominator");
      if (item.policy.definitionVersion !== c.metrics.metricRegistryV1.policy_version)
        fail("registry_definition_version_mismatch");
    }
    for (const template of config.scopes) {
      const scope = publicScopeFromTemplate(template);
      if (
        scope.organization !== config.organization ||
        !["repository", "workstream", "start", "end"].every((key) => key in scope)
      )
        fail("invalid_public_scope");
      if (scope.repository !== null && !config.repositories.some((repo) => String(repo.id) === scope.repository))
        fail("unapproved_scope_repository");
      if (
        scope.branch !== undefined &&
        (!policiesForScope(scope).length ||
          !config.repositories.find((repo) => String(repo.id) === scope.repository)?.families.includes("pull_requests"))
      )
        fail("merge_target_scope_requires_merged_metric_and_pull_requests");
      if (scope.workstream !== null) required(scope.workstream, "invalid_workstream_scope");
      if ((scope.start === null) !== (scope.end === null)) fail("incomplete_public_window");
      if (scope.start !== null && utc(scope.start) >= utc(scope.end)) fail("invalid_public_window");
      const approvedProjects = new Set(
        config.repositories
          .filter((repo) => scope.repository === null || String(repo.id) === scope.repository)
          .flatMap((repo) => repo.allowedProjectIds ?? []),
      );
      if ((scope.projects ?? []).some((id) => !approvedProjects.has(id))) fail("unapproved_scope_project");
    }
    try {
      validatePublicationPeriods(config.scopes);
    } catch (error) {
      if (error?.message === "duplicate_public_scope") fail("duplicate_public_scope_configuration");
      throw error;
    }
    feedbackAuthority.assert(capturedFeedbackAuthority);
    return true;
  }
  const configuredScope = (scope) =>
    approvedDiscoverablePublicationScope(config.scopes, scope, c.metrics.resolveMetricWindow);
  const metadataEnrichment = createMetadataEnrichment({
    db,
    ingestion: c.ingestion,
    setting: options.metadataEnrichment,
    config,
    dataMode,
    async capture() {
      if (stopped || !(await approved())) fail("enrichment_authorization_changed");
      const revision = restrictConfiguration(controlsStore.read()).revision;
      const current = () => {
        if (stopped || restrictConfiguration(controlsStore.read()).revision !== revision)
          fail("enrichment_authorization_changed");
        try {
          assertPipelineSourcesNotRetired(
            controlsStore,
            config.repositories.map((repo) => repo.id),
          );
        } catch {
          fail("enrichment_authorization_changed");
        }
      };
      current();
      return {
        revision,
        current,
        async authorize(tx) {
          if (!(await approved(tx))) fail("enrichment_authorization_changed");
          current();
        },
      };
    },
  });
  let publicationWindowIndex;
  const windowIndex = () =>
    (publicationWindowIndex ??= createPublicationWindowIndex({
      configurationVersion: config.version,
      configurationHash: digest(config),
      dataMode,
      templates: config.scopes,
      resolveMetricWindow: c.metrics.resolveMetricWindow,
    }));
  const repositoriesFor = (scope) =>
    config.repositories.filter((repo) => scope.repository === null || String(repo.id) === scope.repository);
  async function receipt(tx, operationKey, kind, document) {
    const receiptId = digest([operationKey, kind]);
    await tx.query(
      `INSERT INTO leaderboard_pipeline.receipts (receipt_id,operation_key,kind,document,document_hash,operation_hash)
      VALUES ($1,$2,$3,$4::jsonb,$5,${pipelineKeySQL("$2")}) ON CONFLICT (operation_hash) DO NOTHING`,
      [receiptId, operationKey, kind, JSON.stringify(document), digest(document)],
    );
    const saved = (
      await tx.query(
        `SELECT receipt_id,kind,document,document_hash FROM leaderboard_pipeline.receipts
       WHERE operation_hash=${pipelineKeySQL("$1")} AND operation_key=$1`,
        [operationKey],
      )
    ).rows[0];
    if (
      !saved ||
      saved.receipt_id !== receiptId ||
      saved.kind !== kind ||
      digest(saved.document) !== saved.document_hash
    )
      fail("pipeline_receipt_identity_conflict");
    return receiptId;
  }
  async function denyRepository(repo, reason, checkedAt) {
    let controlsFailure;
    const scopeDenial = sourceDenialScopes.find((scope) => scope.reason === reason);
    if (scopeDenial) {
      // Persist the public-read/write fence before SQL work. A repository-level
      // public probe cannot reauthorize hidden Project or native field evidence.
      scopeDenial.denied.add(repo.id);
      try {
        controlsStore.transaction((state) => {
          state.pipelineSourceDenials ||= {};
          state.pipelineSourceDenials[repo.id] = { configurationVersion: config.version, reason, checkedAt };
        });
      } catch (error) {
        controlsFailure = error;
      }
    }
    await db.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO leaderboard_ingestion.repository_access (repository_id,installation_id,state)
        VALUES ($1,$2,'unavailable') ON CONFLICT (repository_id) DO UPDATE SET state='unavailable',
        generation=repository_access.generation+1,checked_at=clock_timestamp()`,
        [repo.id, repo.installationId],
      );
      if (scopeDenial)
        await receipt(tx, scopeDenial.key(repo), scopeDenial.kind, {
          repositoryId: repo.id,
          configurationVersion: config.version,
          reason,
          checkedAt,
        });
      await receipt(tx, `source-probe:${repo.id}:${checkedAt}:${reason}`, "source_unavailable", {
        repositoryId: repo.id,
        reason,
        checkedAt,
      });
    });
    if (controlsFailure) throw controlsFailure;
    monitorFailure(
      monitorSource(repo.id),
      "collection",
      reason === "visibility_probe_unavailable" ? "source_unavailable" : "permission_revoked",
    );
  }
  async function verifyRepository(repo) {
    assertRunConfiguration();
    if (!collectionSource?.readPage || !normalizer || !probeSource) fail("source_provider_unconfigured");
    const beforeProbe = (
      await db.query("SELECT state,generation FROM leaderboard_ingestion.repository_access WHERE repository_id=$1", [
        repo.id,
      ])
    ).rows[0];
    // A lifecycle change during this probe must not authorize its older public result.
    const expectedGeneration = beforeProbe ? String(beforeProbe.generation) : null;
    const wasPublic = beforeProbe?.state === "public";
    assertRunConfiguration();
    let checkedAt = utc(now());
    let probe;
    try {
      probe = await probeSource(copy(repo));
    } catch {
      await denyRepository(repo, "visibility_probe_unavailable", checkedAt);
      fail("public_source_not_verified");
    }
    assertRunConfiguration();
    checkedAt = utc(now());
    try {
      assertDataMode(probe);
    } catch {
      await denyRepository(repo, "fixture_source_rejected", checkedAt);
      fail("synthetic_data_forbidden_in_public_runtime");
    }
    let validTime = false;
    try {
      validTime = utc(probe?.checkedAt) <= checkedAt && Date.parse(checkedAt) - Date.parse(probe.checkedAt) <= 60_000;
    } catch {
      /* unknown time fails closed */
    }
    if (
      !probe ||
      probe.repositoryId !== repo.id ||
      probe.installationId !== repo.installationId ||
      probe.visibility !== "public" ||
      !validTime
    ) {
      await denyRepository(repo, "visibility_or_scope_not_public", checkedAt);
      fail("public_source_not_verified");
    }
    if (wasPublic) {
      const saved = await db.query(
        "UPDATE leaderboard_ingestion.repository_access SET checked_at=clock_timestamp() WHERE repository_id=$1 AND generation=$2 AND state='public' RETURNING repository_id",
        [repo.id, expectedGeneration],
      );
      if (!saved.rows.length) fail("repository_access_changed");
      return;
    }
    if (!(await collection.verifyPublic(repo.id, repo.installationId, expectedGeneration)))
      fail("repository_revoked_or_changed");
  }
  const hasDispatchEvidence = (document, dispatch, row) =>
    !dispatch?.targetKeys.includes(row.fact_key) ||
    document.facts.some(
      (fact) =>
        fact.metricId === "issues_opened" &&
        fact.artifactId === dispatch.lease.observation.subjectId &&
        document.evidence.some(
          (entry) =>
            entry.contribution.contributionId === fact.id &&
            entry.artifact.publicUrl === dispatch.lease.observation.sourceUrl,
        ),
    );
  async function normalizeStored(
    repositoryIds,
    cutoff,
    dispatch,
    releasePass = null,
    mergeTargetPass = null,
    decisionRuns = [],
  ) {
    // A first-review sequence depends on the whole cohort, not just the review's
    // mutable fields. Only a source observation bound to the latest completed
    // review scan may supply that sequence to this publication. Retained caches
    // remain immutable inputs to historical snapshots and other review metrics.
    const reviewRuns = (
      await db.query(
        `SELECT run_id,repository_id FROM (
          SELECT run_id,repository_id,
            DENSE_RANK() OVER (PARTITION BY repository_id ORDER BY last_success_at DESC) AS recency
          FROM leaderboard_ingestion.collection_runs
          WHERE repository_id=ANY($1::bigint[]) AND family='reviews'
          AND state='complete' AND last_success_at <= $2
        ) AS completed WHERE recency=1 ORDER BY repository_id,run_id LIMIT 10001`,
        [repositoryIds, cutoff],
      )
    ).rows;
    if (reviewRuns.length > 10000) fail("frozen_dataset_budget_exceeded");
    const reviewScans = new Map();
    for (const run of reviewRuns) {
      const id = String(run.repository_id);
      reviewScans.set(id, reviewScans.has(id) ? null : run.run_id);
    }
    const sequenceObserved = (row) => {
      if (row.family !== "reviews") return false;
      const runId = reviewScans.get(String(row.repository_id));
      const fingerprint = /^([a-f0-9]{64})\.[a-f0-9]{32}$/.exec(row.source_revision)?.[1];
      return (
        typeof runId === "string" &&
        row.first_run_id === runId &&
        !!fingerprint &&
        row.source_revision === githubSnapshotRevision(fingerprint, runId)
      );
    };
    // Current association is selected from one completed whole-repository scan.
    // A partial later run cannot replace it, and subjects absent from the latest
    // complete inventory cannot inherit older membership rows.
    const latestProjectRuns = (
      await db.query(
        `SELECT run_id,repository_id FROM (
          SELECT run_id,repository_id,
            DENSE_RANK() OVER (PARTITION BY repository_id ORDER BY last_success_at DESC) AS recency
          FROM leaderboard_ingestion.collection_runs
          WHERE repository_id=ANY($1::bigint[]) AND family='project_current'
          AND state='complete' AND last_success_at <= $2
        ) AS completed WHERE recency=1 ORDER BY repository_id,run_id LIMIT 10001`,
        [repositoryIds, cutoff],
      )
    ).rows;
    if (latestProjectRuns.length > 10000) fail("frozen_dataset_budget_exceeded");
    if (new Set(latestProjectRuns.map((run) => String(run.repository_id))).size !== latestProjectRuns.length)
      fail("ambiguous_current_project_run");
    const selectedProjectRuns = latestProjectRuns.map((run) => run.run_id);
    const selectedDecisionRuns = decisionRuns.filter((run) => repositoryIds.includes(run.repositoryId));
    const selectedDecisionRepositories = selectedDecisionRuns.map((run) => run.repositoryId);
    const selectedFeedbackRuns = await db.transaction((tx) => feedbackStore.currentScanIds(tx, repositoryIds, cutoff));
    assertRunConfiguration();
    const sourceRows = (
      await db.query(
        `SELECT fact.* FROM (
        SELECT fact_key,repository_id,family,subject_id,source_revision,
          document - 'pullRequestDecisionHistory' AS document,first_run_id,observed_at
        FROM leaderboard_ingestion.source_facts
      ) AS fact
      JOIN leaderboard_ingestion.repository_access AS access USING (repository_id)
      WHERE fact.repository_id = ANY($1::bigint[]) AND fact.observed_at <= $2 AND access.state='public'
      AND (fact.family<>'discussions' OR fact.repository_id<>ALL($4::bigint[]) OR fact.first_run_id=ANY($5::text[]))
      AND (fact.family<>'pull_requests' OR fact.repository_id<>ALL($6::bigint[])
        OR EXISTS (SELECT 1 FROM leaderboard_ingestion.collection_items AS selected
          WHERE selected.fact_key=fact.fact_key AND selected.run_id=ANY($7::text[])))
      AND (
        (fact.family='project_current' AND fact.document ? 'projectSubjectId'
          AND EXISTS (SELECT 1 FROM leaderboard_ingestion.collection_items AS selected
            WHERE selected.fact_key=fact.fact_key AND selected.run_id=ANY($3::text[])))
        OR (NOT (fact.family='project_current' AND fact.document ? 'projectSubjectId')
        AND (fact.document->>'evidence' <> 'current_state'
        OR (fact.family='pull_requests' AND fact.repository_id=ANY($6::bigint[]))
        OR NOT EXISTS (
        SELECT 1 FROM leaderboard_ingestion.source_facts AS newer
        WHERE newer.repository_id=fact.repository_id AND newer.family=fact.family AND newer.subject_id=fact.subject_id
        AND newer.document->>'evidence'='current_state' AND newer.observed_at <= $2 AND newer.observed_at > fact.observed_at
        AND (NOT (newer.family='project_current' AND newer.document ? 'projectSubjectId')
          OR EXISTS (SELECT 1 FROM leaderboard_ingestion.collection_items AS selected
            WHERE selected.fact_key=newer.fact_key AND selected.run_id=ANY($3::text[]))))))
      )
      AND NOT EXISTS (SELECT 1 FROM leaderboard_ingestion.object_suppressions AS removed
        WHERE removed.repository_id=fact.repository_id AND removed.subject_id=fact.subject_id)
      ORDER BY fact.fact_key LIMIT 10001`,
        [
          repositoryIds,
          cutoff,
          selectedProjectRuns,
          feedbackAuthority.repositoryIds,
          selectedFeedbackRuns,
          selectedDecisionRepositories,
          selectedDecisionRuns.map((run) => run.runId),
        ],
      )
    ).rows;
    if (sourceRows.length > 10000) fail("frozen_dataset_budget_exceeded");
    const currentSubjects = new Set();
    for (const row of sourceRows.filter((row) => row.document.evidence === "current_state")) {
      const key = JSON.stringify([String(row.repository_id), row.family, row.subject_id]);
      if (currentSubjects.has(key)) fail("ambiguous_current_source_revision");
      currentSubjects.add(key);
    }
    if (
      dispatch &&
      repositoryIds.includes(dispatch.lease.observation.repositoryId) &&
      dispatch.targetKeys.some((key) => !sourceRows.some((row) => row.fact_key === key))
    )
      fail("dispatch_enrichment_unavailable");
    const unlabeled = (
      await db.query(
        `SELECT fact.fact_key FROM leaderboard_ingestion.source_facts AS fact LEFT JOIN leaderboard_pipeline.source_modes AS mode USING(fact_key) WHERE fact.repository_id=ANY($1::bigint[]) AND (mode.data_mode IS NULL OR mode.data_mode<>$2) LIMIT 1`,
        [repositoryIds, dataMode],
      )
    ).rows;
    if (unlabeled.length) fail("cross_mode_or_unproven_source_data");
    // Trusted native readers may share one fresh issue-membership scan within
    // this invocation. The opaque token never survives into another batch.
    const issueFieldHistoryBatch = Object.freeze({});
    let mergeTargetHistoryCount = 0;
    const outputs = [];
    for (const row of sourceRows) {
      const mergeTargetSource =
        row.family === "pull_requests" && mergeTargetRepositoryIds.includes(Number(row.repository_id));
      if (mergeTargetPass?.only && !mergeTargetSource) continue;
      if (mergeTargetSource) {
        if (!mergeTargetPass) fail("merge_target_normalizer_version_unverified");
        assertMergeTargetNormalizer();
      }
      const typedHistory = ["relationships", "project_history", "issue_field_history"].includes(row.family);
      const sourceFamilySignature =
        row.family === "reviews"
          ? reviewNormalizationSignature
          : row.family === "discussions"
            ? discussionNormalizationSignature
            : typedHistory
              ? typedHistoryNormalizationSignature
              : normalizationSignature;
      const familySignature = mergeTargetSource
        ? mergeTargetGenerationSignature(normalizationSignature, mergeTargetPass.generation, digest)
        : sourceFamilySignature;
      const currentGenerations = normalizationGenerations(familySignature);
      const previousBaseSignatures = [
        ...new Set([
          ...(mergeTargetSource ? [sourceFamilySignature] : []),
          ...(typedHistory ? [normalizationSignature, ...previousTypedHistoryNormalizationSignatures] : []),
          ...(row.family === "reviews" ? previousReviewNormalizationSignatures : []),
          ...previousNormalizationSignatures.map((signature) =>
            row.family === "reviews"
              ? digest([reviewSourceNormalizationVersion, signature])
              : row.family === "discussions"
                ? digest([discussionSourceNormalizationVersion, signature])
                : signature,
          ),
        ]),
      ].filter((signature) => signature !== familySignature);
      const generations = [...currentGenerations, ...previousBaseSignatures.flatMap(normalizationGenerations)];
      if (row.family === "reviews") assertReviewNormalizer();
      if (row.family === "discussions") assertDiscussionNormalizer();
      const repository = config.repositories.find((repo) => String(repo.id) === String(row.repository_id));
      const discussionFeedback = row.document.discussionFeedback !== undefined;
      if (discussionFeedback) {
        assertDiscussionFeedbackNormalizer();
        await db.transaction((tx) => feedbackStore.verifyRow(tx, row, { current: true }));
        assertRunConfiguration();
        assertDiscussionFeedbackNormalizer();
      }
      const releaseTargets =
        dataMode === "public" && row.family === "pull_requests"
          ? (config.releaseInclusionTargets ?? []).filter(
              (target) =>
                target.repositoryId === repository.id &&
                row.document.sourceUrl === `https://github.com/${repository.slug}/pull/${target.pullRequestNumber}`,
            )
          : [];
      if (releasePass && !releaseTargets.length) continue;
      const knownSignatures = new Set(generations.map((generation) => generation.signature));
      const storedCandidates = (
        await db.query(
          `SELECT policy_signature,document,document_hash FROM leaderboard_pipeline.normalizations
           WHERE fact_key=$1 AND (policy_signature=ANY($2::text[]) OR $3::boolean)
           ORDER BY policy_signature LIMIT 20001`,
          [row.fact_key, [...knownSignatures], mergeTargetSource],
        )
      ).rows;
      if (mergeTargetSource) assertMergeTargetNormalizer();
      if (row.family === "reviews") assertReviewNormalizer();
      if (row.family === "discussions") assertDiscussionNormalizer();
      if (discussionFeedback) assertDiscussionFeedbackNormalizer();
      // Inspect enrolled PR history independently of mutable marker contents.
      // Only an admitted generation can supply a classification hint.
      if (storedCandidates.length > 20000) fail("merge_target_history_budget_exceeded");
      if (mergeTargetSource) {
        mergeTargetHistoryCount += storedCandidates.length;
        if (mergeTargetHistoryCount > 20000) fail("merge_target_history_budget_exceeded");
      }
      for (const candidate of storedCandidates) {
        if (digest(candidate.document) !== candidate.document_hash) fail("normalization_integrity_error");
        if (candidate.document.isSynthetic !== (dataMode === "synthetic")) fail("normalization_data_mode_mismatch");
        assertDataMode(candidate.document);
      }
      const candidates = [];
      const retainedMergeTargetGenerations = [];
      for (const candidate of storedCandidates) {
        const marker = candidate.document.pullRequestMergeTargetNormalization;
        if (
          marker !== undefined ||
          (mergeTargetSource && currentGenerations.some((entry) => entry.signature === candidate.policy_signature))
        ) {
          if (
            !knownSignatures.has(candidate.policy_signature) &&
            !mergeTargetBaseSignatures.includes(marker?.baseSignature)
          )
            continue;
          await validateMergeTargetRow({ ...row, ...candidate, source_document: row.document }, null, false);
          assertRunConfiguration();
          const priorBase = mergeTargetGenerationSignature(marker.baseSignature, marker.generation, digest);
          const generation = normalizationGenerations(priorBase).find(
            (entry) => entry.signature === candidate.policy_signature,
          );
          if (!generation) fail("merge_target_normalization_binding_unavailable");
          retainedMergeTargetGenerations.push(generation);
        } else if (!knownSignatures.has(candidate.policy_signature)) continue;
        candidates.push(candidate);
      }
      const generationSignatures = (field) =>
        new Set(
          [...generations, ...retainedMergeTargetGenerations]
            .filter((generation) => generation[field])
            .map((generation) => generation.signature),
        );
      const deliveryGenerations = generationSignatures("defaultDelivery");
      const fieldGenerations = generationSignatures("fieldChange");
      const pairGenerations = generationSignatures("relationshipPair");
      const triageGenerations = generationSignatures("triageMetadata");
      let defaultDelivery =
        ["commits", "pull_requests"].includes(row.family) ||
        candidates.some(
          (entry) => deliveryGenerations.has(entry.policy_signature) || hasDefaultDeliveryClaims(entry.document),
        );
      let fieldChange =
        ["project_history", "issue_field_history"].includes(row.family) ||
        candidates.some(
          (entry) =>
            fieldGenerations.has(entry.policy_signature) ||
            hasFieldChangeClaims(entry.document) ||
            entry.document.fieldChangeNormalizationVersion !== undefined,
        );
      let relationshipPair = candidates.some(
        (entry) =>
          pairGenerations.has(entry.policy_signature) ||
          hasRelationshipPairClaims(entry.document) ||
          hasRelationshipPairMarker(entry.document),
      );
      let triageMetadata = candidates.some(
        (entry) => triageGenerations.has(entry.policy_signature) || hasTriageMetadataOutput(entry.document),
      );
      const selectedSignature = () =>
        currentGenerations.find(
          (generation) =>
            generation.defaultDelivery === defaultDelivery &&
            generation.fieldChange === fieldChange &&
            generation.triageMetadata === triageMetadata &&
            generation.relationshipPair === relationshipPair,
        ).signature;
      const assertRowNormalizer = () => {
        if (mergeTargetSource) assertMergeTargetNormalizer();
        if (row.family === "reviews") assertReviewNormalizer();
        if (row.family === "discussions") assertDiscussionNormalizer();
        if (discussionFeedback) assertDiscussionFeedbackNormalizer();
        if (defaultDelivery) assertDefaultDeliveryNormalizer();
        if (fieldChange) assertFieldChangeNormalizer();
        if (triageMetadata) assertTriageMetadataNormalizer();
        if (relationshipPair) assertRelationshipPairNormalizer();
      };
      let signature = selectedSignature();
      // Other current-family documents may retain private migration metadata,
      // but only the exact selected combination can supply reusable facts.
      const cached =
        candidates.find((entry) => entry.policy_signature === signature) ??
        currentGenerations
          .toReversed()
          .map((generation) => candidates.find((entry) => entry.policy_signature === generation.signature))
          .find(Boolean);
      assertRowNormalizer();
      if (cached) {
        if (digest(cached.document) !== cached.document_hash) fail("normalization_integrity_error");
        if (cached.document.isSynthetic !== (dataMode === "synthetic")) fail("normalization_data_mode_mismatch");
        assertDataMode(cached.document);
        // Reprocess Project caches created before collected-subject binding.
        // Keep the shared policy signature stable for frozen comparisons.
        const currentHistoryNormalizer =
          row.family !== "project_history" ||
          cached.document.projectHistoryNormalizationVersion === "collected-subject/v2";
        const currentProjectNormalizer =
          row.family !== "project_current" ||
          row.document.projectSubjectId === undefined ||
          cached.document.projectContextNormalizationVersion === "subject-membership/v2";
        if (
          currentHistoryNormalizer &&
          currentProjectNormalizer &&
          (!mergeTargetSource ||
            cached.document.pullRequestMergeTargetNormalization?.generation === mergeTargetPass.generation) &&
          (!fieldChange || cached.document.fieldChangeNormalizationVersion === fieldChangeNormalizationVersion) &&
          (!triageMetadata ||
            cached.document.triageMetadataNormalizationVersion === triageMetadataNormalizationVersion) &&
          // Native field visibility can change without changing an event or its
          // revision. Revalidate every retained transition before publication.
          row.family !== "issue_field_history" &&
          cached.policy_signature === signature &&
          (!defaultDelivery ||
            cached.document.defaultDeliveryNormalizationVersion === defaultDeliveryNormalizationVersion) &&
          (!relationshipPair ||
            cached.document.relationshipPairNormalizationVersion === relationshipPairNormalizationVersion) &&
          reviewEvidenceCurrent({
            family: row.family,
            document: cached.document,
            document_hash: cached.document_hash,
          }) &&
          discussionEvidenceCurrent({
            family: row.family,
            document: cached.document,
            document_hash: cached.document_hash,
          }) &&
          fieldChangeEvidenceCurrent({
            document: cached.document,
            document_hash: cached.document_hash,
          }) &&
          triageMetadataEvidenceCurrent({
            document: cached.document,
            document_hash: cached.document_hash,
          }) &&
          hasDispatchEvidence(cached.document, dispatch, row)
        ) {
          if (mergeTargetSource) {
            await validateMergeTargetRow(
              { ...row, ...cached, source_document: row.document },
              mergeTargetPass.collect ? null : cutoff,
            );
            assertMergeTargetNormalizer();
          }
          if (releaseTargets.length && !releasePass?.collect) {
            const records = cached.document.releaseInclusions;
            if (
              !Array.isArray(records) ||
              !records.length ||
              !records.every(
                (record) =>
                  c.contracts.sourceEventSchema.shape.observedAt.safeParse(record?.observedAt).success &&
                  c.contracts.compareSourceInstants(record.observedAt, cutoff) <= 0,
              ) ||
              !releaseTargets.every((target) =>
                records.some(
                  (record) =>
                    record.request?.repositoryId === target.repositoryId &&
                    record.request?.releaseId === target.releaseId &&
                    record.request?.pullRequestNumber === target.pullRequestNumber,
                ),
              )
            )
              fail("release_inclusion_frozen_normalization_unavailable");
          }
          normalizedProjectContext(cached.document, row, repository, projectWorkstreamMappings);
          retainPhysicalContext(cached.document, row, repository, c.contracts, dataMode);
          await db.transaction(async (tx) => {
            await lockIssueTransferSources(tx, config.repositories, "update");
            assertRowNormalizer();
            const current = (
              await tx.query(
                "SELECT document_hash FROM leaderboard_pipeline.normalizations WHERE fact_key=$1 AND policy_signature=$2 FOR UPDATE",
                [row.fact_key, cached.policy_signature],
              )
            ).rows[0];
            if (current?.document_hash !== cached.document_hash)
              fail("normalization_changed_before_dependency_capture");
            assertRowNormalizer();
            await retainSourceArtifacts(tx, row.fact_key, cached.document);
            await retainIssueTransferIndex(tx, row, cached.policy_signature, cached.document);
            assertRowNormalizer();
          });
          assertRowNormalizer();
          outputs.push({
            document: cached.document,
            source: sourceBinding(row),
            family: row.family,
            repositoryId: String(row.repository_id),
            subjectId: row.subject_id,
            selectedCurrentState: row.document.evidence === "current_state",
            reviewSequenceObserved: sequenceObserved(row),
          });
          continue;
        }
      }
      // A frozen publication may only consume proof collected before its cutoff.
      // Missing compatible caches require a fresh cycle, never a backdated lookup.
      if (releaseTargets.length && !releasePass?.collect) fail("release_inclusion_frozen_normalization_unavailable");
      if (mergeTargetSource && !mergeTargetPass.collect) fail("merge_target_frozen_normalization_unavailable");
      const normalizationStarted = performance.now();
      let output;
      try {
        assertRunConfiguration();
        assertRowNormalizer();
        output = await normalizer({
          repository: copy(repository),
          family: row.family,
          ...(row.family === "issue_field_history" ? { issueFieldHistoryBatch } : {}),
          factKey: row.fact_key,
          selectedCurrentState: row.document.evidence === "current_state",
          fact: copy(row.document),
          observedAt: new Date(row.observed_at).toISOString(),
          policyVersion: config.version,
        });
        if (mergeTargetSource) output = copy(output);
        assertRunConfiguration();
        assertRowNormalizer();
        monitorSuccess(monitorSource(repository.id), "normalization", normalizationStarted);
      } catch (error) {
        if (isProjectSourceScopeFailure(error, row.family))
          await denyRepository(repository, "project_scope_unavailable", utc(now()));
        else if (isIssueFieldSourceScopeFailure(error, row.family))
          await denyRepository(repository, "issue_field_scope_unavailable", utc(now()));
        monitorFailure(monitorSource(repository.id), "normalization", "schema_changed");
        if (dispatch) {
          assertRunConfiguration();
          fail("dispatch_enrichment_unavailable");
        }
        throw error;
      }
      assertDataMode(output);
      if (output?.reasons?.includes("repository_public_scope_unverified_or_revoked")) {
        await denyRepository(repository, "source_access_changed_during_normalization", utc(now()));
        fail("source_revoked_during_normalization");
      }
      if (
        !output ||
        !Array.isArray(output.facts) ||
        !Array.isArray(output.actors) ||
        !Array.isArray(output.evidence) ||
        output.facts.length > 132 ||
        output.actors.length > 100 ||
        output.evidence.length > 132
      )
        fail("invalid_normalized_evidence");
      // Keep the existing 100-record base budget. The locale classifier adds at
      // most one paired fact/proof for each explicitly configured language/category,
      // so those bounded additions must not evict previously supported PR evidence.
      const documentationPolicy = (config.documentationPolicies ?? []).find(
        (item) => item.repositoryId === repository.id,
      );
      const localePairs = new Set(
        (documentationPolicy?.localizationPaths ?? [])
          .slice(0, 32)
          .map((item) => JSON.stringify([item.locale, item.category])),
      );
      const localeUnits = new Set();
      for (const entry of output.evidence) {
        const contribution = entry?.contribution;
        if (
          !Array.isArray(contribution?.metricIds) ||
          contribution.metricIds.length !== 1 ||
          contribution.metricIds[0] !== "localization" ||
          !Array.isArray(contribution.reasonCodes) ||
          !output.facts.some((fact) => fact.id === contribution.contributionId && fact.metricId === "localization")
        )
          continue;
        const reasons = c.contracts.publicDocumentationReasons(contribution);
        if (reasons.length !== 3 || reasons[0] !== `documentation_path_policy:${documentationPolicy?.version}`)
          continue;
        const pair = JSON.stringify([
          reasons[1].slice("locale:".length),
          reasons[2].slice("localization_category:".length),
        ]);
        if (localePairs.has(pair)) localeUnits.add(pair);
      }
      if (output.facts.length > 100 + localeUnits.size || output.evidence.length > 100 + localeUnits.size)
        fail("invalid_normalized_evidence");
      // Validate the public boundary now; the public API validates it again on every read.
      for (const evidence of output.evidence) {
        c.contracts.artifactSchema.parse(evidence.artifact);
        c.contracts.contributionSchema.parse(evidence.contribution);
        if (
          evidence.artifact.repositoryId !== String(repository.id) ||
          evidence.artifact.visibility !== "public" ||
          !evidence.artifact.publicUrl?.startsWith(`https://github.com/${repository.slug}/`)
        )
          fail("normalized_evidence_scope_mismatch");
      }
      for (const fact of output.facts)
        if (
          fact.repoId !== String(repository.id) ||
          !output.evidence.some(
            (e) =>
              e.contribution.contributionId === fact.id &&
              e.contribution.actorId === fact.actorId &&
              e.contribution.artifactId === fact.artifactId &&
              e.contribution.metricIds.includes(fact.metricId),
          )
        )
          fail("normalized_fact_without_provenance");
      defaultDelivery ||= hasDefaultDeliveryClaims(output);
      if (defaultDelivery) assertDefaultDeliveryNormalizer();
      relationshipPair ||= hasRelationshipPairClaims(output) || hasRelationshipPairMarker(output);
      fieldChange ||= hasFieldChangeClaims(output);
      triageMetadata ||= hasTriageMetadataOutput(output);
      // Empty corrected output retains every validated generation hint. The
      // callback selected at construction must still have live compatibility.
      assertRowNormalizer();
      signature = selectedSignature();
      const suppressed = Array.isArray(output.suppressArtifactIds) ? output.suppressArtifactIds : [];
      for (const artifactId of suppressed) {
        if (typeof artifactId !== "string" || !/^[A-Za-z0-9_=.:-]{1,200}$/.test(artifactId))
          fail("invalid_artifact_suppression");
        await db.transaction(async (tx) => {
          // Match collection/correction suppression fencing: readers hold this
          // source gate through their final current-privacy projection.
          await lockIssueTransferSources(tx, config.repositories, "update");
          assertRunConfiguration();
          assertRowNormalizer();
          await tx.query(
            "INSERT INTO leaderboard_ingestion.object_suppressions(repository_id,subject_id,reason) VALUES($1,$2,'unavailable') ON CONFLICT DO NOTHING",
            [repository.id, artifactId],
          );
        });
      }
      // Persist authoritative exclusions even when this dispatch cannot yet
      // prove the target creation. Failure must not leave older evidence visible.
      if (!hasDispatchEvidence(output, dispatch, row)) fail("dispatch_enrichment_unavailable");
      const pullRequestMergeTargets = mergeTargetSource
        ? await readMergeTargetNormalization(output, row, repository)
        : undefined;
      if (
        !mergeTargetSource &&
        (output.pullRequestMergeTargets !== undefined || output.facts.some((fact) => fact.mergeTarget !== undefined))
      )
        fail("unconfigured_merge_target_proof");
      assertRunConfiguration();
      // Keep collector products private and bound to this source repository.
      // The normalizer's public evidence is validated separately above; copying
      // this explicit, minimized field never expands that public boundary.
      let releaseInclusions;
      if (output.releaseInclusions !== undefined) {
        if (!Array.isArray(output.releaseInclusions) || output.releaseInclusions.length > 1000)
          fail("invalid_normalized_release_inclusions");
        releaseInclusions = output.releaseInclusions.map((value) => {
          const record = c.github.validateGithubReleaseInclusion(value);
          if (
            row.family !== "pull_requests" ||
            record.repository.id !== repository.id ||
            String(record.repository.id) !== String(row.repository_id) ||
            record.repository.slug !== repository.slug ||
            !output.facts.some((fact) => fact.metricId === "pr_merged" && fact.artifactId === record.pullRequest.nodeId)
          )
            fail("normalized_release_inclusion_scope_mismatch");
          return record;
        });
      }
      let syntheticFactIds;
      if (output.syntheticFactIds !== undefined) {
        if (
          !Array.isArray(output.syntheticFactIds) ||
          output.syntheticFactIds.length > output.facts.length ||
          new Set(output.syntheticFactIds).size !== output.syntheticFactIds.length ||
          output.syntheticFactIds.some((id) => typeof id !== "string" || !output.facts.some((fact) => fact.id === id))
        )
          fail("invalid_normalized_synthetic_facts");
        syntheticFactIds = [...output.syntheticFactIds];
      }
      const document = {
        ...(relationshipPair ? { relationshipPairNormalizationVersion } : {}),
        ...(mergeTargetSource
          ? {
              pullRequestMergeTargetNormalization: {
                schemaVersion: mergeTargetNormalizationVersion,
                baseSignature: normalizationSignature,
                generation: mergeTargetPass.generation,
              },
              pullRequestMergeTargets,
            }
          : {}),
        ...(fieldChange ? { fieldChangeNormalizationVersion } : {}),
        ...(triageMetadata ? { triageMetadataNormalizationVersion } : {}),
        ...(defaultDelivery ? { defaultDeliveryNormalizationVersion } : {}),
        ...(row.family === "reviews" ? { reviewSourceNormalizationVersion } : {}),
        ...(row.family === "discussions" ? { discussionSourceNormalizationVersion } : {}),
        ...(row.family === "project_history" ? { projectHistoryNormalizationVersion: "collected-subject/v2" } : {}),
        ...(row.family === "project_current" && row.document.projectSubjectId !== undefined
          ? { projectContextNormalizationVersion: "subject-membership/v2" }
          : {}),
        suppressArtifactIds: suppressed,
        isSynthetic: dataMode === "synthetic",
        facts: output.facts,
        actors: output.actors,
        evidence: output.evidence,
        ...(releaseInclusions === undefined ? {} : { releaseInclusions }),
        ...(syntheticFactIds === undefined ? {} : { syntheticFactIds }),
        ...privateAttribution(output, row),
        ...retainPhysicalContext(output, row, repository, c.contracts, dataMode),
        ...normalizedProjectContext(output, row, repository, projectWorkstreamMappings),
        ...privateIssueTransferMetadata(output, row, repository, config.repositories, cached?.document),
        ...privateDiscussionFeedbackMetadata(output, row),
        reasons: Array.isArray(output.reasons)
          ? output.reasons.map((reason) =>
              typeof reason === "string" && /^[a-z0-9_:-]{1,100}$/.test(reason) ? reason : "normalization_unavailable",
            )
          : [],
      };
      await db.transaction(async (tx) => {
        await lockIssueTransferSources(tx, config.repositories, "update");
        assertRowNormalizer();
        await tx.query(
          `INSERT INTO leaderboard_pipeline.normalizations (fact_key,policy_signature,document,document_hash)
        VALUES ($1,$2,$3::jsonb,$4) ON CONFLICT (fact_key,policy_signature) DO UPDATE
        SET document=EXCLUDED.document,document_hash=EXCLUDED.document_hash
        WHERE normalizations.document_hash=$5`,
          [
            row.fact_key,
            signature,
            JSON.stringify(document),
            digest(document),
            mergeTargetSource ? null : (cached?.document_hash ?? null),
          ],
        );
        const current = (
          await tx.query(
            "SELECT document_hash FROM leaderboard_pipeline.normalizations WHERE fact_key=$1 AND policy_signature=$2 FOR UPDATE",
            [row.fact_key, signature],
          )
        ).rows[0];
        if (current?.document_hash !== digest(document)) fail("normalization_changed_before_dependency_capture");
        assertRowNormalizer();
        await retainSourceArtifacts(tx, row.fact_key, document);
        await retainIssueTransferIndex(tx, row, signature, document);
        assertRowNormalizer();
      });
      assertRowNormalizer();
      outputs.push({
        document,
        source: sourceBinding(row),
        family: row.family,
        repositoryId: String(row.repository_id),
        subjectId: row.subject_id,
        selectedCurrentState: row.document.evidence === "current_state",
        reviewSequenceObserved: sequenceObserved(row),
      });
    }
    return outputs;
  }
  function actorContracts(actors) {
    return actors.map((actor) => {
      if (
        !/^[1-9]\d{0,19}$/.test(actor.id) ||
        !Number.isSafeInteger(actor.githubDatabaseId) ||
        actor.githubDatabaseId !== Number(actor.id)
      )
        fail("unverified_actor_database_id");
      const contract = c.contracts.actorSchema.parse({
        schemaVersion: "leaderboard/v1",
        identityState: actor.publicState === "deleted" ? "deleted" : "resolved",
        githubDatabaseId: Number(actor.id),
        ...(actor.githubNodeId ? { githubNodeId: actor.githubNodeId } : {}),
        ...(actor.login && actor.publicState !== "deleted" ? { login: actor.login } : {}),
        kind: actor.kind,
        executionMode: actor.executionMode === "automated" ? "automated" : "unknown",
      });
      return {
        actorId: actor.id,
        actor: contract,
        state: actor.publicState === "visible" ? "public" : actor.publicState === "deleted" ? "deleted" : "hidden",
      };
    });
  }
  const confirmationMatches = (confirmation, scope, snapshotId, revision) =>
    confirmation?.configurationVersion === config.version &&
    confirmation.configurationHash === digest(config) &&
    confirmation.dataMode === dataMode &&
    confirmation.scopeKey === scopeKey(scope) &&
    confirmation.snapshotId === snapshotId &&
    confirmation.revision === revision &&
    (feedbackInScope(scope)
      ? confirmation.discussionFeedbackNormalizationVersion === discussionFeedbackContentVersion &&
        confirmation.discussionFeedbackAuthorityHash === feedbackAuthorityHash()
      : confirmation.discussionFeedbackNormalizationVersion === undefined &&
        confirmation.discussionFeedbackAuthorityHash === undefined) &&
    (confirmation.reviewSourceNormalizationVersion === undefined ||
      confirmation.reviewSourceNormalizationVersion === reviewSourceNormalizationVersion) &&
    (confirmation.discussionSourceNormalizationVersion === undefined ||
      confirmation.discussionSourceNormalizationVersion === discussionSourceNormalizationVersion) &&
    (confirmation.defaultDeliveryNormalizationVersion === undefined ||
      confirmation.defaultDeliveryNormalizationVersion === defaultDeliveryNormalizationVersion) &&
    (confirmation.relationshipPairNormalizationVersion === undefined ||
      confirmation.relationshipPairNormalizationVersion === relationshipPairNormalizationVersion) &&
    (confirmation.fieldChangeNormalizationVersion === undefined ||
      confirmation.fieldChangeNormalizationVersion === fieldChangeNormalizationVersion) &&
    (confirmation.triageMetadataNormalizationVersion === undefined ||
      confirmation.triageMetadataNormalizationVersion === triageMetadataNormalizationVersion) &&
    typeof confirmation.aggregateExplanationHash === "string" &&
    /^[a-f0-9]{64}$/.test(confirmation.aggregateExplanationHash);
  function confirmPublication(scope, publication, comparisonInput, publicPeriods = []) {
    controlsStore.transaction((state) => {
      if (
        publication.discussionSourceNormalizationVersion !== undefined &&
        !confirmationMatches(
          state.pipelinePublications?.[publication.snapshotId],
          scope,
          publication.snapshotId,
          publication.revision,
        )
      )
        assertDiscussionNormalizer();
      if (feedbackAuthority.enabled) feedbackAuthority.assert(runFeedbackAuthority);
      if (feedbackInScope(scope)) assertDiscussionFeedbackNormalizer();
      if (
        publication.reviewSourceNormalizationVersion !== undefined &&
        !confirmationMatches(
          state.pipelinePublications?.[publication.snapshotId],
          scope,
          publication.snapshotId,
          publication.revision,
        )
      )
        assertReviewNormalizer();
      if (
        !confirmationMatches(
          state.pipelinePublications?.[publication.snapshotId],
          scope,
          publication.snapshotId,
          publication.revision,
        )
      ) {
        assertMergeTargetNormalizer();
        if (publication.defaultDeliveryNormalizationVersion !== undefined) assertDefaultDeliveryNormalizer();
        if (publication.fieldChangeNormalizationVersion !== undefined) assertFieldChangeNormalizer();
        if (publication.triageMetadataNormalizationVersion !== undefined) assertTriageMetadataNormalizer();
        if (publication.relationshipPairNormalizationVersion !== undefined) assertRelationshipPairNormalizer();
      }
      const overlay = restrictConfiguration(state);
      if (overlay.revision !== runConfigurationRevision) fail("active_configuration_changed");
      if (
        recognitionBindings.length &&
        recognitionFingerprint(state, recognitionBindings) !== runRecognitionFingerprint
      )
        fail("recognition_changed_during_run");
      // Required arithmetic explanation and visibility authority share this one
      // durable commit. Optional preview limits can never bypass this write.
      const binding = {
        ...explanationBinding(scope, publication),
        digest: state.pipelinePublications?.[publication.snapshotId]?.aggregateExplanationHash,
      };
      const explanation = comparisonInput
        ? aggregateExplanations.capture(comparisonInput, binding)
        : aggregateExplanations.verify(publication.snapshotId, binding);
      assertPipelineSourcesNotRetired(
        controlsStore,
        explanation.document.authorization.sources.map((source) => Number(source.repositoryId)),
      );
      if (comparisonInput) publication.comparisonInput = policyComparisons.capture(state, comparisonInput);
      state.pipelinePublications ||= {};
      const confirmation = {
        ...(publication.triageMetadataNormalizationVersion === undefined
          ? {}
          : { triageMetadataNormalizationVersion: publication.triageMetadataNormalizationVersion }),
        ...(publication.fieldChangeNormalizationVersion === undefined
          ? {}
          : { fieldChangeNormalizationVersion: publication.fieldChangeNormalizationVersion }),
        ...(feedbackInScope(scope)
          ? {
              discussionFeedbackNormalizationVersion: discussionFeedbackContentVersion,
              discussionFeedbackAuthorityHash: feedbackAuthorityHash(),
            }
          : {}),
        ...(publication.relationshipPairNormalizationVersion === undefined
          ? {}
          : { relationshipPairNormalizationVersion: publication.relationshipPairNormalizationVersion }),
        ...(publication.discussionSourceNormalizationVersion === undefined
          ? {}
          : { discussionSourceNormalizationVersion: publication.discussionSourceNormalizationVersion }),
        ...(publication.defaultDeliveryNormalizationVersion === undefined
          ? {}
          : { defaultDeliveryNormalizationVersion: publication.defaultDeliveryNormalizationVersion }),
        ...(publication.reviewSourceNormalizationVersion === undefined
          ? {}
          : { reviewSourceNormalizationVersion: publication.reviewSourceNormalizationVersion }),
        recognitionFingerprint: recognitionBindings.length ? runRecognitionFingerprint : null,
        configurationVersion: config.version,
        configurationHash: digest(config),
        controlsConfigurationRevision: runConfigurationRevision,
        aggregateExplanationHash: explanation.digest,
        dataMode,
        scopeKey: scopeKey(scope),
        snapshotId: publication.snapshotId,
        revision: publication.revision,
      };
      state.pipelinePublications[publication.snapshotId] = confirmation;
      state.pipelineHeads ||= {};
      const head = state.pipelineHeads[scopeKey(scope)];
      if (head && (!Number.isSafeInteger(head.revision) || head.revision < 1)) fail("confirmed_head_integrity_error");
      if (head?.revision === publication.revision && head.snapshotId !== publication.snapshotId)
        fail("confirmed_head_revision_conflict");
      // The marker, preview capture and visible head are one durable SQLite
      // commit. A delayed confirmation may acknowledge history, never rewind it.
      if (!head || head.revision <= publication.revision) state.pipelineHeads[scopeKey(scope)] = confirmation;
      // Explicit labels gain visibility in this same durable confirmation. A
      // replay may confirm SQL history; it cannot infer labels or rewind them.
      windowIndex().record(state, scope, publicPeriods, confirmation);
    });
  }
  async function publish(
    { scope, window, publicPeriods = [] },
    cutoff,
    observationCutoff,
    dispatch,
    scan = null,
    mergeTargetGeneration = null,
    decisionCapture = null,
  ) {
    assertRunConfiguration();
    scope = c.contracts.canonicalPublicScope(scope);
    if (!configuredScope(scope)) fail("scope_not_approved");
    const selectedPolicies = policiesForScope(scope);
    const repos = repositoriesFor(scope);
    const scopedDecisionRuns =
      decisionCapture?.runs.filter((run) => repos.some((repo) => repo.id === run.repositoryId)) ?? [];
    const scopedDecisionCapture = scopedDecisionRuns.length
      ? parseDecisionGenerationCapture({ ...decisionCapture, runs: scopedDecisionRuns })
      : null;
    const generations = (
      await db.query(
        "SELECT repository_id,state,generation FROM leaderboard_ingestion.repository_access WHERE repository_id=ANY($1::bigint[]) ORDER BY repository_id",
        [repos.map((repo) => repo.id)],
      )
    ).rows;
    if (generations.length !== repos.length || generations.some((row) => row.state !== "public"))
      fail("source_unavailable_before_normalization");
    if (
      dispatch &&
      generations.some(
        (row) =>
          !dispatch.generations.some(
            (saved) => saved.repositoryId === Number(row.repository_id) && saved.generation === String(row.generation),
          ),
      )
    )
      fail("dispatch_source_generation_changed");
    let priorPublication = null;
    let priorDecisionBound = false;
    let replayedBackfillRevision;
    if (dispatch) {
      // A committed operation can be acknowledged after another publisher advances
      // the head. Never repoint the head to its historical immutable revision.
      const prior = (
        await db.query(
          `SELECT saved.document,saved.document_hash,saved.snapshot_id,saved.revision,saved.config_version
        FROM leaderboard_pipeline.dispatch_publications AS operation
        JOIN leaderboard_pipeline.snapshots AS saved USING(snapshot_id)
        WHERE operation.operation_key=$1 AND operation.scope_hash=${pipelineKeySQL("$2")} AND operation.scope_key=$2`,
          [dispatch.lease.operation.operationKey, scopeKey(scope)],
        )
      ).rows[0];
      if (prior) {
        if (
          digest(prior.document) !== prior.document_hash ||
          prior.document.snapshot.snapshotId !== prior.snapshot_id ||
          prior.document.snapshot.revision !== Number(prior.revision) ||
          prior.config_version !== config.version ||
          prior.document.dataMode !== dataMode
        )
          fail("dispatch_snapshot_integrity_error");
        await db.transaction((tx) => outbox.assertLease(tx, dispatch.lease));
        priorPublication = { snapshotId: prior.snapshot_id, revision: Number(prior.revision), changed: false };
        if (!controlsStore.read().pipelineHeads?.[scopeKey(scope)]) {
          const latest = (
            await db.query(
              `SELECT snapshot_id FROM leaderboard_pipeline.heads WHERE scope_hash=${pipelineKeySQL("$1")} AND scope_key=$1`,
              [scopeKey(scope)],
            )
          ).rows[0];
          // Missing/legacy private authority has no trustworthy high-water mark.
          // Only an authorized replay of the latest SQL publication may rebuild
          // it; a delayed historical operation cannot choose an older baseline.
          if (latest?.snapshot_id !== prior.snapshot_id) fail("confirmed_head_recovery_requires_latest_publication");
        }
        const priorConfirmation = controlsStore.read().pipelinePublications?.[prior.snapshot_id];
        if (confirmationMatches(priorConfirmation, scope, prior.snapshot_id, Number(prior.revision))) {
          // A prior confirmation authorizes its original recognition inputs.
          // Never relabel immutable accepted content with later consent or a
          // changed recognition rule when recovering an unacknowledged dispatch.
          if (recognitionBindings.length && priorConfirmation.recognitionFingerprint !== runRecognitionFingerprint)
            fail("dispatch_recognition_changed");
          const explanation = aggregateExplanations.verify(prior.snapshot_id, {
            ...explanationBinding(scope, priorPublication),
            digest: priorConfirmation.aggregateExplanationHash,
          }).document;
          const normalizationBinding = await db.transaction(async (tx) => {
            await lockIssueTransferSources(tx, config.repositories);
            await outbox.assertLease(tx, dispatch.lease);
            const access = (
              await tx.query(
                "SELECT repository_id,state,generation FROM leaderboard_ingestion.repository_access WHERE repository_id=ANY($1::bigint[]) ORDER BY repository_id FOR SHARE",
                [repos.map((repo) => repo.id)],
              )
            ).rows;
            if (
              access.length !== repos.length ||
              access.some(
                (row) =>
                  row.state !== "public" ||
                  !dispatch.generations.some(
                    (saved) =>
                      saved.repositoryId === Number(row.repository_id) && saved.generation === String(row.generation),
                  ),
              )
            )
              fail("dispatch_source_generation_changed");
            return publicationNormalizationBinding(tx, scope, priorPublication, explanation);
          });
          if (normalizationBinding.obsolete) fail(`dispatch_${normalizationBinding.obsolete}_normalization_obsolete`);
          // A corrected wrapped cache may now contribute no delivery references.
          // Keep the already confirmed content-version fields when acknowledging
          // that immutable operation; empty output cannot erase its identity.
          for (const field of [
            "reviewSourceNormalizationVersion",
            "discussionSourceNormalizationVersion",
            "discussionFeedbackNormalizationVersion",
            "defaultDeliveryNormalizationVersion",
            "relationshipPairNormalizationVersion",
            "fieldChangeNormalizationVersion",
            "triageMetadataNormalizationVersion",
          ])
            if (priorConfirmation[field] !== undefined) priorPublication[field] = priorConfirmation[field];
          if (normalizationBinding.review)
            priorPublication.reviewSourceNormalizationVersion = reviewSourceNormalizationVersion;
          if (normalizationBinding.discussion)
            priorPublication.discussionSourceNormalizationVersion = discussionSourceNormalizationVersion;
          if (normalizationBinding.defaultDelivery)
            priorPublication.defaultDeliveryNormalizationVersion = defaultDeliveryNormalizationVersion;
          if (normalizationBinding.relationshipPair)
            priorPublication.relationshipPairNormalizationVersion = relationshipPairNormalizationVersion;
          if (normalizationBinding.fieldChange)
            priorPublication.fieldChangeNormalizationVersion = fieldChangeNormalizationVersion;
          if (normalizationBinding.triageMetadata)
            priorPublication.triageMetadataNormalizationVersion = triageMetadataNormalizationVersion;
          confirmPublication(scope, priorPublication, undefined, publicPeriods);
          return priorPublication;
        }
        // An unconfirmed SQL commit has no private preview capture. Recompute
        // its exact frozen input before atomically confirming both; do not
        // manufacture a marker or move the SQL head to a historical operation.
        const retained = await readDecisionFrozenInput(db, prior.snapshot_id, scopedDecisionCapture !== null);
        priorDecisionBound = retained?.decision_bound === true;
        if (
          !retained ||
          digest(retained.document) !== retained.document_hash ||
          retained.document.frozen?.cutoff !== observationCutoff ||
          !/^[a-f0-9]{64}$/.test(retained.document.frozen?.backfillRevision)
        )
          fail("dispatch_frozen_input_unavailable");
        // The committed operation owns its original marker format. Only that
        // verified value is reused; the complete recomputed comparison input
        // must still match the publication receipt before private confirmation.
        replayedBackfillRevision = retained.document.frozen.backfillRevision;
      }
    }
    const normalizedAll = await normalizeStored(
      config.repositories.map((repo) => repo.id),
      observationCutoff,
      dispatch,
      null,
      mergeTargetGeneration === null ? null : { generation: mergeTargetGeneration, collect: false },
      decisionCapture?.runs ?? [],
    );
    const selectedArtifactIds = normalizedAll
      .filter((entry) => repos.some((repo) => String(repo.id) === entry.repositoryId))
      .flatMap((entry) =>
        entry.document.facts.filter((fact) => fact.metricId === "issues_opened").map((fact) => fact.artifactId),
      );
    const transferAuthority = await db.transaction((tx) =>
      readSourceAuthority(tx, {
        repositories: config.repositories,
        repositoryIds: repos.map((repo) => repo.id),
        artifactIds: selectedArtifactIds,
        cutoff: observationCutoff,
        dataMode,
        normalized: normalizedAll,
      }),
    );
    if (!transferAuthority.selectedPublic || transferAuthority.access.length !== transferAuthority.repositoryIds.length)
      fail("source_unavailable_before_normalization");
    const normalized = transferAuthority.normalized;
    const displayActorIds = new Set(
      normalized
        .filter((entry) => entry.relationshipPairFactHashes === undefined)
        .flatMap((entry) => entry.document.actors.map((actor) => actor.id)),
    );
    const hasFieldChangeSources = normalized.some(
      (entry) => entry.document.fieldChangeNormalizationVersion === fieldChangeNormalizationVersion,
    );
    const hasTriageMetadataSources = normalized.some(
      (entry) => entry.document.triageMetadataNormalizationVersion === triageMetadataNormalizationVersion,
    );
    const hasReviewSources = normalized.some((entry) => entry.family === "reviews");
    const hasDiscussionSources = normalized.some((entry) => entry.family === "discussions");
    const hasDefaultDeliverySources = normalized.some(
      (entry) => entry.document.defaultDeliveryNormalizationVersion === defaultDeliveryNormalizationVersion,
    );
    const hasRelationshipPairSources = normalized.some(
      (entry) => entry.document.relationshipPairNormalizationVersion === relationshipPairNormalizationVersion,
    );
    const ready = () => {
      assertRunConfiguration();
      if (hasReviewSources) assertReviewNormalizer();
      if (hasDiscussionSources) assertDiscussionNormalizer();
      if (hasDefaultDeliverySources) assertDefaultDeliveryNormalizer();
      if (hasFieldChangeSources) assertFieldChangeNormalizer();
      if (hasTriageMetadataSources) assertTriageMetadataNormalizer();
      if (hasRelationshipPairSources) assertRelationshipPairNormalizer();
    };
    ready();
    const feedbackCapture = await db.transaction((tx) =>
      feedbackStore.capture(
        tx,
        repos.map((repo) => repo.id),
      ),
    );
    ready();
    let outputs = normalized.map((entry) => {
      const document = {
        ...copy(relationshipPairCalculationDocument(entry)),
        selectedCurrentState: entry.selectedCurrentState,
      };
      if (entry.family !== "reviews" || entry.reviewSequenceObserved) return document;
      const withheld = new Set(
        document.facts.filter((fact) => fact.metricId === "first_reviews").map((fact) => fact.id),
      );
      if (!withheld.size) return document;
      return {
        ...document,
        facts: document.facts.filter((fact) => !withheld.has(fact.id)),
        evidence: document.evidence.filter((entry) => !withheld.has(entry.contribution.contributionId)),
        reasons: [...document.reasons, "first_review_sequence_observation_unversioned"],
      };
    });
    const actorSources = new Map(outputs.map((output, index) => [output, normalized[index].source]));
    // Only persisted provider normalizations can restore identity; recognition overlays are transient.
    const normalizationSources = normalized
      .map((entry) => ({
        factKey: entry.source.factKey,
        documentHash: digest(entry.document),
        ...(entry.relationshipPairFactHashes === undefined
          ? {}
          : {
              relationshipPairFactHashes: [...entry.relationshipPairFactHashes].sort(),
            }),
      }))
      .sort((left, right) => left.factKey.localeCompare(right.factKey));
    const normalizationHashes = [...new Set(normalizationSources.map((entry) => entry.documentHash))].sort();
    const physicalSources = selectedPolicies.some((item) =>
      c.contracts.physicalMetricIds.includes(item.policy.metricId),
    )
      ? capturePhysicalSources(normalized, normalizationSources, digest, dataMode)
      : [];
    const suppressedArtifactIds = new Set([
      ...outputs.flatMap((output) => output.suppressArtifactIds ?? []),
      ...transferAuthority.removed,
    ]);
    // Reconcile every original source identity before recognition admission.
    // Repeated observations contribute one actor; their original source bindings
    // still govern alias, classification and execution-evidence conflicts.
    const identity = sourceActorEvidence();
    const actors = identity.actors;
    for (const output of outputs) {
      for (const actor of output.actors) {
        if (!retainSourceActor(identity, actor, actorSources.get(output), c.metrics.stableJSON, c.contracts))
          fail("conflicting_actor_metadata");
      }
    }
    outputs = conserveIssueCreations(
      outputs.map((output) => ({
        ...output,
        facts: output.facts.filter((fact) => !suppressedArtifactIds.has(fact.artifactId)),
        evidence: output.evidence.filter((entry) => !suppressedArtifactIds.has(entry.artifact.stableId)),
      })),
      {
        transfers: transferAuthority.transfers,
        creationScopes: transferAuthority.creationScopes,
        repositoryIds: repos.map((repo) => repo.id),
        context: scope.context ?? "event",
      },
    ).outputs;
    let decidedProjection = null;
    if (
      scopedDecisionCapture !== null &&
      selectedPolicies.some((item) => item.policy.metricId === "pr_accepted_rate")
    ) {
      const assertCurrent = decisionReadFence(scopedDecisionCapture);
      const decision = await db.transaction((tx) =>
        readDecisionGenerations(tx, {
          selectedRuns: scopedDecisionCapture.runs.map((run) => ({
            repositoryId: run.repositoryId,
            runId: run.runId,
          })),
          repositories: config.repositories,
          source: decisionSourceId,
          asOf: scopedDecisionCapture.asOf,
          selectionAsOf: window.to,
          observationCutoff,
          dataMode,
          assertAuthorized: assertCurrent,
          expected: scopedDecisionCapture,
        }),
      );
      assertCurrent();
      decidedProjection = projectDecidedPullRequests(decision, normalized, window.to);
      const enrolled = new Set(scopedDecisionCapture.runs.map((run) => String(run.repositoryId)));
      outputs = outputs.map((output) => {
        const replaced = new Set(
          output.facts
            .filter((fact) => fact.metricId === "pr_accepted_rate" && enrolled.has(fact.repoId))
            .map((fact) => fact.id),
        );
        return {
          ...output,
          facts: output.facts.filter((fact) => !replaced.has(fact.id)),
          evidence: output.evidence.filter((entry) => !replaced.has(entry.contribution.contributionId)),
        };
      });
      outputs.push({
        actors: [],
        facts: decidedProjection.facts,
        evidence: decidedProjection.evidence,
        reasons: [],
        isSynthetic: dataMode === "synthetic",
      });
      ready();
    }
    let reviewedWorkstreamHelp = recognitionBindings.some((binding) => Object.hasOwn(binding, "workstreamHelp"))
      ? []
      : null;
    let workstreamHelpSourceDecisions = [];
    if (recognitionBindings.length && scope.branch === undefined) {
      const combined = {
        facts: outputs.flatMap((o) => o.facts),
        actors: [...actors.values()],
        evidence: outputs.flatMap((o) => o.evidence),
        releaseInclusions: outputs.flatMap((o) => o.releaseInclusions ?? []),
        syntheticFactIds: outputs.flatMap((o) => [
          ...(o.syntheticFactIds ?? []),
          ...(o.isSynthetic === true ? o.facts.map((fact) => fact.id) : []),
        ]),
        reasons: [],
        issueTransfers: transferAuthority.transfers,
        issueCreationScopes: transferAuthority.creationScopes,
        discussionFeedbackSources: outputs.flatMap((output) =>
          (output.discussionFeedbackSources ?? []).map((source) => ({
            ...source,
            selectedCurrentState: output.selectedCurrentState === true,
          })),
        ),
        discussionFeedbackRepositoryIds: feedbackCapture.map((entry) => entry.repositoryId),
        discussionFeedbackOriginals: await db.transaction((tx) =>
          feedbackStore.originals(
            tx,
            controlsStore.read(),
            recognitionBindings.filter((binding) => repos.some((repo) => String(repo.id) === binding.repositoryId)),
            observationCutoff,
          ),
        ),
      };
      combined.facts = [
        ...new Map(
          combined.facts.filter((f) => !suppressedArtifactIds.has(f.artifactId)).map((f) => [f.id, f]),
        ).values(),
      ];
      const recognized = materializeRecognition(
        combined,
        controlsStore.read(),
        recognitionBindings,
        selectedPolicies,
        c.github.applyRecognitionReceipt,
        observationCutoff,
        c.contracts.publicDocumentationReasons,
      );
      if (reviewedWorkstreamHelp !== null) {
        if (
          !Array.isArray(recognized.reviewedWorkstreamHelp) ||
          recognized.reviewedWorkstreamHelp.some((entry) => entry.statement.organization !== scope.organization)
        )
          fail("workstream_help_evidence_unverified");
        reviewedWorkstreamHelp = recognized.reviewedWorkstreamHelp;
        workstreamHelpSourceDecisions = recognized.workstreamHelpSourceDecisions;
      }
      outputs = [
        ...outputs,
        {
          facts: recognized.facts.slice(combined.facts.length),
          actors: [],
          evidence: recognized.evidence.slice(combined.evidence.length),
        },
      ];
    }
    const uniqueFacts = new Map();
    for (const fact of outputs.flatMap((output) => output.facts)) {
      if (suppressedArtifactIds.has(fact.artifactId)) continue;
      const previous = uniqueFacts.get(fact.id);
      const semantic = (value) => {
        const { observedAt, ...rest } = value;
        return c.metrics.stableJSON(rest);
      };
      if (previous && semantic(previous) !== semantic(fact)) fail("conflicting_normalized_fact");
      if (!previous || fact.observedAt < previous.observedAt) uniqueFacts.set(fact.id, fact);
    }
    const facts = applyCurrentProjectContexts(
      [...uniqueFacts.values()].sort((a, b) => a.id.localeCompare(b.id)),
      outputs,
    );
    const evidence = new Map();
    for (const output of outputs) {
      for (const entry of output.evidence) {
        const id = entry.contribution.contributionId,
          previous = evidence.get(id);
        if (
          previous &&
          c.metrics.stableJSON([previous.artifact, previous.contribution, previous.occurredAt]) !==
            c.metrics.stableJSON([entry.artifact, entry.contribution, entry.occurredAt])
        )
          fail("conflicting_evidence_metadata");
        evidence.set(id, selectEvidenceMetadata(previous, entry));
      }
    }
    const correctionState = await readCorrectionState(db, transferAuthority.repositoryIds);
    const reversion = materializeReversionEffectiveness(
      {
        facts,
        policies: selectedPolicies,
        evidence: [...evidence.values()],
      },
      correctionState.decisions,
      observationCutoff,
    );
    const projectedLegacyCorrections = projectIssueCreationCorrections(
      correctionState.legacy.map((row) => row.document.fact),
      facts,
      transferAuthority.transfers,
    );
    const corrections = [...projectedLegacyCorrections, ...reversion.overlays];
    const issueTransferCorrections = correctionState.legacy
      .map((row, index) => ({
        artifactId: row.artifact_id,
        hash: digest(row.document.fact),
        projectionArtifactId: projectedLegacyCorrections[index].artifactId,
        projectionHash: digest(projectedLegacyCorrections[index]),
      }))
      .filter((entry, index) => correctionState.legacy[index].document.fact.metricId === "issues_opened");
    const reversionBinding = reversionCapture(correctionState, observationCutoff);
    // Keep legacy imports literal. Versioned observations retain every read,
    // while unchanged audits do not manufacture another semantic history epoch.
    // Committed pages of a later-failed audit remain part of its actual evidence.
    const importedHistory = replayedBackfillRevision
      ? []
      : await readImportedHistory(
          db,
          repos.map((repo) => repo.id),
          observationCutoff,
        );
    const engineScope = {
      ...window,
      repos: repos.map((repo) => String(repo.id)),
      projects: scope.projects ?? [],
      workstreams: scope.workstream === null ? [] : [scope.workstream],
      roles: scope.roles ?? [],
      actors: "all",
      context: scope.context ?? "event",
      ...(scope.branch === undefined ? {} : { branch: scope.branch }),
    };
    const projectContextFor = createPublicProjectContextProjector(normalized, engineScope.context, observationCutoff);
    const state = controlsStore.read();
    assertRunConfiguration();
    for (const actor of actors.values()) if (state.profiles[actor.id]?.suppressed) actor.publicState = "suppressed";
    // Completed scans establish bounded progress, not complete historic source capability.
    const reconciliation = reconciliationPolicy
      ? await db.transaction((tx) =>
          reconciliationState(tx, repos, observationCutoff, { untilCutoff: cutoff, scan: scan?.plan ? scan : null }),
        )
      : null;
    const coverage = repos.flatMap((repo) =>
      [...new Set(selectedPolicies.flatMap((item) => item.policy.sources))].map((source) => {
        const progress = reconciliation?.progress.filter((row) => row.repositoryId === repo.id);
        const github = source.startsWith("github_");
        const lastSuccessfulSync = reconciliation
          ? github
            ? leastReconciliationTime(progress.map((row) => row.lastSuccessfulSync))
            : null
          : cutoff;
        const sourceWatermark = reconciliation
          ? github
            ? leastReconciliationTime(progress.map((row) => row.reconciledThrough))
            : null
          : cutoff;
        const sourceErrors = ["historical_capability_not_certified"];
        if (decidedProjection?.unavailable) sourceErrors.push("decision_history_unavailable");
        if (reconciliation && github) {
          if (sourceWatermark === null) sourceErrors.push("reconciliation_baseline_unavailable");
          else if (sourceWatermark < cutoff) sourceErrors.push("reconciliation_gap");
          if (progress.some((row) => row.expectedCount === null || row.expectedCount !== row.itemCount))
            sourceErrors.push("reconciliation_count_unknown");
          if (progress.some((row) => row.state !== "complete")) sourceErrors.push("reconciliation_incomplete");
        }
        return {
          schemaVersion: "leaderboard/v1",
          state: "partial",
          source,
          scopeId: String(repo.id),
          windowStart: window.from,
          windowEnd: window.to,
          knownStart: null,
          lastSuccessfulSync,
          sourceWatermark,
          missingPages: 0,
          permissionsMissing: [],
          sourceErrors,
        };
      }),
    );
    const frozen = {
      datasetId: digest([facts, corrections]),
      cutoff: observationCutoff,
      backfillRevision:
        replayedBackfillRevision ??
        digest([
          "pipeline-reconciliation/v1",
          normalizationSignature,
          importedHistory,
          // Keep the complete captured corrections in frozen.facts for the existing
          // dispatch input fence; only effective observations belong to this epoch.
          corrections
            .filter((fact) => c.contracts.compareSourceInstants(fact.observedAt, observationCutoff) <= 0)
            .map(digest)
            .sort(),
        ]),
      repositoryIds: transferAuthority.repositoryIds,
      // Validate all provider bindings before any privacy projection.
      actors: [...actors.values()],
      facts: [...facts, ...corrections],
      coverage,
    };
    for (const item of selectedPolicies.filter((item) => item.policy.metricId === "pr_accepted_rate")) {
      const units = new Set();
      for (const fact of frozen.facts.filter(
        (fact) => fact.metricId === item.policy.metricId && item.policy.rankedStates.includes(fact.state),
      )) {
        const unit = JSON.stringify([fact.actorId, fact.artifactId]);
        if (units.has(unit)) fail("decision_lifecycle_selection_unproven");
        units.add(unit);
      }
    }
    const aggregates = selectedPolicies.map((item) => c.metrics.aggregateMetric(frozen, item.policy, engineScope));
    const physical = selectPhysicalContexts({
      sources: physicalSources,
      aggregates,
      policies: selectedPolicies,
      contracts: c.contracts,
      serialize: c.metrics.stableJSON,
      policyDigest,
      projectContextFor,
    });
    const pendingFor = (aggregate, row) => ({
      schemaVersion: "leaderboard-pending/v1",
      state: aggregate.coverage === "complete" ? "measured" : row.pending > 0 ? "partial" : "unknown",
      valueClass: selectedPolicies.find((item) => item.policy.metricId === aggregate.metricId).policy.rankedStates[0],
      count: row.pending > 0 || aggregate.coverage === "complete" ? row.pending : null,
      evidenceIds: row.pendingEvidence.map((fact) => fact.id),
    });
    const diagnostics = aggregates.flatMap((aggregate) =>
      aggregate.rows.map((row) => ({
        metricId: aggregate.metricId,
        actorId: row.actorId,
        numerator: row.numerator,
        denominator: row.denominator,
        sampleCount: row.sampleCount,
        censored: row.censored,
        missingReadiness: row.missingReadiness,
        p75: row.p75,
        pending: pendingFor(aggregate, row),
      })),
    );
    const rows = aggregates.flatMap((aggregate) =>
      aggregate.rows.map((row) => ({
        actorId: row.actorId,
        result: {
          schemaVersion: "leaderboard/v1",
          metricId: aggregate.metricId,
          state: row.value === null ? "unknown" : "partial",
          ...(row.value === null ? {} : { value: row.value }),
          coverage: { ...coverage[0], scopeId: scopeKey(scope) },
        },
        evidenceIds: row.evidenceIds,
        pending: pendingFor(aggregate, row),
      })),
    );
    // Dependency receipts use the exact aggregate selection, not portfolio grouping.
    // If any receipt is absent or no longer public, projection withholds the pending count.
    const pendingEvidence = aggregates.flatMap((aggregate) =>
      aggregate.rows.flatMap((row) =>
        row.pendingEvidence.flatMap((fact) => {
          const original = evidence.get(fact.id);
          if (!original) return [];
          return [
            {
              artifact: copy(original.artifact),
              contribution: {
                ...copy(original.contribution),
                actorId: fact.actorId,
                roles: [fact.role],
                qualification: "eligible",
                metricIds: [fact.metricId],
                reasonCodes: ["public_pending_work", ...c.contracts.publicDocumentationReasons(original.contribution)],
              },
              occurredAt: fact.occurredAt,
              observedAt: fact.observedAt,
              activityState: "pending",
              ...(fact.decisionAsOf === undefined ? {} : { decisionAsOf: fact.decisionAsOf }),
              sourceRevision: original.sourceRevision,
              sourceRevisionUrl: original.sourceRevisionUrl,
              ...materializeEvidenceMetadata(original, fact),
              ...projectContextFor(original, fact),
            },
          ];
        }),
      ),
    );
    // Descriptive public work is not conditional on earning a ranked outcome.
    // Selection reuses existing corrections, source/role/context checks and receipt validation.
    const portfolioFacts = selectedPolicies.flatMap((item) =>
      c.metrics.selectPortfolioFacts(frozen, item.policy, engineScope),
    );
    const portfolioEvidence = portfolioFacts.flatMap((fact) => {
      const original = evidence.get(fact.id);
      if (!original || !["observed", "pending", "qualified", "reviewed"].includes(fact.state)) return [];
      const activityState = ["qualified", "reviewed"].includes(fact.state) ? "accepted" : fact.state;
      return [
        {
          artifact: copy(original.artifact),
          contribution: {
            ...copy(original.contribution),
            actorId: fact.actorId,
            roles: [fact.role],
            qualification: "eligible",
            metricIds: [fact.metricId],
            reasonCodes: [
              `public_${activityState}_work`,
              ...c.contracts.publicDocumentationReasons(original.contribution),
              ...(activityState === "accepted"
                ? [
                    ...c.contracts.publicDocumentationRecognitionReasons(original.contribution),
                    ...c.contracts.publicReproductionRecognitionReasons(original.contribution, true),
                    ...publicMaintenanceClassificationReasons(original.contribution),
                  ]
                : []),
            ],
          },
          occurredAt: fact.occurredAt,
          observedAt: fact.observedAt,
          activityState,
          ...(activityState === "pending" && fact.decisionAsOf !== undefined
            ? { decisionAsOf: fact.decisionAsOf }
            : {}),
          sourceRevision: original.sourceRevision,
          sourceRevisionUrl: original.sourceRevisionUrl,
          ...materializeEvidenceMetadata(original, fact),
          ...projectContextFor(original, fact),
        },
      ];
    });
    const usedIds = new Set(rows.flatMap((row) => row.evidenceIds));
    const publicEvidence = [...evidence.values()].filter((entry) => usedIds.has(entry.contribution.contributionId));
    // Evidence period filtering follows the metric's declared clock, with raw time preserved upstream.
    for (const entry of publicEvidence) {
      // A restored qualified unit uses the same last effective reviewed revision
      // as the aggregate and portfolio; the immutable raw source stays in facts.
      const fact =
        reversion.overlays.findLast((fact) => fact.id === entry.contribution.contributionId) ??
        facts.find((fact) => fact.id === entry.contribution.contributionId);
      if (fact) {
        entry.occurredAt =
          fact[selectedPolicies.find((item) => item.policy.metricId === fact.metricId).policy.dateBasis];
        Object.assign(entry, materializeEvidenceMetadata(entry, fact));
        Object.assign(entry, projectContextFor(entry, fact));
      }
    }
    const publicActorIds = new Set([
      ...displayActorIds,
      ...rows.map((row) => row.actorId),
      ...[...publicEvidence, ...portfolioEvidence, ...pendingEvidence].map((entry) => entry.contribution.actorId),
    ]);
    const content = {
      ...(hasFieldChangeSources ? { fieldChangeNormalizationVersion } : {}),
      ...(hasTriageMetadataSources ? { triageMetadataNormalizationVersion } : {}),
      ...(feedbackCapture.length
        ? {
            discussionFeedbackNormalizationVersion: discussionFeedbackContentVersion,
            discussionFeedbackEvidenceHash: digest(feedbackCapture),
          }
        : {}),
      ...(hasRelationshipPairSources ? { relationshipPairNormalizationVersion } : {}),
      ...(hasDiscussionSources ? { discussionSourceNormalizationVersion } : {}),
      ...(hasDefaultDeliverySources ? { defaultDeliveryNormalizationVersion } : {}),
      ...(hasReviewSources ? { reviewSourceNormalizationVersion } : {}),
      approvedPublic: true,
      scope: copy(scope),
      actors: actorContracts([...actors.values()].filter((actor) => publicActorIds.has(actor.id))),
      rows,
      evidence: publicEvidence,
      portfolioEvidence,
      pendingEvidence,
      ...(reviewedWorkstreamHelp === null
        ? {}
        : {
            reviewedWorkstreamHelp: selectWorkstreamHelp(
              reviewedWorkstreamHelp,
              portfolioFacts,
              evidence,
              workstreamHelpSourceDecisions,
            ),
          }),
      ...physical,
      ranking: selectedPolicies.map((item) => ({
        metricId: item.policy.metricId,
        direction: "descending",
        rank: item.policy.rank,
      })),
      rankingPresentationPolicy: copy(c.contracts.currentRankingPresentationPolicy),
      diagnostics,
      methodology: selectedPolicies.map((item) => ({
        metricId: item.policy.metricId,
        policyVersion: item.policy.version,
        policySignature: policyDigest(item.signature),
        policyLink: item.policyLink ?? null,
      })),
      definitionVersion: c.metrics.metricRegistryV1.policy_version,
      dataMode,
      cutoff,
      coverage,
      configVersion: config.version,
      repositoryIds: transferAuthority.repositoryIds.map(Number),
      issueTransferEvidenceHash: digest(transferAuthority.capture),
      ...(transferAuthority.relationshipPairEvidence === undefined
        ? {}
        : {
            relationshipPairEvidenceHash: digest(transferAuthority.relationshipPairEvidence),
          }),
      ...reversionBinding,
    };
    const snapshotId = digest(content);
    if (priorPublication && priorPublication.snapshotId !== snapshotId) fail("dispatch_snapshot_replay_changed");
    const comparisonInputFor = (publication) => ({
      input: { ...frozen, actors: frozen.actors.map(previewActor) },
      scope: engineScope,
      policies: selectedPolicies.map((item) => item.policy),
      aggregates,
      snapshot: { snapshotId: publication.snapshotId, revision: publication.revision },
      authorization: {
        configurationHash: digest(config),
        dataMode,
        controlsConfigurationRevision: runConfigurationRevision,
        identityEvidence: {
          schemaVersion: "pipeline-identity-evidence/v1",
          normalizationHashes,
          // Versioned source semantics bind exact pairs even without renames;
          // hash-only historical captures can otherwise be ambiguous across families.
          normalizationSources,
        },
        ...mergeTargetAuthorization(scope, observationCutoff),
        issueTransferEvidence: transferAuthority.capture,
        ...(scopedDecisionCapture === null ? {} : { pullRequestDecisionEvidence: scopedDecisionCapture }),
        ...(decidedProjection === null
          ? {}
          : {
              pullRequestDecisionProjection: decisionProjectionBinding(scopedDecisionCapture, window.to, facts),
            }),
        ...(feedbackCapture.length ? { discussionFeedbackEvidence: feedbackCapture } : {}),
        ...(transferAuthority.relationshipPairEvidence === undefined
          ? {}
          : {
              relationshipPairEvidence: transferAuthority.relationshipPairEvidence,
            }),
        issueTransferCorrections,
        sources: transferAuthority.access.map((row) => ({
          repositoryId: String(row.repository_id),
          generation: String(row.generation),
        })),
        ...reversionBinding,
      },
    });
    let retainedComparisonInput;
    const restorePublicationInput = async (tx, publication) => {
      const retained = await readDecisionFrozenInput(tx, publication.snapshotId, scopedDecisionCapture !== null);
      const decisionBound = retained?.decision_bound === true;
      const document = retained?.document;
      if (
        !document ||
        digest(document) !== retained.document_hash ||
        canonical(document.scope) !== canonical(scope) ||
        canonical(document.engineScope) !== canonical(engineScope) ||
        canonical(document.policies) !== canonical(JSON.parse(JSON.stringify(selectedPolicies))) ||
        document.identityAuthorization?.configurationHash !== digest(config) ||
        document.identityAuthorization?.dataMode !== dataMode
      )
        fail("retained_publication_input_conflict");
      const original = await withAuthorizedComparisonInputs(
        [document.identityAuthorization],
        (removed, guard) => {
          const suppressed = new Set(removed);
          if (document.frozen.facts.some((fact) => suppressed.has(fact.artifactId)))
            fail("retained_publication_source_unavailable");
          const restored = guard.restoreInput(document.frozen, document.identityAuthorization);
          return {
            input: document.frozen,
            scope: document.engineScope,
            policies: document.policies.map((item) => item.policy),
            aggregates: document.policies.map((item) =>
              c.metrics.aggregateMetric(restored, item.policy, document.engineScope),
            ),
            snapshot: { snapshotId: publication.snapshotId, revision: publication.revision },
            authorization: document.identityAuthorization,
          };
        },
        tx,
      );
      const saved = await readDecisionPublicationReceipt(
        tx,
        `publish:${scopeKey(scope)}:${publication.snapshotId}`,
        decisionBound,
      );
      if (
        !saved ||
        digest(saved.document) !== saved.document_hash ||
        saved.document.snapshotId !== publication.snapshotId ||
        saved.document.revision !== publication.revision ||
        saved.document.comparisonInputHash !== digest(original)
      )
        fail("retained_publication_input_conflict");
      return original;
    };
    const publicationStarted = performance.now();
    try {
      const publication = await db.transaction(async (tx) => {
        await lockIssueTransferSources(tx, config.repositories);
        if (hasReviewSources) assertReviewNormalizer();
        ready();
        await feedbackStore.assertCapture(
          tx,
          repos.map((repo) => repo.id),
          feedbackCapture.length ? feedbackCapture : undefined,
        );
        if (scopedDecisionCapture !== null)
          await retainedDecisionEvidence(
            tx,
            {
              pullRequestDecisionEvidence: scopedDecisionCapture,
              sources: transferAuthority.access.map((row) => ({
                repositoryId: String(row.repository_id),
                generation: String(row.generation),
              })),
            },
            observationCutoff,
          );
        const scanHeads = scan ? await scanContinuations.lockForPublication(tx, scan, assertRunConfiguration) : null;
        if (dispatch) await outbox.assertLease(tx, dispatch.lease);
        const bindPublication = async (publication) => {
          if (scan) await scanContinuations.rememberPublication(tx, scan, scopeKey(scope), publication.snapshotId);
          if (dispatch) {
            await tx.query(
              `INSERT INTO leaderboard_pipeline.dispatch_publications(operation_key,scope_key,snapshot_id,scope_hash)
              VALUES($1,$2,$3,${pipelineKeySQL("$2")}) ON CONFLICT (operation_key,scope_hash) DO NOTHING`,
              [dispatch.lease.operation.operationKey, scopeKey(scope), publication.snapshotId],
            );
            const saved = (
              await tx.query(
                `SELECT snapshot_id FROM leaderboard_pipeline.dispatch_publications WHERE operation_key=$1 AND scope_hash=${pipelineKeySQL("$2")} AND scope_key=$2`,
                [dispatch.lease.operation.operationKey, scopeKey(scope)],
              )
            ).rows[0];
            if (saved?.snapshot_id !== publication.snapshotId) fail("dispatch_publication_conflict");
            await outbox.assertLease(tx, dispatch.lease);
          }
          if (hasReviewSources) assertReviewNormalizer();
          ready();
          return publication;
        };
        await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`pipeline:${scopeKey(scope)}`]);
        const retainedAuthority = await readSourceAuthority(tx, {
          repositories: config.repositories,
          repositoryIds: repos.map((repo) => repo.id),
          artifactIds: selectedArtifactIds,
          cutoff: observationCutoff,
          dataMode,
          normalized: normalizedAll,
        });
        if (retainedAuthority.fingerprint !== transferAuthority.fingerprint)
          fail("issue_transfer_authority_changed_before_publication");
        const currentTransferAuthority = await readSourceAuthority(tx, {
          repositories: config.repositories,
          repositoryIds: repos.map((repo) => repo.id),
          artifactIds: selectedArtifactIds,
          dataMode,
        });
        const scopeSources = generations.map((row) => ({
          repositoryId: Number(row.repository_id),
          generation: String(row.generation),
        }));
        const expectedSources = reconciliation?.sources ?? scopeSources;
        const access = (
          await tx.query(
            "SELECT repository_id,generation FROM leaderboard_ingestion.repository_access WHERE repository_id=ANY($1::bigint[]) AND state='public' FOR SHARE",
            [expectedSources.map((source) => source.repositoryId)],
          )
        ).rows;
        if (
          access.length !== expectedSources.length ||
          // The full reconciliation context supplements the generations captured
          // before normalization; it cannot replace that earlier source fence.
          expectedSources
            .concat(scopeSources)
            .some(
              (prior) =>
                !access.some(
                  (current) =>
                    String(current.repository_id) === String(prior.repositoryId) &&
                    String(current.generation) === prior.generation,
                ),
            ) ||
          reconciliation?.confirmCurrent() === false
        )
          fail("source_revoked_before_publication");
        const removed = new Set(currentTransferAuthority.removed);
        if (facts.some((fact) => removed.has(fact.artifactId))) fail("source_suppressed_before_publication");
        // Corrections share the source write lock but do not increment its
        // generation. Recheck complete joined rows/seals while that lock is held.
        if (
          (await readCorrectionState(tx, transferAuthority.repositoryIds)).fingerprint !== correctionState.fingerprint
        )
          fail("reversion_changed_before_publication");
        const current = (
          await tx.query(
            `SELECT snapshot_id,revision FROM leaderboard_pipeline.heads WHERE scope_hash=${pipelineKeySQL("$1")} AND scope_key=$1`,
            [scopeKey(scope)],
          )
        ).rows[0];
        ready();
        if (hasReviewSources) assertReviewNormalizer();
        if (scan) scanContinuations.assertHead(scanHeads, scopeKey(scope), current?.snapshot_id ?? null);
        if (priorPublication) {
          const saved = await readDecisionPublicationReceipt(
            tx,
            `publish:${scopeKey(scope)}:${snapshotId}`,
            priorDecisionBound || scopedDecisionCapture !== null,
          );
          if (
            !saved ||
            digest(saved.document) !== saved.document_hash ||
            saved.document.comparisonInputHash !== digest(comparisonInputFor(priorPublication))
          )
            fail("dispatch_snapshot_input_changed_or_unbound");
          return bindPublication(priorPublication);
        }
        if (current?.snapshot_id === snapshotId) {
          const publication = { snapshotId, revision: Number(current.revision), changed: false };
          const confirmation = controlsStore.read().pipelinePublications?.[snapshotId];
          if (confirmationMatches(confirmation, scope, snapshotId, publication.revision)) {
            const original = aggregateExplanations.verify(snapshotId, {
              ...explanationBinding(scope, publication),
              digest: confirmation.aggregateExplanationHash,
            });
            if (
              scopedDecisionCapture !== null ||
              original.document.authorization.pullRequestDecisionEvidence !== undefined
            )
              // Identical public content keeps its first private generation,
              // including legacy absence. Never backfill it with a later scan.
              retainedComparisonInput = await restorePublicationInput(tx, publication);
          } else {
            // An unconfirmed retry may observe the same public content at a
            // later clock. Its committed receipt owns the original private
            // input; re-admit it without rewriting either SQL record.
            retainedComparisonInput = await restorePublicationInput(tx, publication);
          }
          return bindPublication(publication);
        }
        const revision = Number(current?.revision ?? 0) + 1;
        if (!Number.isSafeInteger(revision)) fail("pipeline_revision_exhausted");
        const document = {
          approvedPublic: true,
          scope: copy(scope),
          actors: content.actors,
          rows,
          evidence: publicEvidence,
          portfolioEvidence,
          pendingEvidence,
          ...(content.reviewedWorkstreamHelp === undefined
            ? {}
            : {
                reviewedWorkstreamHelp: content.reviewedWorkstreamHelp,
              }),
          ...physical,
          ranking: content.ranking,
          rankingPresentationPolicy: content.rankingPresentationPolicy,
          dataMode,
          diagnostics,
          methodology: content.methodology,
          ...reversionBinding,
          snapshot: {
            schemaVersion: "leaderboard/v1",
            snapshotId,
            revision,
            generatedAt: utc(now()),
            metricDefinitionVersion: content.definitionVersion,
            computationVersion,
            coverage,
            results: [],
          },
        };
        const inserted = await tx.query(
          `INSERT INTO leaderboard_pipeline.snapshots (snapshot_id,scope_key,revision,config_version,repository_ids,document,document_hash)
        VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7) ON CONFLICT DO NOTHING RETURNING snapshot_id`,
          [
            snapshotId,
            scopeKey(scope),
            revision,
            config.version,
            JSON.stringify(content.repositoryIds),
            JSON.stringify(document),
            digest(document),
          ],
        );
        // A historical content ID still owns its original immutable revision/document.
        // Never advance the head to a new revision when that insert was skipped.
        // Re-materialize at a fresh cutoff instead of rewriting the prior snapshot.
        if (inserted.rows.length !== 1) fail("pipeline_snapshot_identity_conflict");
        const savedHead = await tx.query(
          `INSERT INTO leaderboard_pipeline.heads (scope_key,snapshot_id,revision,scope_hash)
           VALUES ($1,$2,$3,${pipelineKeySQL("$1")})
           ON CONFLICT (scope_hash) DO UPDATE SET snapshot_id=EXCLUDED.snapshot_id,revision=EXCLUDED.revision
           WHERE heads.scope_key=EXCLUDED.scope_key RETURNING scope_key`,
          [scopeKey(scope), snapshotId, revision],
        );
        if (savedHead.rows.length !== 1 || savedHead.rows[0].scope_key !== scopeKey(scope))
          fail("pipeline_scope_identity_conflict");
        const frozenDocument = JSON.parse(
          JSON.stringify({
            frozen: { ...frozen, actors: frozen.actors.map(previewActor) },
            identityAuthorization: comparisonInputFor({ snapshotId, revision }).authorization,
            engineScope,
            scope,
            policies: selectedPolicies,
          }),
        );
        await tx.query(
          "INSERT INTO leaderboard_pipeline.frozen_inputs(snapshot_id,document,document_hash) VALUES($1,$2::jsonb,$3)",
          [snapshotId, JSON.stringify(frozenDocument), digest(frozenDocument)],
        );
        const receiptId = await receipt(tx, `publish:${scopeKey(scope)}:${snapshotId}`, "snapshot_published", {
          snapshotId,
          revision,
          configuration: config.version,
          policySignatures: selectedPolicies.map((item) => item.signature),
          datasetId: frozen.datasetId,
          comparisonInputHash: digest(comparisonInputFor({ snapshotId, revision })),
          controlsRevision: state.revision,
        });
        ready();
        return bindPublication({ snapshotId, revision, changed: true, receiptId });
      });
      // PostgreSQL can commit while controls change. Confirm publication only in
      // the same synchronous SQLite boundary used by configuration activation.
      ready();
      if (hasTriageMetadataSources) {
        assertTriageMetadataNormalizer();
        publication.triageMetadataNormalizationVersion = triageMetadataNormalizationVersion;
      }
      if (hasFieldChangeSources) {
        assertFieldChangeNormalizer();
        publication.fieldChangeNormalizationVersion = fieldChangeNormalizationVersion;
      }
      if (hasReviewSources) {
        assertReviewNormalizer();
        publication.reviewSourceNormalizationVersion = reviewSourceNormalizationVersion;
      }
      if (hasDiscussionSources) {
        assertDiscussionNormalizer();
        publication.discussionSourceNormalizationVersion = discussionSourceNormalizationVersion;
      }
      if (feedbackCapture.length) publication.discussionFeedbackNormalizationVersion = discussionFeedbackContentVersion;
      if (hasDefaultDeliverySources) {
        assertDefaultDeliveryNormalizer();
        publication.defaultDeliveryNormalizationVersion = defaultDeliveryNormalizationVersion;
      }
      if (hasRelationshipPairSources)
        publication.relationshipPairNormalizationVersion = relationshipPairNormalizationVersion;
      confirmPublication(scope, publication, retainedComparisonInput ?? comparisonInputFor(publication), publicPeriods);
      monitorSuccess(
        publicationMonitorIdentity(scopeKey(scope)),
        "publication",
        publicationStarted,
        String(publication.revision),
      );
      return publication;
    } catch (error) {
      monitorFailure(publicationMonitorIdentity(scopeKey(scope)), "publication", "publication_failed");
      throw error;
    }
  }
  async function participationInput(tx, read) {
    const snapshot = read.selected.snapshot;
    const row = (
      await tx.query(
        `SELECT CASE WHEN octet_length(document::text)<=8000000 THEN document END AS document,
          document_hash,octet_length(document::text) AS document_bytes
        FROM leaderboard_pipeline.frozen_inputs WHERE snapshot_id=$1 FOR SHARE`,
        [snapshot.snapshotId],
      )
    ).rows[0];
    if (!row || !Number.isSafeInteger(Number(row.document_bytes)) || Number(row.document_bytes) > 8_000_000)
      fail("participation_history_input_unavailable");
    const document = copyParticipationHistoryJSON(row.document);
    if (!document || typeof document !== "object" || Array.isArray(document))
      fail("participation_history_input_integrity_error");
    const confirmation = controlsStore.read().pipelinePublications?.[snapshot.snapshotId];
    if (!confirmationMatches(confirmation, read.selected.scope, snapshot.snapshotId, snapshot.revision))
      fail("participation_history_confirmation_changed");
    const explanation = aggregateExplanations.verify(snapshot.snapshotId, {
      ...explanationBinding(read.selected.scope, snapshot),
      digest: confirmation.aggregateExplanationHash,
    }).document;
    if (
      digest(document) !== row.document_hash ||
      scopeKey(document.scope) !== scopeKey(read.selected.scope) ||
      canonical(document.policies) !== canonical(JSON.parse(JSON.stringify(config.policies))) ||
      canonical(document.engineScope) !== canonical(explanation.scope) ||
      document.frozen?.datasetId !== explanation.datasetId ||
      document.frozen?.cutoff !== explanation.cutoff ||
      document.frozen?.backfillRevision !== explanation.backfillRevision ||
      [
        "configurationHash",
        "dataMode",
        "controlsConfigurationRevision",
        "identityEvidence",
        "sources",
        "issueTransferEvidence",
        "relationshipPairEvidence",
        "pullRequestDecisionEvidence",
        "pullRequestDecisionProjection",
        "discussionFeedbackEvidence",
        "reversionAuthority",
        "reversionRecordsHash",
      ].some((key) => canonical(document.identityAuthorization?.[key]) !== canonical(explanation.authorization[key])) ||
      document.identityAuthorization?.configurationHash !== digest(config) ||
      document.identityAuthorization?.dataMode !== dataMode
    )
      fail("participation_history_input_integrity_error");
    return {
      document,
      explanation,
      binding: {
        snapshotId: snapshot.snapshotId,
        revision: snapshot.revision,
        sha256: row.document_hash,
        cutoff: document.frozen.cutoff,
      },
    };
  }
  async function participationPublicActors(tx, input, read, restored) {
    const authorization = input.document.identityAuthorization;
    if (authorization.relationshipPairEvidence === undefined) fail("participation_history_actor_binding_changed");
    const rows = await readNormalizationEvidence(tx, authorization, true);
    if (rows === null) fail("participation_history_actor_binding_changed");
    // Current reads may filter disabled rows. Reproduce the original publication
    // roster from its exact confirmed content and the verified source projection.
    const row = (
      await tx.query(
        `SELECT CASE WHEN octet_length(document::text)<=8000000 THEN document END AS document,
          document_hash,octet_length(document::text) AS document_bytes,revision,config_version,scope_key
        FROM leaderboard_pipeline.snapshots WHERE snapshot_id=$1 FOR SHARE`,
        [read.selected.snapshot.snapshotId],
      )
    ).rows[0];
    if (!row || !Number.isSafeInteger(Number(row.document_bytes)) || Number(row.document_bytes) > 8_000_000)
      fail("participation_history_input_unavailable");
    const publication = copyParticipationHistoryJSON(row.document);
    if (
      !publication ||
      typeof publication !== "object" ||
      Array.isArray(publication) ||
      digest(publication) !== row.document_hash ||
      row.config_version !== config.version ||
      row.scope_key !== scopeKey(read.selected.scope) ||
      scopeKey(publication.scope) !== scopeKey(read.selected.scope) ||
      publication.dataMode !== dataMode ||
      publication.snapshot?.snapshotId !== read.selected.snapshot.snapshotId ||
      publication.snapshot?.revision !== read.selected.snapshot.revision ||
      Number(row.revision) !== read.selected.snapshot.revision ||
      canonical(publication.actors) !== canonical(read.selected.actors) ||
      !["rows", "evidence", "portfolioEvidence", "pendingEvidence"].every((key) => Array.isArray(publication[key]))
    )
      fail("participation_history_actor_binding_changed");
    const publicActorIds = new Set([
      ...rows
        .filter((entry) => entry.relationshipPairFactHashes === undefined)
        .flatMap((entry) => entry.document.actors.map((actor) => actor.id)),
      ...publication.rows.map((entry) => entry.actorId),
      ...[...publication.evidence, ...publication.portfolioEvidence, ...publication.pendingEvidence].map(
        (entry) => entry.contribution.actorId,
      ),
    ]);
    return actorContracts(restored.actors.filter((actor) => publicActorIds.has(actor.id)));
  }
  async function readParticipationHistory(scope, pin, _actorId, signal) {
    if (signal.aborted) return null;
    // Ask the host about an exact already-confirmed selected input. The external
    // callback holds no SQL locks and cannot choose a latest/nearest fallback.
    const selected = await db.transaction(async (tx) => {
      const read = await source.read(scope, pin, signal, tx, false, true);
      return read && !signal.aborted ? (await participationInput(tx, read)).binding : null;
    });
    if (!selected || signal.aborted) return null;
    const request = {
      schemaVersion: "pipeline-participation-history-request/v1",
      ...discoveryAuthorityBinding,
      organization: config.organization,
      selectedInput: selected,
    };
    const epoch = participationAuthority.epoch(request);
    const supplied = epoch === null ? null : await participationAuthority.resolve(request, signal);
    if (signal.aborted || participationAuthority.epoch(request) !== epoch) return null;
    const admission = validateParticipationHistoryAdmission(
      supplied,
      request,
      config,
      c.contracts,
      digest,
      policyDigest,
    );
    const historyScope = {
      organization: config.organization,
      repository: null,
      workstream: null,
      start: null,
      end: null,
    };
    let finalRead = () => null;
    const paired = await db.transaction(async (tx) => {
      if (signal.aborted || participationAuthority.epoch(request) !== epoch || !(await approved(tx))) return null;
      const privateState = canonical(controlsStore.read());
      await lockIssueTransferSources(tx, config.repositories);
      const current = await source.read(scope, selected.snapshotId, signal, tx, false, true);
      if (!current || signal.aborted) return null;
      const currentInput = await participationInput(tx, current);
      if (canonical(currentInput.binding) !== canonical(selected)) return null;
      let history = null,
        historyInput = null;
      if (admission) {
        history = await source.read(historyScope, admission.historyInput.snapshotId, signal, tx, false, true);
        if (!history || signal.aborted) return null;
        historyInput = await participationInput(tx, history);
        if (
          canonical(historyInput.binding) !== canonical(admission.historyInput) ||
          canonical(history.selected.scope) !== canonical(historyScope) ||
          historyInput.document.engineScope.from !== null ||
          historyInput.document.engineScope.actors !== "all" ||
          historyInput.document.engineScope.context !== "event" ||
          ["projects", "workstreams", "roles"].some((key) => historyInput.document.engineScope[key].length !== 0) ||
          canonical([...historyInput.document.engineScope.repos].sort()) !==
            canonical(config.repositories.map((repo) => String(repo.id)).sort()) ||
          canonical([...historyInput.document.frozen.repositoryIds].sort()) !==
            canonical(config.repositories.map((repo) => String(repo.id)).sort())
        )
          fail("participation_history_unfiltered_input_required");
      }
      const inputs = [currentInput, ...(historyInput ? [historyInput] : [])];
      const restored = await withAuthorizedComparisonInputs(
        inputs.map((input) => input.document.identityAuthorization),
        (_removed, guard) =>
          inputs.map((input) => guard.restoreInput(input.document.frozen, input.document.identityAuthorization)),
        tx,
        true,
      );
      // Private pair-conservation dependencies can be absent from the public
      // roster. Only the exact verified projection may explain that omission.
      for (const [index, read] of [current, ...(history ? [history] : [])].entries()) {
        const input = inputs[index];
        const projected = input.document.identityAuthorization.identityEvidence.normalizationSources?.some(
          (entry) => entry.relationshipPairFactHashes !== undefined,
        );
        const actors = projected
          ? await participationPublicActors(tx, input, read, restored[index])
          : actorContracts(restored[index].actors);
        if (canonical(actors) !== canonical(read.selected.actors)) fail("participation_history_actor_binding_changed");
      }
      if (!(await approved(tx)) || signal.aborted || participationAuthority.epoch(request) !== epoch) return null;
      const repositoryIds = config.repositories.map((repo) => repo.id);
      const transfer = await readSourceAuthority(tx, {
        repositories: config.repositories,
        repositoryIds,
        dataMode,
        historyBudget: true,
      });
      if (!transfer.selectedPublic || signal.aborted) return null;
      const feedback = await feedbackStore.capture(tx, repositoryIds);
      const feedbackEpoch = feedbackAuthority.capture();
      // This final statement is the SQL authorization point. Source/transfer
      // locks span both immutable reads and every awaited configuration check.
      const rows = (
        await tx.query(
          `WITH access AS MATERIALIZED (
          SELECT repository_id,installation_id,state,generation FROM leaderboard_ingestion.repository_access
          WHERE repository_id=ANY($1::bigint[]) ORDER BY repository_id FOR SHARE
        ), removed AS (${sourceSuppressionQuery}), correction_rows AS MATERIALIZED (${correctionStateQuery})
        SELECT 'access' AS kind,repository_id::text,installation_id::text,state,generation::text,NULL::text AS subject_id,
          NULL::text AS request_id,NULL::text AS fact_id,NULL::text AS artifact_id,NULL::bigint AS correction_repository_id,NULL::jsonb AS document,NULL::jsonb AS receipt FROM access
        UNION ALL SELECT 'removed',NULL,NULL,NULL,NULL,subject_id,NULL,NULL,NULL,NULL,NULL,NULL FROM removed
        UNION ALL SELECT 'denial',NULL,NULL,NULL,NULL,receipt.operation_key,NULL,NULL,NULL,NULL,NULL,NULL
          FROM unnest($2::text[]) AS requested(operation_key) JOIN leaderboard_pipeline.receipts AS receipt
          ON receipt.operation_hash=pg_catalog.sha256(pg_catalog.convert_to(requested.operation_key,'UTF8')) AND receipt.operation_key=requested.operation_key
          WHERE receipt.kind='project_scope_denial'
        UNION ALL SELECT 'denial',NULL,NULL,NULL,NULL,receipt.operation_key,NULL,NULL,NULL,NULL,NULL,NULL
          FROM unnest($3::text[]) AS requested(operation_key) JOIN leaderboard_pipeline.receipts AS receipt
          ON receipt.operation_hash=pg_catalog.sha256(pg_catalog.convert_to(requested.operation_key,'UTF8')) AND receipt.operation_key=requested.operation_key
          WHERE receipt.kind='issue_field_scope_denial'
        UNION ALL SELECT 'correction',NULL,NULL,NULL,NULL,NULL,request_id,fact_id,artifact_id,repository_id,document,receipt FROM correction_rows
        ORDER BY kind,request_id`,
          [
            transfer.repositoryIds,
            config.repositories.map(projectDenialKey),
            config.repositories.map(issueFieldDenialKey),
          ],
        )
      ).rows;
      const access = rows.filter((row) => row.kind === "access");
      if (
        rows.some((row) => row.kind === "denial") ||
        config.repositories.some(
          (repo) =>
            !access.some(
              (row) =>
                row.repository_id === String(repo.id) &&
                row.installation_id === String(repo.installationId) &&
                row.state === "public",
            ),
        ) ||
        inputs.some((input) =>
          input.document.identityAuthorization.sources.some(
            (source) =>
              !access.some((row) => row.repository_id === source.repositoryId && row.generation === source.generation),
          ),
        )
      )
        return null;
      const correctionRows = rows
        .filter((row) => row.kind === "correction")
        .map(({ request_id, fact_id, artifact_id, correction_repository_id, document, receipt }) => ({
          request_id,
          fact_id,
          artifact_id,
          repository_id: correction_repository_id,
          document,
          receipt,
        }));
      const corrections = correctionStateFromRows(correctionRows);
      for (const input of inputs) {
        const authorization = input.document.identityAuthorization;
        const ids = new Set(authorization.sources.map((source) => source.repositoryId));
        assertReversionCapture(
          authorization,
          correctionStateFromRows(correctionRows.filter((row) => ids.has(String(row.repository_id)))),
          utc(now()),
        );
      }
      const removed = issueTransferRemovals(
        {
          ...transfer,
          removed: [...transfer.removed, ...rows.filter((row) => row.kind === "removed").map((row) => row.subject_id)],
        },
        corrections,
      );
      const portfolioFacts = history
        ? historyInput.document.policies.flatMap(({ policy }) =>
            c.metrics.selectPortfolioFacts(restored[1], policy, historyInput.document.engineScope),
          )
        : [];
      finalRead = () => {
        if (signal.aborted || participationAuthority.epoch(request) !== epoch) return null;
        const controls = controlsStore.read();
        if (canonical(controls) !== privateState) return null;
        const overlay = restrictConfiguration(controls);
        assertPipelineSourcesNotRetired(controlsStore, transfer.repositoryIds.map(Number));
        feedbackAuthority.assert(feedbackEpoch);
        for (const input of inputs) {
          const authorization = input.document.identityAuthorization;
          const ids =
            authorization.issueTransferEvidence?.selectedRepositoryIds ??
            authorization.sources.map((source) => source.repositoryId);
          if (
            canonical(feedback.filter((entry) => ids.includes(String(entry.repositoryId)))) !==
            canonical(authorization.discussionFeedbackEvidence ?? [])
          )
            return null;
        }
        const authorityAt = utc(now());
        const reads = [current, ...(history ? [history] : [])];
        const explanationSeals = [];
        const fingerprint = recognitionBindings.length ? recognitionFingerprint(controls, recognitionBindings) : null;
        for (const read of reads) {
          const head = controls.pipelineHeads?.[scopeKey(read.selected.scope)];
          if (!confirmationMatches(head, read.selected.scope, read.head.snapshotId, read.head.revision)) return null;
          for (const [id, revision] of new Map([
            [read.selected.snapshot.snapshotId, read.selected.snapshot.revision],
            [read.head.snapshotId, read.head.revision],
          ])) {
            const confirmation = controls.pipelinePublications?.[id];
            if (
              !confirmationMatches(confirmation, read.selected.scope, id, revision) ||
              (recognitionBindings.length && confirmation.recognitionFingerprint !== fingerprint)
            )
              return null;
            const seal = {
              ...explanationBinding(read.selected.scope, { revision }),
              digest: confirmation.aggregateExplanationHash,
            };
            aggregateExplanations.verify(id, seal);
            explanationSeals.push([id, seal]);
          }
        }
        const sharedControls = {
          version: currentControlsVersion(controls, overlay, access, removed, corrections, authorityAt),
          suppressedActorIds: Object.entries(controls.profiles)
            .filter(([, profile]) => profile.suppressed)
            .map(([id]) => id)
            .sort(),
          suppressedArtifactIds: [...removed].sort(),
          revokedSnapshotIds: [],
          suppressedContributionIds: [
            ...new Set(
              reads.flatMap(
                (read) =>
                  reversionProjection(corrections.decisions, read.selected.reversionAuthority, authorityAt)
                    .suppressedContributionIds,
              ),
            ),
          ].sort(),
        };
        const selectedRead = { ...current, controls: copy(sharedControls) };
        const result = history
          ? assembleParticipationHistory({
              current: selectedRead,
              selectedInput: selected,
              history: { ...history, controls: copy(sharedControls) },
              retained: restored[1],
              portfolioFacts,
              explanation: historyInput.explanation,
              admission,
              contracts: c.contracts,
              digest,
            })
          : { current: selectedRead, selectedInput: selected, history: null };
        // Host epoch callbacks can observe/revoke private authority. Check the
        // separate stores after those synchronous calls, without another await.
        if (participationAuthority.epoch(request) !== epoch) return null;
        feedbackAuthority.assert(feedbackEpoch);
        if (signal.aborted || canonical(controlsStore.read()) !== privateState) return null;
        assertPipelineSourcesNotRetired(controlsStore, transfer.repositoryIds.map(Number));
        for (const [id, seal] of explanationSeals) aggregateExplanations.verify(id, seal);
        return signal.aborted ? null : result;
      };
      return finalRead();
    });
    // COMMIT can yield after the callback. Never return its stale private copy.
    return paired ? finalRead() : null;
  }
  const source = {
    ...(participationAuthority ? { readParticipationHistory } : {}),
    async readWindows(scope, signal) {
      const requested = c.contracts.canonicalPublicScope(scope);
      if (
        requested.start !== null ||
        requested.end !== null ||
        signal.aborted ||
        typeof options.configurationAuthorityEpoch !== "function"
      )
        return null;
      // One bounded index lookup supplies only explicitly confirmed choices.
      // Reuse the first transaction for every unique scope, then re-admit its
      // complete SQL authority after the final awaited host verification.
      const repositoryIds = repositoriesFor(requested).map((repo) => repo.id);
      const accessIdentity = (rows) =>
        rows
          .map((row) => [String(row.repository_id), String(row.installation_id), row.state, String(row.generation)])
          .sort((left, right) => left[0].localeCompare(right[0]));
      let capturedAuthority;
      let finalRead = () => null;
      const result = await db.transaction(async (tx) => {
        if (!(await approved(tx)) || signal.aborted) return null;
        const initialControls = controlsStore.read();
        restrictConfiguration(initialControls);
        const initial = windowIndex().read(initialControls, requested);
        if (!initial) return null;
        const reads = new Map();
        for (const entry of initial.windows) {
          const key = scopeKey(entry.scope);
          if (reads.has(key)) continue;
          const read = await source.read(entry.scope, null, signal, tx);
          if (!read || signal.aborted) return null;
          reads.set(key, read);
        }
        // Even a legitimate empty menu still requires current repository and
        // installation authority; no history scan or GET-side repair occurs.
        const transferAuthority = await readSourceAuthority(tx, {
          repositories: config.repositories,
          repositoryIds,
          dataMode,
        });
        const access = transferAuthority.access;
        if (signal.aborted || !transferAuthority.selectedPublic) return null;
        const corrections = await readCorrectionState(tx, transferAuthority.repositoryIds);
        const removed = issueTransferRemovals(transferAuthority, corrections);
        capturedAuthority = {
          issueTransfers: transferAuthority.fingerprint,
          access: accessIdentity(access),
          removed: [...removed].sort(),
          corrections: corrections.fingerprint,
          discussionFeedback: await feedbackStore.capture(tx, repositoryIds),
        };
        if (!(await approved(tx)) || signal.aborted) return null;
        finalRead = () => {
          // No awaits below: the complete index, current privacy authority,
          // confirmations, recognition and explanations fence all captured reads.
          const controls = controlsStore.read();
          const overlay = restrictConfiguration(controls);
          const current = windowIndex().read(controls, requested);
          if (!current || canonical(current) !== canonical(initial)) return null;
          const authorityAt = utc(now());
          const version = currentControlsVersion(controls, overlay, access, removed, corrections, authorityAt);
          const suppressedActors = Object.entries(controls.profiles)
            .filter(([, profile]) => profile.suppressed)
            .map(([id]) => id)
            .sort();
          const fingerprint = recognitionBindings.length ? recognitionFingerprint(controls, recognitionBindings) : null;
          for (const entry of current.windows) {
            const read = reads.get(scopeKey(entry.scope));
            const selected = read?.selected.snapshot;
            const head = controls.pipelineHeads?.[scopeKey(entry.scope)];
            if (
              !read ||
              scopeKey(read.selected.scope) !== scopeKey(entry.scope) ||
              selected.snapshotId !== entry.confirmation.snapshotId ||
              selected.revision !== entry.confirmation.revision ||
              read.head.snapshotId !== entry.confirmation.snapshotId ||
              read.head.revision !== entry.confirmation.revision ||
              read.controls.version !== version ||
              canonical([...read.controls.suppressedActorIds].sort()) !== canonical(suppressedActors) ||
              canonical([...read.controls.suppressedArtifactIds].sort()) !== canonical([...removed].sort()) ||
              canonical([...(read.controls.suppressedContributionIds ?? [])].sort()) !==
                canonical(
                  reversionProjection(corrections.decisions, read.selected.reversionAuthority, authorityAt)
                    .suppressedContributionIds,
                ) ||
              canonical(read.controls.revokedSnapshotIds) !== canonical([]) ||
              !confirmationMatches(head, entry.scope, read.head.snapshotId, read.head.revision) ||
              !confirmationMatches(
                controls.pipelinePublications?.[selected.snapshotId],
                entry.scope,
                selected.snapshotId,
                selected.revision,
              ) ||
              (recognitionBindings.length &&
                [read.head.snapshotId, selected.snapshotId].some(
                  (id) => controls.pipelinePublications?.[id]?.recognitionFingerprint !== fingerprint,
                ))
            )
              return null;
          }
          for (const read of reads.values()) {
            // Each chosen publication is its current confirmed head. Aliases use
            // this same captured read and need only one final explanation check.
            aggregateExplanations.verify(read.selected.snapshot.snapshotId, {
              ...explanationBinding(read.selected.scope, read.selected.snapshot),
              digest: controls.pipelinePublications[read.selected.snapshot.snapshotId].aggregateExplanationHash,
            });
          }
          return {
            scope: requested,
            windows: current.windows.map((entry) => ({ period: entry.period, read: reads.get(scopeKey(entry.scope)) })),
          };
        };
        return finalRead();
      });
      // The first COMMIT and the host verifier can both yield to SQL writers.
      // Do not hold source locks while awaiting that external callback.
      if (!result || signal.aborted || !(await verifyConfig(copy(config))) || signal.aborted) return null;
      const epoch = discoveryEpoch();
      if (epoch === null) return null;
      const admitted = await db.transaction(async (tx) => {
        if (signal.aborted || discoveryEpoch() !== epoch) return null;
        const transferAuthority = await readSourceAuthority(tx, {
          repositories: config.repositories,
          repositoryIds,
          dataMode,
        });
        if (!transferAuthority.selectedPublic || signal.aborted) return null;
        // One statement snapshot is the final SQL authorization point. It checks
        // full tuples and expanded removal sets even for an empty menu, together
        // with persisted source denials that need not change SQLite revisions.
        const rows = (
          await tx.query(
            `WITH access AS MATERIALIZED (
            SELECT repository_id,installation_id,state,generation
            FROM leaderboard_ingestion.repository_access
            WHERE repository_id=ANY($1::bigint[]) ORDER BY repository_id FOR SHARE
          ), removed AS (
            ${sourceSuppressionQuery}
          ), correction_rows AS MATERIALIZED (
            ${correctionStateQuery}
          )
          SELECT 'access' AS kind,repository_id::text,installation_id::text,state,generation::text,NULL::text AS subject_id,
            NULL::text AS request_id,NULL::text AS fact_id,NULL::text AS artifact_id,
            NULL::bigint AS correction_repository_id,NULL::jsonb AS document,NULL::jsonb AS receipt FROM access
          UNION ALL SELECT 'removed',NULL,NULL,NULL,NULL,subject_id,NULL,NULL,NULL,NULL,NULL,NULL FROM removed
          UNION ALL SELECT 'denial',NULL,NULL,NULL,NULL,receipt.operation_key,NULL,NULL,NULL,NULL,NULL,NULL
            FROM unnest($2::text[]) AS requested(operation_key)
            JOIN leaderboard_pipeline.receipts AS receipt
              ON receipt.operation_hash=pg_catalog.sha256(pg_catalog.convert_to(requested.operation_key,'UTF8'))
              AND receipt.operation_key=requested.operation_key
            WHERE receipt.kind='project_scope_denial'
          UNION ALL SELECT 'denial',NULL,NULL,NULL,NULL,receipt.operation_key,NULL,NULL,NULL,NULL,NULL,NULL
            FROM unnest($3::text[]) AS requested(operation_key)
            JOIN leaderboard_pipeline.receipts AS receipt
              ON receipt.operation_hash=pg_catalog.sha256(pg_catalog.convert_to(requested.operation_key,'UTF8'))
              AND receipt.operation_key=requested.operation_key
            WHERE receipt.kind='issue_field_scope_denial'
          UNION ALL SELECT 'correction',NULL,NULL,NULL,NULL,NULL,
            request_id,fact_id,artifact_id,repository_id,document,receipt FROM correction_rows
          ORDER BY kind,request_id`,
            [
              transferAuthority.repositoryIds,
              config.repositories.map(projectDenialKey),
              config.repositories.map(issueFieldDenialKey),
            ],
          )
        ).rows;
        if (signal.aborted || discoveryEpoch() !== epoch || rows.some((row) => row.kind === "denial")) return null;
        // Preserve the same typed row shapes as readCorrectionState. Revalidate
        // every joined seal and the entire chain before selecting legacy removals.
        const currentCorrections = correctionStateFromRows(
          rows
            .filter((row) => row.kind === "correction")
            .map(({ request_id, fact_id, artifact_id, correction_repository_id, document, receipt }) => ({
              request_id,
              fact_id,
              artifact_id,
              repository_id: correction_repository_id,
              document,
              receipt,
            })),
        );
        const currentAuthority = {
          issueTransfers: transferAuthority.fingerprint,
          access: accessIdentity(rows.filter((row) => row.kind === "access")),
          removed: issueTransferRemovals(
            {
              ...transferAuthority,
              removed: [
                ...transferAuthority.removed,
                ...rows.filter((row) => row.kind === "removed").map((row) => row.subject_id),
              ],
            },
            currentCorrections,
          ),
          corrections: currentCorrections.fingerprint,
          discussionFeedback: await feedbackStore.capture(tx, repositoryIds),
        };
        if (canonical(currentAuthority) !== canonical(capturedAuthority)) return null;
        const current = finalRead();
        return discoveryEpoch() === epoch ? current : null;
      });
      // SQL authorization linearizes at the statement above, not at HTTP send.
      // COMMIT may yield, so retain the final synchronous private-state fence.
      if (!admitted || signal.aborted || discoveryEpoch() !== epoch) return null;
      const current = finalRead();
      return discoveryEpoch() === epoch ? current : null;
    },
    async readComparison(scope, pin, previous, signal) {
      if (c.contracts.publicScopeFilterKey(scope) !== c.contracts.publicScopeFilterKey(previous.scope)) return null;
      // Both reads reuse this transaction. Source locks remain held through the
      // final authority query, including expanded retained-source revocations.
      let finalRead = () => null;
      const result = await db.transaction(async (tx) => {
        const current = await source.read(scope, pin, signal, tx);
        if (!current) return null;
        const prior = await source.read(previous.scope, previous.snapshotId, signal, tx);
        const repositoryIds = repositoriesFor(scope).map((repo) => repo.id);
        const transferAuthority = await readSourceAuthority(tx, {
          repositories: config.repositories,
          repositoryIds,
          dataMode,
        });
        const access = transferAuthority.access;
        if (signal.aborted || !transferAuthority.selectedPublic) return null;
        const corrections = await readCorrectionState(tx, transferAuthority.repositoryIds);
        const removed = issueTransferRemovals(transferAuthority, corrections);
        if (!(await approved(tx)) || signal.aborted) return null;
        finalRead = () => {
          if (signal.aborted) return null;
          const authorityAt = utc(now());
          // No awaits below: configuration, recognition, confirmed heads and exact
          // current privacy/source signatures fence both captured projections.
          const controls = controlsStore.read(),
            overlay = restrictConfiguration(controls);
          const version = currentControlsVersion(controls, overlay, access, removed, corrections, authorityAt);
          const suppressedActors = Object.entries(controls.profiles)
            .filter(([, profile]) => profile.suppressed)
            .map(([id]) => id)
            .sort();
          for (const read of [current, prior].filter(Boolean)) {
            const selectedScope = read.selected.scope,
              head = controls.pipelineHeads?.[scopeKey(selectedScope)];
            if (
              read.controls.version !== version ||
              canonical([...read.controls.suppressedActorIds].sort()) !== canonical(suppressedActors) ||
              canonical([...read.controls.suppressedArtifactIds].sort()) !== canonical([...removed].sort()) ||
              canonical([...(read.controls.suppressedContributionIds ?? [])].sort()) !==
                canonical(
                  reversionProjection(corrections.decisions, read.selected.reversionAuthority, authorityAt)
                    .suppressedContributionIds,
                ) ||
              !confirmationMatches(head, selectedScope, read.head.snapshotId, read.head.revision) ||
              !confirmationMatches(
                controls.pipelinePublications?.[read.selected.snapshot.snapshotId],
                selectedScope,
                read.selected.snapshot.snapshotId,
                read.selected.snapshot.revision,
              ) ||
              (recognitionBindings.length &&
                [read.head.snapshotId, read.selected.snapshot.snapshotId].some(
                  (id) =>
                    controls.pipelinePublications?.[id]?.recognitionFingerprint !==
                    recognitionFingerprint(controls, recognitionBindings),
                ))
            )
              return null;
          }
          const history = (read) =>
            read === null
              ? null
              : retainedRankHistory(
                  aggregateExplanations.verify(read.selected.snapshot.snapshotId, {
                    ...explanationBinding(read.selected.scope, read.selected.snapshot),
                    digest: controls.pipelinePublications[read.selected.snapshot.snapshotId].aggregateExplanationHash,
                  }).document,
                );
          // A valid old pin can require stricter restoration proof than the new
          // current snapshot. Preserve current values and withhold only that baseline;
          // malformed or stale global authority already failed above.
          if (
            prior &&
            canonical(current.controls.suppressedContributionIds ?? []) !==
              canonical(prior.controls.suppressedContributionIds ?? [])
          )
            return { current, previous: null, currentHistory: history(current), previousHistory: null };
          return { current, previous: prior, currentHistory: history(current), previousHistory: history(prior) };
        };
        return finalRead();
      });
      // Nested reads cannot fence this owner's awaited COMMIT. Recheck both
      // captured projections under the same current private authority.
      return result ? finalRead() : null;
    },
    async readProfile(scope, pin, actorId, signal) {
      // Select one visible actor; the route supplies no identity or consent authority.
      return source.read(scope, pin, signal, undefined, false, false, actorId);
    },
    async readHealth(scope, pin, signal) {
      return source.read(scope, pin, signal, undefined, true);
    },
    async read(scope, pin, signal, transaction, health = false, historyBudget = false, profileActorId = null) {
      if (signal.aborted || !(await approved(transaction ?? db)) || !configuredScope(scope)) return null;
      // The SQL head allocates revisions, not visibility. Only this private
      // authority advances after confirmation. Bound retries if another runtime
      // confirms a newer head while this reader is awaiting SQL/approval.
      const retry = Symbol("confirmed_head_changed");
      for (let attempt = 0; attempt < 3; attempt++) {
        const head = controlsStore.read().pipelineHeads?.[scopeKey(scope)];
        if (
          !confirmationMatches(head, scope, head?.snapshotId, head?.revision) ||
          !Number.isSafeInteger(head.revision) ||
          head.revision < 1
        )
          return null;
        const run = transaction ? (work) => work(transaction) : (work) => db.transaction(work);
        let finalRead = () => null;
        const result = await run(async (tx) => {
          await lockIssueTransferSources(tx, config.repositories);
          const result = await tx.query(
            `SELECT ${historyBudget ? "CASE WHEN octet_length(selected.document::text)<=8000000 THEN selected.document END AS document" : "selected.document"},selected.document_hash,selected.config_version,selected.repository_ids,selected.revision AS selected_revision,selected.snapshot_id AS selected_id,latest.revision,
      latest.snapshot_id AS head_id,${historyBudget ? "CASE WHEN octet_length(latest.document::text)<=8000000 THEN latest.document END" : "latest.document"} AS head_document,latest.document_hash AS head_document_hash,
      latest.config_version AS head_config_version,latest.repository_ids AS head_repository_ids,
      ${historyBudget ? "CASE WHEN octet_length(latest.document::text)<=8000000 THEN latest.document->'snapshot'->>'generatedAt' END" : "latest.document->'snapshot'->>'generatedAt'"} AS published_at
      FROM leaderboard_pipeline.snapshots AS latest
      JOIN leaderboard_pipeline.snapshots AS selected ON selected.snapshot_id=COALESCE($2,latest.snapshot_id)
      WHERE latest.scope_key=$1 AND selected.scope_key=latest.scope_key AND latest.snapshot_id=$3`,
            [scopeKey(scope), pin, head.snapshotId],
          );
          if (signal.aborted || !result.rows[0]) return null;
          const selected = result.rows[0];
          // Bound both parsed snapshots before hashing/copying on every history
          // retry. Ordinary board, health and comparison reads keep their query.
          if (historyBudget) {
            if (selected.document === null || selected.head_document === null)
              fail("participation_history_snapshot_budget_exceeded");
            selected.document = copyParticipationHistoryJSON(selected.document);
            selected.head_document = copyParticipationHistoryJSON(selected.head_document);
          }
          if (
            digest(selected.document) !== selected.document_hash ||
            selected.document.snapshot.snapshotId !== selected.selected_id ||
            selected.document.snapshot.revision !== Number(selected.selected_revision) ||
            digest(selected.head_document) !== selected.head_document_hash ||
            selected.head_document.snapshot.snapshotId !== head.snapshotId ||
            selected.head_document.snapshot.revision !== head.revision ||
            Number(selected.revision) !== head.revision ||
            scopeKey(selected.document.scope) !== scopeKey(scope) ||
            scopeKey(selected.head_document.scope) !== scopeKey(scope)
          )
            fail("public_snapshot_integrity_error");
          if (
            selected.config_version !== config.version ||
            selected.document.dataMode !== dataMode ||
            selected.head_config_version !== config.version ||
            selected.head_document.dataMode !== dataMode
          )
            return null;
          const transferAuthority = await readSourceAuthority(tx, {
            repositories: config.repositories,
            repositoryIds: repositoriesFor(scope).map((repo) => repo.id),
            dataMode,
            historyBudget,
          });
          const access = transferAuthority.access;
          if (signal.aborted || !transferAuthority.selectedPublic) return null;
          // A durable publication predating a source semantics fix cannot regain
          // authority from its old confirmation. Bind both selected and head views
          // to their retained source rows under the existing source read locks.
          for (const [id, revision] of new Map([
            [selected.selected_id, Number(selected.selected_revision)],
            [selected.head_id, Number(selected.revision)],
          ])) {
            const confirmation = controlsStore.read().pipelinePublications?.[id];
            if (!confirmationMatches(confirmation, scope, id, revision)) return null;
            const explanation = aggregateExplanations.verify(id, {
              ...explanationBinding(scope, { revision }),
              digest: confirmation.aggregateExplanationHash,
            }).document;
            // The selected scope and complete private dependencies have separate
            // exact bindings. A newer head may legitimately have more aliases;
            // neither SQL row can borrow the other's source list.
            const boundIds = id === selected.selected_id ? selected.repository_ids : selected.head_repository_ids;
            const expectedIds =
              explanation.authorization.issueTransferEvidence === undefined
                ? repositoriesFor(scope).map((repo) => repo.id)
                : explanation.authorization.sources.map((source) => Number(source.repositoryId));
            if (canonical(boundIds) !== canonical(expectedIds)) fail("public_snapshot_integrity_error");
            if (
              (
                await publicationNormalizationBinding(
                  tx,
                  scope,
                  { snapshotId: id, revision },
                  explanation,
                  historyBudget ? { maxFrozenBytes: 8_000_000, historyBudget: true } : undefined,
                )
              ).obsolete
            )
              return null;
          }
          const corrections = await readCorrectionState(tx, transferAuthority.repositoryIds);
          const removed = issueTransferRemovals(transferAuthority, corrections);
          const healthRepositories = health
            ? repositoriesFor(scope).filter((repo) =>
                selected.document.snapshot.coverage.some(
                  (coverage) => coverage.scopeId === String(repo.id) && coverage.source.startsWith("github_"),
                ),
              )
            : [];
          const healthAt = health ? utc(now()) : null;
          const healthReconciliation =
            health && reconciliationPolicy && healthRepositories.length
              ? await reconciliationState(tx, healthRepositories, healthAt)
              : null;
          const currentSourceHealth = health
            ? await readCurrentSourceHealth(tx, healthRepositories, healthAt, healthReconciliation?.progress)
            : undefined;
          let physicalInputsCurrent = true;
          let physicalExplanationHash = null;
          if (selected.document.physicalContexts?.some((entry) => entry.state === "available")) {
            const confirmation = controlsStore.read().pipelinePublications?.[selected.selected_id];
            if (!confirmationMatches(confirmation, scope, selected.selected_id, Number(selected.selected_revision)))
              return null;
            const saved = aggregateExplanations.verify(selected.selected_id, {
              ...explanationBinding(scope, { revision: Number(selected.selected_revision) }),
              digest: confirmation.aggregateExplanationHash,
            });
            physicalExplanationHash = saved.digest;
            try {
              // The optional context needs the original selected normalization
              // copies, not a new hash over a replacement or a later cache entry.
              requireThat(
                Array.isArray(saved.document.authorization.identityEvidence?.normalizationSources),
                409,
                "Frozen physical source binding unavailable",
              );
              await withAuthorizedComparisonInputs([saved.document.authorization], () => true, tx, historyBudget);
            } catch (error) {
              // A missing/conflicting retained dependency removes the whole
              // optional context. Unexpected database/authority failures retain
              // their existing error path; metric quantities never change here.
              if (!(error instanceof ControlError) || error.status !== 409) throw error;
              physicalInputsCurrent = false;
            }
          }
          if (!(await approved(tx)) || signal.aborted || healthReconciliation?.confirmCurrent() === false) return null;
          finalRead = () => {
            if (signal.aborted || healthReconciliation?.confirmCurrent() === false) return null;
            const authorityAt = utc(now());
            // Read current private controls after all awaited I/O, even for pinned historical snapshots.
            const controls = controlsStore.read();
            const overlay = restrictConfiguration(controls);
            if (canonical(controls.pipelineHeads?.[scopeKey(scope)]) !== canonical(head)) return retry;
            if (
              physicalExplanationHash !== null &&
              controls.pipelinePublications?.[selected.selected_id]?.aggregateExplanationHash !==
                physicalExplanationHash
            )
              return retry;
            if (
              !confirmationMatches(
                controls.pipelinePublications?.[selected.selected_id],
                scope,
                selected.selected_id,
                Number(selected.selected_revision),
              ) ||
              !confirmationMatches(
                controls.pipelinePublications?.[selected.head_id],
                scope,
                selected.head_id,
                Number(selected.revision),
              )
            )
              return null;
            if (
              recognitionBindings.length &&
              [selected.selected_id, selected.head_id].some(
                (id) =>
                  controls.pipelinePublications?.[id]?.recognitionFingerprint !==
                  recognitionFingerprint(controls, recognitionBindings),
              )
            )
              return null;
            // Required explanations are private dependencies of both selected and
            // current confirmed snapshots; corruption never acquires visibility.
            for (const id of new Set([selected.selected_id, selected.head_id])) {
              aggregateExplanations.verify(id, {
                ...explanationBinding(scope, {
                  revision:
                    id === selected.selected_id ? Number(selected.selected_revision) : Number(selected.revision),
                }),
                digest: controls.pipelinePublications[id].aggregateExplanationHash,
              });
            }
            const document = copy(selected.document);
            if (!physicalInputsCurrent) {
              document.physicalContexts = document.physicalContexts.map((entry) => ({
                schemaVersion: entry.schemaVersion,
                actorId: entry.actorId,
                metricId: entry.metricId,
                policyVersion: entry.policyVersion,
                policySignature: entry.policySignature,
                state: "unknown",
                reason: "current_context_unavailable",
              }));
              document.physicalEvidence = [];
            }
            const reversion = reversionProjection(corrections.decisions, document.reversionAuthority, authorityAt);
            addReversionNotices(document, reversion.notices, c.contracts.publicEvidenceMetadataSchema);
            document.disabledMetrics = overlay.disabledMetrics.map((entry) => ({
              ...entry,
              reason: /^[a-z0-9_:-]{1,100}$/.test(entry.reason)
                ? entry.reason
                : "metric_disabled_by_approved_configuration",
            }));
            const disabled = new Set(overlay.disabledMetricIds);
            document.rows = document.rows.filter((row) => !disabled.has(row.result.metricId));
            document.ranking = document.ranking.filter((row) => !disabled.has(row.metricId));
            if (document.diagnostics)
              document.diagnostics = document.diagnostics.filter((row) => !disabled.has(row.metricId));
            const evidenceIds = new Set(document.rows.flatMap((row) => row.evidenceIds));
            document.evidence = document.evidence.filter((entry) => evidenceIds.has(entry.contribution.contributionId));
            let presentation = null;
            if (profileActorId !== null) {
              const visible = document.actors.find(
                (entry) => entry.actorId === profileActorId && entry.state === "public",
              );
              const profile = Object.hasOwn(controls.profiles, profileActorId)
                ? controls.profiles[profileActorId]
                : null;
              if (visible && profile?.public === true && !profile.suppressed) {
                const parsed = publicProfilePresentationSchema.safeParse({
                  schemaVersion: publicProfilePresentationVersion,
                  actorId: profileActorId,
                  bio: profile.bio,
                  highlights: profile.highlights,
                });
                if (parsed.success && publicProfilePresentationMatches(parsed.data, visible.actorId, visible.actor))
                  presentation = parsed.data;
                // Unsafe legacy values are omitted from this optional presentation.
                // Reads never rewrite controls or publish only its safe fragments.
              }
            }
            return {
              ...(profileActorId === null ? {} : { presentation }),
              ...(currentSourceHealth === undefined ? {} : { currentSourceHealth }),
              head: {
                snapshotId: selected.head_id,
                revision: Number(selected.revision),
                publishedAt: selected.published_at,
              },
              selected: document,
              controls: {
                version: currentControlsVersion(controls, overlay, access, removed, corrections, authorityAt),
                ...(corrections.decisions.length
                  ? { suppressedContributionIds: reversion.suppressedContributionIds }
                  : {}),
                suppressedActorIds: Object.entries(controls.profiles)
                  .filter(([, profile]) => profile.suppressed)
                  .map(([id]) => id),
                suppressedArtifactIds: removed,
                revokedSnapshotIds: [],
              },
            };
          };
          return finalRead();
        });
        // COMMIT may yield after the callback. A borrowed transaction is also
        // fenced by its owning public read; keep this attempt's retry bound.
        if (result === null) return null;
        const current = result === retry ? retry : finalRead();
        if (current !== retry) return current;
      }
      return null;
    },
  };
  const app = c.service.createService({
    source,
    registry: c.metrics.metricRegistryV1,
    cursorSecret: options.cursorSecret,
    approvedWorkstreamHelpRuleVersion: config.approvedWorkstreamHelpRuleVersion,
    now: () => Date.parse(now()),
  });
  async function runOnceInternal(options) {
    contentEditAdmission.clear();
    try {
      return await runOnceSelected(options);
    } finally {
      contentEditAdmission.clear();
    }
  }
  async function runOnceSelected({ cutoff, mode = "reconcile", maxPages = 100, dispatch = null } = {}) {
    const implicitCutoff = cutoff === undefined;
    cutoff = utc(implicitCutoff ? now() : cutoff);
    if (stopped) fail("pipeline_stopped");
    if (!(await approved())) return { state: "blocked", reason: "approved_configuration_required" };
    const runState = controlsStore.read();
    runConfigurationRevision = restrictConfiguration(runState).revision;
    runRecognitionFingerprint = recognitionFingerprint(runState, recognitionBindings);
    runFeedbackAuthority = feedbackAuthority.capture();
    if (dispatch && runConfigurationRevision !== dispatch.lease.operation.configurationRevision)
      fail("dispatch_configuration_changed");
    if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 10000) fail("invalid_pipeline_page_budget");
    if (!["backfill", "reconcile", "audit"].includes(mode)) fail("invalid_scan_scope");
    if (feedbackAuthority.enabled) await feedbackStore.assertStorage();
    let scan = null;
    if (implicitCutoff && !dispatch) {
      // Verify all configured sources before choosing a durable scan context.
      // Per-repository probes below still run immediately before collection.
      for (const repo of config.repositories) await verifyRepository(repo);
      const sources = (
        await db.query(
          `SELECT repository_id,generation FROM leaderboard_ingestion.repository_access
         WHERE repository_id=ANY($1::bigint[]) AND state='public' ORDER BY repository_id`,
          [config.repositories.map((repo) => repo.id)],
        )
      ).rows.map((row) => ({ repositoryId: Number(row.repository_id), generation: String(row.generation) }));
      if (sources.length !== config.repositories.length) fail("pipeline_scan_source_changed");
      scan = await scanContinuations.claim(
        {
          ...scanContext(mode, sources, runConfigurationRevision, runRecognitionFingerprint),
          cutoff,
          sources,
        },
        assertRunConfiguration,
        implicitPublicationCutoff,
        (savedCutoff) =>
          resolveDiscoverablePublicationWindows(config.scopes, savedCutoff, c.metrics.resolveMetricWindow).map(
            ({ scope }) => scopeKey(scope),
          ),
        reconciliationPolicy && mode === "reconcile"
          ? (tx, selected, { fresh }) =>
              prepareReconciliationPlan(tx, {
                scan: selected,
                repositories: config.repositories,
                policy: reconciliationPolicy,
                fresh,
                startInTransaction: (session, request) => collection.startInTransaction(session, request),
                readProgress: readReconciliationProgress,
              })
          : null,
      );
      cutoff = scan.cutoff;
      if (defaultContentEditInventory && scan.plan) contentEditAdmission.setPlanned(scan, scan.plan, true);
    }
    const publicationWindows = resolveDiscoverablePublicationWindows(
      config.scopes,
      cutoff,
      c.metrics.resolveMetricWindow,
    );
    const progress = [];
    for (const repo of config.repositories) {
      await verifyRepository(repo, cutoff);
      const requests = scan?.plan
        ? scan.plan.filter((request) => request.repositoryId === repo.id)
        : repo.families.map((family) => ({
            runId: digest([
              config.version,
              repo.id,
              family,
              cutoff,
              mode,
              dataMode,
              ...(family === "pull_requests" && decisionRepositoryIds.includes(repo.id)
                ? [pullRequestDecisionGenerationVersion, decisionSourceId]
                : []),
              ...(family === "discussions" && feedbackAuthority.repositoryIds.includes(repo.id)
                ? [discussionFeedbackContentVersion, feedbackAuthority.current(repo.id).authorityHash]
                : []),
              ...(scan ? [scan.token] : []),
              ...(dispatch ? [dispatch.lease.operation.operationKey, dispatch.lease.collectionRevision] : []),
            ]),
            repositoryId: repo.id,
            family,
            mode,
            since: null,
            until: cutoff,
          }));
      for (const request of requests) {
        // Scheduled rows already bind the versioned default inventory context.
        // For explicit/dispatch runs, retain an existing old operation literally;
        // otherwise atomically materialize and pin the expanded inventory ID.
        const selectedRequest =
          !scan?.plan && defaultContentEditInventory && request.family === "content_edits"
            ? await startGithubContentEditRun(db, collection, request, assertRunConfiguration, true)
            : !scan?.plan && defaultCommentsInventory && request.family === "comments"
              ? await startGithubCommentsRun(db, collection, request, assertRunConfiguration)
              : request;
        const { runId, family } = selectedRequest;
        if (!scan?.plan && defaultContentEditInventory && family === "content_edits")
          contentEditAdmission.recordSelected(selectedRequest);
        if (!scan?.plan && selectedRequest === request) await collection.start(request);
        const collectionStarted = performance.now();
        let status = "progress";
        for (let page = 0; page < maxPages && status === "progress"; page++) {
          assertRunConfiguration();
          status = await collection.step(runId, guardedSource);
          assertRunConfiguration();
          if (status === "progress" || status === "complete")
            await db.query(
              `INSERT INTO leaderboard_pipeline.source_modes(fact_key,data_mode) SELECT item.fact_key,$2 FROM leaderboard_ingestion.collection_items AS item JOIN leaderboard_ingestion.source_facts AS fact USING(fact_key) WHERE item.run_id=$1 AND fact.first_run_id=$1 ON CONFLICT DO NOTHING`,
              [runId, dataMode],
            );
        }
        if (status === "complete") monitorSuccess(monitorSource(repo.id), "collection", collectionStarted);
        else if (status === "failed") monitorFailure(monitorSource(repo.id), "collection", "source_unavailable");
        progress.push({ repositoryId: repo.id, family, runId, status });
        if (status !== "complete") return { state: "collecting", progress, publications: [] };
      }
    }
    const decisionRuns = progress
      .filter((entry) => entry.family === "pull_requests" && decisionRepositoryIds.includes(entry.repositoryId))
      .map(({ repositoryId, runId }) => ({ repositoryId, runId }));
    // New release proof is a separate observation from the immutable PR row.
    // Complete only explicitly selected public lookups before freezing the cycle;
    // a frozen retry reuses its exact compatible cache and never recollects it.
    const mergeTargetGeneration = mergeTargetRepositoryIds.length
      ? digest([
          mergeTargetNormalizationVersion,
          cutoff,
          mode,
          scan?.token ?? null,
          progress
            .filter((entry) => entry.family === "pull_requests")
            .map((entry) => entry.runId)
            .sort(),
        ])
      : null;
    if (dataMode === "public" && config.releaseInclusionTargets?.length) {
      const releaseRepositoryIds = config.repositories
        .filter((repo) => config.releaseInclusionTargets.some((target) => target.repositoryId === repo.id))
        .map((repo) => repo.id);
      await normalizeStored(
        releaseRepositoryIds,
        scan?.observationCutoff ?? utc(now()),
        null,
        {
          collect: !scan?.observationCutoff,
        },
        mergeTargetGeneration === null
          ? null
          : { generation: mergeTargetGeneration, collect: !scan?.observationCutoff },
        decisionRuns,
      );
    }
    if (mergeTargetGeneration !== null)
      await normalizeStored(
        mergeTargetRepositoryIds,
        scan?.observationCutoff ?? utc(now()),
        null,
        null,
        { generation: mergeTargetGeneration, collect: !scan?.observationCutoff, only: true },
        decisionRuns,
      );
    const publications = [];
    let observationCutoff = scan?.observationCutoff ?? utc(now());
    const captureDecisionRuns = (selectedCutoff) =>
      db.transaction((tx) =>
        readDecisionGenerations(tx, {
          selectedRuns: decisionRuns,
          repositories: config.repositories,
          source: decisionSourceId,
          asOf: cutoff,
          observationCutoff: selectedCutoff,
          dataMode,
          assertAuthorized: assertRunConfiguration,
        }),
      );
    // A sub-millisecond database O must not be rounded down or committed behind
    // a new frozen F. A too-early host clock fails before creating that freeze.
    let decisionCapture = decisionRuns.length ? (await captureDecisionRuns(observationCutoff)).capture : null;
    try {
      if (scan) {
        scan = await scanContinuations.freeze(scan, observationCutoff, assertRunConfiguration);
        observationCutoff = scan.observationCutoff;
      }
      if (dispatch) {
        const lease = dispatch.lease;
        const keys = (
          await db.query(
            `SELECT item.fact_key FROM leaderboard_ingestion.collection_items AS item
          JOIN leaderboard_ingestion.source_facts AS fact USING(fact_key)
          WHERE item.run_id=ANY($1::text[]) AND fact.repository_id=$2 AND fact.family='issues' AND fact.subject_id=$3 AND fact.document->>'sourceUrl'=$4`,
            [
              progress.map((item) => item.runId),
              lease.observation.repositoryId,
              lease.observation.subjectId,
              lease.observation.sourceUrl,
            ],
          )
        ).rows;
        if (!keys.length) {
          await outbox.refreshCollection(lease);
          fail("dispatch_source_subject_unavailable");
        }
        dispatch.targetKeys = keys.map((row) => row.fact_key);
        const generations = (
          await db.query(
            `SELECT repository_id,generation FROM leaderboard_ingestion.repository_access WHERE repository_id=ANY($1::bigint[]) AND state='public' ORDER BY repository_id`,
            [config.repositories.map((repo) => repo.id)],
          )
        ).rows;
        if (generations.length !== config.repositories.length) fail("dispatch_source_unavailable");
        const frozen = await outbox.freeze(
          lease,
          observationCutoff,
          generations.map((row) => ({ repositoryId: Number(row.repository_id), generation: String(row.generation) })),
        );
        observationCutoff = frozen.cutoff;
        dispatch.generations = frozen.generations;
      }
      if (observationCutoff < cutoff) fail("observation_clock_precedes_event_cutoff");
      if (decisionCapture !== null && decisionCapture.observationCutoff !== observationCutoff)
        decisionCapture = (await captureDecisionRuns(observationCutoff)).capture;
      assertRunConfiguration();
      for (const selected of publicationWindows)
        publications.push(
          await publish(selected, cutoff, observationCutoff, dispatch, scan, mergeTargetGeneration, decisionCapture),
        );
      // SQL publication and synchronous private confirmation must both succeed.
      // A failed/partial batch keeps its original event and observation cutoffs.
      if (scan) await scanContinuations.retire(scan, assertRunConfiguration);
      return { state: "published", progress, publications };
    } catch (error) {
      // An authoritative cycle/head conflict cannot become a permanent retry
      // loop. Remove only this exact implicit token, leaving newer work intact.
      if (scan && error instanceof ScanSupersededError) await scanContinuations.retire(scan, assertRunConfiguration);
      throw error;
    }
  }
  function runOnce(options) {
    return serialize(() => runOnceInternal(options));
  }
  async function verifyDispatchPublications(tx, lease, publications) {
    if (!(await approved(tx))) fail("dispatch_collection_incomplete");
    assertConfigurationCurrent();
    await outbox.assertLease(tx, lease);
    const saved = (
      await tx.query(
        "SELECT operation,observation_cutoff,source_generations FROM leaderboard_ingestion.outbox WHERE event_key=$1",
        [lease.eventKey],
      )
    ).rows[0];
    if (!saved || canonical(saved.operation) !== canonical(lease.operation)) fail("dispatch_configuration_changed");
    const access = (
      await tx.query(
        `SELECT repository_id,installation_id,generation FROM leaderboard_ingestion.repository_access
         WHERE repository_id=ANY($1::bigint[]) AND state='public' ORDER BY repository_id FOR SHARE`,
        [config.repositories.map((repo) => repo.id)],
      )
    ).rows;
    if (
      access.length !== config.repositories.length ||
      !Array.isArray(saved.source_generations) ||
      saved.source_generations.length !== access.length ||
      new Set(saved.source_generations.map((entry) => entry.repositoryId)).size !== access.length ||
      access.some(
        (row) =>
          String(row.installation_id) !==
            String(config.repositories.find((repo) => repo.id === Number(row.repository_id))?.installationId) ||
          !saved.source_generations.some(
            (prior) => prior.repositoryId === Number(row.repository_id) && prior.generation === String(row.generation),
          ),
      )
    )
      fail("dispatch_source_generation_changed");
    const windows = resolveDiscoverablePublicationWindows(
      config.scopes,
      lease.operation.cutoff,
      c.metrics.resolveMetricWindow,
    );
    if (
      !windows.length ||
      publications.length !== windows.length ||
      new Set(publications.map((entry) => entry.scopeKey)).size !== windows.length
    )
      fail("dispatch_publication_unconfirmed");
    for (const publication of publications) {
      const selected = windows.find(({ scope }) => scopeKey(scope) === publication.scopeKey);
      const selectedScope = selected?.scope;
      const receipt = (
        await tx.query(
          `SELECT saved.snapshot_id,saved.revision,saved.config_version,saved.scope_key,
            saved.document,saved.document_hash
           FROM leaderboard_pipeline.dispatch_publications AS operation
           JOIN leaderboard_pipeline.snapshots AS saved USING(snapshot_id)
           WHERE operation.operation_key=$1 AND operation.scope_hash=${pipelineKeySQL("$2")}
             AND operation.scope_key=$2 AND operation.snapshot_id=$3`,
          [lease.operation.operationKey, publication.scopeKey, publication.snapshotId],
        )
      ).rows[0];
      const confirmation = controlsStore.read().pipelinePublications?.[publication.snapshotId];
      if (
        !receipt ||
        !selectedScope ||
        !confirmationMatches(confirmation, selectedScope, publication.snapshotId, publication.revision) ||
        confirmation?.controlsConfigurationRevision !== runConfigurationRevision
      )
        fail("dispatch_publication_unconfirmed");
      if (
        digest(receipt.document) !== receipt.document_hash ||
        receipt.document.snapshot?.snapshotId !== publication.snapshotId ||
        receipt.document.snapshot?.revision !== publication.revision ||
        Number(receipt.revision) !== publication.revision ||
        receipt.config_version !== config.version ||
        receipt.document.dataMode !== dataMode ||
        receipt.scope_key !== publication.scopeKey ||
        scopeKey(receipt.document.scope) !== publication.scopeKey
      )
        fail("dispatch_snapshot_integrity_error");
      if (recognitionBindings.length && confirmation.recognitionFingerprint !== runRecognitionFingerprint)
        fail("dispatch_recognition_changed");
      if (!confirmation.aggregateExplanationHash) fail("aggregate_explanation_required");
      const explanation = aggregateExplanations.verify(publication.snapshotId, {
        scopeKey: publication.scopeKey,
        revision: publication.revision,
        computationVersion,
        configurationHash: digest(config),
        digest: confirmation.aggregateExplanationHash,
      }).document;
      const normalizationBinding = await publicationNormalizationBinding(tx, selectedScope, publication, explanation);
      if (normalizationBinding.obsolete) fail(`dispatch_${normalizationBinding.obsolete}_normalization_obsolete`);
      if (mergeTargetRepositoryIds.length) {
        const retained = await readDecisionFrozenInput(tx, publication.snapshotId);
        const document = retained?.document;
        const engineScope = {
          ...selected.window,
          repos: repositoriesFor(selectedScope).map((repo) => String(repo.id)),
          projects: selectedScope.projects ?? [],
          workstreams: selectedScope.workstream === null ? [] : [selectedScope.workstream],
          roles: selectedScope.roles ?? [],
          actors: "all",
          context: selectedScope.context ?? "event",
          ...(selectedScope.branch === undefined ? {} : { branch: selectedScope.branch }),
        };
        // An identical already-confirmed snapshot may predate this operation's
        // observation freeze. Its original cutoff remains authoritative.
        if (
          saved.observation_cutoff === null ||
          saved.observation_cutoff === undefined ||
          !document ||
          digest(document) !== retained.document_hash ||
          utc(document.frozen?.cutoff) !== explanation.cutoff ||
          explanation.cutoff < lease.operation.cutoff ||
          explanation.cutoff > utc(new Date(saved.observation_cutoff).toISOString()) ||
          canonical(document.scope) !== canonical(selectedScope) ||
          canonical(document.engineScope) !== canonical(engineScope) ||
          canonical(document.policies) !== canonical(JSON.parse(JSON.stringify(policiesForScope(selectedScope))))
        )
          fail("dispatch_frozen_input_unavailable");
        const original = await withAuthorizedComparisonInputs(
          [document.identityAuthorization],
          (removed, guard) => {
            const suppressed = new Set(removed);
            if (document.frozen.facts.some((fact) => suppressed.has(fact.artifactId)))
              fail("retained_publication_source_unavailable");
            const restored = guard.restoreInput(document.frozen, document.identityAuthorization);
            return {
              input: document.frozen,
              scope: document.engineScope,
              policies: document.policies.map((item) => item.policy),
              aggregates: document.policies.map((item) =>
                c.metrics.aggregateMetric(restored, item.policy, document.engineScope),
              ),
              snapshot: { snapshotId: publication.snapshotId, revision: publication.revision },
              authorization: document.identityAuthorization,
            };
          },
          tx,
        );
        const published = await readDecisionPublicationReceipt(
          tx,
          `publish:${publication.scopeKey}:${publication.snapshotId}`,
          explanation.authorization.pullRequestDecisionEvidence !== undefined,
        );
        if (
          !published ||
          digest(published.document) !== published.document_hash ||
          published.document.snapshotId !== publication.snapshotId ||
          published.document.revision !== publication.revision ||
          published.document.configuration !== config.version ||
          published.document.datasetId !== document.frozen.datasetId ||
          published.document.comparisonInputHash !== digest(original) ||
          canonical(published.document.policySignatures) !==
            canonical(policiesForScope(selectedScope).map((item) => item.signature))
        )
          fail("dispatch_snapshot_integrity_error");
      }
    }
    if (!(await approved(tx))) fail("dispatch_collection_incomplete");
    await outbox.assertLease(tx, lease);
    assertConfigurationCurrent();
  }
  async function readConfirmedDispatchPublications(lease) {
    const runState = controlsStore.read();
    runConfigurationRevision = restrictConfiguration(runState).revision;
    runRecognitionFingerprint = recognitionFingerprint(runState, recognitionBindings);
    runFeedbackAuthority = feedbackAuthority.capture();
    if (runConfigurationRevision !== lease.operation.configurationRevision) fail("dispatch_configuration_changed");
    const windows = resolveDiscoverablePublicationWindows(
      config.scopes,
      lease.operation.cutoff,
      c.metrics.resolveMetricWindow,
    );
    return db.transaction(async (tx) => {
      await lockIssueTransferSources(tx, config.repositories);
      await outbox.assertLease(tx, lease);
      assertConfigurationCurrent();
      const rows = (
        await tx.query(
          `SELECT scope_key,snapshot_id FROM leaderboard_pipeline.dispatch_publications
           WHERE operation_key=$1 ORDER BY scope_key LIMIT $2`,
          [lease.operation.operationKey, windows.length + 1],
        )
      ).rows;
      if (rows.length > windows.length) fail("dispatch_publication_unconfirmed");
      if (rows.length !== windows.length) return null;
      const byScope = new Map(rows.map((row) => [row.scope_key, row]));
      if (byScope.size !== windows.length || windows.some(({ scope }) => !byScope.has(scopeKey(scope))))
        fail("dispatch_publication_unconfirmed");
      const state = controlsStore.read();
      const publications = [];
      for (const { scope } of windows) {
        const row = byScope.get(scopeKey(scope));
        const confirmation = state.pipelinePublications?.[row.snapshot_id];
        // Missing confirmation or private head still needs the original fully
        // guarded recovery path. A newer head need never be moved backwards.
        if (
          !state.pipelineHeads?.[scopeKey(scope)] ||
          !Number.isSafeInteger(confirmation?.revision) ||
          confirmation.revision < 1 ||
          !confirmationMatches(confirmation, scope, row.snapshot_id, confirmation.revision) ||
          confirmation.controlsConfigurationRevision !== runConfigurationRevision
        )
          return null;
        publications.push({
          scopeKey: scopeKey(scope),
          snapshotId: row.snapshot_id,
          revision: confirmation.revision,
        });
      }
      await verifyDispatchPublications(tx, lease, publications);
      return publications;
    });
  }
  const dispatch = createWebhookDispatcher({
    outbox,
    config,
    dataMode,
    policyVersion: c.metrics.metricRegistryV1.policy_version,
    approved,
    configurationRevision: () => restrictConfiguration(controlsStore.read()).revision,
    now: implicitPublicationCutoff,
    publicationEligible: (cutoff) =>
      resolveDiscoverablePublicationWindows(config.scopes, cutoff, c.metrics.resolveMetricWindow).length > 0,
    execute: async (lease) => {
      if (mergeTargetRepositoryIds.length) {
        const confirmed = await readConfirmedDispatchPublications(lease);
        if (confirmed) return confirmed;
      }
      const result = await runOnceInternal({ cutoff: lease.operation.cutoff, dispatch: { lease } });
      if (result.state !== "published") fail("dispatch_collection_incomplete");
      const windows = resolveDiscoverablePublicationWindows(
        config.scopes,
        lease.operation.cutoff,
        c.metrics.resolveMetricWindow,
      );
      return result.publications.map((publication, index) => ({
        scopeKey: scopeKey(windows[index].scope),
        snapshotId: publication.snapshotId,
        revision: publication.revision,
      }));
    },
    assertAuthorized: () => assertConfigurationCurrent(),
    prepareCompletion: async (tx) => {
      await lockIssueTransferSources(tx, config.repositories);
    },
    confirm: verifyDispatchPublications,
  });
  function dispatchOnce() {
    return serialize(() => (stopped || !options.webhookDispatch ? "blocked" : dispatch()));
  }
  const diagnosticConfigurationCurrent = (scope) => {
    if (!diagnosticOptions || stopped) return false;
    const current = diagnosticOptions.configurationCurrent({
      configurationHash: digest(config),
      configurationVersion: config.version,
      dataMode,
      repositoryId: scope.repositoryId,
      installationId: scope.installationId,
      sourceGeneration: scope.sourceGeneration ?? scope.generation,
    });
    if (current && typeof current.then === "function") void Promise.resolve(current).catch(() => undefined);
    return current === true;
  };
  const verifyReplayPublications = createOperatorPublicationVerifier({
    config,
    dataMode,
    policyVersion: c.metrics.metricRegistryV1.policy_version,
    computationVersion,
    scopeKey,
    publicationScopesAt: (cutoff) =>
      resolveDiscoverablePublicationWindows(config.scopes, cutoff, c.metrics.resolveMetricWindow).map(
        ({ scope }) => scope,
      ),
    digest,
    approved,
    controlsStore,
    restrictConfiguration,
    confirmationMatches,
    aggregateExplanations,
    recognitionCurrent: (state, confirmation) =>
      !recognitionBindings.length ||
      confirmation.recognitionFingerprint === recognitionFingerprint(state, recognitionBindings),
    configurationCurrent: diagnosticConfigurationCurrent,
    withAuthorizedInputs: withAuthorizedComparisonInputs,
    publicationNormalizationBinding,
  });
  const operatorOperations = diagnosticOptions
    ? new c.ingestion.OperatorInbox(db, {
        prepareSourceRead: async (tx) => {
          await lockIssueTransferSources(tx, config.repositories);
        },
        now: () => utc(now()),
        verifyPublications: verifyReplayPublications,
        replayReadGuard: (scope) => {
          const revision = restrictConfiguration(controlsStore.read()).revision;
          return () =>
            diagnosticConfigurationCurrent(scope) && restrictConfiguration(controlsStore.read()).revision === revision;
        },
        readHealth: async (tx, scope) => {
          const repository = config.repositories.find(
            (repo) => repo.id === scope.repositoryId && String(repo.installationId) === scope.installationId,
          );
          if (!repository || !(await approved(tx))) fail("operation_health_unavailable");
          const revision = restrictConfiguration(controlsStore.read()).revision;
          const current = () => {
            try {
              return (
                diagnosticConfigurationCurrent(scope) &&
                restrictConfiguration(controlsStore.read()).revision === revision
              );
            } catch {
              return false;
            }
          };
          if (!current()) fail("operation_health_unavailable");
          const asOf = utc(now());
          const reconciliation = reconciliationPolicy ? await reconciliationState(tx, [repository], asOf) : null;
          const read = await readOperatorHealth(tx, {
            scope,
            repository,
            asOf,
            reconciliationProgress: reconciliation?.progress,
            freshnessBudgetSeconds: diagnosticOptions.freshnessBudgetSeconds,
            protocol: c.ingestion,
            verifyPublications: verifyReplayPublications,
            readQuota: async () => {
              if (!options.githubClient?.forRepository || typeof options.sourceId !== "string") return null;
              const client = options.githubClient.forRepository(scope.repositoryId);
              if (typeof client.readQuota !== "function") return null;
              return client.readQuota(options.sourceId, () => {
                if (!current()) fail("operation_health_changed");
              });
            },
          });
          if (!(await approved(tx))) fail("operation_health_changed");
          return {
            health: read.health,
            confirmCurrent: () =>
              current() && reconciliation?.confirmCurrent() !== false && read.confirmCurrent() === true,
          };
        },
      })
    : null;
  async function policyInputGuard(snapshotId, input, transaction) {
    if (!input.scope) fail("policy_input_scope_unavailable");
    const read = await source.read(input.scope, snapshotId, new AbortController().signal, transaction);
    if (
      !read ||
      input.frozen.actors.some((actor) => read.controls.suppressedActorIds.includes(actor.id)) ||
      input.frozen.facts.some(
        (fact) =>
          read.controls.suppressedArtifactIds.includes(fact.artifactId) ||
          read.controls.suppressedContributionIds?.includes(fact.id),
      )
    )
      fail("policy_input_revoked");
    return digest([
      read.controls.version,
      recognitionFingerprint(controlsStore.read(), recognitionBindings),
      configurationOverlay(controlsStore.read()),
    ]);
  }
  async function previewPolicy({ snapshotId, policy, operatorId }) {
    return serialize(async () => {
      if (
        stopped ||
        !(await approved()) ||
        !(await options.authorizePolicyPreview?.({ snapshotId, policy: copy(policy), operatorId }))
      )
        fail("policy_preview_not_authorized");
      const saved = await readDecisionFrozenInput(db, snapshotId);
      if (!saved || digest(saved.document) !== saved.document_hash) fail("frozen_input_unavailable");
      const guard = await policyInputGuard(snapshotId, saved.document);
      const previous = saved.document.policies.find((p) => p.policy.metricId === policy.metricId)?.policy;
      if (!previous) fail("policy_metric_not_in_snapshot");
      const compare = (input) => c.metrics.comparePolicies(input, previous, policy, saved.document.engineScope);
      const comparison = saved.document.identityAuthorization
        ? await withAuthorizedComparisonInputs(
            [saved.document.identityAuthorization],
            async (_removed, authority, tx) => {
              if (guard !== (await policyInputGuard(snapshotId, saved.document, tx))) fail("policy_input_changed");
              const input = authority.restoreInput(saved.document.frozen, saved.document.identityAuthorization);
              return compare(input);
            },
          )
        : compare(saved.document.frozen);
      const document = { snapshotId, guard, comparison, previousPolicy: previous, targetPolicy: copy(policy) };
      const comparisonId = digest(document);
      await db.query(
        "INSERT INTO leaderboard_pipeline.policy_comparisons(comparison_id,document,document_hash) VALUES($1,$2::jsonb,$3) ON CONFLICT DO NOTHING",
        [comparisonId, JSON.stringify(document), digest(document)],
      );
      if (guard !== (await policyInputGuard(snapshotId, saved.document))) fail("policy_input_changed");
      return { comparisonId, ...copy(document) };
    });
  }
  async function approvePolicyComparison({ comparisonId, operatorId, approvalReceipt, releaseNotes }) {
    return serialize(async () => {
      const authorization = { comparisonId, operatorId, approvalReceipt, releaseNotes };
      if (stopped || !(await approved()) || !(await options.authorizePolicyRelease?.(copy(authorization))))
        fail("policy_release_not_authorized");
      const saved = (
        await db.query(
          "SELECT document,document_hash FROM leaderboard_pipeline.policy_comparisons WHERE comparison_id=$1",
          [comparisonId],
        )
      ).rows[0];
      if (!saved || digest(saved.document) !== saved.document_hash) fail("policy_comparison_unavailable");
      const input = await readDecisionFrozenInput(db, saved.document.snapshotId);
      if (
        !input ||
        digest(input.document) !== input.document_hash ||
        saved.document.guard !== (await policyInputGuard(saved.document.snapshotId, input.document))
      )
        fail("policy_input_changed");
      const manifest = c.metrics.planPolicyRelease(saved.document.comparison, {
        approverId: operatorId,
        designatedApproverIds: options.policyApproverIds ?? [],
        approvalReceipt,
        releaseNotes,
      });
      // A reviewed manifest remains non-public until a separately source-tested configuration activates it.
      const document = { comparisonId, manifest };
      const receiptId = await db.transaction(async (tx) => {
        const id = await receipt(tx, `policy-release:${digest(document)}`, "policy_release_reviewed", document);
        if (saved.document.guard !== (await policyInputGuard(saved.document.snapshotId, input.document, tx)))
          fail("policy_input_changed");
        return id;
      });
      if (saved.document.guard !== (await policyInputGuard(saved.document.snapshotId, input.document)))
        fail("policy_input_changed");
      return { receiptId, ...document };
    });
  }
  async function applyCorrection({ requestId, expectedVersion, factId, operatorId, approvalReceipt }) {
    return serialize(async () => {
      if (stopped) fail("pipeline_stopped");
      if (
        !(await approved()) ||
        !(await authorizeCorrection({ requestId, expectedVersion, factId, operatorId, approvalReceipt }))
      )
        fail("correction_not_authorized");
      const operationBinding = { requestId, expectedVersion, factId, operatorId, approvalReceipt };
      const priorRow = (
        await db.query("SELECT document,repository_id FROM leaderboard_pipeline.corrections WHERE request_id=$1", [
          requestId,
        ])
      ).rows[0];
      if (priorRow) {
        await readCorrectionState(db, [Number(priorRow.repository_id)]);
        if (Object.hasOwn(priorRow.document, "kind")) fail("correction_retry_mismatch");
      }
      const priorCorrection = priorRow?.document;
      if (priorCorrection && c.metrics.stableJSON(priorCorrection.operation) !== c.metrics.stableJSON(operationBinding))
        fail("correction_retry_mismatch");
      const state = controlsStore.read(),
        request = state.requests[requestId];
      if (
        !request ||
        request.kind !== "correction" ||
        !["pending", "applied"].includes(request.status) ||
        request.owner === operatorId ||
        (request.status !== "applied" && request.version !== expectedVersion)
      )
        fail("correction_request_conflict");
      required(approvalReceipt, "correction_approval_required");
      if (request.status === "applied" && !priorCorrection) fail("missing_applied_correction_receipt");
      const receiptId = await db.transaction(async (tx) => {
        await lockIssueTransferSources(tx, config.repositories, "update", [], "share");
        const candidates = (
          await tx.query(
            `SELECT n.document,n.document_hash,n.policy_signature,f.repository_id,f.family,f.observed_at,f.document - 'pullRequestDecisionHistory' AS source_document FROM leaderboard_pipeline.normalizations n
          JOIN leaderboard_ingestion.source_facts f USING(fact_key) WHERE f.repository_id=ANY($1::bigint[]) AND
            (n.policy_signature=ANY($2::text[]) OR
             (n.document->'pullRequestMergeTargetNormalization'->>'schemaVersion'=$4 AND
              n.document->'pullRequestMergeTargetNormalization'->>'baseSignature'=$5))
          AND EXISTS(SELECT 1 FROM jsonb_array_elements(n.document->'facts') item WHERE item->>'id'=$3)
          ORDER BY n.fact_key,n.policy_signature LIMIT 10001 FOR SHARE OF n`,
            [
              config.repositories.map((repo) => repo.id),
              identityNormalizationSignatures,
              factId,
              mergeTargetNormalizationVersion,
              normalizationSignature,
            ],
          )
        ).rows;
        if (candidates.length > 10000) fail("correction_evidence_budget_exceeded");
        for (const row of candidates) {
          if (digest(row.document) !== row.document_hash || row.document.isSynthetic !== (dataMode === "synthetic"))
            fail("normalization_integrity_error");
          if (row.document.pullRequestMergeTargetNormalization !== undefined) {
            await validateMergeTargetRow(row);
          }
        }
        const views = candidates
          .flatMap((row) =>
            row.document.facts
              .filter((fact) => fact.id === factId)
              .map((fact) => ({
                fact,
                evidence: row.document.evidence.find(
                  (entry) =>
                    entry.contribution.contributionId === fact.id &&
                    entry.artifact.stableId === fact.artifactId &&
                    entry.artifact.repositoryId === fact.repoId,
                ),
                repositoryId: String(row.repository_id),
              })),
          )
          .filter((view) => view.fact.repoId === view.repositoryId && view.evidence);
        views.sort(
          (a, b) => a.fact.observedAt.localeCompare(b.fact.observedAt) || a.fact.repoId.localeCompare(b.fact.repoId),
        );
        const fact = views[0]?.fact;
        if (!fact) fail("correction_evidence_mismatch");
        const authority = await readSourceAuthority(tx, {
          repositories: config.repositories,
          repositoryIds: [fact.repoId],
          artifactIds: [fact.artifactId],
          dataMode,
          mode: "update",
          graphMode: "share",
        });
        if (!authority.selectedPublic || authority.removed.includes(fact.artifactId))
          fail("correction_source_unavailable");
        const knownUrls = new Set(
          views
            .filter(
              (view) =>
                view.evidence.artifact.visibility === "public" &&
                view.evidence.artifact.publicUrl?.startsWith(
                  `https://github.com/${config.repositories.find((repo) => String(repo.id) === view.repositoryId)?.slug}/`,
                ),
            )
            .map((view) => view.evidence.artifact.publicUrl),
        );
        if (fact.metricId === "issues_opened") {
          const component = issueTransferClosure(authority.transfers, { artifactIds: [fact.artifactId] });
          for (const entry of component.transfers) {
            knownUrls.add(entry.sourceUrl);
            knownUrls.add(entry.targetUrl);
          }
        }
        if (!knownUrls.has(request.locator)) fail("correction_evidence_mismatch");
        const corrected = priorCorrection?.fact ?? {
          ...fact,
          revision: fact.revision + 1,
          state: "excluded",
          correctionReceipt: approvalReceipt,
          observedAt: utc(now()),
        };
        // A new exclusion cannot earn merge credit. Its durable receipt must not
        // inherit the positive source fact's generation-specific proof projection.
        // Exact retries retain the original persisted correction bytes.
        if (!priorCorrection) delete corrected.mergeTarget;
        restrictConfiguration(controlsStore.read());
        await tx.query(
          `INSERT INTO leaderboard_pipeline.corrections (request_id,fact_id,artifact_id,repository_id,document)
          VALUES ($1,$2,$3,$4,$5::jsonb) ON CONFLICT (request_id) DO NOTHING`,
          [
            requestId,
            fact.id,
            fact.artifactId,
            Number(fact.repoId),
            JSON.stringify({ fact: corrected, operation: operationBinding }),
          ],
        );
        const persisted = (
          await tx.query("SELECT document FROM leaderboard_pipeline.corrections WHERE request_id=$1 FOR UPDATE", [
            requestId,
          ])
        ).rows[0];
        await readCorrectionState(tx, [Number(fact.repoId)]);
        if (Object.hasOwn(persisted.document, "kind")) fail("correction_retry_mismatch");
        if (c.metrics.stableJSON(persisted.document.operation) !== c.metrics.stableJSON(operationBinding))
          fail("correction_retry_mismatch");
        return receipt(tx, `correction:${requestId}:${expectedVersion}`, "correction_applied", {
          requestId,
          factId,
          operatorId,
          approvalReceipt,
        });
      });
      // DB overlay already denies the affected artifact if this separate controls transaction fails.
      if (request.status !== "applied")
        controlsStore.transaction(
          (current) => {
            const target = current.requests[requestId];
            if (target.status === "applied") return;
            if (target.version !== expectedVersion) fail("correction_request_conflict");
            target.status = "applied";
            c.controls.record(current, target, operatorId, "pipeline-correction-applied", Date.parse(now()), {
              receiptId,
            });
          },
          { publish: true },
        );
      return { receiptId, requestId, status: "applied" };
    });
  }
  async function applyReversionDecision({ operation, lineageEvidenceIds }) {
    const invocation = copy({ operation, lineageEvidenceIds });
    return serialize(async () => {
      if (stopped) fail("pipeline_stopped");
      return applyReviewedReversion({
        db,
        controlsStore,
        ...invocation,
        configurationHash: digest(config),
        dataMode,
        now: () => utc(now()),
        approved,
        authorize: options.authorizeReversionDecision,
        lockSources: async (tx, ids) =>
          (await lockIssueTransferSources(tx, config.repositories, "update", [], "share")).filter((row) =>
            ids.includes(Number(row.repository_id)),
          ),
        suppressedArtifacts: async (tx, ids) =>
          (
            await readSourceAuthority(tx, {
              repositories: config.repositories,
              repositoryIds: ids,
              dataMode,
              mode: "update",
              graphMode: "share",
            })
          ).removed,
        receipt,
        verifyFrozen(saved, access, state) {
          const authorization = saved.input.identityAuthorization;
          const scope = saved.snapshot.scope;
          const snapshot = saved.snapshot.snapshot;
          const overlay = restrictConfiguration(state);
          const confirmation = state.pipelinePublications?.[snapshot.snapshotId];
          assertPipelineSourcesNotRetired(
            controlsStore,
            access.map((row) => Number(row.repository_id)),
          );
          if (
            !authorization ||
            authorization.configurationHash !== digest(config) ||
            authorization.dataMode !== dataMode ||
            saved.snapshot.dataMode !== dataMode ||
            canonical(saved.input.policies) !== canonical(policiesForScope(scope)) ||
            authorization.controlsConfigurationRevision !== overlay.revision ||
            !configuredScope(scope) ||
            !confirmationMatches(confirmation, scope, snapshot.snapshotId, snapshot.revision) ||
            confirmation.controlsConfigurationRevision !== overlay.revision ||
            (recognitionBindings.length &&
              confirmation.recognitionFingerprint !== recognitionFingerprint(state, recognitionBindings)) ||
            !Array.isArray(authorization.sources) ||
            authorization.sources.length !== access.length ||
            authorization.sources.some(
              (source) =>
                !access.some(
                  (row) =>
                    String(row.repository_id) === source.repositoryId &&
                    String(row.generation) === source.generation &&
                    config.repositories.some(
                      (repo) =>
                        repo.id === Number(row.repository_id) &&
                        String(repo.installationId) === String(row.installation_id),
                    ),
                ),
            )
          )
            fail("reversion_frozen_authority_changed");
          const selected = new Set([
            invocation.operation.originalFactId,
            invocation.operation.revertingFactId,
            ...invocation.operation.targetFactIds,
          ]);
          if (
            saved.input.frozen.facts.some(
              (fact) =>
                selected.has(fact.id) &&
                (state.profiles[fact.actorId]?.suppressed || overlay.disabledMetricIds.includes(fact.metricId)),
            )
          )
            fail("reversion_frozen_authority_changed");
          aggregateExplanations.verify(snapshot.snapshotId, {
            ...explanationBinding(scope, snapshot),
            digest: confirmation.aggregateExplanationHash,
          });
        },
        markApplied(result, operation) {
          controlsStore.transaction(
            (state) => {
              const target = state.requests[operation.requestId];
              if (!target || target.owner === operation.operatorId || target.kind !== "correction")
                fail("reversion_request_conflict");
              if (target.status === "applied") {
                const events = target.history.filter(
                  (event) =>
                    event.action === "pipeline-correction-applied" &&
                    event.receiptId === result.receiptId &&
                    event.decisionHash === result.document.decisionHash &&
                    event.actor === operation.operatorId &&
                    event.version === operation.expectedVersion + 1,
                );
                if (
                  target.version !== operation.expectedVersion + 1 ||
                  events.length !== 1 ||
                  state.audit.filter((event) => canonical(event) === canonical(events[0])).length !== 1
                )
                  fail("reversion_applied_audit_changed");
                return;
              }
              if (target.status !== "pending" || target.version !== operation.expectedVersion)
                fail("reversion_request_conflict");
              target.status = "applied";
              c.controls.record(state, target, operation.operatorId, "pipeline-correction-applied", Date.parse(now()), {
                receiptId: result.receiptId,
                decisionHash: result.document.decisionHash,
                authorityVersion: result.document.kind,
              });
            },
            { publish: true },
          );
        },
      });
    });
  }
  async function start({ public: publicAddress = { host: "127.0.0.1", port: 0 }, webhook, controls } = {}) {
    if (stopped) fail("pipeline_stopped");
    const allowed = await approved();
    if (
      dataMode === "synthetic" &&
      [publicAddress, webhook, controls]
        .filter(Boolean)
        .some((address) => !["127.0.0.1", "::1", "localhost"].includes(address.host))
    )
      fail("synthetic_runtime_requires_loopback");
    await app.listen(publicAddress);
    try {
      if (webhook) {
        if (!allowed || !options.webhookSecrets?.length) fail("webhook_configuration_required");
        const scope = new Map();
        for (const repo of config.repositories) {
          const ids = scope.get(repo.installationId) ?? new Set();
          ids.add(repo.id);
          scope.set(repo.installationId, ids);
        }
        webhookServer = c.ingestion.createIngestionServer({
          secrets: options.webhookSecrets,
          scope,
          store: inbox,
          lifecycle: collection,
        });
        workerController = new AbortController();
        workerPromise = c.ingestion.runWorker(inbox, {
          signal: workerController.signal,
          idleMs: 100,
          failureBackoffMs: 1000,
        });
        await new Promise((resolve, reject) => {
          webhookServer.once("error", reject);
          webhookServer.listen(webhook.port, webhook.host, resolve);
        });
      }
      if (options.webhookDispatch) {
        if (!allowed) fail("webhook_dispatch_configuration_required");
        outboxController = new AbortController();
        outboxPromise = c.ingestion.runOutboxWorker(dispatchOnce, {
          signal: outboxController.signal,
          idleMs: 100,
          failureBackoffMs: 1000,
        });
      }
      if (metadataEnrichment) {
        if (!allowed) fail("metadata_enrichment_configuration_required");
        enrichmentController = new AbortController();
        enrichmentPromise = metadataEnrichment.run(enrichmentController.signal);
      }
      if (controls) {
        if (!options.controlsAuthentication) fail("controls_authentication_required");
        controlsServer = c.controls.createControlsServer({
          ...options.controlsAuthentication,
          store: controlsStore,
          operations: options.controlsAuthentication.operations ?? operatorOperations,
          policyComparisons: { comparisons: policyComparisons, withAuthorizedInputs: withAuthorizedComparisonInputs },
        });
        await new Promise((resolve, reject) => {
          controlsServer.once("error", reject);
          controlsServer.listen(controls.port, controls.host, resolve);
        });
      }
      return {
        public: app.server.address(),
        webhook: webhookServer?.address() ?? null,
        controls: controlsServer?.address() ?? null,
      };
    } catch (error) {
      await stop();
      throw error;
    }
  }
  function stop() {
    if (stopping) return stopping;
    stopped = true;
    controller?.abort();
    workerController?.abort();
    outboxController?.abort();
    enrichmentController?.abort();
    metadataEnrichment?.stop();
    stopping = (async () => {
      if (runner) await runner;
      if (workerPromise) await workerPromise;
      if (outboxPromise) await outboxPromise;
      if (enrichmentPromise) await enrichmentPromise;
      if (metadataEnrichment) await metadataEnrichment.settled();
      await operation;
      await Promise.all([
        app.close(),
        ...[webhookServer, controlsServer]
          .filter((server) => server?.listening)
          .map(
            (server) => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
          ),
      ]);
    })();
    return stopping;
  }
  function run({ intervalMs = 60000 } = {}) {
    if (runner || stopped || !Number.isInteger(intervalMs) || intervalMs < 1000 || intervalMs > 3600000)
      fail("invalid_pipeline_runner");
    controller = new AbortController();
    runner = (async () => {
      while (!controller.signal.aborted) {
        try {
          await runOnce();
        } catch {
          /* durable source/pipeline receipts preserve retry state; health reads fail closed */
        }
        try {
          await delay(intervalMs, undefined, { signal: controller.signal });
        } catch {
          if (!controller.signal.aborted) throw new Error("pipeline_wait_failed");
        }
      }
    })();
    return runner;
  }
  return {
    app,
    source,
    collection,
    inbox,
    outbox,
    // Privileged host-only metadata state; neither this object nor metadata grants recognition.
    enrichment: metadataEnrichment && {
      processOne: metadataEnrichment.processOne,
      readStates: metadataEnrichment.readStates,
    },
    operations: operatorOperations,
    dispatchOnce,
    runOnce,
    applyCorrection,
    applyReversionDecision,
    previewPolicy,
    approvePolicyComparison,
    // Privileged host composition only; never attached to the public service.
    policyComparisons: { comparisons: policyComparisons, withAuthorizedInputs: withAuthorizedComparisonInputs },
    aggregateExplanations: {
      // Privileged in-process review only, with current source and privacy checks.
      // No raw store is exposed and there is deliberately no public HTTP route.
      async read(snapshotId) {
        const initial = aggregateExplanations.read(snapshotId);
        return withAuthorizedComparisonInputs([initial.document.authorization], async (removed, _authority, tx) => {
          const stored = (
            await tx.query("SELECT document,document_hash FROM leaderboard_pipeline.snapshots WHERE snapshot_id=$1", [
              snapshotId,
            ])
          ).rows[0];
          if (!stored) fail("aggregate_explanation_snapshot_unavailable");
          if (digest(stored.document) !== stored.document_hash) fail("public_snapshot_integrity_error");
          if (!(await approved(tx))) fail("aggregate_explanation_authorization_changed");
          // No await after this current-state fence. Withhold the entire audit
          // rather than leak hidden IDs through reasons, hashes or stale totals.
          const state = controlsStore.read();
          const overlay = restrictConfiguration(state);
          const confirmation = state.pipelinePublications?.[snapshotId];
          if (
            !confirmation?.aggregateExplanationHash ||
            (recognitionBindings.length &&
              confirmation.recognitionFingerprint !== recognitionFingerprint(state, recognitionBindings)) ||
            overlay.revision !== initial.document.authorization.controlsConfigurationRevision
          )
            fail("aggregate_explanation_authorization_changed");
          const saved = aggregateExplanations.verify(snapshotId, {
            ...explanationBinding(stored.document.scope, stored.document.snapshot),
            digest: confirmation.aggregateExplanationHash,
          });
          if (
            saved.document.references.some(
              (reference) => state.profiles[reference.actorId]?.suppressed || removed.includes(reference.artifactId),
            ) ||
            saved.document.metrics.some((metric) => overlay.disabledMetricIds.includes(metric.metricId))
          )
            fail("aggregate_explanation_privacy_changed");
          return copy(saved);
        });
      },
    },
    start,
    stop,
    run,
    diagnostics: (repositoryId) => collection.diagnostics(repositoryId),
    operationalStatus(repositoryId, stage = "collection") {
      return (
        options.monitor?.status(monitorSource(repositoryId), stage) ?? { state: "unknown", lagMs: null, revision: null }
      );
    },
    async receipts() {
      return (
        await db.query(
          "SELECT receipt_id,kind,document FROM leaderboard_pipeline.receipts ORDER BY created_at,receipt_id",
        )
      ).rows;
    },
  };
}
