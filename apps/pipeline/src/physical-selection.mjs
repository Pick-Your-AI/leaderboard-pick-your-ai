import { materializeEvidenceMetadata } from "./evidence-metadata.mjs";

/** Capture original hash-bound normalizations before recognition or privacy edits.
 * The bindings are the existing frozen identity authorization, not a new grant.
 */
export function capturePhysicalSources(normalized, normalizationSources, digest, dataMode) {
  const bound = new Map(normalizationSources.map((entry) => [entry.factKey, entry.documentHash]));
  return normalized.map((entry) => {
    if (
      bound.get(entry.source.factKey) !== digest(entry.document) ||
      entry.document.isSynthetic !== (dataMode === "synthetic")
    )
      throw new Error("physical_normalization_binding_unavailable");
    return structuredClone(entry.document);
  });
}

/** Select from the engine's actual aggregate units, never descriptive portfolio
 * grouping. Original source absence and a corrected/collapsed unit stay unknown.
 */
export function selectPhysicalContexts({
  sources,
  aggregates,
  policies,
  contracts,
  serialize,
  policyDigest,
  projectContextFor,
}) {
  const applicable = policies.filter((item) => contracts.physicalMetricIds.includes(item.policy.metricId));
  if (!applicable.length) return {};
  const copies = new Map();
  for (const output of sources)
    for (const fact of output.facts) {
      if (!contracts.physicalMetricIds.includes(fact.metricId)) continue;
      const list = copies.get(fact.id) ?? [];
      list.push({ output, fact });
      copies.set(fact.id, list);
    }
  const dependencies = new Map();
  const physicalContexts = [];
  for (const item of applicable) {
    const policy = item.policy;
    const aggregate = aggregates.find((entry) => entry.metricId === policy.metricId);
    for (const row of aggregate?.rows ?? []) {
      const common = {
        schemaVersion: contracts.publicPhysicalContextVersion,
        actorId: row.actorId,
        metricId: policy.metricId,
        policyVersion: policy.version,
        policySignature: policyDigest(item.signature),
      };
      const unknown = (reason) => ({ ...common, state: "unknown", reason });
      const selected = new Set(row.evidenceIds);
      let reason = !selected.size || selected.size !== row.evidenceIds.length ? "selected_units_unbound" : null;
      const samples = new Map();
      const sampleDependencies = new Map();
      for (const id of selected) {
        const candidates = copies.get(id) ?? [];
        if (!candidates.length || candidates.some(({ output }) => output.physicalContext === undefined)) {
          reason = "retained_context_unavailable";
          break;
        }
        const originalReceipts = candidates.map(({ output }) =>
          contracts.githubPhysicalContextReceiptSchema.parse(output.physicalContext),
        );
        if (new Set(originalReceipts.map(serialize)).size !== 1) {
          reason = "selected_units_unbound";
          break;
        }
        const selectedEvidence = row.evidence.find((entry) => entry.id === id);
        const signature = (fact) =>
          serialize([
            fact.actorId,
            fact.revision,
            fact.role,
            fact.state,
            fact[policy.dateBasis] == null ? null : Date.parse(fact[policy.dateBasis]),
            fact.quantity ?? null,
            fact.outcome ?? null,
            fact.readyAt == null ? null : Date.parse(fact.readyAt),
            fact.firstReviewAt == null ? null : Date.parse(fact.firstReviewAt),
          ]);
        const candidate = candidates.find(
          ({ fact }) =>
            selectedEvidence?.comparisonSignature === signature(fact) &&
            selectedEvidence.observedAt === fact.observedAt,
        );
        if (!candidate || candidate.fact.revision !== 0 || candidate.fact.actorId !== row.actorId) {
          reason = "selected_units_unbound";
          break;
        }
        const receipt = originalReceipts[0];
        const facts = receipt.facts.filter((fact) => fact.metricId === policy.metricId);
        const binding = facts.find((fact) => fact.factId === id);
        const merged = candidate.output.facts.filter((fact) => fact.metricId === "pr_merged");
        const proof = candidate.output.evidence.find((entry) => entry.contribution.contributionId === merged[0]?.id);
        if (
          !binding ||
          binding.canonicalKey !== candidate.fact.canonicalKey ||
          binding.quantity !== (candidate.fact.quantity ?? 1) ||
          !facts.every((fact) => selected.has(fact.factId)) ||
          receipt.actorId !== row.actorId ||
          merged.length !== 1 ||
          !proof
        ) {
          reason = "selected_units_unbound";
          break;
        }
        const key = serialize([receipt.repositoryId, receipt.canonicalIntegrationId, receipt.actorId]);
        const sample = { receipt, mergedEvidenceId: merged[0].id };
        if (samples.has(key) && serialize(samples.get(key)) !== serialize(sample)) {
          reason = "selected_units_unbound";
          break;
        }
        samples.set(key, sample);
        const dependency = {
          ...structuredClone(proof),
          ...materializeEvidenceMetadata(proof, merged[0]),
          ...projectContextFor(proof, merged[0]),
        };
        const previous = sampleDependencies.get(merged[0].id);
        if (previous && serialize(previous) !== serialize(dependency)) {
          reason = "selected_units_unbound";
          break;
        }
        sampleDependencies.set(merged[0].id, dependency);
      }
      const ordered = [...samples.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, value]) => value);
      const ids = ordered.flatMap((sample) =>
        sample.receipt.facts.filter((fact) => fact.metricId === policy.metricId).map((fact) => fact.factId),
      );
      if (!reason && serialize([...ids].sort()) !== serialize([...selected].sort())) reason = "selected_units_unbound";
      if (
        !reason &&
        (ids.length > contracts.physicalContextLimits.units || ordered.length > contracts.physicalContextLimits.units)
      )
        reason = "context_budget_exceeded";
      const context = reason
        ? unknown(reason)
        : contracts.physicalSnapshotContextSchema.parse({ ...common, state: "available", samples: ordered });
      // Unknown candidates retain no partial samples. Public projection cannot
      // expose a budget/detail reason without a complete current dependency set.
      physicalContexts.push(context);
      if (!reason)
        for (const [id, dependency] of sampleDependencies) {
          const previous = dependencies.get(id);
          if (previous && serialize(previous) !== serialize(dependency))
            throw new Error("conflicting_physical_dependency");
          dependencies.set(id, dependency);
        }
    }
  }
  return {
    physicalContexts,
    physicalEvidence: [...dependencies.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, entry]) => entry),
  };
}
