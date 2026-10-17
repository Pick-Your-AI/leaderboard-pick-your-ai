import type { MetricDefinition } from "@pick-your-ai/contracts";
import { metricDefinitionsV1, metricRegistryV1 } from "@pick-your-ai/metrics";

export const registry = metricRegistryV1;
export const metrics: readonly MetricDefinition[] = metricDefinitionsV1;

/**
 * Registry families in contribution-lifecycle order. The labels are prototype
 * display names. Department assignment is still an unresolved registry field
 * (ui_metadata), so the UI groups by the registry's own family and says so.
 */
export const families = [
  { id: "research", label: "Research" },
  { id: "issues", label: "Issues" },
  { id: "triage", label: "Triage and stewardship" },
  { id: "delivery", label: "Code delivery" },
  { id: "review", label: "Review" },
  { id: "craft", label: "Craft and quality" },
  { id: "lines", label: "Lines of change" },
  { id: "operations", label: "Operations and maintenance" },
  { id: "community", label: "Community" },
  { id: "breadth", label: "Breadth and milestones" },
] as const;

export type FamilyId = (typeof families)[number]["id"];

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
        familyLabel(metric.family),
      ].join(" "),
    );
    return terms.every((term) => haystack.includes(term));
  });
}
