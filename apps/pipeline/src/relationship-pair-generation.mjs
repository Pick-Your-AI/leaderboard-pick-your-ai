// Relationship enrichment can be attached to any collected family. Both a
// calculation fact and its public evidence claim can retain obsolete semantics.
const metrics = new Set(["reference_links", "closing_links"]);

export const isRelationshipPairMetric = (metricId) => metrics.has(metricId);

export const hasRelationshipPairClaims = (document) =>
  (Array.isArray(document?.facts) && document.facts.some((fact) => metrics.has(fact?.metricId))) ||
  (Array.isArray(document?.evidence) &&
    document.evidence.some(
      (entry) =>
        Array.isArray(entry?.contribution?.metricIds) &&
        entry.contribution.metricIds.some((metricId) => metrics.has(metricId)),
    ));

// Presence, not the value, preserves classification when corrected output is
// empty. The caller separately verifies the exact supported version and key.
export const hasRelationshipPairMarker = (document) =>
  document !== null && typeof document === "object" && Object.hasOwn(document, "relationshipPairNormalizationVersion");
