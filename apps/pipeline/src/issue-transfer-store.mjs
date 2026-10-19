import { createHash } from "node:crypto";
import {
  validateIssueTransfers,
  validateIssueCreationScopes,
  issueEndpointUrl,
  issueArtifactId,
  issueTransferLimits,
} from "./issue-transfer-privacy.mjs";

export const issueTransferMetadataVersion = "pipeline-issue-transfer/v1";
const canonical = (value) =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(",")}]`
    : value !== null && typeof value === "object"
      ? `{${Object.keys(value)
          .sort()
          .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
          .join(",")}}`
      : JSON.stringify(value);
export const issueTransferDigest = (value) => createHash("sha256").update(canonical(value)).digest("hex");
const check = (condition, code = "invalid_private_issue_transfer_metadata") => {
  if (!condition) throw new Error(code);
};
const hash = (value) => typeof value === "string" && value.length === 64 && !/[^a-f0-9]/.test(value);
const observationFields = [
  "id",
  "source",
  "action",
  "artifactId",
  "occurredAt",
  "observedAt",
  "sourceRevision",
  "sourceUrl",
];
const observed = (row) => new Date(row.observed_at).toISOString();
const sourceArtifact = (row, id) =>
  id === row.subject_id || (/^[1-9][0-9]*$/.test(row.subject_id) && id === `github:issue:${row.subject_id}`);
const eventObservation = (eventId) =>
  `gh:${createHash("sha256")
    .update(JSON.stringify(["event", eventId]))
    .digest("hex")}`;
const present = (doc) =>
  doc.issueTransferMetadataVersion !== undefined ||
  doc.issueTransfers !== undefined ||
  doc.issueCreationScopes !== undefined ||
  doc.issueTransferObservations !== undefined;

/** Minimize and bind the protected producer records before persistence. The
 * original source observation and an approved endpoint coordinate are required;
 * arbitrary generic lineage never enters this projection. */
export function privateIssueTransferMetadata(output, row, repository, repositories, previous = null) {
  const transfers = validateIssueTransfers([...(previous?.issueTransfers ?? []), ...(output.issueTransfers ?? [])]);
  const scopes = validateIssueCreationScopes([
    ...(previous?.issueCreationScopes ?? []),
    ...(output.issueCreationScopes ?? []),
  ]);
  if (!transfers.length && !scopes.length) return {};
  check(transfers.length <= 100 && scopes.length <= 100);
  const candidates = [
    ...(previous?.issueTransferObservations ?? []),
    ...(output.observations ?? output.issueTransferObservations ?? []),
  ];
  check(Array.isArray(candidates) && candidates.length <= 200);
  const observations = new Map();
  for (const entry of candidates) {
    if (![...transfers, ...scopes].some((binding) => binding.observationId === entry?.id)) continue;
    const selected = Object.fromEntries(observationFields.map((field) => [field, entry[field]]));
    check(observationFields.every((field) => Object.hasOwn(entry, field)));
    if (observations.has(entry.id)) check(canonical(observations.get(entry.id)) === canonical(selected));
    observations.set(entry.id, selected);
  }
  const repositoryId = String(row.repository_id);
  check(String(repository.id) === repositoryId);
  const bindObservation = (entry, artifactId, action) => {
    const observation = observations.get(entry.observationId);
    check(
      observation &&
        observation.artifactId === artifactId &&
        sourceArtifact(row, artifactId) &&
        observation.action === action &&
        ["github_webhook", "github_graphql", "github_rest"].includes(observation.source) &&
        observation.sourceRevision === entry.sourceRevision &&
        entry.sourceRevision === row.source_revision &&
        observation.observedAt === entry.observedAt &&
        entry.observedAt === observed(row) &&
        observation.occurredAt === entry.occurredAt &&
        issueEndpointUrl(observation.sourceUrl, repository.slug) &&
        observation.sourceUrl === row.document.sourceUrl &&
        (entry.eventId === null || entry.observationId === eventObservation(entry.eventId)),
    );
    return observation;
  };
  for (const entry of transfers) {
    const observation = bindObservation(entry, entry.sourceArtifactId, "transferred");
    const target = repositories.find((repo) => String(repo.id) === entry.targetRepositoryId);
    check(
      entry.sourceRepositoryId === repositoryId &&
        entry.sourceUrl === observation.sourceUrl &&
        target &&
        issueEndpointUrl(entry.targetUrl, target.slug),
    );
  }
  for (const entry of scopes) {
    const observation = bindObservation(entry, entry.artifactId, "opened");
    check(
      observation.source === "github_webhook" &&
        entry.repositoryId === repositoryId &&
        (output.facts ?? previous?.facts ?? []).some(
          (fact) =>
            fact.id === entry.factId &&
            fact.metricId === "issues_opened" &&
            fact.artifactId === entry.artifactId &&
            fact.repoId === repositoryId &&
            fact.occurredAt === entry.occurredAt &&
            fact.observedAt === entry.observedAt,
        ),
    );
  }
  return {
    issueTransferMetadataVersion,
    issueTransfers: transfers,
    issueCreationScopes: scopes,
    issueTransferObservations: [...observations.values()].sort((a, b) => a.id.localeCompare(b.id)),
  };
}

/** Validate historical proof against its original immutable source coordinates.
 * Current configuration is a separate permission check: removing a repository
 * must not erase private dependency identity or approve its retained actors. */
function retainedMetadata(row) {
  check(row.document && issueTransferDigest(row.document) === row.document_hash, "issue_transfer_integrity_error");
  if (!present(row.document)) return null;
  check(row.document.issueTransferMetadataVersion === issueTransferMetadataVersion);
  const transfers = validateIssueTransfers(row.document.issueTransfers);
  const scopes = validateIssueCreationScopes(row.document.issueCreationScopes);
  check(transfers.length + scopes.length > 0);
  check(Array.isArray(row.document.issueTransferObservations));
  // These exact retained coordinates supply identity only, never live access.
  const source = row.source_document ?? row.sourceDocument;
  check(source && String(row.repository_id) !== "undefined" && row.source_revision && row.subject_id);
  const sourceUrl = source.sourceUrl;
  check(issueEndpointUrl(sourceUrl));
  const slug = new URL(sourceUrl).pathname.split("/").slice(1, 3).join("/");
  const repository = { id: Number(row.repository_id), slug };
  const coordinates = [
    repository,
    ...transfers.map((entry) => ({
      id: Number(entry.targetRepositoryId),
      slug: new URL(entry.targetUrl).pathname.split("/").slice(1, 3).join("/"),
    })),
  ];
  const metadata = privateIssueTransferMetadata(
    { ...row.document, observations: row.document.issueTransferObservations },
    { ...row, document: source },
    repository,
    coordinates,
  );
  for (const key of [
    "issueTransferMetadataVersion",
    "issueTransfers",
    "issueCreationScopes",
    "issueTransferObservations",
  ])
    check(canonical(metadata[key]) === canonical(row.document[key]));
  return metadata;
}

const indexSchema = `CREATE TABLE leaderboard_pipeline.issue_transfer_index (
  fact_key text NOT NULL REFERENCES leaderboard_ingestion.source_facts(fact_key),
  policy_signature text NOT NULL, repository_id bigint NOT NULL CHECK(repository_id>0),
  document_hash text NOT NULL CHECK(document_hash ~ '^[a-f0-9]{64}$'),
  PRIMARY KEY(fact_key,policy_signature),
  FOREIGN KEY(fact_key,policy_signature) REFERENCES leaderboard_pipeline.normalizations(fact_key,policy_signature)
)`;
const endpointSchema = `CREATE TABLE leaderboard_pipeline.issue_transfer_endpoints (
  fact_key text NOT NULL, policy_signature text NOT NULL,
  repository_id bigint NOT NULL CHECK(repository_id>0),
  artifact_id text NOT NULL CHECK(length(artifact_id) BETWEEN 1 AND 200 AND artifact_id !~ '[^A-Za-z0-9_=.:-]'),
  endpoint_url text NOT NULL,
  PRIMARY KEY(fact_key,policy_signature,repository_id,artifact_id,endpoint_url),
  FOREIGN KEY(fact_key,policy_signature) REFERENCES leaderboard_pipeline.issue_transfer_index(fact_key,policy_signature)
)`;
const unavailableSchema = `CREATE TABLE leaderboard_pipeline.issue_transfer_unavailable (
  artifact_id text PRIMARY KEY CHECK(length(artifact_id) BETWEEN 1 AND 200 AND artifact_id !~ '[^A-Za-z0-9_=.:-]')
)`;
const migrationVersion = "pipeline-issue-transfer-index/v1";
const migrationHash = issueTransferDigest([migrationVersion, indexSchema, endpointSchema, unavailableSchema]);

/** Graph membership changes take this gate before any repository or
 * normalization lock. Readers share it through final source admission, so a
 * previously unconfigured endpoint cannot appear between discovery and use. */
export async function lockIssueTransferGraph(tx, mode = "share") {
  check(["share", "update"].includes(mode), "invalid_issue_transfer_lock");
  await tx.query(
    `SELECT ${mode === "share" ? "pg_advisory_xact_lock_shared" : "pg_advisory_xact_lock"}(hashtextextended('pipeline-issue-transfer-graph/v1',0))`,
  );
}

function metadataEndpoints(metadata) {
  const values = [];
  for (const entry of metadata.issueTransfers) {
    values.push({ repositoryId: entry.sourceRepositoryId, artifactId: entry.sourceArtifactId, url: entry.sourceUrl });
    values.push({ repositoryId: entry.targetRepositoryId, artifactId: entry.targetArtifactId, url: entry.targetUrl });
  }
  for (const entry of metadata.issueCreationScopes) {
    const observation = metadata.issueTransferObservations.find((value) => value.id === entry.observationId);
    check(observation, "invalid_private_issue_transfer_metadata");
    values.push({ repositoryId: entry.repositoryId, artifactId: entry.artifactId, url: observation.sourceUrl });
  }
  return [...new Map(values.map((value) => [canonical(value), value])).values()].sort((a, b) =>
    canonical(a).localeCompare(canonical(b)),
  );
}

async function retainEndpoints(tx, row, signature, metadata) {
  for (const entry of metadataEndpoints(metadata))
    await tx.query(
      `INSERT INTO leaderboard_pipeline.issue_transfer_endpoints(fact_key,policy_signature,repository_id,artifact_id,endpoint_url)
    VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
      [row.fact_key, signature, entry.repositoryId, entry.artifactId, entry.url],
    );
  const saved = (
    await tx.query(
      "SELECT repository_id,artifact_id,endpoint_url FROM leaderboard_pipeline.issue_transfer_endpoints WHERE fact_key=$1 AND policy_signature=$2",
      [row.fact_key, signature],
    )
  ).rows
    .map((value) => ({
      repositoryId: String(value.repository_id),
      artifactId: value.artifact_id,
      url: value.endpoint_url,
    }))
    .sort((a, b) => canonical(a).localeCompare(canonical(b)));
  check(canonical(saved) === canonical(metadataEndpoints(metadata)), "issue_transfer_endpoint_index_conflict");
}

/** Relational discovery never examines mutable normalization JSON. Only an
 * explicitly selected repository seeds a component by repository; discovered
 * repositories do not pull in unrelated issues merely by sharing that scope.
 * Caller holds the graph gate before discovery and then locks the complete
 * returned repository set in numeric order before reading proof documents. */
export async function discoverIssueTransferDependencies(tx, { repositoryIds, artifactIds = [], cutoff = null }) {
  check(
    Array.isArray(repositoryIds) && repositoryIds.length <= issueTransferLimits.repositories,
    "issue_transfer_repository_budget_exceeded",
  );
  check(
    Array.isArray(artifactIds) &&
      artifactIds.length <= issueTransferLimits.records &&
      artifactIds.every(issueArtifactId),
    "issue_transfer_artifact_budget_exceeded",
  );
  const shared = (
    await tx.query(
      `SELECT DISTINCT a.artifact_id FROM leaderboard_pipeline.source_artifacts a
    JOIN leaderboard_ingestion.source_facts f USING(fact_key) WHERE f.repository_id=ANY($1::bigint[])
    AND (EXISTS(SELECT 1 FROM leaderboard_pipeline.source_artifacts other JOIN leaderboard_ingestion.source_facts origin USING(fact_key)
      WHERE other.artifact_id=a.artifact_id AND origin.repository_id<>f.repository_id)
      OR EXISTS(SELECT 1 FROM leaderboard_pipeline.issue_transfer_unavailable gone WHERE gone.artifact_id=a.artifact_id))
    LIMIT 10001`,
      [repositoryIds],
    )
  ).rows
    .map((row) => row.artifact_id)
    .filter(issueArtifactId);
  const seeds = [...new Set([...artifactIds, ...shared])].sort();
  check(seeds.length <= issueTransferLimits.records, "issue_transfer_artifact_budget_exceeded");
  const pointers = (
    await tx.query(
      `WITH RECURSIVE reachable(fact_key,policy_signature) AS (
      SELECT endpoint.fact_key,endpoint.policy_signature FROM leaderboard_pipeline.issue_transfer_endpoints endpoint
      JOIN leaderboard_ingestion.source_facts source USING(fact_key)
      WHERE (endpoint.repository_id=ANY($1::bigint[]) OR endpoint.artifact_id=ANY($2::text[]))
        AND ($3::timestamptz IS NULL OR source.observed_at<=$3)
      UNION
      SELECT next.fact_key,next.policy_signature FROM reachable known
      JOIN leaderboard_pipeline.issue_transfer_endpoints own USING(fact_key,policy_signature)
      JOIN leaderboard_pipeline.issue_transfer_endpoints next ON next.artifact_id=own.artifact_id
      JOIN leaderboard_ingestion.source_facts source ON source.fact_key=next.fact_key
      WHERE ($3::timestamptz IS NULL OR source.observed_at<=$3)
    ) SELECT fact_key,policy_signature FROM reachable LIMIT 10001`,
      [repositoryIds, seeds, cutoff],
    )
  ).rows;
  check(pointers.length <= issueTransferLimits.records, "issue_transfer_history_budget_exceeded");
  const keys = pointers.map((row) => row.fact_key),
    signatures = pointers.map((row) => row.policy_signature);
  const endpoints = (
    await tx.query(
      `SELECT endpoint.* FROM leaderboard_pipeline.issue_transfer_endpoints endpoint
    JOIN unnest($1::text[],$2::text[]) AS selected(fact_key,policy_signature) USING(fact_key,policy_signature)
    LIMIT 20001`,
      [keys, signatures],
    )
  ).rows;
  check(endpoints.length <= issueTransferLimits.rawRecords, "issue_transfer_endpoint_budget_exceeded");
  const aliases = [...new Set([...seeds, ...endpoints.map((row) => row.artifact_id)])].sort();
  check(aliases.length <= issueTransferLimits.records, "issue_transfer_artifact_budget_exceeded");
  const dependencies = (
    await tx.query(
      `SELECT DISTINCT source.repository_id,artifact.artifact_id FROM leaderboard_pipeline.source_artifacts artifact
    JOIN leaderboard_ingestion.source_facts source USING(fact_key) WHERE artifact.artifact_id=ANY($1::text[]) LIMIT 10001`,
      [aliases],
    )
  ).rows;
  check(dependencies.length <= issueTransferLimits.records, "issue_transfer_dependency_budget_exceeded");
  const ids = [
    ...new Set([
      ...repositoryIds.map(String),
      ...endpoints.map((row) => String(row.repository_id)),
      ...dependencies.map((row) => String(row.repository_id)),
    ]),
  ].sort((a, b) => Number(a) - Number(b));
  check(ids.length <= issueTransferLimits.repositories, "issue_transfer_repository_budget_exceeded");
  return { repositoryIds: ids, artifactIds: seeds, aliases, pointers, endpoints, dependencies };
}

/** Explicit installation migration. The one-time legacy walk is paged and
 * checks hashes BEFORE examining JSON metadata, including empty/absent arrays.
 * It does not put a 10,000-row cap on unrelated historic normalization caches. */
export async function migrateIssueTransferMetadata(db) {
  return db.transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('pipeline-issue-transfer-index-migration',0))");
    await tx.query(
      "CREATE TABLE IF NOT EXISTS leaderboard_pipeline.issue_transfer_migrations(version text PRIMARY KEY,fingerprint text NOT NULL)",
    );
    const prior = (
      await tx.query("SELECT fingerprint FROM leaderboard_pipeline.issue_transfer_migrations WHERE version=$1", [
        migrationVersion,
      ])
    ).rows[0];
    if (prior) {
      check(prior.fingerprint === migrationHash, "issue_transfer_migration_changed");
      check(
        (await tx.query("SELECT to_regclass('leaderboard_pipeline.issue_transfer_index') AS name")).rows[0]?.name,
        "issue_transfer_index_unavailable",
      );
      return;
    }
    // Installation serializes against existing repository writers before table
    // mutation. This is an administrative migration, not a public read path.
    await lockIssueTransferGraph(tx, "update");
    await tx.query(
      "SELECT repository_id FROM leaderboard_ingestion.repository_access ORDER BY repository_id FOR UPDATE",
    );
    await tx.query("LOCK TABLE leaderboard_pipeline.normalizations IN SHARE ROW EXCLUSIVE MODE");
    await tx.query(indexSchema);
    await tx.query(endpointSchema);
    await tx.query(unavailableSchema);
    await tx.query(
      "CREATE INDEX issue_transfer_repository ON leaderboard_pipeline.issue_transfer_index(repository_id)",
    );
    await tx.query(
      "CREATE INDEX issue_transfer_endpoint_repository ON leaderboard_pipeline.issue_transfer_endpoints(repository_id)",
    );
    await tx.query(
      "CREATE INDEX issue_transfer_endpoint_artifact ON leaderboard_pipeline.issue_transfer_endpoints(artifact_id)",
    );
    let after = null;
    for (;;) {
      const rows = (
        await tx.query(
          `SELECT n.*,f.repository_id,f.subject_id,f.source_revision,f.document AS source_document,f.observed_at,f.first_run_id
        FROM leaderboard_pipeline.normalizations n LEFT JOIN leaderboard_ingestion.source_facts f USING(fact_key)
        WHERE ($1::text IS NULL OR (n.fact_key,n.policy_signature)>($1,$2)) ORDER BY n.fact_key,n.policy_signature LIMIT 256`,
          after ?? [null, null],
        )
      ).rows;
      for (const row of rows) {
        check(issueTransferDigest(row.document) === row.document_hash, "issue_transfer_integrity_error");
        if (!present(row.document)) continue;
        const metadata = retainedMetadata(row);
        await tx.query(
          "INSERT INTO leaderboard_pipeline.issue_transfer_index(fact_key,policy_signature,repository_id,document_hash) VALUES($1,$2,$3,$4)",
          [row.fact_key, row.policy_signature, row.repository_id, row.document_hash],
        );
        await retainEndpoints(tx, row, row.policy_signature, metadata);
      }
      if (rows.length < 256) break;
      after = [rows.at(-1).fact_key, rows.at(-1).policy_signature];
    }
    await tx.query("INSERT INTO leaderboard_pipeline.issue_transfer_migrations(version,fingerprint) VALUES($1,$2)", [
      migrationVersion,
      migrationHash,
    ]);
  });
}

/** Called in the same source-locked transaction as normalization persistence.
 * An update must retain previous typed bindings; absence cannot delete proof. */
export async function retainIssueTransferIndex(tx, row, signature, document) {
  if (!present(document)) {
    check(
      !(
        await tx.query(
          "SELECT 1 FROM leaderboard_pipeline.issue_transfer_index WHERE fact_key=$1 AND policy_signature=$2",
          [row.fact_key, signature],
        )
      ).rows.length,
      "issue_transfer_proof_removed",
    );
    return;
  }
  const metadata = retainedMetadata({
    ...row,
    document,
    document_hash: issueTransferDigest(document),
    source_document: row.document,
  });
  const saved = await tx.query(
    `INSERT INTO leaderboard_pipeline.issue_transfer_index(fact_key,policy_signature,repository_id,document_hash)
    VALUES($1,$2,$3,$4) ON CONFLICT(fact_key,policy_signature) DO UPDATE SET document_hash=EXCLUDED.document_hash
    WHERE issue_transfer_index.repository_id=EXCLUDED.repository_id RETURNING fact_key,policy_signature,repository_id,document_hash`,
    [row.fact_key, signature, row.repository_id, issueTransferDigest(document)],
  );
  check(
    saved.rows.length === 1 &&
      saved.rows[0].fact_key === row.fact_key &&
      saved.rows[0].policy_signature === signature &&
      String(saved.rows[0].repository_id) === String(row.repository_id) &&
      saved.rows[0].document_hash === issueTransferDigest(document),
    "issue_transfer_index_write_conflict",
  );
  await retainEndpoints(tx, row, signature, metadata);
}

/** Caller holds all configured repository access gates before acquiring these
 * shared normalization locks. Selection never examines mutable JSON fields. */
export async function loadRetainedIssueMetadata(
  tx,
  { repositoryIds, artifactIds = [], cutoff = null, dataMode = null, discovery = null },
) {
  check(Array.isArray(repositoryIds) && repositoryIds.length <= issueTransferLimits.repositories);
  discovery ??= await discoverIssueTransferDependencies(tx, { repositoryIds, artifactIds, cutoff });
  const rows = (
    await tx.query(
      `SELECT n.*,i.repository_id AS indexed_repository_id,i.document_hash AS indexed_document_hash,
      f.repository_id,f.subject_id,f.source_revision,f.document AS source_document,f.observed_at,f.first_run_id
    FROM leaderboard_pipeline.issue_transfer_index i
    JOIN leaderboard_pipeline.normalizations n USING(fact_key,policy_signature)
    JOIN leaderboard_ingestion.source_facts f USING(fact_key)
    JOIN unnest($1::text[],$2::text[]) AS selected(fact_key,policy_signature) USING(fact_key,policy_signature)
    ORDER BY i.fact_key,i.policy_signature LIMIT 10001 FOR SHARE OF i,n`,
      [discovery.pointers.map((row) => row.fact_key), discovery.pointers.map((row) => row.policy_signature)],
    )
  ).rows;
  check(rows.length <= issueTransferLimits.records, "issue_transfer_history_budget_exceeded");
  check(rows.length === discovery.pointers.length, "issue_transfer_index_unavailable");
  return rows.map((row) => {
    check(
      String(row.repository_id) === String(row.indexed_repository_id) &&
        row.document_hash === row.indexed_document_hash,
      "issue_transfer_integrity_error",
    );
    check(
      dataMode === null || row.document.isSynthetic === (dataMode === "synthetic"),
      "issue_transfer_data_mode_mismatch",
    );
    const metadata = retainedMetadata(row);
    check(metadata, "issue_transfer_proof_removed");
    const endpoints = discovery.endpoints
      .filter((entry) => entry.fact_key === row.fact_key && entry.policy_signature === row.policy_signature)
      .map((entry) => ({
        repositoryId: String(entry.repository_id),
        artifactId: entry.artifact_id,
        url: entry.endpoint_url,
      }))
      .sort((a, b) => canonical(a).localeCompare(canonical(b)));
    check(canonical(endpoints) === canonical(metadataEndpoints(metadata)), "issue_transfer_endpoint_integrity_error");
    return {
      document: row.document,
      metadata,
      repositoryId: String(row.repository_id),
      source: { factKey: row.fact_key, observedAt: observed(row), runId: row.first_run_id },
      binding: { factKey: row.fact_key, policySignature: row.policy_signature, documentHash: row.document_hash },
    };
  });
}

export function issueTransferCapture(rows, { repositoryIds = [], artifactIds = [] } = {}) {
  return {
    schemaVersion: issueTransferMetadataVersion,
    selectedRepositoryIds: [...new Set(repositoryIds.map(String))].sort((a, b) => Number(a) - Number(b)),
    artifactIds: [...new Set(artifactIds)].sort(),
    bindings: rows.map((row) => row.binding).sort((a, b) => canonical(a).localeCompare(canonical(b))),
  };
}
export function validateIssueTransferCapture(saved) {
  check(
    saved?.schemaVersion === issueTransferMetadataVersion &&
      Object.keys(saved).sort().join(",") === "artifactIds,bindings,schemaVersion,selectedRepositoryIds" &&
      Array.isArray(saved.bindings) &&
      saved.bindings.length <= issueTransferLimits.records,
    "issue_transfer_frozen_binding_invalid",
  );
  check(
    Array.isArray(saved.selectedRepositoryIds) &&
      saved.selectedRepositoryIds.length <= issueTransferLimits.repositories &&
      saved.selectedRepositoryIds.every(
        (id) => typeof id === "string" && /^[1-9][0-9]*$/.test(id) && Number.isSafeInteger(Number(id)),
      ) &&
      new Set(saved.selectedRepositoryIds).size === saved.selectedRepositoryIds.length,
    "issue_transfer_frozen_binding_invalid",
  );
  check(
    Array.isArray(saved.artifactIds) &&
      saved.artifactIds.length <= issueTransferLimits.records &&
      saved.artifactIds.every(issueArtifactId) &&
      new Set(saved.artifactIds).size === saved.artifactIds.length,
    "issue_transfer_frozen_binding_invalid",
  );
  check(
    saved.bindings.every(
      (binding) =>
        Object.keys(binding).sort().join(",") === "documentHash,factKey,policySignature" &&
        hash(binding.documentHash) &&
        hash(binding.factKey) &&
        hash(binding.policySignature),
    ) && new Set(saved.bindings.map(canonical)).size === saved.bindings.length,
    "issue_transfer_frozen_binding_invalid",
  );
  return structuredClone(saved);
}
export function assertIssueTransferCapture(saved, rows, repositoryIds = null) {
  validateIssueTransferCapture(saved);
  if (repositoryIds !== null)
    check(
      canonical(saved.selectedRepositoryIds) ===
        canonical([...new Set(repositoryIds.map(String))].sort((a, b) => Number(a) - Number(b))),
      "issue_transfer_frozen_scope_changed",
    );
  const current = new Set(rows.map((row) => canonical(row.binding)));
  check(
    saved.bindings.every((binding) => current.has(canonical(binding))),
    "issue_transfer_frozen_binding_unavailable",
  );
}

/** Before an authorized eraser takes its owning repository lock, discover all
 * immutable endpoint gates in numeric order. Retirement already prevents new
 * source normalizations; the shared eraser advisory gate serializes deletions. */
export async function lockIssueTransferRetirementDependencies(tx, repositoryId) {
  const present = (await tx.query("SELECT to_regclass('leaderboard_pipeline.issue_transfer_index') AS name")).rows[0]
    ?.name;
  if (!present) return;
  await lockIssueTransferGraph(tx, "update");
  const discovery = await discoverIssueTransferDependencies(tx, { repositoryIds: [repositoryId] });
  await tx.query(
    "SELECT repository_id FROM leaderboard_ingestion.repository_access WHERE repository_id=ANY($1::bigint[]) ORDER BY repository_id FOR UPDATE",
    [discovery.repositoryIds],
  );
  // Validate every discovered indexed document before any owned erasure. A
  // malformed old edge cannot disappear just because its endpoint is retired.
  await loadRetainedIssueMetadata(tx, { repositoryIds: [repositoryId], discovery });
}

/** The eraser has independently authenticated the exact normalization row and
 * source retirement. Keep only unavailable endpoint IDs before proof deletion;
 * existing deletion reasons and all original receipts remain immutable. */
export async function retireIssueTransferMetadata(tx, row) {
  const presentIndex = (await tx.query("SELECT to_regclass('leaderboard_pipeline.issue_transfer_index') AS name"))
    .rows[0]?.name;
  if (!presentIndex) return;
  const indexed = (
    await tx.query(
      "SELECT * FROM leaderboard_pipeline.issue_transfer_index WHERE fact_key=$1 AND policy_signature=$2",
      [row.fact_key, row.policy_signature],
    )
  ).rows[0];
  const source = (await tx.query("SELECT * FROM leaderboard_ingestion.source_facts WHERE fact_key=$1", [row.fact_key]))
    .rows[0];
  check(source && issueTransferDigest(row.document) === row.document_hash, "issue_transfer_integrity_error");
  const endpoints = new Map();
  if (indexed) {
    check(
      indexed.document_hash === row.document_hash && String(indexed.repository_id) === String(source.repository_id),
      "issue_transfer_integrity_error",
    );
    const metadata = retainedMetadata({ ...source, ...row, source_document: source.document });
    check(metadata, "issue_transfer_proof_removed");
    for (const entry of metadataEndpoints(metadata))
      endpoints.set(JSON.stringify([entry.repositoryId, entry.artifactId]), [entry.repositoryId, entry.artifactId]);
  } else check(!present(row.document), "issue_transfer_index_unavailable");
  // Equal native IDs need no enriched edge. Keep the minimal unavailable issue
  // identity even when this is the last source_artifacts row for its retired
  // repository; later observations in other repositories must still withdraw.
  for (const fact of row.document.facts ?? []) {
    if (
      typeof fact.metricId === "string" &&
      (fact.metricId.startsWith("issues_") || fact.metricId === "issue_transfers") &&
      issueArtifactId(fact.artifactId)
    )
      endpoints.set(JSON.stringify([String(source.repository_id), fact.artifactId]), [
        String(source.repository_id),
        fact.artifactId,
      ]);
  }
  if (source.family === "issues")
    for (const entry of (
      await tx.query("SELECT artifact_id FROM leaderboard_pipeline.source_artifacts WHERE fact_key=$1", [row.fact_key])
    ).rows) {
      if (issueArtifactId(entry.artifact_id))
        endpoints.set(JSON.stringify([String(source.repository_id), entry.artifact_id]), [
          String(source.repository_id),
          entry.artifact_id,
        ]);
    }
  for (const [repositoryId, artifactId] of endpoints.values()) {
    check(issueArtifactId(artifactId));
    await tx.query(
      "INSERT INTO leaderboard_pipeline.issue_transfer_unavailable(artifact_id) VALUES($1) ON CONFLICT DO NOTHING",
      [artifactId],
    );
    await tx.query(
      "INSERT INTO leaderboard_ingestion.object_suppressions(repository_id,subject_id,reason) VALUES($1,$2,'unavailable') ON CONFLICT DO NOTHING",
      [repositoryId, artifactId],
    );
  }
  if (indexed) {
    await tx.query(
      "DELETE FROM leaderboard_pipeline.issue_transfer_endpoints WHERE fact_key=$1 AND policy_signature=$2",
      [row.fact_key, row.policy_signature],
    );
    await tx.query(
      "DELETE FROM leaderboard_pipeline.issue_transfer_index WHERE fact_key=$1 AND policy_signature=$2 AND document_hash=$3",
      [row.fact_key, row.policy_signature, row.document_hash],
    );
  }
}
