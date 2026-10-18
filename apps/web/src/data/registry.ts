import type { MetricDefinition } from "@pick-your-ai/contracts";
import {
  getLeadMetrics,
  getMetricUi,
  getMetricGroupingPolicy,
  getRegistryDepartments,
  metricDefinitionsV1,
  metricRegistryV1,
} from "@pick-your-ai/metrics";

export const registry = metricRegistryV1;
export const metrics: readonly MetricDefinition[] = metricDefinitionsV1;

/** UI departments reuse metric families; they do not assign team ownership. */
export const families = getRegistryDepartments(registry);
export type FamilyId = string;
export { getMetricUi, getMetricGroupingPolicy };
export const leadMetrics = (surface: "overview" | "wall") => getLeadMetrics(surface, registry);

export function familyLabel(id: string): string {
  return families.find((family) => family.id === id)?.label ?? id;
}

export function getMetric(id: string): MetricDefinition | undefined {
  return metrics.find((metric) => metric.id === id);
}

export function metricsInFamily(id: string): MetricDefinition[] {
  return metrics.filter((metric) => metric.family === id);
}

export const displayPolicyLabels: Record<string, string> = {
  leaderboard: "Ranked board",
  context: "Context only (not ranked)",
  spotlight: "Editorial spotlight (not ranked)",
};

export const releaseEligibilityLabels: Record<string, string> = {
  "automatic baseline": "Automatic from source data",
  conditional: "Conditional on source capability",
  "evidence-reviewed": "Requires reviewed evidence",
  "descriptive-only": "Descriptive only",
  "deferred advanced": "Deferred",
};

function normalize(text: string): string {
  return text.toLowerCase().replace(/[_-]+/g, " ");
}

/** Search names, IDs, units and counting rules. Every term must match. */
export function searchMetrics(query: string, family: string | null = null): MetricDefinition[] {
  const terms = normalize(query).split(/\s+/).filter(Boolean);
  return metrics.filter((metric) => {
    if (family && metric.family !== family) return false;
    if (terms.length === 0) return true;
    const haystack = normalize(
      [
        metric.id,
        metric.name,
        metric.definition.unit,
        metric.counting_rule,
        metric.attribution,
        familyLabel(getMetricUi(metric.id)?.department ?? metric.family),
        ...(getMetricUi(metric.id)?.synonyms ?? []),
      ].join(" "),
    );
    return terms.every((term) => haystack.includes(term));
  });
}
