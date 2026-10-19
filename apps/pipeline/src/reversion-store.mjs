import {
  classifyCorrectionRows,
  prepareReversionDecision,
  recordReversionDecision,
  reversionAuthority,
  reversionHash,
  reversionOperationKey,
  reversionReceiptDocument,
} from "./reversion-effectiveness.mjs";

const fail = (reason) => {
  throw new Error("reversion_" + reason);
};
const same = (left, right) => reversionHash(left) === reversionHash(right);
const copy = (value) => structuredClone(value);
const repositoryIds = (values) => {
  if (
    !Array.isArray(values) ||
    !values.length ||
    values.length > 1200 ||
    values.some((id) => !Number.isSafeInteger(Number(id)) || Number(id) < 1)
  )
    fail("invalid_repositories");
  return [...new Set(values.map(Number))].sort((a, b) => a - b);
};

/** Every consumer reads the row and its exact existing-kind receipt together.
 * Unknown/unsealed tags are errors, never exemptions from artifact suppression. */
export async function readCorrectionState(tx, ids) {
  const rows = (
    await tx.query(
      `SELECT c.request_id,c.fact_id,c.artifact_id,c.repository_id,c.document,
       CASE WHEN r.operation_key IS NULL THEN NULL ELSE jsonb_build_object(
         'operation_key',r.operation_key,'kind',r.kind,'document',r.document,'document_hash',r.document_hash) END AS receipt
     FROM leaderboard_pipeline.corrections AS c
     LEFT JOIN leaderboard_pipeline.receipts AS r
       ON r.operation_hash=pg_catalog.sha256(pg_catalog.convert_to(
         ('reversion:' || c.request_id || ':' || (c.document->'operation'->>'expectedVersion')), 'UTF8'))
       AND r.operation_key=('reversion:' || c.request_id || ':' || (c.document->'operation'->>'expectedVersion'))
     WHERE c.repository_id=ANY($1::bigint[]) ORDER BY c.request_id LIMIT 10001`,
      [repositoryIds(ids)],
    )
  ).rows;
  const classified = classifyCorrectionRows(rows);
  // Validate the entire chain, including future decisions, before selecting any view.
  reversionAuthority(classified.decisions, "9999-12-31T23:59:59.999Z");
  return {
    ...classified,
    fingerprint: reversionHash(rows),
    ...(classified.decisions.length ? { recordsHash: reversionHash(classified.decisions) } : {}),
  };
}

/** Preserve absent legacy capture fields. A complete retained tagged record set
 * supplements the effective-prefix authority, including active restorations. */
export function reversionCapture(state, cutoff) {
  return state.decisions.length
    ? {
        reversionAuthority: reversionAuthority(state.decisions, cutoff),
        reversionRecordsHash: state.recordsHash,
      }
    : {};
}

export function assertReversionCapture(authorization, state, cutoff) {
  const expected = reversionCapture(state, cutoff);
  for (const key of ["reversionAuthority", "reversionRecordsHash"]) {
    if (
      Object.hasOwn(authorization, key) !== Object.hasOwn(expected, key) ||
      (Object.hasOwn(expected, key) && !same(authorization[key], expected[key]))
    )
      fail("authority_changed");
  }
}

/** Add only the minimized reviewed public receipt to an already copied public
 * proof. This does not synthesize missing source metadata or complete history. */
export function addReversionNotices(document, notices, metadataSchema) {
  for (const entries of [document.evidence, document.portfolioEvidence, document.pendingEvidence]) {
    for (const entry of entries ?? []) {
      const selected = notices.filter((notice) => notice.artifactId === entry.artifact.stableId);
      if (!selected.length || entry.evidenceMetadata === undefined) continue;
      const metadata = metadataSchema.parse(entry.evidenceMetadata);
      const additions = selected.map(({ kind, occurredAt, publicUrl }) => ({ kind, occurredAt, publicUrl }));
      const records = [
        ...new Map(
          [...metadata.history.records, ...additions].map((record) => [reversionHash(record), record]),
        ).values(),
      ].slice(-20);
      let value = { ...metadata, history: { coverage: "partial", records } };
      while (!metadataSchema.safeParse(value).success && records.length > additions.length) {
        records.shift();
        value = { ...metadata, history: { coverage: "partial", records } };
      }
      entry.evidenceMetadata = metadataSchema.parse(value);
    }
  }
}

/** Privileged host composition only. The caller supplies current configuration,
 * frozen-source verification and exact-candidate authorization; none default to
 * permission. The existing repository lock serializes admission with publication
 * and privacy/retirement. No new table, receipt kind or deletion authority exists. */
export async function applyReviewedReversion({
  db,
  controlsStore,
  operation,
  lineageEvidenceIds,
  configurationHash,
  dataMode,
  now,
  approved,
  authorize,
  verifyFrozen,
  suppressedArtifacts,
  receipt,
  markApplied,
}) {
  const invocation = copy({ operation, lineageEvidenceIds });
  reversionHash(invocation);
  const requested = invocation.operation;
  if (
    !requested ||
    typeof requested.requestId !== "string" ||
    typeof requested.snapshotId !== "string" ||
    typeof authorize !== "function"
  )
    fail("not_authorized");
  const result = await db.transaction(async (tx) => {
    if (!(await approved(tx))) fail("not_authorized");
    const saved = (
      await tx.query(
        `SELECT f.document AS input,f.document_hash AS input_hash,
         s.document AS snapshot,s.document_hash AS snapshot_hash,s.repository_ids
       FROM leaderboard_pipeline.frozen_inputs AS f
       JOIN leaderboard_pipeline.snapshots AS s USING(snapshot_id) WHERE f.snapshot_id=$1`,
        [requested.snapshotId],
      )
    ).rows[0];
    if (
      !saved ||
      !same(saved.input_hash, reversionHash(saved.input)) ||
      !same(saved.snapshot_hash, reversionHash(saved.snapshot)) ||
      saved.snapshot.snapshot?.snapshotId !== requested.snapshotId
    )
      fail("frozen_input_unavailable");
    // Decisions use an original immutable qualification capture. Restoration
    // reuses that same reviewed baseline, never an already overlaid fact array.
    if (
      saved.snapshot.reversionAuthority !== undefined ||
      saved.input.identityAuthorization?.reversionAuthority !== undefined
    )
      fail("original_capture_required");
    const ids = repositoryIds(saved.repository_ids);
    const access = (
      await tx.query(
        `SELECT repository_id,installation_id,state,generation FROM leaderboard_ingestion.repository_access
       WHERE repository_id=ANY($1::bigint[]) ORDER BY repository_id FOR UPDATE`,
        [ids],
      )
    ).rows;
    if (access.length !== ids.length || access.some((row) => row.state !== "public")) fail("source_unavailable");
    const input = {
      snapshotId: requested.snapshotId,
      cutoff: saved.input.frozen?.cutoff,
      facts: saved.input.frozen?.facts,
      policies: saved.input.policies,
      evidence: [
        ...new Map(
          [
            ...(saved.snapshot.evidence ?? []),
            ...(saved.snapshot.portfolioEvidence ?? []),
            ...(saved.snapshot.pendingEvidence ?? []),
          ].map((entry) => [entry.contribution.contributionId, entry]),
        ).values(),
      ],
    };
    const original = input.facts?.find((fact) => fact.id === requested.originalFactId);
    const current = access.find((row) => String(row.repository_id) === original?.repoId);
    if (!current) fail("source_unavailable");
    const candidate = prepareReversionDecision({
      operation: requested,
      input,
      binding: {
        configurationHash,
        dataMode,
        sourceGeneration: String(current.generation),
        lineageEvidenceIds: invocation.lineageEvidenceIds,
      },
    });
    const requestCurrent = (state, prior) => {
      const request = state.requests[requested.requestId];
      if (
        !request ||
        request.id !== requested.requestId ||
        request.kind !== "correction" ||
        !["pending", "applied"].includes(request.status) ||
        request.owner === requested.operatorId ||
        request.locator !==
          input.evidence.find((entry) => entry.contribution.contributionId === requested.originalFactId)?.artifact
            .publicUrl ||
        (request.status === "pending" && request.version !== requested.expectedVersion) ||
        (request.status === "applied" && !prior)
      )
        fail("request_conflict");
      return request;
    };
    let state = await readCorrectionState(tx, ids);
    const prior = state.decisions.find((document) => document.operation.requestId === requested.requestId);
    if (state.legacy.some((row) => row.request_id === requested.requestId)) fail("retry_mismatch");
    if (prior) {
      const { recordedAt, decisionHash, ...previous } = prior;
      if (!same(previous, candidate)) fail("retry_mismatch");
    }
    if (
      state.legacy.some(
        (row) =>
          row.artifact_id === candidate.source.original.artifactId ||
          row.artifact_id === candidate.source.reverting.artifactId,
      )
    )
      fail("source_suppressed");
    const removed = await suppressedArtifacts(tx, ids);
    if ([candidate.source.original, candidate.source.reverting].some((source) => removed.includes(source.artifactId)))
      fail("source_suppressed");
    verifyFrozen(saved, access, controlsStore.read());
    requestCurrent(controlsStore.read(), prior);
    // The immutable prepared candidate contains the exact relationship, source
    // pins, policy/acceptance hashes and reviewer. Caller booleans are not inputs.
    if ((await authorize(candidate)) !== true) fail("not_authorized");
    if (!(await approved(tx))) fail("not_authorized");
    verifyFrozen(saved, access, controlsStore.read());
    requestCurrent(controlsStore.read(), prior);
    const document = prior ?? recordReversionDecision(candidate, now());
    reversionAuthority(prior ? state.decisions : [...state.decisions, document], document.recordedAt);
    await tx.query(
      `INSERT INTO leaderboard_pipeline.corrections(request_id,fact_id,artifact_id,repository_id,document)
       VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT(request_id) DO NOTHING`,
      [
        requested.requestId,
        document.source.original.factId,
        document.source.original.artifactId,
        Number(document.source.repositoryId),
        JSON.stringify(document),
      ],
    );
    const receiptId = await receipt(
      tx,
      reversionOperationKey(document),
      "correction_applied",
      reversionReceiptDocument(document),
    );
    // The generic receipt helper alone does not compare an existing document to
    // this request. Joined exact readback rejects a conflicting operation key.
    state = await readCorrectionState(tx, ids);
    const persisted = state.decisions.find((entry) => entry.operation.requestId === requested.requestId);
    if (!persisted || !same(persisted, document)) fail("retry_mismatch");
    if (!(await approved(tx))) fail("not_authorized");
    verifyFrozen(saved, access, controlsStore.read());
    requestCurrent(controlsStore.read(), prior);
    return { receiptId, requestId: requested.requestId, document: persisted };
  });
  // As with legacy correction application, the committed sealed DB authority
  // survives a failed private acknowledgment. Exact retry completes that audit.
  markApplied(result, invocation.operation);
  return { receiptId: result.receiptId, requestId: result.requestId, status: "applied" };
}
