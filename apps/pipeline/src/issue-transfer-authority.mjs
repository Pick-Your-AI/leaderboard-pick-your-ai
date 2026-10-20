import {
  issueArtifactId,
  issueEndpointUrl,
  issueTransferClosure,
  expandIssueTransferSuppressions,
  validateIssueTransfers,
  validateIssueCreationScopes,
  issueTransferLimits,
} from "./issue-transfer-privacy.mjs";
import {
  lockIssueTransferGraph,
  discoverIssueTransferDependencies,
  loadRetainedIssueMetadata,
  issueTransferCapture,
  issueTransferDigest,
  validateIssueTransferCapture,
} from "./issue-transfer-store.mjs";

const check = (condition, code) => {
  if (!condition) throw new Error(code);
};
const sortedIds = (ids) => [...new Set(ids.map(String))].sort((a, b) => Number(a) - Number(b));

/** Every current normalization/dependency writer uses these same bounded gates
 * before a normalization row lock. Readers keep them through final admission. */
export async function lockIssueTransferSources(tx, repositories, mode = "share", artifactIds = [], graphMode = mode) {
  check(["share", "update"].includes(mode), "invalid_issue_transfer_lock");
  await lockIssueTransferGraph(tx, graphMode);
  const discovery = await discoverIssueTransferDependencies(tx, {
    repositoryIds: sortedIds(repositories.map((repo) => repo.id)),
    artifactIds,
  });
  const ids = discovery.repositoryIds;
  return (
    await tx.query(
      `SELECT repository_id,installation_id,state,generation FROM leaderboard_ingestion.repository_access
    WHERE repository_id=ANY($1::bigint[]) ORDER BY repository_id FOR ${mode === "share" ? "SHARE" : "UPDATE"}`,
      [ids],
    )
  ).rows;
}

const suppressionSQL = `SELECT subject_id FROM leaderboard_ingestion.object_suppressions WHERE repository_id=ANY($1::bigint[])
  UNION SELECT dependency.artifact_id FROM leaderboard_pipeline.source_artifacts dependency
  JOIN leaderboard_ingestion.source_facts fact USING(fact_key)
  JOIN leaderboard_ingestion.object_suppressions removed ON removed.repository_id=fact.repository_id AND removed.subject_id=fact.subject_id
  WHERE fact.repository_id=ANY($1::bigint[])`;

/** Current access and exact private proof determine the dependency closure.
 * An unavailable nonselected endpoint removes its component; it does not deny
 * unrelated source artifacts merely because they share that repository. */
export async function readIssueTransferAuthority(
  tx,
  { repositories, repositoryIds, artifactIds = [], cutoff = null, dataMode, mode = "share", graphMode = mode },
) {
  const selected = sortedIds(repositoryIds);
  await lockIssueTransferSources(tx, repositories, mode, artifactIds, graphMode);
  const discovery = await discoverIssueTransferDependencies(tx, { repositoryIds: selected, artifactIds, cutoff });
  // A saved artifact can reveal a newly observed alias even if neither its old
  // source nor its current dependency is configured. Recheck the complete set
  // in numeric order while the graph gate still prevents membership changes.
  const ids = sortedIds([...discovery.repositoryIds, ...repositories.map((repo) => repo.id)]);
  check(ids.length <= issueTransferLimits.repositories, "issue_transfer_repository_budget_exceeded");
  const gates = (
    await tx.query(
      `SELECT repository_id,installation_id,state,generation FROM leaderboard_ingestion.repository_access
    WHERE repository_id=ANY($1::bigint[]) ORDER BY repository_id FOR ${mode === "share" ? "SHARE" : "UPDATE"}`,
      [ids],
    )
  ).rows;
  const seeds = discovery.artifactIds;
  const publicRepo = (id) =>
    gates.some(
      (row) =>
        String(row.repository_id) === id &&
        row.state === "public" &&
        String(row.installation_id) === String(repositories.find((repo) => String(repo.id) === id)?.installationId),
    );
  const retained = await loadRetainedIssueMetadata(tx, {
    repositoryIds: selected,
    artifactIds: seeds,
    cutoff,
    dataMode,
    discovery,
  });
  const allTransfers = validateIssueTransfers(retained.flatMap((row) => row.metadata.issueTransfers));
  const closure = issueTransferClosure(allTransfers, { repositoryIds: selected, artifactIds: seeds });
  const aliases = new Set(closure.artifactIds);
  const rows = retained.filter(
    (row) =>
      row.metadata.issueTransfers.some(
        (entry) => aliases.has(entry.sourceArtifactId) || aliases.has(entry.targetArtifactId),
      ) ||
      row.metadata.issueCreationScopes.some(
        (entry) => selected.includes(entry.repositoryId) || aliases.has(entry.artifactId),
      ),
  );
  const transfers = validateIssueTransfers(rows.flatMap((row) => row.metadata.issueTransfers));
  const creationScopes = validateIssueCreationScopes(rows.flatMap((row) => row.metadata.issueCreationScopes));
  const dependencies = discovery.dependencies.filter((row) => aliases.has(row.artifact_id));
  const dependencyIds = sortedIds([
    ...selected,
    ...closure.repositoryIds,
    ...dependencies.map((row) => row.repository_id),
  ]);
  const unavailable = dependencyIds.filter((id) => !publicRepo(id));
  const direct = (await tx.query(suppressionSQL, [dependencyIds])).rows.map((row) => row.subject_id);
  direct.push(...dependencies.filter((row) => !publicRepo(String(row.repository_id))).map((row) => row.artifact_id));
  direct.push(
    ...discovery.endpoints
      .filter((entry) => {
        const repo = repositories.find((value) => String(value.id) === String(entry.repository_id));
        return !repo || !issueEndpointUrl(entry.endpoint_url, repo.slug);
      })
      .map((entry) => entry.artifact_id),
  );
  direct.push(
    ...(
      await tx.query(
        "SELECT artifact_id FROM leaderboard_pipeline.issue_transfer_unavailable WHERE artifact_id=ANY($1::text[])",
        [closure.artifactIds],
      )
    ).rows.map((row) => row.artifact_id),
  );
  const expanded = expandIssueTransferSuppressions(transfers, {
    artifactIds: direct.filter(issueArtifactId),
    unavailableRepositoryIds: unavailable,
  });
  const removed = [...new Set([...direct, ...expanded])].sort();
  const sourceAccess = gates.filter((row) => dependencyIds.includes(String(row.repository_id)));
  const capture = issueTransferCapture(rows, { repositoryIds: selected, artifactIds: seeds });
  const fingerprint = issueTransferDigest({ capture, repositoryIds: dependencyIds, access: sourceAccess, removed });
  return {
    selectedRepositoryIds: selected,
    repositoryIds: dependencyIds,
    artifactIds: seeds,
    rows,
    transfers,
    creationScopes,
    access: sourceAccess,
    removed,
    capture,
    fingerprint,
    selectedPublic: selected.every(publicRepo),
  };
}

/** Old immutable correction receipts remain the authority. A projected alias
 * exemption is valid only when its exact exclusion was effective in this same
 * already hash-bound capture; copying a proposed mapping is insufficient. */
export function issueTransferCorrectionExempt(authorization, correction) {
  const original = correction.document.fact;
  const direct = authorization.corrections?.some(
    (saved) => saved.artifactId === correction.artifact_id && saved.hash === issueTransferDigest(original),
  );
  if (direct) return true;
  return (
    authorization.issueTransferCorrections?.some(
      (mapping) =>
        mapping.artifactId === correction.artifact_id &&
        mapping.hash === issueTransferDigest(original) &&
        authorization.corrections?.some(
          (saved) => saved.artifactId === mapping.projectionArtifactId && saved.hash === mapping.projectionHash,
        ),
    ) === true
  );
}

export function captureIssueTransferAuthorization(authorization, corrections) {
  if (authorization.issueTransferEvidence === undefined) return {};
  const evidence = validateIssueTransferCapture(authorization.issueTransferEvidence);
  const mappings = authorization.issueTransferCorrections ?? [];
  check(
    Array.isArray(mappings) && mappings.length <= issueTransferLimits.records,
    "invalid_issue_transfer_correction_authority",
  );
  for (const entry of mappings)
    check(
      entry &&
        Object.keys(entry).sort().join(",") === "artifactId,hash,projectionArtifactId,projectionHash" &&
        issueArtifactId(entry.artifactId) &&
        issueArtifactId(entry.projectionArtifactId) &&
        [entry.hash, entry.projectionHash].every(
          (value) => typeof value === "string" && value.length === 64 && !/[^a-f0-9]/.test(value),
        ),
      "invalid_issue_transfer_correction_authority",
    );
  return {
    issueTransferEvidence: evidence,
    issueTransferCorrections: mappings
      .filter((mapping) =>
        corrections.some(
          (saved) => saved.artifactId === mapping.projectionArtifactId && saved.hash === mapping.projectionHash,
        ),
      )
      .map((entry) => ({ ...entry })),
  };
}
