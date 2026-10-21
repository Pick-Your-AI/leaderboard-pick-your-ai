import { captureRankEvidence, retainedRankHistory } from "./rank-history.mjs";
import { createHash } from "node:crypto";
import { compareSourceInstants, parseDiscussionFeedbackCapture } from "@pick-your-ai/contracts";
import { reversionAuthorityVersion } from "./reversion-effectiveness.mjs";
import { captureIssueTransferAuthorization } from "./issue-transfer-authority.mjs";
import { validateRelationshipPairCapture } from "./relationship-pair-authority.mjs";
import { captureMergeTargetAuthorization } from "./pull-request-merge-target.mjs";
import { decisionGenerationAuthorization, parseDecisionGenerationCapture } from "./pull-request-decision-history.mjs";

// Local fail-closed bounds, not a production retention or capacity commitment.
// Records have the retained snapshot's lifecycle, never the optional preview TTL.
export const aggregateExplanationLimitsV1 = Object.freeze({
  schemaVersion: "private-aggregate-explanation/v1",
  computationVersion: "independent-metric-arithmetic/v1",
  bytes: 16 * 1024 * 1024,
  facts: 50_000,
});
const stable = (value) =>
  value === undefined
    ? "null"
    : Array.isArray(value)
      ? `[${value.map(stable).join(",")}]`
      : value !== null && typeof value === "object"
        ? `{${Object.keys(value)
            .sort()
            .map((key) => `${JSON.stringify(key)}:${stable(value[key])}`)
            .join(",")}}`
        : JSON.stringify(value);
export const aggregateExplanationHash = (value) => createHash("sha256").update(stable(value)).digest("hex");
const fail = (code = "aggregate_explanation_integrity_error") => {
  throw new Error(code);
};
const check = (value, code) => {
  if (!value) fail(code);
};
const token = (value) => {
  check(
    typeof value === "string" && /^[A-Za-z0-9_.:=/-]{1,256}$/.test(value),
    "aggregate_explanation_invalid_identifier",
  );
  return value;
};
const optionalToken = (value) => (value === null ? null : token(value));
const hash = (value) => {
  check(typeof value === "string" && /^[a-f0-9]{64}$/.test(value));
  return value;
};
const sorted = (values) => [...new Set(values)].sort();
const same = (left, right) => stable(left) === stable(right);
const finite = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;

function reversionAuthorization(authorization) {
  if (!Object.hasOwn(authorization, "reversionAuthority") && !Object.hasOwn(authorization, "reversionRecordsHash"))
    return {};
  const authority = authorization.reversionAuthority;
  check(
    authority &&
      Object.keys(authority).sort().join(",") === "digest,hashes,version" &&
      authority.version === reversionAuthorityVersion &&
      Array.isArray(authority.hashes) &&
      authority.hashes.length <= 10000 &&
      same(authority.hashes, sorted(authority.hashes)),
  );
  authority.hashes.forEach(hash);
  check(hash(authority.digest) === aggregateExplanationHash([reversionAuthorityVersion, authority.hashes]));
  return {
    reversionAuthority: structuredClone(authority),
    reversionRecordsHash: hash(authorization.reversionRecordsHash),
  };
}

function identityAuthorization(authorization) {
  if (authorization.identityEvidence === undefined) return {};
  const binding = authorization.identityEvidence;
  check(
    binding?.schemaVersion === "pipeline-identity-evidence/v1" &&
      Object.keys(binding).every((key) =>
        ["schemaVersion", "normalizationHashes", "normalizationSources"].includes(key),
      ) &&
      Array.isArray(binding.normalizationHashes) &&
      binding.normalizationHashes.length <= 10000 &&
      new Set(binding.normalizationHashes).size === binding.normalizationHashes.length &&
      (binding.normalizationSources === undefined ||
        (Array.isArray(binding.normalizationSources) && binding.normalizationSources.length <= 10000)),
  );
  const normalizationHashes = binding.normalizationHashes.map(hash);
  const normalizationSources = binding.normalizationSources?.map((entry) => {
    check(
      entry !== null &&
        typeof entry === "object" &&
        Object.keys(entry).every((key) => ["factKey", "documentHash", "relationshipPairFactHashes"].includes(key)),
    );
    const projection = entry.relationshipPairFactHashes;
    check(
      projection === undefined ||
        (Array.isArray(projection) &&
          projection.length > 0 &&
          projection.length <= 10000 &&
          same(projection, sorted(projection))),
    );
    if (projection !== undefined) projection.forEach(hash);
    return {
      factKey: hash(entry.factKey),
      documentHash: hash(entry.documentHash),
      ...(projection === undefined ? {} : { relationshipPairFactHashes: [...projection] }),
    };
  });
  const hashes = new Set(normalizationHashes);
  check(
    normalizationSources === undefined ||
      (new Set(normalizationSources.map((entry) => entry.factKey)).size === normalizationSources.length &&
        new Set(normalizationSources.map((entry) => entry.documentHash)).size === hashes.size &&
        normalizationSources.every((entry) => hashes.has(entry.documentHash))),
  );
  return {
    identityEvidence: {
      schemaVersion: binding.schemaVersion,
      normalizationHashes,
      ...(normalizationSources === undefined ? {} : { normalizationSources }),
    },
  };
}

function explanationRow(row, policy, input, facts) {
  const eligible = row.evidenceIds.map((id) => {
    const fact = facts.get(id);
    check(fact && fact.actorId === row.actorId && policy.rankedStates.includes(fact.state));
    const base = { factId: token(id), revision: fact.revision, factHash: aggregateExplanationHash(fact) };
    if (policy.aggregation === "sum") return { ...base, quantity: fact.quantity ?? null };
    if (policy.aggregation === "ratio") return { ...base, outcome: fact.outcome };
    if (policy.aggregation === "duration") {
      const status =
        fact.readyAt == null
          ? "missing_readiness"
          : fact.firstReviewAt == null || Date.parse(fact.firstReviewAt) > Date.parse(input.cutoff)
            ? "censored"
            : Date.parse(fact.firstReviewAt) < Date.parse(fact.readyAt)
              ? "invalid_chronology"
              : "sample";
      return {
        ...base,
        status,
        hours: status === "sample" ? (Date.parse(fact.firstReviewAt) - Date.parse(fact.readyAt)) / 3600000 : null,
      };
    }
    return base;
  });
  const pendingIds = row.pendingEvidence.map((evidence) => {
    const fact = facts.get(evidence.id);
    check(
      fact &&
        same(fact, evidence) &&
        fact.actorId === row.actorId &&
        (fact.state === "pending" ||
          (policy.aggregation === "ratio" && policy.rankedStates.includes(fact.state) && fact.outcome === "pending")),
    );
    return token(fact.id);
  });
  const result = {
    actorId: token(row.actorId),
    value: row.value,
    state: row.state,
    rank: row.rank,
    tied: row.tied,
    eligible,
    pendingIds,
    pending: row.pending,
    numerator: row.numerator,
    denominator: row.denominator,
    sampleCount: row.sampleCount,
    samples: row.samples,
    p75: row.p75,
    censored: row.censored,
    missingReadiness: row.missingReadiness,
  };
  validateArithmetic(result, policy.aggregation, policy.minimumSamples, policy.rank);
  return result;
}

/** Validate the arithmetic without retaining acceptance, classification or raw source receipts. */
function validateArithmetic(row, aggregation, minimumSamples, ranked) {
  const eligibleIds = new Set(row.eligible.map((entry) => entry.factId));
  check(eligibleIds.size === row.eligible.length);
  check(new Set(row.pendingIds).size === row.pendingIds.length && row.pending === row.pendingIds.length);
  check(!row.pendingIds.some((id) => eligibleIds.has(id)));
  check(row.value === null || finite(row.value));
  check(row.rank === null || (ranked && Number.isSafeInteger(row.rank) && row.rank > 0));
  let expected = null;
  if (aggregation === "count" || aggregation === "sum") {
    check(row.sampleCount === row.eligible.length && row.samples.length === 0);
    check(
      row.numerator === null &&
        row.denominator === null &&
        row.p75 === null &&
        row.censored === 0 &&
        row.missingReadiness === 0,
    );
    if (aggregation === "sum")
      check(
        row.eligible.every(
          (entry) => entry.quantity === null || (Number.isSafeInteger(entry.quantity) && entry.quantity >= 0),
        ),
      );
    if (row.eligible.length && (aggregation === "count" || row.eligible.every((entry) => entry.quantity !== null)))
      expected =
        aggregation === "count"
          ? row.eligible.length
          : row.eligible.reduce((total, entry) => total + entry.quantity, 0);
    check(expected === null || Number.isSafeInteger(expected));
  } else if (aggregation === "ratio") {
    check(row.eligible.every((entry) => ["merged", "closed_unmerged"].includes(entry.outcome)));
    check(row.numerator === row.eligible.filter((entry) => entry.outcome === "merged").length);
    check(row.denominator === row.eligible.length && row.sampleCount === row.denominator);
    check(row.samples.length === 0 && row.p75 === null && row.censored === 0 && row.missingReadiness === 0);
    if (row.denominator >= minimumSamples) expected = row.numerator / row.denominator;
  } else {
    check(aggregation === "duration" && row.numerator === null && row.denominator === null);
    const samples = row.eligible
      .filter((entry) => entry.status === "sample")
      .map((entry) => entry.hours)
      .sort((a, b) => a - b);
    check(samples.every(finite) && same(samples, row.samples) && row.sampleCount === samples.length);
    check(
      row.eligible.every(
        (entry) =>
          ["sample", "censored", "missing_readiness", "invalid_chronology"].includes(entry.status) &&
          (entry.status === "sample" || entry.hours === null),
      ),
    );
    check(row.censored === row.eligible.filter((entry) => entry.status === "censored").length);
    check(
      row.missingReadiness ===
        row.eligible.filter((entry) => ["missing_readiness", "invalid_chronology"].includes(entry.status)).length,
    );
    if (samples.length >= minimumSamples) {
      const middle = Math.floor(samples.length / 2);
      expected = samples.length % 2 ? samples[middle] : (samples[middle - 1] + samples[middle]) / 2;
      check(row.p75 === samples[Math.ceil(samples.length * 0.75) - 1]);
    } else check(row.p75 === null);
  }
  // Incomplete coverage can withhold a measured zero; it cannot alter arithmetic.
  check(row.value === expected || (expected === 0 && row.value === null && row.state === "unknown"));
}

function validateRanks(rows, ranked) {
  const frequencies = new Map();
  for (const row of rows) if (row.value !== null) frequencies.set(row.value, (frequencies.get(row.value) ?? 0) + 1);
  const ranks = new Map([...frequencies.keys()].sort((a, b) => b - a).map((value, index) => [value, index + 1]));
  for (const row of rows) {
    const rank = ranked && row.value !== null ? ranks.get(row.value) : null;
    check(row.rank === rank && row.tied === (rank !== null && frequencies.get(row.value) > 1));
  }
}

function validateAudit(rows, audit, aggregation, evidenceClass) {
  check(new Set(rows.map((row) => row.actorId)).size === rows.length);
  const eligibleIds = rows.flatMap((row) => row.eligible.map((entry) => entry.factId));
  const eligibleSet = new Set(eligibleIds);
  const pendingIds = rows.flatMap((row) => row.pendingIds);
  check(
    eligibleSet.size === eligibleIds.length &&
      new Set(pendingIds).size === pendingIds.length &&
      !pendingIds.some((id) => eligibleSet.has(id)),
  );
  const included = `included_${aggregation}_${evidenceClass}`;
  check(audit.every((entry) => !entry.reason.startsWith("included_") || entry.reason === included));
  const pairs = (entries) => entries.map(([actorId, id]) => stable([actorId, id])).sort();
  const audited = (reason) =>
    pairs(
      audit
        .filter((entry) => entry.reason === reason)
        .flatMap((entry) => entry.factIds.map((id) => [entry.actorId, id])),
    );
  check(
    same(audited(included), pairs(rows.flatMap((row) => row.eligible.map((entry) => [row.actorId, entry.factId])))),
    "aggregate_explanation_unaccounted_evidence",
  );
  check(
    same(audited("pending_not_ranked"), pairs(rows.flatMap((row) => row.pendingIds.map((id) => [row.actorId, id])))),
    "aggregate_explanation_unaccounted_evidence",
  );
}

export function buildAggregateExplanation(capture, binding) {
  const { input, policies, aggregates, authorization, snapshot, scope } = capture;
  const decision = decisionGenerationAuthorization(authorization);
  if (decision.pullRequestDecisionEvidence !== undefined) {
    const retained = decision.pullRequestDecisionEvidence;
    check(
      retained.observationCutoff === input.cutoff &&
        retained.runs.every((run) =>
          authorization.sources.some(
            (source) => source.repositoryId === String(run.repositoryId) && source.generation === run.accessGeneration,
          ),
        ),
    );
  }
  const canonicalScope = {
    ...scope,
    repos: sorted(scope.repos),
    projects: sorted(scope.projects),
    workstreams: sorted(scope.workstreams),
    roles: sorted(scope.roles),
  };
  check(input.facts.length <= aggregateExplanationLimitsV1.facts, "aggregate_explanation_budget_exceeded");
  check(policies.length > 0 && policies.length <= 98 && policies.length === aggregates.length);
  check(new Set(policies.map((policy) => policy.metricId)).size === policies.length);
  const metrics = policies.map((policy) => {
    const aggregate = aggregates.find((item) => item.metricId === policy.metricId);
    check(
      aggregate &&
        aggregate.policySignature === stable(policy) &&
        aggregate.policyVersion === policy.version &&
        aggregate.definitionVersion === policy.definitionVersion &&
        aggregate.unit === policy.unit &&
        aggregate.aggregation === policy.aggregation &&
        same(aggregate.scope, canonicalScope) &&
        aggregate.datasetId === input.datasetId &&
        aggregate.cutoff === input.cutoff &&
        aggregate.backfillRevision === input.backfillRevision,
    );
    const allFacts = input.facts.filter((fact) => fact.metricId === policy.metricId);
    const facts = new Map();
    for (const fact of allFacts) {
      if (
        compareSourceInstants(fact.observedAt, input.cutoff) > 0 ||
        (fact.revision > 0 && !fact.correctionReceipt?.trim())
      )
        continue;
      if (!facts.has(fact.id) || facts.get(fact.id).revision < fact.revision) facts.set(fact.id, fact);
    }
    const audit = aggregate.audit.map((entry) => ({
      factIds: entry.factIds.map(token),
      actorId: optionalToken(entry.actorId),
      reason: token(entry.reason),
    }));
    check(
      same(sorted(allFacts.map((fact) => fact.id)), sorted(audit.flatMap((entry) => entry.factIds))),
      "aggregate_explanation_unaccounted_evidence",
    );
    const rows = aggregate.rows.map((row) => explanationRow(row, policy, input, facts));
    validateRanks(rows, policy.rank);
    validateAudit(rows, audit, policy.aggregation, policy.rankedStates[0]);
    check(
      new Set(rows.flatMap((row) => row.eligible.map((entry) => entry.factId))).size ===
        rows.reduce((sum, row) => sum + row.eligible.length, 0),
    );
    return {
      metricId: token(policy.metricId),
      policyVersion: token(policy.version),
      policyHash: aggregateExplanationHash(policy),
      definitionVersion: token(policy.definitionVersion),
      unit: policy.unit,
      aggregation: policy.aggregation,
      dateBasis: policy.dateBasis,
      evidenceClass: policy.rankedStates[0],
      minimumSamples: policy.minimumSamples,
      ranked: policy.rank,
      coverage: aggregate.coverage,
      rows,
      audit,
    };
  });
  const references = [
    ...new Map(
      input.facts
        .filter((fact) => policies.some((policy) => policy.metricId === fact.metricId))
        .map((fact) => {
          const reference = {
            metricId: token(fact.metricId),
            factId: token(fact.id),
            actorId: optionalToken(fact.actorId),
            artifactId: optionalToken(fact.artifactId),
            repositoryId: token(fact.repoId),
          };
          return [stable(reference), reference];
        }),
    ).values(),
  ].sort((a, b) => stable(a).localeCompare(stable(b)));
  const document = {
    schemaVersion: aggregateExplanationLimitsV1.schemaVersion,
    computationVersion: aggregateExplanationLimitsV1.computationVersion,
    snapshot: {
      snapshotId: hash(snapshot.snapshotId),
      revision: snapshot.revision,
      computationVersion: token(binding.computationVersion),
    },
    scopeKey: binding.scopeKey,
    scope: canonicalScope,
    inputHash: aggregateExplanationHash(capture),
    datasetId: token(input.datasetId),
    cutoff: input.cutoff,
    backfillRevision: token(input.backfillRevision),
    authorization: {
      configurationHash: hash(authorization.configurationHash),
      dataMode: authorization.dataMode,
      controlsConfigurationRevision: authorization.controlsConfigurationRevision,
      ...identityAuthorization(authorization),
      ...(authorization.discussionFeedbackEvidence === undefined
        ? {}
        : {
            discussionFeedbackEvidence: parseDiscussionFeedbackCapture(authorization.discussionFeedbackEvidence),
          }),
      ...(authorization.relationshipPairEvidence === undefined
        ? {}
        : {
            relationshipPairEvidence: validateRelationshipPairCapture(authorization.relationshipPairEvidence),
          }),
      ...captureMergeTargetAuthorization(authorization),
      ...decision,
      ...reversionAuthorization(authorization),
      sources: authorization.sources.map((source) => ({
        repositoryId: token(source.repositoryId),
        generation: token(source.generation),
      })),
      // A correction already effective in this exact calculation is explained,
      // not a stale-input disclosure. Keep only artifact identity and a hash;
      // future, unreviewed or superseded corrections cannot authorize a read.
      corrections: input.facts
        .filter(
          (fact) =>
            fact.revision > 0 &&
            fact.correctionReceipt?.trim() &&
            fact.state === "excluded" &&
            compareSourceInstants(fact.observedAt, input.cutoff) <= 0 &&
            metrics.some(
              (metric) =>
                metric.metricId === fact.metricId &&
                metric.audit.some(
                  (entry) => entry.reason === "excluded_by_policy_or_correction" && entry.factIds.includes(fact.id),
                ) &&
                !metric.rows.some((row) => row.eligible.some((entry) => entry.factId === fact.id)),
            ),
        )
        .map((fact) => ({ artifactId: token(fact.artifactId), hash: aggregateExplanationHash(fact) })),
    },
    references,
    metrics,
    rankEvidence: captureRankEvidence(aggregates, policies),
  };
  Object.assign(
    document.authorization,
    captureIssueTransferAuthorization(authorization, document.authorization.corrections),
  );
  retainedRankHistory(document);
  check(Number.isSafeInteger(snapshot.revision) && snapshot.revision > 0);
  check(
    Buffer.byteLength(stable(document)) <= aggregateExplanationLimitsV1.bytes,
    "aggregate_explanation_budget_exceeded",
  );
  return document;
}

/** Privileged host storage only. Never mount this store on public HTTP routes. */
export class AggregateExplanationStore {
  constructor(store) {
    this.store = store;
    store.db.exec(
      "CREATE TABLE IF NOT EXISTS pipeline_aggregate_explanations (snapshot_id TEXT PRIMARY KEY, document TEXT NOT NULL, digest TEXT NOT NULL)",
    );
  }
  read(snapshotId) {
    hash(snapshotId);
    const row = this.store.db
      .prepare("SELECT * FROM pipeline_aggregate_explanations WHERE snapshot_id=?")
      .get(snapshotId);
    check(row, "aggregate_explanation_required");
    try {
      check(Buffer.byteLength(row.document) <= aggregateExplanationLimitsV1.bytes);
      const document = JSON.parse(row.document);
      const decision =
        document.authorization?.pullRequestDecisionEvidence === undefined
          ? null
          : parseDecisionGenerationCapture(document.authorization.pullRequestDecisionEvidence);
      if (decision !== null) document.authorization.pullRequestDecisionEvidence = decision;
      check(
        document.schemaVersion === aggregateExplanationLimitsV1.schemaVersion &&
          document.snapshot.snapshotId === snapshotId &&
          aggregateExplanationHash(document) === row.digest,
      );
      check(document.computationVersion === aggregateExplanationLimitsV1.computationVersion);
      reversionAuthorization(document.authorization);
      if (decision !== null) {
        check(
          decision.observationCutoff === document.cutoff &&
            decision.runs.every((run) =>
              document.authorization.sources.some(
                (source) =>
                  source.repositoryId === String(run.repositoryId) && source.generation === run.accessGeneration,
              ),
            ),
        );
      }
      if (document.authorization.discussionFeedbackEvidence !== undefined) {
        const capture = parseDiscussionFeedbackCapture(document.authorization.discussionFeedbackEvidence);
        check(
          capture.every((entry) =>
            document.authorization.sources.some((source) => source.repositoryId === String(entry.repositoryId)),
          ),
        );
      }
      for (const metric of document.metrics) {
        for (const row of metric.rows)
          validateArithmetic(row, metric.aggregation, metric.minimumSamples, metric.ranked);
        validateRanks(metric.rows, metric.ranked);
        validateAudit(metric.rows, metric.audit, metric.aggregation, metric.evidenceClass);
      }
      retainedRankHistory(document);
      return { digest: row.digest, document };
    } catch {
      fail();
    }
  }
  verify(snapshotId, binding) {
    const saved = this.read(snapshotId);
    check(
      saved.document.snapshot.revision === binding.revision &&
        saved.document.scopeKey === binding.scopeKey &&
        saved.document.authorization.configurationHash === binding.configurationHash &&
        saved.document.snapshot.computationVersion === binding.computationVersion &&
        (!binding.digest || saved.digest === binding.digest),
    );
    return saved;
  }
  // Must run within the existing synchronous controls transaction. Readback
  // detects ignored writes, collisions and corruption before confirmation commits.
  capture(capture, binding) {
    const document = buildAggregateExplanation(capture, binding);
    const digest = aggregateExplanationHash(document);
    const existing = this.store.db
      .prepare("SELECT snapshot_id FROM pipeline_aggregate_explanations WHERE snapshot_id=?")
      .get(document.snapshot.snapshotId);
    if (!existing && binding.digest) check(binding.digest === digest);
    if (!existing)
      this.store.db
        .prepare("INSERT INTO pipeline_aggregate_explanations VALUES(?,?,?)")
        .run(document.snapshot.snapshotId, stable(document), digest);
    const saved = this.verify(document.snapshot.snapshotId, {
      ...binding,
      revision: document.snapshot.revision,
      configurationHash: document.authorization.configurationHash,
      ...(!existing ? { digest } : {}),
    });
    // A content-identical publication may be recomputed at a later observation
    // cutoff. The first explanation remains immutable; changed arithmetic cannot
    // acquire its identity. Exact dispatch input replay is also receipt-bound.
    check(
      same(saved.document.metrics, document.metrics) &&
        same(saved.document.references, document.references) &&
        same(saved.document.scope, document.scope) &&
        same(saved.document.authorization, document.authorization),
    );
    return saved;
  }
}
