import type { MetricDefinition, MetricRegistry } from "@pick-your-ai/contracts";
import { getMetricUi, getRegistryDepartments, stableJSON } from "@pick-your-ai/metrics";
import { ReadFailure, type Selection } from "./client.ts";

export const isCatalogPath = (path: string) =>
  path === "/leaderboards" || path === "/methodology" || path === "/methodology/changes";

export function validateCatalogRoute(path: string, query: string): void {
  const params = new URLSearchParams(query);
  if (!isCatalogPath(path) && (params.has("q") || params.has("department")))
    throw new ReadFailure(400, "unsupported_catalog_filter_for_route");
}

export function registryMetric(registry: MetricRegistry, metricId: string): MetricDefinition {
  const metric = registry.metrics.find((entry) => entry.id === metricId);
  if (!metric) throw new ReadFailure(404, "unknown_metric_definition");
  return metric;
}

/** A board cannot replace the meaning of a definition from the loaded registry. */
export function verifyBoardDefinition(registry: MetricRegistry, metric: MetricDefinition): void {
  if (stableJSON(registryMetric(registry, metric.id)) !== stableJSON(metric))
    throw new ReadFailure(502, "api_metric_definition_mismatch");
}

export function discoverMetrics(registry: MetricRegistry, selected: Pick<Selection, "catalogQuery" | "department">) {
  const departments = getRegistryDepartments(registry);
  if (selected.department && !departments.some((department) => department.id === selected.department))
    throw new ReadFailure(400, "unknown_registry_department");
  const normalize = (value: string) => value.toLowerCase().replace(/[_-]+/g, " ");
  const terms = normalize(selected.catalogQuery ?? "")
    .split(/\s+/)
    .filter(Boolean);
  return registry.metrics.filter((metric) => {
    const ui = getMetricUi(metric.id, registry);
    if (selected.department && ui?.department !== selected.department) return false;
    const department = departments.find((entry) => entry.id === ui?.department);
    const text = normalize(
      [
        metric.id,
        metric.name,
        metric.counting_rule,
        metric.definition.unit,
        metric.attribution,
        department?.label ?? "",
        ...(ui?.synonyms ?? []),
      ].join(" "),
    );
    return terms.every((term) => text.includes(term));
  });
}
