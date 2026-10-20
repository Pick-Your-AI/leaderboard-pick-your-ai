import { createHash } from "node:crypto";
import { webhookDispatchVersion } from "./webhook-dispatch.mjs";
import { lockIssueTransferSources } from "./issue-transfer-authority.mjs";

const normalizationVersionFields = [
  "reviewSourceNormalizationVersion",
  "discussionSourceNormalizationVersion",
  "discussionFeedbackNormalizationVersion",
  "defaultDeliveryNormalizationVersion",
  "relationshipPairNormalizationVersion",
  "fieldChangeNormalizationVersion",
  "triageMetadataNormalizationVersion",
];

const unavailable = () => {
  throw new Error("operator_publication_unavailable");
};
/** Bound the combined private material inspected for one diagnostic response. */
export const operatorPublicationProofBytes = 16 * 1024 * 1024;

/** Verify the actual SQL publication ledger, immutable snapshot and private
 * arithmetic confirmation. Outbox completion JSON alone cannot supply this proof.
 * The final closure is synchronous and runs under the caller's source locks. */
export function createOperatorPublicationVerifier({
  config,
  dataMode,
  policyVersion,
  computationVersion,
  scopeKey,
  publicationScopesAt,
  digest,
  approved,
  controlsStore,
  restrictConfiguration,
  confirmationMatches,
  aggregateExplanations,
  recognitionCurrent,
  configurationCurrent,
  withAuthorizedInputs,
  publicationNormalizationBinding,
}) {
  const configurationHash = digest(config);
  // The dispatcher intentionally hashes ordered configuration bytes. Its
  // operation binding and the private canonical hash are distinct contracts.
  const dispatchConfigurationHash = createHash("sha256").update(JSON.stringify(config)).digest("hex");
  return async (tx, binding) => {
    const operation = binding.operation;
    if (
      !(await approved(tx)) ||
      operation.configurationHash !== dispatchConfigurationHash ||
      operation.configurationVersion !== config.version ||
      operation.normalizationVersion !== webhookDispatchVersion ||
      operation.policyVersion !== policyVersion ||
      operation.dataMode !== dataMode ||
      binding.sourceGenerations.length !== config.repositories.length
    )
      return null;
    // The persisted event cutoff owns the scopes, independently of later read clocks.
    // Several named presets can share one concrete scope and publication.
    const scopes = new Map(publicationScopesAt(operation.cutoff).map((scope) => [scopeKey(scope), scope]));
    if (
      scopes.size !== binding.publications.length ||
      new Set(binding.publications.map((item) => item.scopeKey)).size !== scopes.size ||
      binding.publications.some((item) => !scopes.has(item.scopeKey))
    )
      return null;
    // This entry is also safe when invoked directly. Outer operator readers
    // acquire the same gates before their first source access or outbox row.
    const access = (await lockIssueTransferSources(tx, config.repositories)).filter((row) =>
      config.repositories.some((repo) => String(repo.id) === String(row.repository_id)),
    );
    if (
      access.length !== config.repositories.length ||
      !config.repositories.every((repo) =>
        access.some(
          (row) =>
            Number(row.repository_id) === repo.id &&
            String(row.installation_id) === String(repo.installationId) &&
            row.state === "public" &&
            binding.sourceGenerations.some(
              (source) => source.repositoryId === repo.id && source.generation === String(row.generation),
            ),
        ),
      ) ||
      !access.some(
        (row) =>
          Number(row.repository_id) === binding.repositoryId &&
          String(row.installation_id) === binding.installationId &&
          String(row.generation) === binding.sourceGeneration,
      )
    )
      return null;
    const publications = (
      await tx.query(
        `SELECT publication.scope_key,publication.snapshot_id,snapshot.revision,
           octet_length(snapshot.document::text) AS document_bytes
         FROM leaderboard_pipeline.dispatch_publications AS publication
         JOIN leaderboard_pipeline.snapshots AS snapshot ON snapshot.snapshot_id=publication.snapshot_id
           AND snapshot.scope_key=publication.scope_key
         WHERE publication.operation_key=$1 LIMIT 101 FOR SHARE OF publication,snapshot`,
        [operation.operationKey],
      )
    ).rows;
    if (publications.length !== binding.publications.length) return null;
    const proofs = [];
    let bytes = publications.reduce((sum, row) => sum + Number(row.document_bytes), 0);
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > operatorPublicationProofBytes) return null;
    for (const expected of binding.publications) {
      const manifest = publications.find(
        (value) => value.scope_key === expected.scopeKey && value.snapshot_id === expected.snapshotId,
      );
      if (!manifest || Number(manifest.revision) !== expected.revision) return null;
      const row = (
        await tx.query(
          "SELECT document,document_hash FROM leaderboard_pipeline.snapshots WHERE snapshot_id=$1 AND scope_key=$2",
          [expected.snapshotId, expected.scopeKey],
        )
      ).rows[0];
      if (
        !row ||
        row.document?.approvedPublic !== true ||
        row.document.snapshot?.snapshotId !== expected.snapshotId ||
        row.document.snapshot?.revision !== expected.revision ||
        row.document.snapshot?.computationVersion !== computationVersion ||
        row.document.snapshot?.metricDefinitionVersion !== policyVersion ||
        row.document.dataMode !== dataMode ||
        scopeKey(row.document.scope) !== expected.scopeKey ||
        digest(row.document) !== row.document_hash
      )
        return null;
      const confirmation = controlsStore.read().pipelinePublications?.[expected.snapshotId];
      if (!confirmationMatches(confirmation, scopes.get(expected.scopeKey), expected.snapshotId, expected.revision))
        return null;
      const normalizationVersions = {};
      for (const field of normalizationVersionFields)
        if (confirmation[field] !== undefined) normalizationVersions[field] = confirmation[field];
      const proof = aggregateExplanations.verify(expected.snapshotId, {
        scopeKey: expected.scopeKey,
        revision: expected.revision,
        computationVersion,
        configurationHash,
        digest: confirmation.aggregateExplanationHash,
      });
      bytes += Buffer.byteLength(JSON.stringify(proof));
      if (bytes > operatorPublicationProofBytes) return null;
      let transferContent = {};
      if (
        proof.document.authorization.issueTransferEvidence !== undefined ||
        proof.document.authorization.pullRequestDecisionEvidence !== undefined
      ) {
        if (typeof publicationNormalizationBinding !== "function") return null;
        const normalization = await publicationNormalizationBinding(
          tx,
          scopes.get(expected.scopeKey),
          expected,
          proof.document,
          { maxFrozenBytes: operatorPublicationProofBytes - bytes },
        );
        if (normalization.obsolete || !normalization.issueTransferContent) return null;
        bytes += normalization.frozenInputBytes;
        if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > operatorPublicationProofBytes) return null;
        // These are the hash-verified frozen repository IDs and original graph
        // capture, not a dependency set reconstructed from today's config.
        transferContent = { ...normalization.issueTransferContent, ...normalization.discussionFeedbackContent };
      }
      // Public documents omit the event cutoff and optional normalization
      // versions used to derive their content ID. Reconstruct every hashed field;
      // the private source guard below still checks actual retained evidence.
      const document = row.document;
      const content = {
        ...normalizationVersions,
        approvedPublic: true,
        scope: document.scope,
        actors: document.actors,
        rows: document.rows,
        evidence: document.evidence,
        portfolioEvidence: document.portfolioEvidence,
        pendingEvidence: document.pendingEvidence,
        ranking: document.ranking,
        diagnostics: document.diagnostics,
        methodology: document.methodology,
        definitionVersion: document.snapshot.metricDefinitionVersion,
        dataMode,
        cutoff: operation.cutoff,
        coverage: document.snapshot.coverage,
        configVersion: config.version,
        repositoryIds: config.repositories
          .filter((repo) => document.scope.repository === null || String(repo.id) === document.scope.repository)
          .map((repo) => repo.id),
        ...transferContent,
        ...(Object.hasOwn(document, "reversionAuthority") ? { reversionAuthority: document.reversionAuthority } : {}),
        ...(Object.hasOwn(document, "reversionRecordsHash")
          ? { reversionRecordsHash: document.reversionRecordsHash }
          : {}),
      };
      // These fields are part of the content ID only when the original
      // publication captured them. Preserve legacy absence; never substitute
      // a current presentation policy or synthesize a missing physical receipt.
      for (const field of [
        "rankingPresentationPolicy",
        "physicalContexts",
        "physicalEvidence",
        "reviewedWorkstreamHelp",
      ])
        if (Object.hasOwn(document, field)) content[field] = document[field];
      if (digest(content) !== expected.snapshotId) return null;
      // Identical content may reuse the first immutable arithmetic explanation
      // after a later observation freeze. A future explanation cannot authorize
      // an earlier frozen operation, and the current source/cache fence remains.
      if (
        typeof proof.document.cutoff !== "string" ||
        !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(proof.document.cutoff) ||
        new Date(proof.document.cutoff).toISOString() !== proof.document.cutoff ||
        proof.document.cutoff > binding.observationCutoff
      )
        return null;
      proofs.push({ expected, proof, normalizationVersions });
    }
    const authorizations = [
      ...new Map(
        proofs.map(({ proof }) => [digest(proof.document.authorization), proof.document.authorization]),
      ).values(),
    ];
    if (
      authorizations.reduce((sum, item) => sum + (item.identityEvidence?.normalizationHashes?.length ?? 0), 0) > 10000
    )
      return null;
    return withAuthorizedInputs(
      authorizations,
      async (removed, authority) => {
        if (!(await authority.refreshApproval())) return null;
        const confirmCurrent = () => {
          try {
            const current = configurationCurrent(binding);
            if (current && typeof current.then === "function") void Promise.resolve(current).catch(() => undefined);
            if (current !== true) return false;
            const state = controlsStore.read();
            const overlay = restrictConfiguration(state);
            if (overlay.revision !== operation.configurationRevision) return false;
            for (const { expected, proof, normalizationVersions } of proofs) {
              const confirmation = state.pipelinePublications?.[expected.snapshotId];
              if (
                !confirmationMatches(
                  confirmation,
                  scopes.get(expected.scopeKey),
                  expected.snapshotId,
                  expected.revision,
                ) ||
                confirmation.controlsConfigurationRevision !== operation.configurationRevision ||
                normalizationVersionFields.some((field) => confirmation[field] !== normalizationVersions[field]) ||
                confirmation.aggregateExplanationHash !== proof.digest ||
                !recognitionCurrent(state, confirmation) ||
                proof.document.authorization.controlsConfigurationRevision !== overlay.revision
              )
                return false;
              const saved = aggregateExplanations.verify(expected.snapshotId, {
                scopeKey: expected.scopeKey,
                revision: expected.revision,
                computationVersion,
                configurationHash,
                digest: confirmation.aggregateExplanationHash,
              });
              if (
                saved.document.references.some(
                  (reference) =>
                    state.profiles[reference.actorId]?.suppressed || removed.includes(reference.artifactId),
                ) ||
                saved.document.metrics.some((metric) => overlay.disabledMetricIds.includes(metric.metricId))
              )
                return false;
            }
            return true;
          } catch {
            return false;
          }
        };
        if (!confirmCurrent()) unavailable();
        return confirmCurrent;
      },
      tx,
    );
  };
}
