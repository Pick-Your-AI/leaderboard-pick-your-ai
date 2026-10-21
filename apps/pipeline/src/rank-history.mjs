import { compareSourceInstants, pullRequestDecisionInstantSchema, sourceAdapterSchema } from "@pick-your-ai/contracts";
import { createHash } from "node:crypto";
import { parseDecisionProjection } from "./pull-request-decision-history.mjs";
const fail = () => {
  throw new Error("rank_history_integrity_error");
};
const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
const instant = (value) =>
  typeof value === "string" &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value) &&
  Number.isFinite(Date.parse(value));

/** Add only clocks/signatures. Required receipt rows already retain exact ranks,
 * values, policy and scope. No identity/provider records are duplicated. */
export function captureRankEvidence(aggregates, policies) {
  return {
    schemaVersion: "private-rank-evidence/v1",
    metrics: aggregates.map((metric) => ({
      metricId: metric.metricId,
      sources: [...new Set(policies.find((policy) => policy.metricId === metric.metricId).sources)].sort(),
      rows: metric.rows.map((row) => ({
        actorId: row.actorId,
        evidence: row.evidence.map((item) => {
          if (!item.comparisonSignature) fail();
          return {
            id: item.id,
            effectiveAt: item.effectiveAt,
            observedAt: item.observedAt,
            comparisonSignature: createHash("sha256").update(item.comparisonSignature).digest("hex"),
          };
        }),
      })),
    })),
  };
}

/** Call only after the complete explanation's immutable digest and publication
 * confirmation are verified. Legacy receipts remain unchanged. */
export function retainedRankHistory(document) {
  const saved = document.rankEvidence;
  if (saved === undefined) return null;
  if (
    saved.schemaVersion !== "private-rank-evidence/v1" ||
    !Array.isArray(saved.metrics) ||
    !same(
      saved.metrics.map((metric) => metric.metricId),
      document.metrics.map((metric) => metric.metricId),
    )
  )
    fail();
  let nativeDecisionProjection = false;
  if (document.authorization?.pullRequestDecisionProjection !== undefined) {
    try {
      const projection = parseDecisionProjection(
        document.authorization.pullRequestDecisionProjection,
        document.authorization.pullRequestDecisionEvidence,
      );
      if (compareSourceInstants(projection.asOf, document.scope.to) !== 0) fail();
      nativeDecisionProjection = true;
    } catch {
      fail();
    }
  }
  return {
    snapshotId: document.snapshot.snapshotId,
    revision: document.snapshot.revision,
    metrics: document.metrics.map((metric) => {
      const history = saved.metrics.find((entry) => entry.metricId === metric.metricId);
      const evidenceInstant =
        nativeDecisionProjection && metric.metricId === "pr_accepted_rate" && metric.aggregation === "ratio"
          ? (value) => pullRequestDecisionInstantSchema.safeParse(value).success
          : instant;
      if (
        !Array.isArray(history.sources) ||
        !history.sources.length ||
        history.sources.length > sourceAdapterSchema.options.length ||
        new Set(history.sources).size !== history.sources.length ||
        history.sources.some((source) => !sourceAdapterSchema.safeParse(source).success) ||
        !Array.isArray(history.rows) ||
        !same(
          history.rows.map((row) => row.actorId),
          metric.rows.map((row) => row.actorId),
        )
      )
        fail();
      // Index only after the multiset check, so duplicate retained actors cannot
      // collapse into an apparently valid cohort. Keep the first matching row.
      const historyRows = new Map();
      for (const row of history.rows) if (!historyRows.has(row.actorId)) historyRows.set(row.actorId, row);
      return {
        metricId: metric.metricId,
        sources: [...history.sources],
        policyVersion: metric.policyVersion,
        policySignature: metric.policyHash,
        definitionVersion: metric.definitionVersion,
        unit: metric.unit,
        aggregation: metric.aggregation,
        scope: structuredClone(document.scope),
        cutoff: document.cutoff,
        backfillRevision: document.backfillRevision,
        coverage: metric.coverage,
        rows: metric.rows.map((row) => {
          const source = historyRows.get(row.actorId);
          if (
            !Array.isArray(source.evidence) ||
            !same(
              source.evidence.map((item) => item.id),
              row.eligible.map((item) => item.factId),
            ) ||
            source.evidence.some(
              (item) =>
                (item.effectiveAt !== null && !evidenceInstant(item.effectiveAt)) ||
                !evidenceInstant(item.observedAt) ||
                !/^[a-f0-9]{64}$/.test(item.comparisonSignature),
            )
          )
            fail();
          return {
            actorId: row.actorId,
            value: row.value,
            rank: row.rank,
            evidence: source.evidence.map(({ id, effectiveAt, observedAt, comparisonSignature }) => ({
              id,
              effectiveAt,
              observedAt,
              comparisonSignature,
            })),
          };
        }),
      };
    }),
  };
}
