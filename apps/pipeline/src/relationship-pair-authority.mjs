import {
  relationshipPairKey,
  relationshipPairSchema,
  relationshipPairNormalizationVersion,
  compareSourceInstants,
} from "@pick-your-ai/contracts";
import { issueTransferDigest as digest } from "./issue-transfer-store.mjs";
import { issueTransferClosure, issueTransferLimits } from "./issue-transfer-privacy.mjs";
import { selectIssueTransferSources } from "./issue-transfers.mjs";
import { hasRelationshipPairMarker, isRelationshipPairMetric } from "./relationship-pair-generation.mjs";
import { copyParticipationHistoryJSON } from "./participation-history.mjs";

// v4 binds exact source-clock representations in displaced-history semantics.
// Earlier captures may have lost bindings or discarded semantic contradictions.
export const relationshipPairAuthorityVersion = "pipeline-relationship-pair-authority/v4";
const check = (value, code = "relationship_pair_authority_integrity_error") => {
  if (!value) throw new Error(code);
};
const sorted = (values) => [...new Set(values)].sort();
const ids = (values) => [...new Set(values.map(String))].sort((a, b) => Number(a) - Number(b));
const hash = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const repositoryId = (value) =>
  typeof value === "string" && /^[1-9][0-9]*$/.test(value) && Number.isSafeInteger(Number(value));
const same = (left, right) => digest(left) === digest(right);
const sourceKey = (entry) => JSON.stringify([entry.source.factKey, digest(entry.document)]);

function records(entries) {
  let count = 0;
  return entries.flatMap((entry) => {
    check(Array.isArray(entry.document.facts));
    return entry.document.facts
      .filter((fact) => isRelationshipPairMetric(fact.metricId))
      .map((fact) => {
        check(++count <= 50000, "relationship_pair_fact_budget_exceeded");
        check(
          typeof fact.id === "string" &&
            typeof fact.artifactId === "string" &&
            String(fact.repoId) === entry.repositoryId,
        );
        const parsed = relationshipPairSchema.safeParse(fact.relationshipPair);
        const pair =
          parsed.success &&
          fact.metricId === (parsed.data.kind === "reference" ? "reference_links" : "closing_links") &&
          [parsed.data.from, parsed.data.to].some(
            (endpoint) => endpoint.repositoryId === fact.repoId && endpoint.artifactId === fact.artifactId,
          )
            ? parsed.data
            : null;
        return { entry, fact, factHash: digest(fact), pair, key: pair === null ? null : relationshipPairKey(pair) };
      });
  });
}

/** A conflicting event or a later unbound revision is part of the same known
 * history. It must not disappear merely because its evidence view is elsewhere. */
function closure(all, seeds, initial = {}) {
  const indexes = { keys: new Map(), events: new Map(), facts: new Map() };
  const add = (index, key, record) => {
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(record);
  };
  for (const record of all) {
    add(indexes.facts, record.fact.id, record);
    if (record.pair) {
      add(indexes.keys, record.key, record);
      add(indexes.events, record.pair.eventId, record);
    }
  }
  const seen = { keys: new Set(), events: new Set(), facts: new Set() };
  const included = new Set(),
    queue = [];
  const enqueue = (record) => {
    if (included.has(record)) return;
    included.add(record);
    queue.push(record);
  };
  const visit = (kind, key) => {
    if (seen[kind].has(key)) return;
    seen[kind].add(key);
    for (const record of indexes[kind].get(key) ?? []) enqueue(record);
  };
  seeds.forEach(enqueue);
  for (const kind of ["keys", "events", "facts"]) for (const key of initial[kind] ?? []) visit(kind, key);
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const record = queue[cursor];
    visit("facts", record.fact.id);
    if (record.pair) {
      visit("keys", record.key);
      visit("events", record.pair.eventId);
    }
  }
  return { records: queue, keys: [...seen.keys], events: [...seen.events], facts: [...seen.facts] };
}

/** Only authoritative whole-artifact removals seed this expansion. Derived
 * evidence removals do not become new endpoint seeds for unrelated pairs. */
export function expandRelationshipPairSuppressions(authority, artifactIds) {
  if (!artifactIds.length) return [];
  const direct = new Set(artifactIds);
  const all = authority.relationshipPairRecords ?? [];
  const withdrawn = closure(
    all,
    all.filter(
      (record) =>
        direct.has(record.fact.artifactId) ||
        (record.pair && [record.pair.from, record.pair.to].some((endpoint) => direct.has(endpoint.artifactId))),
    ),
  );
  return sorted(withdrawn.records.map((record) => record.fact.artifactId));
}

function selectRetained(entries, selected, aliases) {
  const all = records(entries);
  const related = closure(
    all,
    all.filter((record) => selected.includes(record.entry.repositoryId) || aliases.has(record.fact.artifactId)),
  );
  const included = new Set(related.records.map((record) => record.entry));
  for (const entry of entries)
    if (selected.includes(entry.repositoryId) && hasRelationshipPairMarker(entry.document)) included.add(entry);
  return { ...related, entries: [...included] };
}

function capture(selection, selected) {
  const factsByEntry = new Map(selection.entries.map((entry) => [entry, []]));
  for (const record of selection.records) factsByEntry.get(record.entry).push(record.factHash);
  return {
    schemaVersion: relationshipPairAuthorityVersion,
    selectedRepositoryIds: ids(selected),
    bindings: selection.entries
      .map((entry) => ({
        factKey: entry.source.factKey,
        policySignature: entry.policySignature,
        documentHash: digest(entry.document),
        factHashes: sorted(factsByEntry.get(entry)),
      }))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  };
}

export function validateRelationshipPairCapture(value) {
  check(
    value?.schemaVersion === relationshipPairAuthorityVersion &&
      Object.keys(value).sort().join(",") === "bindings,schemaVersion,selectedRepositoryIds" &&
      Array.isArray(value.selectedRepositoryIds) &&
      value.selectedRepositoryIds.length <= issueTransferLimits.repositories &&
      value.selectedRepositoryIds.every(repositoryId) &&
      same(value.selectedRepositoryIds, ids(value.selectedRepositoryIds)) &&
      Array.isArray(value.bindings) &&
      value.bindings.length <= 20000,
    "relationship_pair_frozen_binding_invalid",
  );
  check(
    value.bindings.every(
      (binding) =>
        binding &&
        Object.keys(binding).sort().join(",") === "documentHash,factHashes,factKey,policySignature" &&
        [binding.factKey, binding.policySignature, binding.documentHash].every(hash) &&
        Array.isArray(binding.factHashes) &&
        binding.factHashes.length <= 10000 &&
        binding.factHashes.every(hash) &&
        same(binding.factHashes, sorted(binding.factHashes)),
    ) &&
      new Set(value.bindings.map((binding) => JSON.stringify([binding.factKey, binding.policySignature]))).size ===
        value.bindings.length &&
      value.bindings.reduce((sum, binding) => sum + binding.factHashes.length, 0) <= 50000,
    "relationship_pair_frozen_binding_invalid",
  );
  return structuredClone(value);
}

function retainedEntry(row, { dataMode, generationsFor }) {
  check(digest(row.document) === row.document_hash, "relationship_pair_normalization_integrity_error");
  check(row.document.isSynthetic === (dataMode === "synthetic"), "relationship_pair_data_mode_mismatch");
  check(
    row.document.relationshipPairNormalizationVersion === relationshipPairNormalizationVersion,
    "relationship_pair_normalization_obsolete",
  );
  check(
    generationsFor(row.family, row.document, row.policy_signature).includes(row.policy_signature),
    "relationship_pair_normalization_obsolete",
  );
  return {
    document: row.document,
    repositoryId: String(row.repository_id),
    family: row.family,
    subjectId: row.subject_id,
    selectedCurrentState: row.source_evidence === "current_state",
    source: { factKey: row.fact_key, observedAt: new Date(row.observed_at).toISOString(), runId: row.first_run_id },
    policySignature: row.policy_signature,
  };
}

/** Retained rows supply dependency, withdrawal and unresolved-history identity.
 * They never replace normalizeStored's current/cutoff calculation facts.
 * All configured source gates are held before these normalization read locks. */
async function validateGeneration(row, options, cutoff = null) {
  if (row.document.pullRequestMergeTargetNormalization === undefined) return [];
  check(typeof options.mergeTarget?.validate === "function", "relationship_pair_merge_target_unavailable");
  return options.mergeTarget.validate(row, cutoff);
}

const protectedPairPayloadColumns = [
  "fact_key",
  "policy_signature",
  "document",
  "document_hash",
  "repository_id",
  "family",
  "subject_id",
  "source_document",
  "source_evidence",
  "observed_at",
  "first_run_id",
];

// Bound the complete projected result in SQL before the driver decodes JSON or
// returns variable-width scalar fields. The ordinary authority query is exact.
function pairReadQuery(query, historyBudget) {
  if (!historyBudget) return query;
  return `WITH pair_retained AS MATERIALIZED (${query}),
    pair_projected AS MATERIALIZED (
      SELECT fact_key,policy_signature,document,document_hash,repository_id,family,subject_id,
        CASE WHEN document ? 'pullRequestMergeTargetNormalization' THEN
          jsonb_build_object('subjectId',source_document->'subjectId','sourceUrl',source_document->'sourceUrl',
            'sourceRevision',source_document->'sourceRevision') END AS source_document,
        source_evidence,observed_at,first_run_id
      FROM pair_retained
    ), pair_footprint AS (
      SELECT count(*) AS records,
        COALESCE(sum(octet_length(to_jsonb(pair_projected)::text)),0) AS bytes
      FROM pair_projected
    )
    SELECT ${protectedPairPayloadColumns
      .map(
        (column) =>
          `CASE WHEN pair_footprint.records<=10000 AND pair_footprint.bytes<=8000000 THEN pair_projected.${column} END AS ${column}`,
      )
      .join(",\n      ")},
      pair_footprint.records AS history_records,pair_footprint.bytes AS history_bytes
    FROM pair_projected CROSS JOIN pair_footprint
    ORDER BY pair_projected.fact_key,pair_projected.policy_signature`;
}

function assertPairReadBudget(rows, historyBudget) {
  if (!historyBudget) return;
  check(
    rows.length <= 10000 &&
      rows.every(
        (row) =>
          Number.isSafeInteger(Number(row.history_records)) &&
          Number(row.history_records) === rows.length &&
          Number.isSafeInteger(Number(row.history_bytes)) &&
          Number(row.history_bytes) >= 0 &&
          Number(row.history_bytes) <= 8_000_000 &&
          row.document !== null,
      ),
    "participation_history_normalization_budget_exceeded",
  );
  // Admit structure before any recursive hash, generation validation or copy.
  for (const row of rows) {
    row.document = copyParticipationHistoryJSON(row.document);
    if (row.source_document !== null) row.source_document = copyParticipationHistoryJSON(row.source_document);
  }
}

async function retainedEntries(tx, options) {
  const { repositories, cutoff, dataMode, generationsFor, signatures, mergeTarget } = options;
  const rows = (
    await tx.query(
      pairReadQuery(
        `SELECT n.*,f.repository_id,f.family,f.subject_id,f.document AS source_document,
       f.document->>'evidence' AS source_evidence,f.observed_at,f.first_run_id
     FROM leaderboard_pipeline.normalizations n JOIN leaderboard_ingestion.source_facts f USING(fact_key)
     WHERE f.repository_id=ANY($1::bigint[]) AND (n.policy_signature=ANY($2::text[])
       OR (f.family='pull_requests' AND f.repository_id=ANY($4::bigint[])))
       AND ($3::timestamptz IS NULL OR f.observed_at<=$3)
     ORDER BY n.fact_key,n.policy_signature LIMIT 20001 FOR SHARE OF n`,
        options.historyBudget,
      ),
      [repositories.map((repo) => repo.id), signatures, cutoff ?? null, mergeTarget?.repositoryIds ?? []],
    )
  ).rows;
  assertPairReadBudget(rows, options.historyBudget);
  check(
    rows.length <= 20000 && new Set(rows.map((row) => row.fact_key)).size <= 10000,
    "relationship_pair_history_budget_exceeded",
  );
  // Integrity inspection is independent of mutable generation marker contents.
  // Unknown historical rows cannot supply dependency or classification hints.
  for (const row of rows) {
    check(digest(row.document) === row.document_hash, "relationship_pair_normalization_integrity_error");
    check(row.document.isSynthetic === (dataMode === "synthetic"), "relationship_pair_data_mode_mismatch");
  }
  const entries = [];
  const future = new Set();
  for (const row of rows) {
    const marker = row.document.pullRequestMergeTargetNormalization;
    if (
      marker !== undefined &&
      marker?.baseSignature !== mergeTarget?.baseSignature &&
      !signatures.includes(row.policy_signature)
    )
      continue;
    const captures = await validateGeneration(row, options);
    if (!generationsFor(row.family, row.document, row.policy_signature).includes(row.policy_signature)) continue;
    const entry = retainedEntry(row, { dataMode, generationsFor });
    entries.push(entry);
    if (cutoff != null && captures.some((capture) => compareSourceInstants(capture.observedAt, cutoff) > 0))
      future.add(entry);
  }
  // Validate every admitted pair and the aggregate fact budget before excluding
  // a later verified generation from an earlier frozen calculation.
  records(entries);
  // Both actual current pair wrappers remain withdrawal identity for no-cutoff
  // authority reads; a frozen calculation uses only its observed history.
  return entries.filter((entry) => !future.has(entry));
}

const suppressionSQL = `SELECT subject_id FROM leaderboard_ingestion.object_suppressions WHERE repository_id=ANY($1::bigint[])
  UNION SELECT dependency.artifact_id FROM leaderboard_pipeline.source_artifacts dependency
  JOIN leaderboard_ingestion.source_facts fact USING(fact_key)
  JOIN leaderboard_ingestion.object_suppressions removed ON removed.repository_id=fact.repository_id AND removed.subject_id=fact.subject_id
  WHERE fact.repository_id=ANY($1::bigint[])`;

async function privacy(tx, selection, { repositories, transfer, mode = "share" }) {
  const requiredIds = ids([
    ...selection.entries.map((entry) => entry.repositoryId),
    ...selection.records.flatMap((record) =>
      record.pair ? [record.pair.from.repositoryId, record.pair.to.repositoryId] : [],
    ),
  ]);
  check(requiredIds.length <= issueTransferLimits.repositories, "relationship_pair_repository_budget_exceeded");
  const configured = ids(repositories.map((repo) => repo.id));
  const readIds = ids([...transfer.repositoryIds, ...requiredIds.filter((id) => configured.includes(id))]);
  const gates = (
    await tx.query(
      `SELECT repository_id,installation_id,state,generation FROM leaderboard_ingestion.repository_access
     WHERE repository_id=ANY($1::bigint[]) ORDER BY repository_id FOR ${mode === "update" ? "UPDATE" : "SHARE"}`,
      [readIds],
    )
  ).rows;
  const publicRepo = (id) =>
    gates.some(
      (gate) =>
        String(gate.repository_id) === id &&
        gate.state === "public" &&
        String(gate.installation_id) === String(repositories.find((repo) => String(repo.id) === id)?.installationId),
    );
  const direct = new Set([
    ...transfer.removed,
    ...(await tx.query(suppressionSQL, [readIds])).rows.map((row) => row.subject_id),
  ]);
  const withdrawn = closure(
    selection.records,
    selection.records.filter(
      (record) =>
        !publicRepo(record.entry.repositoryId) ||
        direct.has(record.fact.artifactId) ||
        (record.pair &&
          [record.pair.from, record.pair.to].some(
            (endpoint) => !publicRepo(endpoint.repositoryId) || direct.has(endpoint.artifactId),
          )),
    ),
  );
  const removed = sorted([...direct, ...withdrawn.records.map((record) => record.fact.artifactId)]);
  const repositoryIds = ids([...transfer.repositoryIds, ...requiredIds.filter(publicRepo)]);
  return {
    requiredIds,
    repositoryIds,
    access: gates.filter((gate) => repositoryIds.includes(String(gate.repository_id))),
    removed,
    available: requiredIds.every(publicRepo) && withdrawn.records.length === 0,
  };
}

function unresolvedHistory(current, retained) {
  const subject = (entry) => JSON.stringify([entry.repositoryId, entry.family, entry.subjectId]);
  const source = (entry) => JSON.stringify([subject(entry), entry.source.factKey]);
  const admitted = ({ fact, pair }) =>
    pair !== null &&
    typeof fact.canonicalKey === "string" &&
    fact.canonicalKey.trim().length > 0 &&
    fact.state !== "unknown" &&
    Number.isSafeInteger(fact.revision) &&
    fact.revision >= 0 &&
    (fact.revision === 0 || (typeof fact.correctionReceipt === "string" && fact.correctionReceipt.trim().length > 0));
  const membership = (context) => {
    // Engine stableJSON serializes both omitted projected contexts and null as
    // null. Other retained fact values have already crossed the JSON/hash gate.
    if (context == null) return null;
    return {
      ...context,
      projects: [...context.projects].sort(),
      workstreams: [...context.workstreams].sort(),
      ...(context.projectScope === undefined ? {} : { projectScope: [...context.projectScope].sort() }),
      ...(context.workstreamScope === undefined ? {} : { workstreamScope: [...context.workstreamScope].sort() }),
    };
  };
  const meaning = ({ fact }) => {
    // Match engine canonical admission: adapter IDs and collection clocks may
    // differ, but every other field remains semantic. In particular, canonical
    // identity, exact source clocks, state and acceptance cannot disappear with
    // an older source row. Membership order alone is not a scope contradiction.
    const { id, observedAt, ...rest } = fact;
    return digest({
      ...rest,
      eventContext: membership(fact.eventContext),
      currentContext: membership(fact.currentContext),
    });
  };
  const identity = ({ fact }) => JSON.stringify([fact.metricId, fact.id]);
  const groups = new Map(),
    latest = new Map();
  for (const record of current) {
    const key = source(record.entry);
    if (!groups.has(key)) groups.set(key, { entry: record.entry, equivalent: new Map(), reviewed: new Map() });
    const group = groups.get(key);
    if (record.entry.selectedCurrentState) {
      const subjectKey = subject(record.entry);
      check(!latest.has(subjectKey) || latest.get(subjectKey) === group, "relationship_pair_current_source_ambiguous");
      latest.set(subjectKey, group);
    }
    if (!admitted(record)) continue;
    const meaningKey = meaning(record);
    group.equivalent.set(meaningKey, Math.max(group.equivalent.get(meaningKey) ?? -1, record.fact.revision));
    if (record.fact.revision > 0) {
      const identityKey = identity(record);
      group.reviewed.set(identityKey, Math.max(group.reviewed.get(identityKey) ?? -1, record.fact.revision));
    }
  }
  return retained.records.filter((prior) => {
    if (!prior.pair || prior.pair.action === "disconnect") return false;
    const meaningKey = meaning(prior),
      identityKey = identity(prior);
    const resolves = (group) =>
      group !== undefined &&
      ((group.equivalent.get(meaningKey) ?? -1) >= prior.fact.revision ||
        (group.reviewed.get(identityKey) ?? -1) > prior.fact.revision);
    // At most two indexed checks per retained fact, not a historical cross-product.
    if (resolves(groups.get(source(prior.entry)))) return false;
    const successor = latest.get(subject(prior.entry));
    return !(
      prior.entry.selectedCurrentState &&
      successor &&
      compareSourceInstants(successor.entry.source.observedAt, prior.entry.source.observedAt) > 0 &&
      resolves(successor)
    );
  });
}

/** Display selection is deliberately unchanged. Only related pair history is
 * added to its calculation sources; full documents remain the identity proof. */
function activeSources(normalized, transfer, selected, retained) {
  // Cache only within this read. The final publication fence hashes the same
  // source objects afresh and cannot inherit an earlier in-memory digest.
  const keys = new Map(normalized.map((entry) => [entry, sourceKey(entry)]));
  const initial = selectIssueTransferSources(normalized, transfer.transfers, selected).normalized;
  const initialKeys = new Set(initial.map((entry) => keys.get(entry)));
  const all = records(normalized);
  // Absence never restores old credit. The retained supported original is
  // enough to withhold its connected unit when no admitted current successor
  // proves the same binding. Empty current output need not become new evidence.
  const unresolved = unresolvedHistory(all, retained);
  const uncertain = closure([...retained.records, ...all], unresolved);
  const uncertainBySource = new Map();
  for (const record of uncertain.records) {
    if (!keys.has(record.entry)) continue;
    const key = keys.get(record.entry);
    if (!uncertainBySource.has(key)) uncertainBySource.set(key, new Set());
    uncertainBySource.get(key).add(record.factHash);
  }
  const selectedRecords = closure(
    all,
    all.filter((record) => initialKeys.has(keys.get(record.entry))),
    retained,
  );
  const wanted = new Map();
  for (const record of selectedRecords.records) {
    const key = keys.get(record.entry);
    if (!wanted.has(key)) wanted.set(key, new Set());
    wanted.get(key).add(record.factHash);
  }
  return normalized.flatMap((entry) => {
    const key = keys.get(entry);
    const uncertainFacts = uncertainBySource.get(key);
    const projected = uncertainFacts
      ? { ...entry, relationshipPairUncertainFactHashes: sorted([...uncertainFacts]) }
      : entry;
    if (initialKeys.has(key)) return [projected];
    const factHashes = wanted.get(key);
    return factHashes ? [{ ...projected, relationshipPairFactHashes: [...factHashes] }] : [];
  });
}

export function relationshipPairCalculationDocument(entry) {
  const projected = entry.relationshipPairFactHashes !== undefined;
  const uncertain = new Set(entry.relationshipPairUncertainFactHashes ?? []);
  if (!projected && !uncertain.size) return entry.document;
  const wanted = new Set(entry.relationshipPairFactHashes ?? []);
  const original = projected ? entry.document.facts.filter((fact) => wanted.has(digest(fact))) : entry.document.facts;
  check(
    !projected ||
      (original.every((fact) => isRelationshipPairMetric(fact.metricId)) &&
        same(sorted(original.map(digest)), sorted(entry.relationshipPairFactHashes))),
    "relationship_pair_projection_integrity_error",
  );
  check(
    same(
      sorted(
        original.filter((fact) => isRelationshipPairMetric(fact.metricId) && uncertain.has(digest(fact))).map(digest),
      ),
      sorted([...uncertain]),
    ),
    "relationship_pair_uncertainty_projection_integrity_error",
  );
  const facts = original.map((fact) => (uncertain.has(digest(fact)) ? { ...fact, state: "unknown" } : fact));
  const reasons = uncertain.size
    ? [...entry.document.reasons, "relationship_pair_history_unresolved"]
    : entry.document.reasons;
  if (!projected) return { ...entry.document, facts, reasons };
  const factIds = new Set(facts.map((fact) => fact.id));
  const artifactIds = new Set(facts.map((fact) => fact.artifactId));
  const actors = new Set(facts.map((fact) => fact.actorId));
  return {
    relationshipPairNormalizationVersion,
    isSynthetic: entry.document.isSynthetic,
    facts,
    actors: entry.document.actors.filter((actor) => actors.has(actor.id)),
    evidence: entry.document.evidence.filter((entry) => factIds.has(entry.contribution.contributionId)),
    suppressArtifactIds: (entry.document.suppressArtifactIds ?? []).filter((id) => artifactIds.has(id)),
    reasons,
    ...(entry.document.projectContext && artifactIds.has(entry.document.projectContext.subjectId)
      ? { projectContext: entry.document.projectContext }
      : {}),
  };
}

export async function readRelationshipPairAuthority(tx, options) {
  const { transfer, normalized, repositoryIds } = options;
  const selected = ids(repositoryIds);
  const entries = await retainedEntries(tx, options);
  const aliases = new Set(
    issueTransferClosure(transfer.transfers, {
      repositoryIds: selected,
      artifactIds: transfer.artifactIds,
    }).artifactIds,
  );
  const selection = selectRetained(entries, selected, aliases);
  const evidence = selection.entries.length ? capture(selection, selected) : undefined;
  if (evidence !== undefined) validateRelationshipPairCapture(evidence);
  const authority = await privacy(tx, selection, options);
  const pairNormalized =
    normalized === undefined ? undefined : activeSources(normalized, transfer, selected, selection);
  if (pairNormalized !== undefined) {
    const retained = new Set(entries.map(sourceKey));
    for (const entry of pairNormalized)
      if (hasRelationshipPairMarker(entry.document))
        check(retained.has(sourceKey(entry)), "relationship_pair_normalization_changed_before_publication");
  }
  return {
    ...transfer,
    repositoryIds: authority.repositoryIds,
    access: authority.access,
    removed: authority.removed,
    // Private in-transaction identities for current correction overlays. Saved
    // authorizations bind the immutable capture; public documents use its hash.
    relationshipPairRecords: selection.records,
    relationshipPairEvidence: evidence,
    ...(pairNormalized === undefined ? {} : { normalized: pairNormalized }),
    fingerprint: digest({
      issueTransfers: transfer.fingerprint,
      relationshipPairs: evidence ?? null,
      repositoryIds: authority.repositoryIds,
      access: authority.access,
      removed: authority.removed,
    }),
  };
}

/** Validate the original immutable capture, never substitute today's closure.
 * Callers hold the same source gates through final publication/read admission. */
export async function readCapturedRelationshipPairAuthority(tx, value, options) {
  const saved = validateRelationshipPairCapture(value);
  if (options.repositoryIds !== undefined)
    check(same(saved.selectedRepositoryIds, ids(options.repositoryIds)), "relationship_pair_frozen_scope_changed");
  const rows = (
    await tx.query(
      pairReadQuery(
        `SELECT n.*,f.repository_id,f.family,f.subject_id,f.document AS source_document,
       f.document->>'evidence' AS source_evidence,f.observed_at,f.first_run_id
     FROM leaderboard_pipeline.normalizations n JOIN leaderboard_ingestion.source_facts f USING(fact_key)
     JOIN unnest($1::text[],$2::text[]) AS bound(fact_key,policy_signature) USING(fact_key,policy_signature)
     ORDER BY n.fact_key,n.policy_signature LIMIT 20001 FOR SHARE OF n`,
        options.historyBudget,
      ),
      [saved.bindings.map((binding) => binding.factKey), saved.bindings.map((binding) => binding.policySignature)],
    )
  ).rows;
  assertPairReadBudget(rows, options.historyBudget);
  check(rows.length === saved.bindings.length, "relationship_pair_frozen_binding_unavailable");
  const entries = [];
  for (const row of rows) {
    const entry = retainedEntry(row, options);
    await validateGeneration(row, options);
    entries.push(entry);
  }
  const included = [];
  const bindings = new Map(
    saved.bindings.map((binding) => [JSON.stringify([binding.factKey, binding.policySignature]), binding]),
  );
  const byEntry = new Map(entries.map((entry) => [entry, []]));
  for (const record of records(entries)) byEntry.get(record.entry).push(record);
  for (const entry of entries) {
    const binding = bindings.get(JSON.stringify([entry.source.factKey, entry.policySignature]));
    check(binding && binding.documentHash === digest(entry.document), "relationship_pair_frozen_binding_unavailable");
    const wanted = new Set(binding.factHashes);
    const selected = byEntry.get(entry).filter((record) => wanted.has(record.factHash));
    check(
      same(sorted(selected.map((record) => record.factHash)), binding.factHashes),
      "relationship_pair_frozen_binding_unavailable",
    );
    included.push(...selected);
  }
  const authority = await privacy(tx, { entries, records: included }, options);
  return {
    ...authority,
    sourcesCurrent:
      options.sources === undefined ||
      authority.requiredIds.every((id) =>
        options.sources.some(
          (source) =>
            source.repositoryId === id &&
            authority.access.some(
              (gate) => String(gate.repository_id) === id && String(gate.generation) === source.generation,
            ),
        ),
      ),
  };
}
