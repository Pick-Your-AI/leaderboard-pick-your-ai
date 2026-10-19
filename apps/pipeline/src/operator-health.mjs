import { reconciliationHealthRows } from "./source-health.mjs";

const numeric = (value) =>
  value !== null && value !== undefined && value !== "" && Number.isSafeInteger(Number(value)) && Number(value) >= 0
    ? Number(value)
    : null;
const elapsed = (start, end) =>
  start !== null && end !== null && end >= start ? (Date.parse(end) - Date.parse(start)) / 1000 : null;
const resources = ["core", "search", "code_search", "graphql", "unknown"];
const unavailableQuota = () => ({ state: "unavailable", scopeKey: null, resources: [] });

function quotaProjection(raw, observed, timestamp) {
  if (
    !raw ||
    !/^[a-f0-9]{64}$/.test(raw.scopeKey) ||
    !Array.isArray(raw.resources) ||
    raw.resources.length !== resources.length ||
    new Set(raw.resources.map((item) => item?.resource)).size !== resources.length ||
    raw.resources.some((item) => !resources.includes(item?.resource))
  )
    return unavailableQuota();
  return {
    state: "available",
    scopeKey: raw.scopeKey,
    resources: resources.map((resource) => {
      const item = raw.resources.find((value) => value.resource === resource);
      const unknown = (state = "unavailable") => ({ resource, state, observation: null });
      if (["unknown", "unavailable"].includes(item.state) && item.observation === null) return unknown(item.state);
      const value = item.observation;
      if (
        item.state !== "observed" ||
        !value ||
        observed(value.observedAt) === null ||
        !Number.isInteger(value.responseStatus) ||
        value.responseStatus < 100 ||
        value.responseStatus > 599 ||
        ["limit", "remaining", "used", "retryAfterSeconds"].some(
          (key) => value[key] !== null && numeric(value[key]) !== value[key],
        ) ||
        (value.resetAt !== null && timestamp(value.resetAt) === null)
      )
        return unknown();
      return {
        resource,
        state: "observed",
        observation: {
          observedAt: value.observedAt,
          responseStatus: value.responseStatus,
          limit: value.limit,
          remaining: value.remaining,
          used: value.used,
          resetAt: value.resetAt,
          retryAfterSeconds: value.retryAfterSeconds,
        },
      };
    }),
  };
}

/** Fixed private diagnostics for a currently authorized repository generation.
 * No request, token acquisition, source payload or inference from an empty queue. */
export async function readOperatorHealth(
  tx,
  { scope, repository, asOf, freshnessBudgetSeconds, protocol, readQuota, verifyPublications, reconciliationProgress },
) {
  const timestamp = protocol.operationTime;
  if (timestamp(asOf) === null) throw new Error("invalid_operation_time");
  const observed = (value) => {
    const parsed = timestamp(value);
    return parsed !== null && parsed <= asOf ? parsed : null;
  };
  const fresh = (value) => value !== null && elapsed(value, asOf) <= freshnessBudgetSeconds;
  const families = [...new Set(repository.families)].sort();
  const rows =
    reconciliationProgress === undefined
      ? (
          await tx.query(
            `SELECT wanted.family,latest.state,latest.reason,latest.attempted_at,latest.item_count,latest.expected_count,
       successful.last_success_at,successful.until_at
     FROM unnest($3::text[]) AS wanted(family)
     LEFT JOIN LATERAL (
       SELECT state,reason,attempted_at,item_count,expected_count FROM leaderboard_ingestion.collection_runs
       WHERE repository_id=$1 AND access_generation=$2 AND family=wanted.family
       ORDER BY COALESCE(attempted_at,until_at) DESC,until_at DESC,run_id DESC LIMIT 1
     ) AS latest ON true
     LEFT JOIN LATERAL (
       SELECT last_success_at,until_at FROM leaderboard_ingestion.collection_runs
       WHERE repository_id=$1 AND access_generation=$2 AND family=wanted.family AND state='complete'
         AND last_success_at IS NOT NULL
       ORDER BY last_success_at DESC,until_at DESC,run_id DESC LIMIT 1
     ) AS successful ON true`,
            [scope.repositoryId, scope.generation, families],
          )
        ).rows
      : reconciliationHealthRows(reconciliationProgress);
  if (
    reconciliationProgress !== undefined &&
    rows.some(
      (row) => String(row.repository_id) !== String(scope.repositoryId) || row.access_generation !== scope.generation,
    )
  )
    throw new Error("operation_health_unavailable");
  const collection = families.map((family) => {
    const row = rows.find((value) => value.family === family) ?? {};
    const lastAttemptAt = observed(row.attempted_at);
    const lastSuccessAt = observed(row.last_success_at);
    const reconciledThrough = observed(row.until_at);
    const items = numeric(row.item_count),
      expectedItems = numeric(row.expected_count);
    let state = "unknown",
      reason = "no_current_attempt";
    if (lastAttemptAt !== null && row.state === "failed") {
      state = row.reason === "source_read_failed" ? "disconnected" : "degraded";
      reason = ["source_read_failed", "source_schema_drift", "source_commit_failed"].includes(row.reason)
        ? row.reason
        : "collection_failed";
    } else if (lastAttemptAt !== null && !fresh(lastAttemptAt)) {
      state = "overdue";
      reason = "attempt_overdue";
    } else if (lastAttemptAt !== null && row.state === "pending") {
      state = "collecting";
      reason = "partial_collection";
    } else if (lastAttemptAt !== null && row.state === "complete") {
      if (reconciliationProgress !== undefined && row.window_complete !== true) {
        reason = "no_current_attempt";
      } else if (lastSuccessAt === null || reconciledThrough === null) {
        reason = "completion_time_unknown";
      } else if (
        reconciliationProgress !== undefined &&
        (observed(row.last_window_end) === null || reconciledThrough < observed(row.last_window_end))
      ) {
        reason = "reconciliation_gap";
      } else if (!fresh(lastSuccessAt) || !fresh(reconciledThrough)) {
        state = "overdue";
        reason = "reconciliation_overdue";
      } else if (items === 0 && expectedItems === 0) {
        state = "quiet";
        reason = "completed_empty_window";
      } else if (items === null || expectedItems === null || items !== expectedItems) {
        reason = "source_count_unknown";
      } else {
        state = "progress";
        reason = "completed_observed_window";
      }
    }
    return { family, state, reason, lastAttemptAt, lastSuccessAt, reconciledThrough, items, expectedItems };
  });
  const collectorState =
    ["disconnected", "degraded", "overdue", "unknown", "collecting"].find((state) =>
      collection.some((row) => row.state === state),
    ) ?? (collection.every((row) => row.state === "quiet") ? "quiet" : "progress");
  const parameters = [String(scope.repositoryId), scope.installationId];
  const intake =
    (
      await tx.query(
        `SELECT count(*) AS retained,count(*) FILTER(WHERE state='pending') AS pending,
       count(*) FILTER(WHERE state='leased') AS leased,count(*) FILTER(WHERE state='quarantined') AS quarantined,
       min(received_at) FILTER(WHERE state IN ('pending','leased','quarantined')) AS oldest_pending
     FROM leaderboard_ingestion.inbox WHERE envelope->>'repositoryId'=$1 AND envelope->>'installationId'=$2`,
        parameters,
      )
    ).rows[0] ?? {};
  const latest =
    (
      await tx.query(
        `SELECT received_at,envelope->>'occurredAt' AS source_at FROM leaderboard_ingestion.inbox
     WHERE envelope->>'repositoryId'=$1 AND envelope->>'installationId'=$2
     ORDER BY received_at DESC,delivery_id DESC LIMIT 1`,
        parameters,
      )
    ).rows[0] ?? {};
  const publication =
    (
      await tx.query(
        `SELECT count(*) FILTER(WHERE notice.state='pending') AS pending,count(*) FILTER(WHERE notice.state='leased') AS leased,
       count(*) FILTER(WHERE notice.state='quarantined') AS quarantined,
       min(notice.created_at) FILTER(WHERE notice.state IN ('pending','leased','quarantined')) AS oldest_pending
     FROM leaderboard_ingestion.outbox AS notice JOIN leaderboard_ingestion.inbox AS intake
       ON notice.event_key='github:delivery:' || intake.delivery_id::text
     WHERE intake.envelope->>'repositoryId'=$1 AND intake.envelope->>'installationId'=$2`,
        parameters,
      )
    ).rows[0] ?? {};
  const completed = (
    await tx.query(
      `SELECT notice.event_key,notice.operation,notice.completion,notice.observation_cutoff,notice.source_generations,
       intake.received_at,finished.completed_at
     FROM leaderboard_ingestion.outbox AS notice JOIN leaderboard_ingestion.inbox AS intake
       ON notice.event_key='github:delivery:' || intake.delivery_id::text
     JOIN LATERAL (SELECT max(finished_at) AS completed_at FROM leaderboard_ingestion.outbox_attempts
       WHERE event_key=notice.event_key AND outcome='done') AS finished ON true
     WHERE intake.envelope->>'repositoryId'=$1 AND intake.envelope->>'installationId'=$2 AND notice.state='done'
     ORDER BY finished.completed_at DESC NULLS LAST,notice.event_key DESC LIMIT 1`,
      parameters,
    )
  ).rows[0];
  const oldestIntake = observed(intake.oldest_pending),
    oldestPublication = observed(publication.oldest_pending);
  const receivedAt = observed(latest.received_at),
    sourceAt = observed(latest.source_at);
  const health = {
    asOf,
    freshnessBudgetSeconds,
    collector: { state: collectorState, families: collection },
    intake: {
      retained: numeric(intake.retained),
      pending: numeric(intake.pending),
      leased: numeric(intake.leased),
      quarantined: numeric(intake.quarantined),
      oldestPendingAt: oldestIntake,
      queueAgeSeconds: elapsed(oldestIntake, asOf),
      latestReceivedAt: receivedAt,
      latestSourceAt: sourceAt,
      lagSeconds: elapsed(sourceAt, receivedAt),
    },
    publication: {
      pending: numeric(publication.pending),
      leased: numeric(publication.leased),
      quarantined: numeric(publication.quarantined),
      oldestPendingAt: oldestPublication,
      queueAgeSeconds: elapsed(oldestPublication, asOf),
      state: completed ? "unavailable" : "unknown",
      completedAt: null,
      delaySeconds: null,
      policyVersion: null,
      publications: [],
    },
    quota: quotaProjection(await readQuota(), observed, timestamp),
  };
  let confirmCurrent = () => true;
  if (completed) {
    const operation = protocol.parseDispatchOperation(completed.operation, completed.event_key);
    const publications = operation && protocol.parseDispatchPublications(completed.completion, operation.operationKey);
    const generations = protocol.parseDispatchGenerations(completed.source_generations);
    const cutoff = observed(completed.observation_cutoff),
      completedAt = observed(completed.completed_at);
    const intakeAt = observed(completed.received_at);
    if (
      operation &&
      publications &&
      generations &&
      cutoff !== null &&
      completedAt !== null &&
      intakeAt !== null &&
      cutoff <= completedAt &&
      operation.cutoff <= completedAt &&
      intakeAt <= completedAt
    ) {
      let verified;
      try {
        verified = await verifyPublications(tx, {
          repositoryId: scope.repositoryId,
          installationId: scope.installationId,
          sourceGeneration: scope.generation,
          receiptId: null,
          eventKey: completed.event_key,
          operation,
          observationCutoff: cutoff,
          sourceGenerations: generations,
          publications: structuredClone(publications),
        });
      } catch {
        /* The fixed unavailable result does not include verifier errors. */
      }
      if (typeof verified === "function") {
        confirmCurrent = verified;
        Object.assign(health.publication, {
          state: "verified",
          completedAt,
          delaySeconds: elapsed(intakeAt, completedAt),
          policyVersion: operation.policyVersion,
          publications,
        });
      }
    }
  }
  return { health, confirmCurrent };
}
