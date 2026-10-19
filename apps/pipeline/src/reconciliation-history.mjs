import { githubRestSnapshotSemanticRevision } from "@pick-your-ai/github";

const restPattern = "^(gh-rest-v1|gh-rest-comment-v2):([a-f0-9]{64})\\.([a-f0-9]{32})$";
const snapshotPattern = "^[a-f0-9]{64}\\.[a-f0-9]{32}$";
const planPattern = "^rc1:[a-f0-9]{64}:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}:[0-9]{4}:[0-9]{4}$";
const restFamilies = ["issues", "pull_requests", "comments", "releases"];
const snapshotFamilies = ["reviews", "discussions", "project_current"];
const fail = (code) => {
  throw new Error(code);
};

/**
 * Preserve legacy history entries literally. New REST observations and the
 * explicitly planned existing snapshot families compare consecutive content,
 * across every collection mode. Their fresh fact keys still retain each actual
 * observation for selection, normalization and restart; page.changed_count is
 * still the number of inserted observations, not this semantic-change count.
 */
export async function readImportedHistory(db, repositoryIds, observationCutoff) {
  if (
    !Array.isArray(repositoryIds) ||
    repositoryIds.length < 1 ||
    repositoryIds.length > 100 ||
    repositoryIds.some((id) => !Number.isSafeInteger(id) || id < 1) ||
    new Set(repositoryIds).size !== repositoryIds.length ||
    typeof observationCutoff !== "string" ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(observationCutoff) ||
    new Date(observationCutoff).toISOString() !== observationCutoff
  )
    fail("reconciliation_history_scope_invalid");
  const rows = (
    await db.query(
      `WITH source AS (
        SELECT fact.first_run_id, fact.fact_key, fact.repository_id, fact.family,
          fact.subject_id, fact.source_revision, fact.observed_at, run.mode,
          run.access_generation,
          fact.source_revision ~ $3 AS rest_revision,
          fact.source_revision LIKE 'gh-rest-%' AS reserved_revision,
          CASE WHEN fact.first_run_id ~ $4 THEN
            substring(fact.first_run_id FROM 112 FOR 4)::integer BETWEEN 1 AND 1200
            AND substring(fact.first_run_id FROM 107 FOR 4)::integer
              < substring(fact.first_run_id FROM 112 FOR 4)::integer
            ELSE false END AS planned,
          fact.first_run_id LIKE 'rc1:%' AS reserved_plan,
          (fact.family = ANY($5::text[]) AND
            (fact.source_revision NOT LIKE 'gh-rest-comment-v2:%' OR fact.family='comments')) AS rest_family,
          fact.family = ANY($6::text[]) AS snapshot_family,
          fact.source_revision ~ $7 AS snapshot_revision
        FROM leaderboard_ingestion.source_facts AS fact
        JOIN leaderboard_ingestion.collection_runs AS run ON run.run_id=fact.first_run_id
        WHERE fact.repository_id=ANY($1::bigint[]) AND fact.observed_at <= $2
      ), classified AS (
        SELECT source.*,
          (rest_revision OR (planned AND snapshot_family AND snapshot_revision)) AS semantic_accounting,
          CASE WHEN rest_revision THEN split_part(source_revision, '.', 1)
            WHEN snapshot_family AND snapshot_revision THEN substring(source_revision FROM 1 FOR 64)
            ELSE NULL END AS semantic_revision
        FROM source
      ), ordered AS (
        SELECT classified.*,
          lag(semantic_revision) OVER (
            PARTITION BY repository_id, family, subject_id, access_generation
            ORDER BY observed_at, fact_key
          ) AS previous_semantic_revision,
          count(*) OVER (
            PARTITION BY repository_id, family, subject_id, access_generation, observed_at
          ) AS simultaneous_observations
        FROM classified
      )
      SELECT first_run_id, fact_key, family, source_revision, semantic_revision,
        semantic_accounting, simultaneous_observations, reserved_revision,
        rest_revision, rest_family, planned, reserved_plan, snapshot_family, snapshot_revision
      FROM ordered
      WHERE (reserved_revision AND (NOT rest_revision OR NOT rest_family))
        OR (reserved_plan AND NOT planned)
        OR (planned AND snapshot_family AND NOT snapshot_revision)
        OR (semantic_accounting AND simultaneous_observations > 1)
        OR (mode IN ('backfill','audit') AND
          (NOT semantic_accounting OR semantic_revision IS DISTINCT FROM previous_semantic_revision))
      ORDER BY first_run_id, fact_key LIMIT 10001`,
      [repositoryIds, observationCutoff, restPattern, planPattern, restFamilies, snapshotFamilies, snapshotPattern],
    )
  ).rows;
  if (rows.length > 10_000) fail("reconciliation_history_budget_exceeded");
  for (const row of rows) {
    if (
      (row.reserved_revision &&
        (!row.rest_revision ||
          !row.rest_family ||
          githubRestSnapshotSemanticRevision(row.source_revision) !== row.semantic_revision)) ||
      (row.reserved_plan && !row.planned) ||
      (row.planned && row.snapshot_family && !row.snapshot_revision)
    )
      fail("reconciliation_history_revision_unverified");
    // A UUID or fact hash is not an occurrence-order receipt. Do not silently
    // decide whether an audit introduced content when observation clocks tie.
    if (row.semantic_accounting && Number(row.simultaneous_observations) > 1)
      fail("reconciliation_history_observation_order_ambiguous");
  }
  return rows.map((row) => [row.first_run_id, row.fact_key]);
}
