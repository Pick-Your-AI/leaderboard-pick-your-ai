import {
  validatePublicationPeriods,
  resolvePublicationWindows,
  approvedPublicationScope,
  publicScopeFromTemplate,
} from "./publication-windows.mjs";
import {
  migratePipeline as migrateScopeStorage,
  assertPipelineStorage,
  pipelineKeySQL,
  publicationMonitorIdentity,
} from "./scope-storage.mjs";
import { retainedRankHistory } from "./rank-history.mjs";
import { readImportedHistory } from "./reconciliation-history.mjs";
import {
  validateReconciliationPolicy,
  reconciliationContextDigest,
  prepareReconciliationPlan,
} from "./reconciliation-plan.mjs";
import { readReconciliationProgress, leastReconciliationTime } from "./reconciliation-progress.mjs";
import { recognitionFingerprint, materializeRecognition } from "./recognition-adapter.mjs";
import { PolicyComparisonStore } from "../../controls/src/policy-comparison.mjs";
import { AggregateExplanationStore } from "./aggregate-explanations.mjs";
import { assertPipelineSourcesNotRetired } from "./derived-retirement.mjs";
import { requireThat } from "../../controls/src/store.mjs";
import { materializeEvidenceMetadata, selectEvidenceMetadata } from "./evidence-metadata.mjs";
import { createWebhookDispatcher } from "./webhook-dispatch.mjs";
import { createGithubCollectionSource, isProjectSourceScopeFailure } from "./github-source.mjs";
import { normalizationDocumentVersion, privateAttribution } from "./private-attribution.mjs";
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
import { setTimeout as delay } from "node:timers/promises";
import { materializeReversionEffectiveness, reversionProjection } from "./reversion-effectiveness.mjs";
import {
  readCorrectionState,
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
  const config = copy(options.config ?? { version: "unconfigured", repositories: [], policies: [], scopes: [] });
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
  const normalizationSignature = digest([
    "project-membership-context/v1",
    verifiedMergeNormalizationSignature,
    projectWorkstreamMappings,
  ]);
  const frozenNormalizationSignatures = [
    normalizationSignature,
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
  const identityNormalizationSignatures = [...new Set(frozenNormalizationSignatures)];
  const verifyConfig = options.verifyConfiguration ?? (async () => false);
  const authorizeCorrection = options.authorizeCorrection ?? (async () => false);
  const now = options.now ?? (() => new Date().toISOString());
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
  // Source read locks span the final reviewer reauthentication and synchronous
  // private result transaction. No source/network permission is granted here.
  async function withAuthorizedComparisonInputs(authorizations, work, transaction) {
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
      const access = (
        await tx.query(
          "SELECT repository_id,state,generation FROM leaderboard_ingestion.repository_access WHERE repository_id=ANY($1::bigint[]) ORDER BY repository_id FOR SHARE",
          [ids],
        )
      ).rows;
      requireThat(
        access.length === ids.length &&
          sources.every((source) =>
            access.some(
              (row) =>
                String(row.repository_id) === source.repositoryId &&
                row.state === "public" &&
                String(row.generation) === source.generation,
            ),
          ),
        409,
        "Frozen input source authorization changed",
      );
      const restoredActors = new Map();
      for (const authorization of authorizations) {
        const binding = authorization.identityEvidence;
        // Legacy, non-service-account captures remain readable. The engine still
        // rejects service accounts without their reviewed provider-bound evidence.
        if (binding === undefined) continue;
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
                  hashes.has(entry.documentHash),
              ) &&
              new Set(normalizationSources.map((entry) => entry.factKey)).size === normalizationSources.length &&
              new Set(normalizationSources.map((entry) => entry.documentHash)).size === hashes.size),
          409,
          "Frozen identity source binding unavailable",
        );
        const rows = (
          await tx.query(
            `SELECT n.document,n.document_hash,f.fact_key,f.observed_at,f.first_run_id FROM leaderboard_pipeline.normalizations AS n
           JOIN leaderboard_ingestion.source_facts AS f ON f.fact_key=n.fact_key
           WHERE n.document_hash=ANY($1::text[]) AND n.policy_signature=ANY($2::text[])
             AND f.repository_id=ANY($3::bigint[])
             AND ($4::jsonb IS NULL OR EXISTS (
               SELECT 1 FROM jsonb_to_recordset($4::jsonb) AS bound(fact_key text,document_hash text)
               WHERE bound.fact_key=f.fact_key AND bound.document_hash=n.document_hash
             )) LIMIT $5 FOR SHARE OF n`,
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
              10000 * identityNormalizationSignatures.length + 1,
            ],
          )
        ).rows;
        requireThat(
          new Set(rows.map((row) => JSON.stringify([row.fact_key, row.document_hash]))).size <= 10000 &&
            new Set(rows.map((row) => row.document_hash)).size === binding.normalizationHashes.length &&
            (normalizationSources === undefined ||
              new Set(rows.map((row) => row.fact_key)).size === normalizationSources.length),
          409,
          "Frozen identity evidence unavailable",
        );
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
          for (const actor of row.document.actors) {
            requireThat(
              retainSourceActor(identity, actor, sourceBinding(row), canonical, c.contracts),
              409,
              "Frozen identity evidence conflict",
            );
          }
        }
        restoredActors.set(digest(authorization), identity.actors);
      }
      const removed = await sourceSuppressions(tx, ids);
      const corrections = await readCorrectionState(tx, ids);
      for (const authorization of authorizations)
        assertReversionCapture(
          authorization,
          await readCorrectionState(
            tx,
            authorization.sources.map((source) => Number(source.repositoryId)),
          ),
          utc(now()),
        );
      for (const correction of corrections.legacy)
        if (
          authorizations.some(
            (authorization) =>
              !authorization.corrections?.some(
                (saved) =>
                  saved.artifactId === correction.artifact_id && saved.hash === digest(correction.document.fact),
              ),
          )
        )
          removed.push(correction.artifact_id);
      return work(
        removed,
        {
          refreshApproval: () => approved(tx),
          restoreInput(input, authorization) {
            if (authorization.identityEvidence === undefined) return input;
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
            const current = options.policyComparisonAuthorityCurrent({
              configurationHash: digest(config),
              actorId: session.actorId,
              roleVersion: session.roleVersion,
            });
            if (current && typeof current.then === "function") void Promise.resolve(current).catch(() => undefined);
            return current === true;
          },
        },
        tx,
      );
    };
    return transaction ? read(transaction) : db.transaction(read);
  }
  const defaultSource = options.githubClient
    ? createGithubCollectionSource({
        client: options.githubClient,
        sourceId: options.sourceId,
        repositories: config.repositories,
        isSynthetic: dataMode === "synthetic",
        assertAuthorized: () => assertRunConfiguration(),
        onUnavailable: (repo, reason) => denyRepository(repo, reason, utc(now())),
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
  const collectionSource = options.source ?? defaultSource;
  const probeSource = options.probeRepository ?? defaultSource?.probeRepository;
  const collection = new c.ingestion.CollectionStore(db);
  const scanContinuations = new ScanContinuationStore(db);
  const guardedSource = {
    assertAuthorized() {
      assertRunConfiguration();
    },
    async readPage(request) {
      // The controls overlay can change while an earlier probe/page is pending.
      // Recheck before collection and reject results that lost authorization.
      assertRunConfiguration();
      const page = await collectionSource.readPage(request);
      assertRunConfiguration();
      assertDataMode(page);
      return page;
    },
  };
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
  const restrictConfiguration = (state) => {
    const overlay = configurationOverlay(state);
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
  const assertRunConfiguration = () => {
    const state = controlsStore.read();
    const overlay = restrictConfiguration(state);
    if (recognitionBindings.length && recognitionFingerprint(state, recognitionBindings) !== runRecognitionFingerprint)
      fail("recognition_changed_during_run");
    if (overlay.revision !== runConfigurationRevision) fail("active_configuration_changed");
  };
  const scanContext = (mode, sources, revision, fingerprint) => ({
    key: digest(["bounded-scan/v1", config, dataMode, mode]),
    contextHash: digest([revision, recognitionBindings.length ? fingerprint : null, sources]),
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
  const normalizer =
    options.normalizer ??
    (options.githubClient && c.github.createGithubEvidenceNormalizer
      ? c.github.createGithubEvidenceNormalizer({
          client: options.githubClient,
          source: options.sourceId,
          allowedRepositoryIds: config.repositories.map((repo) => repo.id),
          isSynthetic: dataMode === "synthetic",
          assertAuthorized: () => assertRunConfiguration(),
          documentationPolicies: config.documentationPolicies ?? [],
          researchPolicies: config.researchPolicies ?? [],
          projectWorkstreamMappings,
          ...(options.githubEnrich ? { enrich: options.githubEnrich } : {}),
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
    authorized = Boolean(await verifyConfig(copy(config)));
    if (!authorized) return false;
    assertDataMode(config);
    const persistedDenials = await transaction.query(
      `SELECT receipt.operation_key
      FROM unnest($1::text[]) AS requested(operation_key)
      JOIN leaderboard_pipeline.receipts AS receipt
        ON receipt.operation_hash=pg_catalog.sha256(pg_catalog.convert_to(requested.operation_key,'UTF8'))
        AND receipt.operation_key=requested.operation_key
      WHERE receipt.kind='project_scope_denial'`,
      [config.repositories.map(projectDenialKey)],
    );
    for (const repo of config.repositories)
      if (persistedDenials.rows.some((row) => row.operation_key === projectDenialKey(repo)))
        projectDeniedRepositories.add(repo.id);
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
    return true;
  }
  const configuredScope = (scope) => approvedPublicationScope(config.scopes, scope, c.metrics.resolveMetricWindow);
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
    if (reason === "project_scope_unavailable") {
      // Persist the public-read/write fence before SQL work. A repository-level
      // public probe cannot reauthorize its now-private Project evidence.
      projectDeniedRepositories.add(repo.id);
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
      if (reason === "project_scope_unavailable")
        await receipt(tx, projectDenialKey(repo), "project_scope_denial", {
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
    const current = (
      await db.query("SELECT state,generation FROM leaderboard_ingestion.repository_access WHERE repository_id=$1", [
        repo.id,
      ])
    ).rows[0];
    if (current?.state === "public") {
      const saved = await db.query(
        "UPDATE leaderboard_ingestion.repository_access SET checked_at=clock_timestamp() WHERE repository_id=$1 AND generation=$2 AND state='public' RETURNING repository_id",
        [repo.id, current.generation],
      );
      if (!saved.rows.length) fail("repository_access_changed");
      return;
    }
    if (!(await collection.verifyPublic(repo.id, repo.installationId, current ? String(current.generation) : null)))
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
  async function normalizeStored(repositoryIds, cutoff, dispatch) {
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
    const sourceRows = (
      await db.query(
        `SELECT fact.* FROM leaderboard_ingestion.source_facts AS fact
      JOIN leaderboard_ingestion.repository_access AS access USING (repository_id)
      WHERE fact.repository_id = ANY($1::bigint[]) AND fact.observed_at <= $2 AND access.state='public'
      AND (
        (fact.family='project_current' AND fact.document ? 'projectSubjectId'
          AND EXISTS (SELECT 1 FROM leaderboard_ingestion.collection_items AS selected
            WHERE selected.fact_key=fact.fact_key AND selected.run_id=ANY($3::text[])))
        OR (NOT (fact.family='project_current' AND fact.document ? 'projectSubjectId')
        AND (fact.document->>'evidence' <> 'current_state' OR NOT EXISTS (
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
        [repositoryIds, cutoff, selectedProjectRuns],
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
    const signature = normalizationSignature;
    const outputs = [];
    for (const row of sourceRows) {
      const repository = config.repositories.find((repo) => String(repo.id) === String(row.repository_id));
      const cached = (
        await db.query(
          "SELECT document,document_hash FROM leaderboard_pipeline.normalizations WHERE fact_key=$1 AND policy_signature=$2",
          [row.fact_key, signature],
        )
      ).rows[0];
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
          cached.document.projectContextNormalizationVersion === "subject-membership/v1";
        if (
          currentHistoryNormalizer &&
          currentProjectNormalizer &&
          hasDispatchEvidence(cached.document, dispatch, row)
        ) {
          normalizedProjectContext(cached.document, row, repository, projectWorkstreamMappings);
          await retainSourceArtifacts(db, row.fact_key, cached.document);
          outputs.push({ document: cached.document, source: sourceBinding(row) });
          continue;
        }
      }
      const normalizationStarted = performance.now();
      let output;
      try {
        assertRunConfiguration();
        output = await normalizer({
          repository: copy(repository),
          family: row.family,
          factKey: row.fact_key,
          selectedCurrentState: row.document.evidence === "current_state",
          fact: copy(row.document),
          observedAt: new Date(row.observed_at).toISOString(),
          policyVersion: config.version,
        });
        assertRunConfiguration();
        monitorSuccess(monitorSource(repository.id), "normalization", normalizationStarted);
      } catch (error) {
        if (isProjectSourceScopeFailure(error, row.family))
          await denyRepository(repository, "project_scope_unavailable", utc(now()));
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
      const suppressed = Array.isArray(output.suppressArtifactIds) ? output.suppressArtifactIds : [];
      for (const artifactId of suppressed) {
        if (typeof artifactId !== "string" || !/^[A-Za-z0-9_=.:-]{1,200}$/.test(artifactId))
          fail("invalid_artifact_suppression");
        await db.transaction(async (tx) => {
          // Match collection/correction suppression fencing: readers hold this
          // source gate through their final current-privacy projection.
          await tx.query(
            "SELECT repository_id FROM leaderboard_ingestion.repository_access WHERE repository_id=$1 FOR UPDATE",
            [repository.id],
          );
          assertRunConfiguration();
          await tx.query(
            "INSERT INTO leaderboard_ingestion.object_suppressions(repository_id,subject_id,reason) VALUES($1,$2,'unavailable') ON CONFLICT DO NOTHING",
            [repository.id, artifactId],
          );
        });
      }
      // Persist authoritative exclusions even when this dispatch cannot yet
      // prove the target creation. Failure must not leave older evidence visible.
      if (!hasDispatchEvidence(output, dispatch, row)) fail("dispatch_enrichment_unavailable");
      const document = {
        ...(row.family === "project_history" ? { projectHistoryNormalizationVersion: "collected-subject/v2" } : {}),
        ...(row.family === "project_current" && row.document.projectSubjectId !== undefined
          ? { projectContextNormalizationVersion: "subject-membership/v1" }
          : {}),
        suppressArtifactIds: suppressed,
        isSynthetic: dataMode === "synthetic",
        facts: output.facts,
        actors: output.actors,
        evidence: output.evidence,
        ...privateAttribution(output, row),
        ...normalizedProjectContext(output, row, repository, projectWorkstreamMappings),
        reasons: Array.isArray(output.reasons)
          ? output.reasons.map((reason) =>
              typeof reason === "string" && /^[a-z0-9_:-]{1,100}$/.test(reason) ? reason : "normalization_unavailable",
            )
          : [],
      };
      await db.transaction(async (tx) => {
        await tx.query(
          `INSERT INTO leaderboard_pipeline.normalizations (fact_key,policy_signature,document,document_hash)
        VALUES ($1,$2,$3::jsonb,$4) ON CONFLICT (fact_key,policy_signature) DO UPDATE
        SET document=EXCLUDED.document,document_hash=EXCLUDED.document_hash
        WHERE normalizations.document_hash=$5`,
          [row.fact_key, signature, JSON.stringify(document), digest(document), cached?.document_hash ?? null],
        );
        await retainSourceArtifacts(tx, row.fact_key, document);
      });
      outputs.push({ document, source: sourceBinding(row) });
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
    typeof confirmation.aggregateExplanationHash === "string" &&
    /^[a-f0-9]{64}$/.test(confirmation.aggregateExplanationHash);
  function confirmPublication(scope, publication, comparisonInput) {
    controlsStore.transaction((state) => {
      assertPipelineSourcesNotRetired(
        controlsStore,
        repositoriesFor(scope).map((repository) => repository.id),
      );
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
      if (comparisonInput) publication.comparisonInput = policyComparisons.capture(state, comparisonInput);
      state.pipelinePublications ||= {};
      const confirmation = {
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
    });
  }
  async function publish({ scope, window }, cutoff, observationCutoff, dispatch, scan = null) {
    assertRunConfiguration();
    scope = c.contracts.canonicalPublicScope(scope);
    if (!configuredScope(scope)) fail("scope_not_approved");
    const repos = repositoriesFor(scope);
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
        if (
          confirmationMatches(
            controlsStore.read().pipelinePublications?.[prior.snapshot_id],
            scope,
            prior.snapshot_id,
            Number(prior.revision),
          )
        ) {
          confirmPublication(scope, priorPublication);
          return priorPublication;
        }
        // An unconfirmed SQL commit has no private preview capture. Recompute
        // its exact frozen input before atomically confirming both; do not
        // manufacture a marker or move the SQL head to a historical operation.
        const retained = (
          await db.query("SELECT document,document_hash FROM leaderboard_pipeline.frozen_inputs WHERE snapshot_id=$1", [
            prior.snapshot_id,
          ])
        ).rows[0];
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
    const normalized = await normalizeStored(
      repos.map((repo) => repo.id),
      observationCutoff,
      dispatch,
    );
    let outputs = normalized.map((entry) => entry.document);
    const actorSources = new Map(normalized.map((entry) => [entry.document, entry.source]));
    // Only persisted provider normalizations can restore identity; recognition overlays are transient.
    const normalizationSources = normalized
      .map((entry) => ({ factKey: entry.source.factKey, documentHash: digest(entry.document) }))
      .sort((left, right) => left.factKey.localeCompare(right.factKey));
    const normalizationHashes = [...new Set(normalizationSources.map((entry) => entry.documentHash))].sort();
    const suppressedArtifactIds = new Set([
      ...outputs.flatMap((output) => output.suppressArtifactIds ?? []),
      ...(await sourceSuppressions(
        db,
        repos.map((repo) => repo.id),
      )),
    ]);
    if (recognitionBindings.length) {
      const combined = {
        facts: outputs.flatMap((o) => o.facts),
        actors: outputs.flatMap((o) => o.actors),
        evidence: outputs.flatMap((o) => o.evidence),
        syntheticFactIds: outputs.filter((o) => o.isSynthetic === true).flatMap((o) => o.facts.map((fact) => fact.id)),
        reasons: [],
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
        config.policies,
        c.github.applyRecognitionReceipt,
        observationCutoff,
        c.contracts.publicDocumentationReasons,
      );
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
    const identity = sourceActorEvidence();
    const actors = identity.actors,
      evidence = new Map();
    for (const output of outputs) {
      for (const actor of output.actors) {
        if (!retainSourceActor(identity, actor, actorSources.get(output), c.metrics.stableJSON, c.contracts))
          fail("conflicting_actor_metadata");
      }
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
    const correctionState = await readCorrectionState(
      db,
      repos.map((repo) => repo.id),
    );
    const reversion = materializeReversionEffectiveness(
      {
        facts,
        policies: config.policies,
        evidence: [...evidence.values()],
      },
      correctionState.decisions,
      observationCutoff,
    );
    const corrections = [...correctionState.legacy.map((row) => row.document.fact), ...reversion.overlays];
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
    };
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
      [...new Set(config.policies.flatMap((item) => item.policy.sources))].map((source) => {
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
            .filter((fact) => Date.parse(fact.observedAt) <= Date.parse(observationCutoff))
            .map(digest)
            .sort(),
        ]),
      repositoryIds: repos.map((repo) => String(repo.id)),
      // Validate all provider bindings before any privacy projection.
      actors: [...actors.values()],
      facts: [...facts, ...corrections],
      coverage,
    };
    for (const item of config.policies.filter((item) => item.policy.metricId === "pr_accepted_rate")) {
      const units = new Set();
      for (const fact of frozen.facts.filter(
        (fact) => fact.metricId === item.policy.metricId && item.policy.rankedStates.includes(fact.state),
      )) {
        const unit = JSON.stringify([fact.actorId, fact.artifactId]);
        if (units.has(unit)) fail("decision_lifecycle_selection_unproven");
        units.add(unit);
      }
    }
    const aggregates = config.policies.map((item) => c.metrics.aggregateMetric(frozen, item.policy, engineScope));
    const pendingFor = (aggregate, row) => ({
      schemaVersion: "leaderboard-pending/v1",
      state: aggregate.coverage === "complete" ? "measured" : row.pending > 0 ? "partial" : "unknown",
      valueClass: config.policies.find((item) => item.policy.metricId === aggregate.metricId).policy.rankedStates[0],
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
              sourceRevision: original.sourceRevision,
              sourceRevisionUrl: original.sourceRevisionUrl,
              ...materializeEvidenceMetadata(original, fact),
            },
          ];
        }),
      ),
    );
    // Descriptive public work is not conditional on earning a ranked outcome.
    // Selection reuses existing corrections, source/role/context checks and receipt validation.
    const portfolioFacts = config.policies.flatMap((item) =>
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
                  ]
                : []),
            ],
          },
          occurredAt: fact.occurredAt,
          observedAt: fact.observedAt,
          activityState,
          sourceRevision: original.sourceRevision,
          sourceRevisionUrl: original.sourceRevisionUrl,
          ...materializeEvidenceMetadata(original, fact),
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
          fact[config.policies.find((item) => item.policy.metricId === fact.metricId).policy.dateBasis];
        Object.assign(entry, materializeEvidenceMetadata(entry, fact));
      }
    }
    const content = {
      approvedPublic: true,
      scope: copy(scope),
      actors: actorContracts([...actors.values()]),
      rows,
      evidence: publicEvidence,
      portfolioEvidence,
      pendingEvidence,
      ranking: config.policies.map((item) => ({
        metricId: item.policy.metricId,
        direction: "descending",
        rank: item.policy.rank,
      })),
      diagnostics,
      methodology: config.policies.map((item) => ({
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
      repositoryIds: repos.map((repo) => repo.id),
      ...reversionBinding,
    };
    const snapshotId = digest(content);
    if (priorPublication && priorPublication.snapshotId !== snapshotId) fail("dispatch_snapshot_replay_changed");
    const comparisonInputFor = (publication) => ({
      input: { ...frozen, actors: frozen.actors.map(previewActor) },
      scope: engineScope,
      policies: config.policies.map((item) => item.policy),
      aggregates,
      snapshot: { snapshotId: publication.snapshotId, revision: publication.revision },
      authorization: {
        configurationHash: digest(config),
        dataMode,
        controlsConfigurationRevision: runConfigurationRevision,
        identityEvidence: {
          schemaVersion: "pipeline-identity-evidence/v1",
          normalizationHashes,
          // Identical-label captures keep their existing authorization bytes.
          // Source ordering is required only when this input reconciles aliases.
          ...(identity.hasRenames ? { normalizationSources } : {}),
        },
        sources: generations.map((row) => ({
          repositoryId: String(row.repository_id),
          generation: String(row.generation),
        })),
        ...reversionBinding,
      },
    });
    const publicationStarted = performance.now();
    try {
      const publication = await db.transaction(async (tx) => {
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
            assertRunConfiguration();
          }
          return publication;
        };
        await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`pipeline:${scopeKey(scope)}`]);
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
        const removed = new Set(
          await sourceSuppressions(
            tx,
            repos.map((repo) => repo.id),
          ),
        );
        if (facts.some((fact) => removed.has(fact.artifactId))) fail("source_suppressed_before_publication");
        // Corrections share the source write lock but do not increment its
        // generation. Recheck complete joined rows/seals while that lock is held.
        if (
          (
            await readCorrectionState(
              tx,
              repos.map((repo) => repo.id),
            )
          ).fingerprint !== correctionState.fingerprint
        )
          fail("reversion_changed_before_publication");
        const current = (
          await tx.query(
            `SELECT snapshot_id,revision FROM leaderboard_pipeline.heads WHERE scope_hash=${pipelineKeySQL("$1")} AND scope_key=$1`,
            [scopeKey(scope)],
          )
        ).rows[0];
        assertRunConfiguration();
        if (scan) scanContinuations.assertHead(scanHeads, scopeKey(scope), current?.snapshot_id ?? null);
        if (priorPublication) {
          const saved = (
            await tx.query(
              `SELECT document,document_hash FROM leaderboard_pipeline.receipts WHERE operation_hash=${pipelineKeySQL("$1")} AND operation_key=$1 AND kind='snapshot_published'`,
              [`publish:${scopeKey(scope)}:${snapshotId}`],
            )
          ).rows[0];
          if (
            !saved ||
            digest(saved.document) !== saved.document_hash ||
            saved.document.comparisonInputHash !== digest(comparisonInputFor(priorPublication))
          )
            fail("dispatch_snapshot_input_changed_or_unbound");
          return bindPublication(priorPublication);
        }
        if (current?.snapshot_id === snapshotId)
          return bindPublication({ snapshotId, revision: Number(current.revision), changed: false });
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
          ranking: content.ranking,
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
        const frozenDocument = {
          frozen: { ...frozen, actors: frozen.actors.map(previewActor) },
          identityAuthorization: comparisonInputFor({ snapshotId, revision }).authorization,
          engineScope,
          scope,
          policies: config.policies,
        };
        await tx.query(
          "INSERT INTO leaderboard_pipeline.frozen_inputs(snapshot_id,document,document_hash) VALUES($1,$2::jsonb,$3)",
          [snapshotId, JSON.stringify(frozenDocument), digest(frozenDocument)],
        );
        const receiptId = await receipt(tx, `publish:${scopeKey(scope)}:${snapshotId}`, "snapshot_published", {
          snapshotId,
          revision,
          configuration: config.version,
          policySignatures: config.policies.map((item) => item.signature),
          datasetId: frozen.datasetId,
          comparisonInputHash: digest(comparisonInputFor({ snapshotId, revision })),
          controlsRevision: state.revision,
        });
        assertRunConfiguration();
        return bindPublication({ snapshotId, revision, changed: true, receiptId });
      });
      // PostgreSQL can commit while controls change. Confirm publication only in
      // the same synchronous SQLite boundary used by configuration activation.
      confirmPublication(scope, publication, comparisonInputFor(publication));
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
  const source = {
    async readComparison(scope, pin, previous, signal) {
      if (c.contracts.publicScopeFilterKey(scope) !== c.contracts.publicScopeFilterKey(previous.scope)) return null;
      // Both reads reuse this transaction. Source locks remain held through the
      // final authority query, including expanded retained-source revocations.
      return db.transaction(async (tx) => {
        const current = await source.read(scope, pin, signal, tx);
        if (!current) return null;
        const prior = await source.read(previous.scope, previous.snapshotId, signal, tx);
        const repositoryIds = repositoriesFor(scope).map((repo) => repo.id);
        const access = (
          await tx.query(
            "SELECT repository_id,state,generation FROM leaderboard_ingestion.repository_access WHERE repository_id=ANY($1::bigint[]) ORDER BY repository_id FOR SHARE",
            [repositoryIds],
          )
        ).rows;
        if (signal.aborted || access.length !== repositoryIds.length || access.some((row) => row.state !== "public"))
          return null;
        const corrections = await readCorrectionState(tx, repositoryIds);
        const removed = [
          ...new Set([
            ...(await sourceSuppressions(tx, repositoryIds)),
            ...corrections.legacy.map((row) => row.artifact_id),
          ]),
        ];
        const authorityAt = utc(now());
        if (!(await approved(tx)) || signal.aborted) return null;
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
      });
    },
    async readHealth(scope, pin, signal) {
      return source.read(scope, pin, signal, undefined, true);
    },
    async read(scope, pin, signal, transaction, health = false) {
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
        const result = await run(async (tx) => {
          const result = await tx.query(
            `SELECT selected.document,selected.document_hash,selected.config_version,selected.repository_ids,selected.revision AS selected_revision,selected.snapshot_id AS selected_id,latest.revision,
      latest.snapshot_id AS head_id,latest.document AS head_document,latest.document_hash AS head_document_hash,
      latest.config_version AS head_config_version,latest.repository_ids AS head_repository_ids,
      latest.document->'snapshot'->>'generatedAt' AS published_at
      FROM leaderboard_pipeline.snapshots AS latest
      JOIN leaderboard_pipeline.snapshots AS selected ON selected.snapshot_id=COALESCE($2,latest.snapshot_id)
      WHERE latest.scope_key=$1 AND selected.scope_key=latest.scope_key AND latest.snapshot_id=$3`,
            [scopeKey(scope), pin, head.snapshotId],
          );
          if (signal.aborted || !result.rows[0]) return null;
          const selected = result.rows[0];
          if (
            digest(selected.document) !== selected.document_hash ||
            selected.document.snapshot.snapshotId !== selected.selected_id ||
            selected.document.snapshot.revision !== Number(selected.selected_revision) ||
            digest(selected.head_document) !== selected.head_document_hash ||
            selected.head_document.snapshot.snapshotId !== head.snapshotId ||
            selected.head_document.snapshot.revision !== head.revision ||
            Number(selected.revision) !== head.revision ||
            scopeKey(selected.document.scope) !== scopeKey(scope) ||
            scopeKey(selected.head_document.scope) !== scopeKey(scope) ||
            canonical(selected.repository_ids) !== canonical(repositoriesFor(scope).map((repo) => repo.id)) ||
            canonical(selected.head_repository_ids) !== canonical(selected.repository_ids)
          )
            fail("public_snapshot_integrity_error");
          if (
            selected.config_version !== config.version ||
            selected.document.dataMode !== dataMode ||
            selected.head_config_version !== config.version ||
            selected.head_document.dataMode !== dataMode
          )
            return null;
          const access = (
            await tx.query(
              "SELECT repository_id,installation_id,state,generation FROM leaderboard_ingestion.repository_access WHERE repository_id=ANY($1::bigint[]) ORDER BY repository_id FOR SHARE",
              [selected.repository_ids],
            )
          ).rows;
          if (
            signal.aborted ||
            access.length !== selected.repository_ids.length ||
            access.some(
              (row) =>
                row.state !== "public" ||
                String(row.installation_id) !==
                  String(
                    config.repositories.find((repo) => String(repo.id) === String(row.repository_id))?.installationId,
                  ),
            )
          )
            return null;
          const corrections = await readCorrectionState(tx, selected.repository_ids);
          const removed = [
            ...new Set([
              ...(await sourceSuppressions(tx, selected.repository_ids)),
              ...corrections.legacy.map((row) => row.artifact_id),
            ]),
          ];
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
          if (!(await approved(tx)) || signal.aborted || healthReconciliation?.confirmCurrent() === false) return null;
          // Read current private controls after all awaited I/O, even for pinned historical snapshots.
          const controls = controlsStore.read();
          const overlay = restrictConfiguration(controls);
          if (canonical(controls.pipelineHeads?.[scopeKey(scope)]) !== canonical(head)) return retry;
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
                revision: id === selected.selected_id ? Number(selected.selected_revision) : Number(selected.revision),
              }),
              digest: controls.pipelinePublications[id].aggregateExplanationHash,
            });
          }
          const document = copy(selected.document);
          const authorityAt = utc(now());
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
          return {
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
        });
        if (result !== retry) return result;
      }
      return null;
    },
  };
  const app = c.service.createService({
    source,
    registry: c.metrics.metricRegistryV1,
    cursorSecret: options.cursorSecret,
    now: () => Date.parse(now()),
  });
  async function runOnceInternal({ cutoff, mode = "reconcile", maxPages = 100, dispatch = null } = {}) {
    const implicitCutoff = cutoff === undefined;
    cutoff = utc(implicitCutoff ? now() : cutoff);
    if (stopped) fail("pipeline_stopped");
    if (!(await approved())) return { state: "blocked", reason: "approved_configuration_required" };
    const runState = controlsStore.read();
    runConfigurationRevision = restrictConfiguration(runState).revision;
    runRecognitionFingerprint = recognitionFingerprint(runState, recognitionBindings);
    if (dispatch && runConfigurationRevision !== dispatch.lease.operation.configurationRevision)
      fail("dispatch_configuration_changed");
    if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 10000) fail("invalid_pipeline_page_budget");
    if (!["backfill", "reconcile", "audit"].includes(mode)) fail("invalid_scan_scope");
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
        () => utc(now()),
        (savedCutoff) =>
          resolvePublicationWindows(config.scopes, savedCutoff, c.metrics.resolveMetricWindow).map(({ scope }) =>
            scopeKey(scope),
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
    }
    const publicationWindows = resolvePublicationWindows(config.scopes, cutoff, c.metrics.resolveMetricWindow);
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
        const { runId, family } = request;
        // Scheduled plan rows were committed atomically with the continuation.
        // Legacy/explicit callers retain their existing per-family start path.
        if (!scan?.plan) await collection.start(request);
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
    const publications = [];
    let observationCutoff = utc(now());
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
      for (const selected of publicationWindows)
        publications.push(await publish(selected, cutoff, observationCutoff, dispatch, scan));
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
  const dispatch = createWebhookDispatcher({
    outbox,
    config,
    dataMode,
    policyVersion: c.metrics.metricRegistryV1.policy_version,
    approved,
    configurationRevision: () => restrictConfiguration(controlsStore.read()).revision,
    now: () => utc(now()),
    execute: async (lease) => {
      const result = await runOnceInternal({ cutoff: lease.operation.cutoff, dispatch: { lease } });
      if (result.state !== "published") fail("dispatch_collection_incomplete");
      const windows = resolvePublicationWindows(config.scopes, lease.operation.cutoff, c.metrics.resolveMetricWindow);
      return result.publications.map((publication, index) => ({
        scopeKey: scopeKey(windows[index].scope),
        snapshotId: publication.snapshotId,
        revision: publication.revision,
      }));
    },
    assertAuthorized: () => assertRunConfiguration(),
    confirm: async (tx, lease, publications) => {
      assertRunConfiguration();
      const saved = (
        await tx.query(`SELECT source_generations FROM leaderboard_ingestion.outbox WHERE event_key=$1`, [
          lease.eventKey,
        ])
      ).rows[0];
      const access = (
        await tx.query(
          `SELECT repository_id,generation FROM leaderboard_ingestion.repository_access WHERE repository_id=ANY($1::bigint[]) AND state='public' FOR SHARE`,
          [config.repositories.map((repo) => repo.id)],
        )
      ).rows;
      if (
        access.length !== config.repositories.length ||
        access.some(
          (row) =>
            !saved.source_generations.some(
              (prior) =>
                prior.repositoryId === Number(row.repository_id) && prior.generation === String(row.generation),
            ),
        )
      )
        fail("dispatch_source_generation_changed");
      const windows = resolvePublicationWindows(config.scopes, lease.operation.cutoff, c.metrics.resolveMetricWindow);
      for (const publication of publications) {
        const selectedScope = windows.find(({ scope }) => scopeKey(scope) === publication.scopeKey)?.scope;
        const receipt = (
          await tx.query(
            `SELECT snapshot_id FROM leaderboard_pipeline.dispatch_publications WHERE operation_key=$1 AND scope_hash=${pipelineKeySQL("$2")} AND scope_key=$2 AND snapshot_id=$3`,
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
        if (!confirmation.aggregateExplanationHash) fail("aggregate_explanation_required");
        aggregateExplanations.verify(publication.snapshotId, {
          scopeKey: publication.scopeKey,
          revision: publication.revision,
          computationVersion,
          configurationHash: digest(config),
          digest: confirmation.aggregateExplanationHash,
        });
      }
      assertRunConfiguration();
    },
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
      resolvePublicationWindows(config.scopes, cutoff, c.metrics.resolveMetricWindow).map(({ scope }) => scope),
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
  });
  const operatorOperations = diagnosticOptions
    ? new c.ingestion.OperatorInbox(db, {
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
      const saved = (
        await db.query("SELECT document,document_hash FROM leaderboard_pipeline.frozen_inputs WHERE snapshot_id=$1", [
          snapshotId,
        ])
      ).rows[0];
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
      const input = (
        await db.query("SELECT document,document_hash FROM leaderboard_pipeline.frozen_inputs WHERE snapshot_id=$1", [
          saved.document.snapshotId,
        ])
      ).rows[0];
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
      const documents = (await db.query("SELECT document FROM leaderboard_pipeline.normalizations")).rows.map(
        (row) => row.document,
      );
      const fact = documents.flatMap((document) => document.facts).find((fact) => fact.id === factId);
      const evidence = documents
        .flatMap((document) => document.evidence)
        .find((entry) => entry.contribution.contributionId === factId);
      if (!fact || !evidence || request.locator !== evidence.artifact.publicUrl) fail("correction_evidence_mismatch");
      const corrected = priorCorrection?.fact ?? {
        ...fact,
        revision: fact.revision + 1,
        state: "excluded",
        correctionReceipt: approvalReceipt,
        observedAt: utc(now()),
      };
      const receiptId = await db.transaction(async (tx) => {
        const available = await tx.query(
          "SELECT repository_id FROM leaderboard_ingestion.repository_access WHERE repository_id=$1 AND state='public' FOR UPDATE",
          [Number(fact.repoId)],
        );
        if (!available.rows.length) fail("correction_source_unavailable");
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
        suppressedArtifacts: sourceSuppressions,
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
            canonical(saved.input.policies) !== canonical(config.policies) ||
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
    stopping = (async () => {
      if (runner) await runner;
      if (workerPromise) await workerPromise;
      if (outboxPromise) await outboxPromise;
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
