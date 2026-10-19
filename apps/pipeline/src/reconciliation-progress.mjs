import { sourceFamilies } from "../../../packages/ingestion/dist/index.js";

const fail = () => {
  throw new Error("reconciliation_progress_integrity_error");
};
const instant = (value) => {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    fail();
  return value;
};
const timestamp = (value) => (value === null ? null : instant(value));
const count = (value) => {
  if (value === null) return null;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) fail();
  return number;
};

/** Completed interval receipts establish bounded progress, never complete source history.
 * SQL compares original timestamps before projecting observation clocks to milliseconds.
 * A later successful disjoint interval cannot bridge an unobserved gap.
 * A completed full traversal rotates even with an unknown total; only exact counts
 * establish a coverage baseline. Both clocks retain the saved event-window cutoff.
 */
export async function readReconciliationProgress(
  tx,
  repositories,
  observationCutoff,
  { contextDigest, untilCutoff = observationCutoff } = {},
) {
  instant(observationCutoff);
  instant(untilCutoff);
  if (untilCutoff > observationCutoff || !/^[a-f0-9]{64}$/.test(contextDigest ?? "")) fail();
  if (!Array.isArray(repositories) || repositories.length < 1 || repositories.length > 100) fail();
  const requested = [];
  const ids = new Set();
  for (const repo of repositories) {
    if (
      !Number.isSafeInteger(repo.id) ||
      repo.id < 1 ||
      ids.has(repo.id) ||
      !Number.isSafeInteger(repo.installationId) ||
      repo.installationId < 1 ||
      !Array.isArray(repo.families) ||
      !repo.families.length ||
      repo.families.some((family) => !sourceFamilies.includes(family))
    )
      fail();
    ids.add(repo.id);
    for (const family of new Set(repo.families))
      requested.push({
        repository_id: repo.id,
        installation_id: repo.installationId,
        family,
      });
  }
  if (requested.length > 1200) fail();
  const rows = (
    await tx.query(
      `WITH wanted AS (
      SELECT * FROM jsonb_to_recordset($1::jsonb)
        AS item(repository_id bigint,installation_id bigint,family text)
    ), available AS (
      SELECT wanted.*,access.generation
      FROM wanted LEFT JOIN leaderboard_ingestion.repository_access AS access
        ON access.repository_id=wanted.repository_id
        AND access.installation_id=wanted.installation_id AND access.state='public'
    ), scoped AS MATERIALIZED (
      SELECT run.*,
        CASE WHEN run_id ~ '^rc1:[a-f0-9]{64}:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}:[0-9]{4}:[0-9]{4}$'
          THEN split_part(run_id,':',5)::integer BETWEEN 1 AND 1200
            AND split_part(run_id,':',4)::integer < split_part(run_id,':',5)::integer
          ELSE false END AS identity_valid,
        isfinite(until_at) AND date_trunc('milliseconds',until_at)=until_at
          AND (since_at IS NULL OR (isfinite(since_at)
            AND date_trunc('milliseconds',since_at)=since_at AND since_at<until_at))
          AND ((mode='audit' AND since_at IS NULL) OR (mode='reconcile' AND since_at IS NOT NULL
            AND run.family IN ('issues','comments','project_history','relationships'))) AS bounds_valid
      FROM leaderboard_ingestion.collection_runs AS run JOIN available
        ON run.repository_id=available.repository_id AND run.family=available.family
        AND run.access_generation=available.generation
      WHERE run.run_id LIKE $4
    ), latest AS (
      SELECT DISTINCT ON (repository_id,family) run_id,repository_id,family,state,reason,
        attempted_at,item_count,expected_count,page_count,cursor,until_at
      FROM scoped
      WHERE until_at<=$3 AND (attempted_at IS NULL OR (isfinite(attempted_at) AND attempted_at<=$2))
      ORDER BY repository_id,family,COALESCE(attempted_at,until_at) DESC,until_at DESC,run_id DESC
    ), integrity AS (
      SELECT repository_id,family,bool_and(identity_valid AND bounds_valid) AS valid
      FROM scoped GROUP BY repository_id,family
    ), terminal AS (
      SELECT * FROM scoped
      WHERE identity_valid AND bounds_valid AND state='complete' AND cursor IS NULL
        AND page_count>0 AND item_count>=0 AND (expected_count IS NULL OR expected_count=item_count)
        AND last_success_at IS NOT NULL AND isfinite(last_success_at)
        AND last_success_at>=until_at AND last_success_at<=$2 AND until_at<=$3
    ), observations AS (
      SELECT repository_id,family,max(until_at) FILTER(WHERE since_at IS NULL) AS full_audit_at,
        max(last_success_at) AS successful_at
      FROM terminal GROUP BY repository_id,family
    ), complete AS (
      SELECT * FROM terminal WHERE expected_count IS NOT NULL
    ), baselines AS (
      SELECT repository_id,family,max(until_at) FILTER(WHERE since_at IS NULL) AS baseline
      FROM complete GROUP BY repository_id,family
    ), intervals AS (
      SELECT complete.repository_id,complete.family,complete.since_at,complete.until_at,baselines.baseline,
        max(complete.until_at) OVER (PARTITION BY complete.repository_id,complete.family
          ORDER BY complete.since_at,complete.until_at,complete.run_id
          ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS previous_end
      FROM complete JOIN baselines USING(repository_id,family)
      WHERE baselines.baseline IS NOT NULL AND complete.since_at IS NOT NULL
        AND complete.until_at>baselines.baseline
    ), gaps AS (
      SELECT repository_id,family,min(since_at)
        FILTER(WHERE since_at>GREATEST(baseline,previous_end)) AS first_gap
      FROM intervals GROUP BY repository_id,family
    ), advancement AS (
      SELECT intervals.repository_id,intervals.family,max(intervals.until_at)
        FILTER(WHERE gaps.first_gap IS NULL OR intervals.since_at<gaps.first_gap) AS through_at
      FROM intervals JOIN gaps USING(repository_id,family)
      GROUP BY intervals.repository_id,intervals.family
    ) SELECT available.repository_id,available.family,available.generation::text AS generation,
      COALESCE(integrity.valid,true) AS valid,latest.state,latest.reason,
      latest_complete.run_id IS NOT NULL AS window_complete,
      latest.item_count,latest.expected_count,latest.page_count,
      to_char(observations.full_audit_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS full_audit_at,
      to_char(GREATEST(baselines.baseline,advancement.through_at) AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS through_at,
      to_char(observations.successful_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS successful_at,
      to_char(latest.until_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS window_end_at,
      CASE WHEN isfinite(latest.attempted_at) AND latest.attempted_at<=$2 THEN
        to_char(latest.attempted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END AS attempted_at
    FROM available LEFT JOIN baselines USING(repository_id,family)
    LEFT JOIN observations USING(repository_id,family)
    LEFT JOIN advancement USING(repository_id,family) LEFT JOIN latest USING(repository_id,family)
    LEFT JOIN integrity USING(repository_id,family)
    LEFT JOIN terminal AS latest_complete ON latest_complete.run_id=latest.run_id
    ORDER BY available.repository_id,available.family`,
      [JSON.stringify(requested), observationCutoff, untilCutoff, `rc1:${contextDigest}:%`],
    )
  ).rows;
  if (rows.length !== requested.length) fail();
  return rows.map((row) => {
    if (
      row.valid !== true ||
      typeof row.window_complete !== "boolean" ||
      !requested.some((item) => String(item.repository_id) === String(row.repository_id) && item.family === row.family)
    )
      fail();
    if (row.generation !== null && !/^[1-9]\d{0,18}$/.test(row.generation)) fail();
    return {
      repositoryId: Number(row.repository_id),
      family: row.family,
      generation: row.generation,
      lastFullAuditAt: timestamp(row.full_audit_at),
      reconciledThrough: timestamp(row.through_at),
      lastSuccessfulSync: timestamp(row.successful_at),
      lastWindowEnd: timestamp(row.window_end_at),
      windowComplete: row.window_complete,
      lastAttemptAt: timestamp(row.attempted_at),
      state: row.state,
      reason: row.reason,
      itemCount: count(row.item_count),
      expectedCount: count(row.expected_count),
      pageCount: count(row.page_count),
    };
  });
}

/** Every required family must have an established completed baseline. */
export const leastReconciliationTime = (values) =>
  values.length && values.every((value) => value !== null) ? [...values].sort()[0] : null;
