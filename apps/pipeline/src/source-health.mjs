const timestamp = (value) => (value instanceof Date ? value.toISOString() : null);
const oldest = (values) => (values.length && values.every((value) => value !== null) ? values.sort()[0] : null);

/** Read inside the publication read's repository-access locks and final authority fence.
 * These are current repository collection receipts, never historical coverage or connectivity proof.
 */
export async function readCurrentSourceHealth(tx, repositories, now) {
  const requested = repositories.flatMap((repo) =>
    [...new Set(repo.families)].map((family) => ({
      repository_id: repo.id,
      installation_id: repo.installationId,
      family,
    })),
  );
  const runs = (
    await tx.query(
      `WITH wanted AS (
        SELECT * FROM jsonb_to_recordset($1::jsonb) AS item(repository_id bigint,installation_id bigint,family text)
      ) SELECT wanted.repository_id,wanted.family,latest.state,latest.attempted_at,latest.item_count,latest.expected_count,
        successful.last_success_at,successful.until_at
      FROM wanted JOIN leaderboard_ingestion.repository_access AS access
        ON access.repository_id=wanted.repository_id AND access.installation_id=wanted.installation_id AND access.state='public'
      LEFT JOIN LATERAL (
        SELECT state,attempted_at,item_count,expected_count FROM leaderboard_ingestion.collection_runs AS run
        WHERE run.repository_id=wanted.repository_id AND run.family=wanted.family AND run.access_generation=access.generation
        ORDER BY COALESCE(attempted_at,until_at) DESC,until_at DESC,run_id DESC LIMIT 1
      ) AS latest ON true
      LEFT JOIN LATERAL (
        SELECT last_success_at,until_at FROM leaderboard_ingestion.collection_runs AS run
        WHERE run.repository_id=wanted.repository_id AND run.family=wanted.family AND run.access_generation=access.generation
          AND run.state='complete' AND run.last_success_at IS NOT NULL
        ORDER BY last_success_at DESC,until_at DESC,run_id DESC LIMIT 1
      ) AS successful ON true`,
      [JSON.stringify(requested)],
    )
  ).rows;
  const inbox = (
    await tx.query(
      `WITH wanted AS (
        SELECT * FROM jsonb_to_recordset($1::jsonb) AS item(repository_id bigint,installation_id bigint,family text)
      ) SELECT wanted.repository_id,count(delivery.delivery_id)::integer AS retained,
        min(delivery.received_at) FILTER (WHERE delivery.state IN ('pending','leased','quarantined')) AS oldest_pending,
        bool_or(delivery.state='quarantined') AS quarantined
      FROM wanted JOIN leaderboard_ingestion.repository_access AS access
        ON access.repository_id=wanted.repository_id AND access.installation_id=wanted.installation_id AND access.state='public'
      LEFT JOIN leaderboard_ingestion.inbox AS delivery
        ON delivery.envelope->>'repositoryId'=wanted.repository_id::text
        AND delivery.envelope->>'installationId'=wanted.installation_id::text
        AND delivery.envelope->>'version'='github-delivery/v1'
        AND delivery.envelope->>'event'=CASE wanted.family WHEN 'issues' THEN 'issues' WHEN 'pull_requests' THEN 'pull_request' END
      GROUP BY wanted.repository_id`,
      [JSON.stringify(requested)],
    )
  ).rows;
  return repositories.map((repo) => {
    const families = runs.filter((row) => String(row.repository_id) === String(repo.id));
    const receipt = inbox.find((row) => String(row.repository_id) === String(repo.id));
    const pending = timestamp(receipt?.oldest_pending);
    const lag = pending === null ? null : (Date.parse(now) - Date.parse(pending)) / 1000;
    const webhookState = !receipt?.retained
      ? "unknown"
      : receipt.quarantined
        ? "degraded"
        : lag !== null && lag < 0
          ? "unknown"
          : pending === null
            ? "idle"
            : "pending";
    const state = families.some((row) => row.state === "failed")
      ? "degraded"
      : families.length !== new Set(repo.families).size || families.some((row) => row.state == null)
        ? "unknown"
        : families.some((row) => row.state !== "complete")
          ? "collecting"
          : families.every((row) => row.item_count === 0 && row.expected_count === 0)
            ? "no_activity_in_window"
            : "reconciled";
    return {
      scopeId: String(repo.id),
      state,
      lastAttemptAt:
        families
          .map((row) => timestamp(row.attempted_at))
          .filter((value) => value !== null)
          .sort()
          .at(-1) ?? null,
      lastSuccessfulSync: oldest(families.map((row) => timestamp(row.last_success_at))),
      reconciledThrough: oldest(families.map((row) => timestamp(row.until_at))),
      webhookLagSeconds:
        webhookState === "unknown" ? null : pending === null ? 0 : lag !== null && lag >= 0 ? Math.floor(lag) : null,
      webhookState,
    };
  });
}
