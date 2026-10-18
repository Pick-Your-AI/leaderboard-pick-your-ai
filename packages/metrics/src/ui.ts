import type { MetricRegistry, MetricSelection, MetricUiEntry } from "@pick-your-ai/contracts";
import { metricRegistryV1 } from "./v1/index.js";

/** Metadata is navigation/candidate capability, never source or release approval. */
export function getMetricUi(metricId: string, registry: MetricRegistry = metricRegistryV1): MetricUiEntry | undefined {
  return registry.ui_metadata.decision_state === "candidate"
    ? registry.ui_metadata.metrics.find((entry) => entry.metric_id === metricId)
    : undefined;
}

export function getRegistryDepartments(registry: MetricRegistry = metricRegistryV1) {
  return registry.ui_metadata.decision_state === "candidate"
    ? [...registry.ui_metadata.departments].sort((a, b) => a.order - b.order)
    : [];
}

/** A pair is validated together, never the cross product of independent lists. */
export function selectMetricView(
  metricId: string,
  request: { state?: string; date_basis?: string } = {},
  registry: MetricRegistry = metricRegistryV1,
): MetricSelection {
  const ui = getMetricUi(metricId, registry);
  if (!ui?.default_combination) throw new Error(`No supported selectable view for ${metricId}`);
  const selection = {
    state: request.state ?? ui.default_combination.state,
    date_basis: request.date_basis ?? ui.default_combination.date_basis,
  };
  const supported = ui.supported_combinations.find(
    (pair) => pair.state === selection.state && pair.date_basis === selection.date_basis,
  );
  if (!supported)
    throw new Error(`Unsupported state/date combination for ${metricId}: ${selection.state}/${selection.date_basis}`);
  return { ...supported };
}

export function getLeadMetrics(surface: "overview" | "wall", registry: MetricRegistry = metricRegistryV1) {
  const ui = registry.ui_metadata;
  if (ui.decision_state !== "candidate") return [];
  return ui.metrics
    .filter((entry) => entry.lead_view[surface])
    .sort((a, b) => a.lead_view.order! - b.lead_view.order!)
    .flatMap((entry) => registry.metrics.filter((metric) => metric.id === entry.metric_id));
}

export function getMetricGroupingPolicy(metricId: string, registry: MetricRegistry = metricRegistryV1) {
  return registry.grouping_policies?.find((policy) => policy.metric_id === metricId);
}
