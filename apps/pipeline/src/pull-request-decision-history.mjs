import { createHash } from "node:crypto";
import {
  compareSourceInstants,
  pullRequestDecisionBindingSchema,
  pullRequestDecisionGenerationSchema,
  pullRequestDecisionInstantSchema,
} from "@pick-your-ai/contracts";
import {
  capturePullRequestDecisionHistory,
  validatePullRequestDecisionHistory,
  selectPullRequestDecisionAsOf,
} from "@pick-your-ai/github";
import {
  githubRestSnapshotSemanticRevision,
  hasGithubRestSnapshotPrefix,
} from "../../../packages/github/dist/rest-snapshot.js";
import {
  parsePullRequestDecisionObservation,
  collectionPullRequestDecisionObservation,
  assertPullRequestDecisionPersistence,
  pullRequestDecisionObservationVersion,
  pullRequestDecisionProducerBinding,
} from "../../../packages/ingestion/dist/pull-request-decision-observation.js";
import { copyParticipationHistoryJSON } from "./participation-history.mjs";

export const pullRequestDecisionGenerationVersion = "pipeline-pr-decision-generations/v1";
const fail = (code) => {
  throw new Error(code);
};
const token = (value) => typeof value === "string" && /^[A-Za-z0-9_=.:/-]{1,512}$/.test(value);
const hash = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const positive = (value) => Number.isSafeInteger(value) && value > 0;
const instant = (value) => pullRequestDecisionInstantSchema.safeParse(value).success;
const canonical = (value) =>
  value && typeof value === "object"
    ? Array.isArray(value)
      ? value.map(canonical)
      : Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical(value[key])]),
        )
    : value;
const digest = (value) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
const exact = (value, names) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).length === names.length &&
  names.every((name) => Object.hasOwn(value, name));
const semanticRevision = (value) => {
  const semantic = githubRestSnapshotSemanticRevision(value);
  if (hasGithubRestSnapshotPrefix(value) && semantic === null) fail("decision_history_source_revision_invalid");
  return semantic ?? value;
};

/** Fixed host enrollment, separate from configuration or public metric activation. */
export function decisionHistoryRepositories(value, repositories) {
  if (value === undefined) return [];
  const selected = copyParticipationHistoryJSON(value);
  if (
    !Array.isArray(selected) ||
    selected.length > 1000 ||
    selected.some(
      (id) => !positive(id) || !repositories.some((repo) => repo.id === id && repo.families.includes("pull_requests")),
    ) ||
    new Set(selected).size !== selected.length
  )
    fail("decision_history_repository_selection_invalid");
  return selected.sort((a, b) => a - b);
}

/** The actual native producer runs here, after the outer REST inventory selects
 * this PR. Callers cannot install a receipt-returning callback in its place. */
export async function captureDecisionObservation({
  client,
  source,
  repository,
  request,
  fact,
  payload,
  now,
  assertAuthorized,
}) {
  assertAuthorized();
  const author = payload.user;
  const binding = pullRequestDecisionBindingSchema.parse({
    repository: { id: repository.id, slug: repository.slug },
    pullNumber: payload.number,
    subject: {
      id: payload.node_id,
      databaseId: payload.id,
      url: payload.html_url,
      createdAt: payload.created_at,
      author: author === null ? null : { id: author?.node_id, databaseId: author?.id, kind: author?.type },
    },
    source,
    semanticRevision: semanticRevision(fact.sourceRevision),
  });
  const generation = pullRequestDecisionGenerationSchema.parse({
    scanId: request.runId,
    asOf: request.until,
    cutoffMode: "exclusive",
  });
  if (fact.subjectId !== binding.subject.id || fact.sourceUrl !== binding.subject.url)
    fail("decision_history_selected_subject_changed");
  const result = await capturePullRequestDecisionHistory({
    client,
    source,
    repository: binding.repository,
    pullNumber: binding.pullNumber,
    expectedSubject: binding.subject,
    semanticRevision: binding.semanticRevision,
    scanId: generation.scanId,
    asOf: generation.asOf,
    now,
    assertAuthorized,
  });
  assertAuthorized();
  // An unavailable result has no invented capture clocks, digest, or decision.
  const observation = parsePullRequestDecisionObservation({
    schemaVersion: pullRequestDecisionObservationVersion,
    sourceRevision: fact.sourceRevision,
    binding,
    generation,
    result,
  });
  if (
    observation.result.status === "captured" &&
    validatePullRequestDecisionHistory(observation.result.receipt, { binding, generation }).status !== "validated"
  )
    fail("decision_history_native_receipt_invalid");
  assertAuthorized();
  return observation;
}

/** This compact private binding never includes timelines, authors or decisions. */
export function parseDecisionGenerationCapture(value) {
  const capture = copyParticipationHistoryJSON(value);
  if (
    !exact(capture, ["schemaVersion", "source", "asOf", "observationCutoff", "runs"]) ||
    capture.schemaVersion !== pullRequestDecisionGenerationVersion ||
    !token(capture.source) ||
    !instant(capture.asOf) ||
    !instant(capture.observationCutoff) ||
    compareSourceInstants(capture.asOf, capture.observationCutoff) > 0 ||
    !Array.isArray(capture.runs) ||
    capture.runs.length === 0 ||
    capture.runs.length > 1000
  )
    fail("decision_history_capture_invalid");
  const repositories = new Set();
  const runIds = new Set();
  const keys = new Set();
  let count = 0;
  for (const run of capture.runs) {
    if (
      !exact(run, ["repositoryId", "runId", "accessGeneration", "completedAt", "observations"]) ||
      !positive(run.repositoryId) ||
      !token(run.runId) ||
      typeof run.accessGeneration !== "string" ||
      !/^[1-9][0-9]{0,30}$/.test(run.accessGeneration) ||
      !instant(run.completedAt) ||
      compareSourceInstants(capture.asOf, run.completedAt) > 0 ||
      compareSourceInstants(run.completedAt, capture.observationCutoff) > 0 ||
      repositories.has(run.repositoryId) ||
      runIds.has(run.runId) ||
      !Array.isArray(run.observations) ||
      (count += run.observations.length) > 10000
    )
      fail("decision_history_capture_invalid");
    repositories.add(run.repositoryId);
    runIds.add(run.runId);
    const subjects = new Set();
    for (const observation of run.observations) {
      if (
        !exact(observation, ["factKey", "subjectId", "sourceRevision", "observedAt", "observationHash"]) ||
        !hash(observation.factKey) ||
        !hash(observation.observationHash) ||
        !token(observation.subjectId) ||
        !token(observation.sourceRevision) ||
        !instant(observation.observedAt) ||
        compareSourceInstants(capture.asOf, observation.observedAt) > 0 ||
        compareSourceInstants(observation.observedAt, run.completedAt) > 0 ||
        keys.has(observation.factKey) ||
        subjects.has(observation.subjectId)
      )
        fail("decision_history_capture_invalid");
      keys.add(observation.factKey);
      subjects.add(observation.subjectId);
    }
  }
  return capture;
}

export const pullRequestDecidedProjectionVersion = "pipeline-pr-decided-projection/v1";

/** Private window selection and fact hashes, never native events or public authority. */
export function parseDecisionProjection(value, capture) {
  const projection = copyParticipationHistoryJSON(value);
  const retained = parseDecisionGenerationCapture(capture);
  if (
    !exact(projection, ["schemaVersion", "asOf", "captureHash", "factHashes"]) ||
    projection.schemaVersion !== pullRequestDecidedProjectionVersion ||
    !instant(projection.asOf) ||
    compareSourceInstants(projection.asOf, retained.asOf) > 0 ||
    projection.captureHash !== digest(retained) ||
    !Array.isArray(projection.factHashes) ||
    projection.factHashes.length > 10000 ||
    projection.factHashes.some((value) => !hash(value)) ||
    new Set(projection.factHashes).size !== projection.factHashes.length ||
    JSON.stringify(projection.factHashes) !== JSON.stringify([...projection.factHashes].sort())
  )
    fail("decision_history_projection_invalid");
  return projection;
}

export function decisionGenerationAuthorization(authorization) {
  if (authorization.pullRequestDecisionEvidence === undefined) {
    if (authorization.pullRequestDecisionProjection !== undefined) fail("decision_history_projection_invalid");
    return {};
  }
  const capture = parseDecisionGenerationCapture(authorization.pullRequestDecisionEvidence);
  return {
    pullRequestDecisionEvidence: capture,
    ...(authorization.pullRequestDecisionProjection === undefined
      ? {}
      : {
          pullRequestDecisionProjection: parseDecisionProjection(authorization.pullRequestDecisionProjection, capture),
        }),
  };
}

const payloadColumns = [
  "fact_key",
  "repository_id",
  "family",
  "subject_id",
  "source_revision",
  "document",
  "first_run_id",
  "observed_at",
  "run_id",
  "data_mode",
];

/** Exact selected runs, including empty inventories. SQL withholds every payload
 * column before decoding an oversized result; structural admission precedes hash.
 * The bound is admitted SQL-text payload, not database work or total JS heap. */
export async function readDecisionGenerations(
  tx,
  {
    selectedRuns,
    repositories,
    source,
    asOf,
    observationCutoff,
    dataMode,
    assertAuthorized,
    expected = null,
    selectionAsOf = asOf,
  },
) {
  const selected = copyParticipationHistoryJSON(selectedRuns);
  if (
    !Array.isArray(selected) ||
    selected.length === 0 ||
    selected.length > 1000 ||
    !instant(asOf) ||
    !instant(selectionAsOf) ||
    compareSourceInstants(selectionAsOf, asOf) > 0 ||
    !instant(observationCutoff) ||
    compareSourceInstants(asOf, observationCutoff) > 0 ||
    !token(source) ||
    !["public", "synthetic"].includes(dataMode) ||
    selected.some(
      (run) =>
        !exact(run, ["repositoryId", "runId"]) ||
        !positive(run.repositoryId) ||
        !token(run.runId) ||
        !repositories.some((repo) => repo.id === run.repositoryId && repo.families.includes("pull_requests")),
    ) ||
    new Set(selected.map((run) => run.repositoryId)).size !== selected.length ||
    new Set(selected.map((run) => run.runId)).size !== selected.length
  )
    fail("decision_history_selected_run_invalid");
  const saved = expected === null ? null : parseDecisionGenerationCapture(expected);
  if (saved && (saved.source !== source || saved.asOf !== asOf || saved.observationCutoff !== observationCutoff))
    fail("decision_history_capture_binding_changed");
  assertAuthorized();
  const runs = (
    await tx.query(
      `SELECT r.run_id,r.repository_id,r.family,r.state,r.item_count,r.expected_count,r.decision_producer,
        to_char(r.until_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS until_exact,
        to_char(r.last_success_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS completed_exact,
        r.access_generation,a.state AS access_state,a.generation AS current_generation
      FROM leaderboard_ingestion.collection_runs AS r
      JOIN leaderboard_ingestion.repository_access AS a USING(repository_id)
      WHERE r.run_id=ANY($1::text[]) ORDER BY r.repository_id,r.run_id FOR SHARE OF r,a`,
      [selected.map((run) => run.runId)],
    )
  ).rows;
  assertAuthorized();
  if (
    runs.length !== selected.length ||
    runs.some(
      (run) =>
        !selected.some((entry) => entry.runId === run.run_id && entry.repositoryId === Number(run.repository_id)) ||
        run.family !== "pull_requests" ||
        run.state !== "complete" ||
        run.access_state !== "public" ||
        String(run.access_generation) !== String(run.current_generation) ||
        run.decision_producer !== pullRequestDecisionProducerBinding(source, dataMode) ||
        !instant(run.until_exact) ||
        compareSourceInstants(run.until_exact, asOf) !== 0 ||
        run.expected_count === null ||
        !Number.isSafeInteger(Number(run.item_count)) ||
        Number(run.item_count) < 0 ||
        Number(run.item_count) > 10000 ||
        Number(run.item_count) !== Number(run.expected_count) ||
        !instant(run.completed_exact) ||
        compareSourceInstants(asOf, run.completed_exact) > 0 ||
        compareSourceInstants(run.completed_exact, observationCutoff) > 0,
    )
  )
    fail("decision_history_selected_run_unavailable");
  const rows = (
    await tx.query(
      `WITH retained AS MATERIALIZED (
        SELECT f.fact_key,f.repository_id,f.family,f.subject_id,f.source_revision,f.document,
          f.first_run_id,
          to_char(f.observed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS observed_at,
          item.run_id,mode.data_mode
        FROM leaderboard_ingestion.collection_items AS item
        JOIN leaderboard_ingestion.source_facts AS f USING(fact_key)
        LEFT JOIN leaderboard_pipeline.source_modes AS mode USING(fact_key)
        WHERE item.run_id=ANY($1::text[])
        ORDER BY item.run_id,f.fact_key LIMIT 10001
      ), footprint AS (
        SELECT count(*) AS records,COALESCE(sum(octet_length(to_jsonb(retained)::text)),0) AS bytes FROM retained
      )
      SELECT
        CASE WHEN footprint.records<=10000 AND footprint.bytes<=8000000 THEN retained.fact_key END AS fact_key,
        CASE WHEN footprint.records<=10000 AND footprint.bytes<=8000000 THEN retained.repository_id END AS repository_id,
        CASE WHEN footprint.records<=10000 AND footprint.bytes<=8000000 THEN retained.family END AS family,
        CASE WHEN footprint.records<=10000 AND footprint.bytes<=8000000 THEN retained.subject_id END AS subject_id,
        CASE WHEN footprint.records<=10000 AND footprint.bytes<=8000000 THEN retained.source_revision END AS source_revision,
        CASE WHEN footprint.records<=10000 AND footprint.bytes<=8000000 THEN retained.document END AS document,
        CASE WHEN footprint.records<=10000 AND footprint.bytes<=8000000 THEN retained.first_run_id END AS first_run_id,
        CASE WHEN footprint.records<=10000 AND footprint.bytes<=8000000 THEN retained.observed_at END AS observed_at,
        CASE WHEN footprint.records<=10000 AND footprint.bytes<=8000000 THEN retained.run_id END AS run_id,
        CASE WHEN footprint.records<=10000 AND footprint.bytes<=8000000 THEN retained.data_mode END AS data_mode,
        footprint.records AS decision_records,footprint.bytes AS decision_bytes
      FROM retained CROSS JOIN footprint`,
      [selected.map((run) => run.runId)],
    )
  ).rows;
  assertAuthorized();
  if (
    rows.some(
      (row) =>
        !Number.isSafeInteger(Number(row.decision_records)) ||
        !Number.isSafeInteger(Number(row.decision_bytes)) ||
        Number(row.decision_records) < 0 ||
        Number(row.decision_records) > 10000 ||
        Number(row.decision_bytes) < 0 ||
        Number(row.decision_bytes) > 8_000_000 ||
        payloadColumns.some((key) => row[key] === null),
    )
  )
    fail("decision_history_source_budget_exceeded");
  const captured = [];
  const selections = [];
  const factKeys = new Set();
  const membersByRun = new Map();
  for (const row of rows) {
    const members = membersByRun.get(row.run_id) ?? [];
    members.push(row);
    membersByRun.set(row.run_id, members);
  }
  for (const run of runs) {
    const repository = repositories.find((repo) => repo.id === Number(run.repository_id));
    const members = membersByRun.get(run.run_id) ?? [];
    if (members.length !== Number(run.item_count)) fail("decision_history_inventory_binding_changed");
    const subjects = new Set();
    const observations = [];
    for (const row of members) {
      const document = copyParticipationHistoryJSON(row.document);
      const observation = collectionPullRequestDecisionObservation(document, row.family, Number(row.repository_id));
      if (
        !observation ||
        row.data_mode !== dataMode ||
        row.first_run_id !== run.run_id ||
        Number(row.repository_id) !== repository.id ||
        row.family !== "pull_requests" ||
        row.subject_id !== document.subjectId ||
        row.source_revision !== document.sourceRevision ||
        factKeys.has(row.fact_key) ||
        subjects.has(row.subject_id)
      )
        fail("decision_history_source_binding_changed");
      factKeys.add(row.fact_key);
      subjects.add(row.subject_id);
      const binding = {
        ...observation.binding,
        repository: { id: repository.id, slug: repository.slug },
        subject: { ...observation.binding.subject, id: row.subject_id, url: document.sourceUrl },
        source,
        semanticRevision: semanticRevision(row.source_revision),
      };
      const generation = { scanId: run.run_id, asOf, cutoffMode: "exclusive" };
      if (digest(binding) !== digest(observation.binding) || digest(generation) !== digest(observation.generation))
        fail("decision_history_source_binding_changed");
      const observedAt = row.observed_at;
      assertPullRequestDecisionPersistence(
        observation,
        { runId: run.run_id, repositoryId: repository.id, family: "pull_requests", until: asOf },
        observedAt,
        row.first_run_id,
      );
      if (
        compareSourceInstants(observedAt, observationCutoff) > 0 ||
        compareSourceInstants(observedAt, run.completed_exact) > 0
      )
        fail("decision_history_observation_after_freeze");
      // Reproduce the collection's closed DTO field order, not jsonb key order.
      const fact = {
        subjectId: document.subjectId,
        sourceRevision: document.sourceRevision,
        sourceUrl: document.sourceUrl,
        evidence: document.evidence,
        actorId: document.actorId,
        occurredAt: document.occurredAt,
        state: document.state,
        pullRequestDecisionHistory: observation,
      };
      const key = createHash("sha256")
        .update(JSON.stringify([repository.id, row.family, row.subject_id, row.source_revision, JSON.stringify(fact)]))
        .digest("hex");
      if (key !== row.fact_key) fail("decision_history_source_integrity_error");
      let selection;
      if (observation.result.status === "captured") {
        const verified = validatePullRequestDecisionHistory(observation.result.receipt, { binding, generation });
        if (verified.status !== "validated") fail("decision_history_retained_receipt_invalid");
        selection = selectPullRequestDecisionAsOf(verified.receipt, selectionAsOf);
        if (selection.status === "unavailable") fail("decision_history_retained_receipt_invalid");
      } else {
        selection = { status: "unavailable", reason: observation.result.reason };
      }
      observations.push({
        factKey: row.fact_key,
        subjectId: row.subject_id,
        sourceRevision: row.source_revision,
        observedAt,
        observationHash: digest(observation),
      });
      selections.push({
        repositoryId: repository.id,
        runId: run.run_id,
        factKey: row.fact_key,
        selection,
        source: {
          subjectId: row.subject_id,
          sourceUrl: document.sourceUrl,
          sourceRevision: row.source_revision,
          createdAt: binding.subject.createdAt,
          author: binding.subject.author,
          observedAt,
        },
      });
    }
    captured.push({
      repositoryId: repository.id,
      runId: run.run_id,
      accessGeneration: String(run.access_generation),
      completedAt: run.completed_exact,
      observations: observations.sort((a, b) => a.factKey.localeCompare(b.factKey)),
    });
  }
  const capture = parseDecisionGenerationCapture({
    schemaVersion: pullRequestDecisionGenerationVersion,
    source,
    asOf,
    observationCutoff,
    runs: captured.sort((a, b) => a.repositoryId - b.repositoryId),
  });
  if (saved && digest(saved) !== digest(capture)) fail("decision_history_capture_binding_changed");
  const removed = (
    await tx.query(
      `SELECT 1 FROM leaderboard_ingestion.collection_items AS item
      JOIN leaderboard_ingestion.source_facts AS fact USING(fact_key)
      JOIN leaderboard_ingestion.object_suppressions AS removed
        ON removed.repository_id=fact.repository_id AND removed.subject_id=fact.subject_id
      WHERE item.run_id=ANY($1::text[]) LIMIT 1`,
      [capture.runs.map((run) => run.runId)],
    )
  ).rows;
  assertAuthorized();
  if (removed.length) fail("decision_history_source_suppressed");
  return { capture, selections };
}

/** Retained private capture reads are bounded before decoding or hashing.
 * The legacy absent/absent path preserves its existing admission policy. */
export async function readDecisionFrozenInput(tx, snapshotId, captureEnabled = false) {
  const rows = (
    await tx.query(
      `SELECT CASE WHEN
        NOT ($2::boolean OR COALESCE(document->'identityAuthorization' ? 'pullRequestDecisionEvidence',false))
        OR octet_length(document::text)<=8000000 THEN document END AS document,
        document_hash,octet_length(document::text) AS document_bytes,
        ($2::boolean OR COALESCE(document->'identityAuthorization' ? 'pullRequestDecisionEvidence',false))
          AS decision_bound
      FROM leaderboard_pipeline.frozen_inputs WHERE snapshot_id=$1`,
      [snapshotId, captureEnabled],
    )
  ).rows;
  if (rows.length > 1) fail("decision_history_frozen_input_unavailable");
  const row = rows[0];
  if (row && typeof row.decision_bound !== "boolean") fail("decision_history_frozen_input_unavailable");
  if (row?.decision_bound) {
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

/** One nullable binding on the existing run. NULL remains a legacy/untrusted run;
 * no migration backfills provenance, and later UPDATE cannot add or replace it. */
export async function migrateDecisionHistoryRuns(db) {
  await db.transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('leaderboard-decision-run-migration',0))");
    await tx.query(`ALTER TABLE leaderboard_ingestion.collection_runs
      ADD COLUMN IF NOT EXISTS decision_producer text CHECK (
        decision_producer IS NULL OR octet_length(decision_producer)<=512)`);
    await tx.query(`CREATE OR REPLACE FUNCTION leaderboard_ingestion.reject_decision_producer_change()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.decision_producer IS DISTINCT FROM OLD.decision_producer THEN
          RAISE EXCEPTION 'immutable_decision_producer';
        END IF;
        RETURN NEW;
      END;
      $$`);
    await tx.query(`DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_catalog.pg_trigger
          WHERE tgrelid='leaderboard_ingestion.collection_runs'::regclass
            AND tgname='immutable_decision_producer' AND NOT tgisinternal
        ) THEN
          CREATE TRIGGER immutable_decision_producer BEFORE UPDATE OF decision_producer
          ON leaderboard_ingestion.collection_runs FOR EACH ROW
          EXECUTE FUNCTION leaderboard_ingestion.reject_decision_producer_change();
        END IF;
      END;
      $$`);
    const columns = (
      await tx.query(`SELECT data_type,is_nullable FROM information_schema.columns
        WHERE table_schema='leaderboard_ingestion' AND table_name='collection_runs'
          AND column_name='decision_producer'`)
    ).rows;
    if (columns.length !== 1 || columns[0].data_type !== "text" || columns[0].is_nullable !== "YES")
      fail("decision_history_storage_schema_invalid");
  });
}
